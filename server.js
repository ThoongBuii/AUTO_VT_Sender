require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

const PORT = process.env.PORT || 3000;
const MIN_DELAY_MS = 20_000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const LOG_DIR = path.join(__dirname, "logs");
const USERS_FILE = path.join(__dirname, "users.json");
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret-before-public-deploy";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("trust proxy", 1);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024,
  },
});

const sessionMiddleware = session({
  name: "wa_sender_sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

const runtimes = new Map();

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));
io.engine.use(sessionMiddleware);

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`, "utf8");
}

function ensureBootstrapAdmin() {
  if (fs.existsSync(USERS_FILE)) {
    return;
  }

  saveUsers([
    {
      id: "admin",
      username: "admin",
      displayName: "Admin",
      role: "admin",
      passwordHash: bcrypt.hashSync("admin123", 12),
    },
  ]);
  console.warn("Created default admin user: admin / admin123. Change this password before deploy.");
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "sales",
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Vui long dang nhap." });
  }

  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Chi admin moi duoc thao tac." });
  }

  next();
}

function sanitizeClientId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function userRoom(userId) {
  return `user:${userId}`;
}

function createRuntime(user) {
  return {
    user,
    client: null,
    clientState: "idle",
    latestQrDataUrl: null,
    isClientReady: false,
    activeJob: null,
    isClientInitializing: false,
    contactNameCache: new Map(),
  };
}

function getRuntime(user) {
  if (!runtimes.has(user.id)) {
    runtimes.set(user.id, createRuntime(user));
  }

  return runtimes.get(user.id);
}

function statusPayload(runtime) {
  return {
    state: runtime.clientState,
    ready: runtime.isClientReady,
    qr: runtime.latestQrDataUrl,
    activeJob: runtime.activeJob,
    user: publicUser(runtime.user),
  };
}

function emitStatus(userId) {
  const runtime = runtimes.get(userId);
  if (!runtime) {
    return;
  }

  io.to(userRoom(userId)).emit("status", statusPayload(runtime));
}

function emitLog(userId, level, message) {
  io.to(userRoom(userId)).emit("log", { level, message });
}

function normalizePhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  if (digits.startsWith("0")) {
    return `84${digits.slice(1)}`;
  }

  return digits;
}

function parseRecipients(input) {
  return String(input || "")
    .split(/[\n,;]+/)
    .map((item) => normalizePhone(item.trim()))
    .filter(Boolean);
}

function parseSelectedChatIds(input) {
  return String(input || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter((item) => /^\d+@c\.us$/.test(item));
}

function parseSelectedChatNames(input) {
  try {
    const parsed = JSON.parse(String(input || "{}"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function firstNameFrom(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function renderMessageTemplate(template, recipient) {
  const name = recipient.name || recipient.phone;
  const replacements = {
    "{name}": name,
    "{firstName}": firstNameFrom(name),
    "{phone}": recipient.phone,
  };

  return Object.entries(replacements).reduce(
    (content, [token, value]) => content.split(token).join(value),
    template,
  );
}

function contactDisplayName(contact) {
  return (
    contact.name ||
    contact.pushname ||
    contact.shortName ||
    contact.verifiedName ||
    contact.id?.user ||
    contact.number ||
    ""
  );
}

function cacheContactName(runtime, chatId, name) {
  const cleanName = String(name || "").trim();
  if (chatId && cleanName) {
    runtime.contactNameCache.set(chatId, cleanName);
  }
}

function resolveRecipientName(runtime, recipient) {
  if (recipient.name) {
    return recipient.name;
  }

  return runtime.contactNameCache.get(recipient.chatId) || recipient.phone;
}

function isDetachedFrameError(error) {
  return /detached frame/i.test(error?.message || "");
}

async function withDetachedFrameRetry(action, retries = 2) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;

      if (!isDetachedFrameError(error) || attempt === retries) {
        throw error;
      }

      await wait(1500 * (attempt + 1));
    }
  }

  throw lastError;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendHistory(userId, entry) {
  const file = path.join(LOG_DIR, `${sanitizeClientId(userId)}-send-history.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function createClient(userId, runtime) {
  const puppeteerOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const nextClient = new Client({
    authStrategy: new LocalAuth({
      clientId: sanitizeClientId(userId),
    }),
    puppeteer: puppeteerOptions,
  });

  nextClient.on("qr", async (qr) => {
    runtime.clientState = "qr_required";
    runtime.isClientReady = false;
    runtime.isClientInitializing = false;
    runtime.latestQrDataUrl = await QRCode.toDataURL(qr);
    emitStatus(userId);
  });

  nextClient.on("ready", () => {
    runtime.clientState = "ready";
    runtime.isClientReady = true;
    runtime.latestQrDataUrl = null;
    runtime.isClientInitializing = false;
    emitStatus(userId);
  });

  nextClient.on("authenticated", () => {
    runtime.clientState = "authenticated";
    emitStatus(userId);
  });

  nextClient.on("auth_failure", (message) => {
    runtime.clientState = "auth_failure";
    runtime.isClientReady = false;
    runtime.latestQrDataUrl = null;
    runtime.isClientInitializing = false;
    emitLog(userId, "error", `Dang nhap that bai: ${message}`);
    emitStatus(userId);
  });

  nextClient.on("disconnected", (reason) => {
    runtime.clientState = "disconnected";
    runtime.isClientReady = false;
    runtime.latestQrDataUrl = null;
    runtime.isClientInitializing = false;
    emitLog(userId, "warn", `WhatsApp da ngat ket noi: ${reason}`);
    emitStatus(userId);
  });

  return nextClient;
}

async function destroyClient(runtime, userId) {
  if (!runtime.client) {
    return;
  }

  try {
    await runtime.client.destroy();
  } catch (error) {
    emitLog(userId, "warn", `Khong destroy duoc client cu: ${error.message}`);
  } finally {
    runtime.client = null;
  }
}

async function initializeClient(user, options = {}) {
  const runtime = getRuntime(user);
  const force = Boolean(options.force);

  if (runtime.isClientInitializing) {
    return;
  }

  if (!force && runtime.client && ["starting", "authenticated", "qr_required", "ready"].includes(runtime.clientState)) {
    return;
  }

  runtime.isClientInitializing = true;
  runtime.clientState = "starting";
  runtime.isClientReady = false;
  runtime.latestQrDataUrl = null;
  emitStatus(user.id);

  await destroyClient(runtime, user.id);
  runtime.client = createClient(user.id, runtime);
  runtime.client.initialize().catch((error) => {
    runtime.clientState = "auth_failure";
    runtime.isClientReady = false;
    runtime.latestQrDataUrl = null;
    runtime.isClientInitializing = false;
    emitLog(user.id, "error", `Khong khoi dong duoc WhatsApp: ${error.message}`);
    emitStatus(user.id);
  });
}

io.on("connection", (socket) => {
  const user = socket.request.session?.user;

  if (!user) {
    socket.emit("auth", { authenticated: false });
    socket.disconnect(true);
    return;
  }

  const runtime = getRuntime(user);
  socket.join(userRoom(user.id));
  socket.emit("auth", { authenticated: true, user: publicUser(user) });
  socket.emit("status", statusPayload(runtime));
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ authenticated: false });
  }

  res.json({ authenticated: true, user: publicUser(req.session.user) });
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const users = loadUsers();
  const user = users.find((item) => item.username === username);

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Tai khoan hoac mat khau khong dung." });
  }

  req.session.user = publicUser(user);
  res.json({ ok: true, user: req.session.user });
});

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || username).trim();

  if (!username || !password) {
    return res.status(400).json({ error: "Vui long nhap username va password." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Mat khau toi thieu 6 ky tu." });
  }

  const users = loadUsers();
  if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: "Username da ton tai." });
  }

  const baseId = username.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const id = baseId || `sales_${Date.now()}`;
  const user = {
    id,
    username,
    displayName,
    role: "sales",
    passwordHash: await bcrypt.hash(password, 12),
  };

  users.push(user);
  saveUsers(users);

  req.session.user = publicUser(user);
  res.status(201).json({ ok: true, user: req.session.user });
});

app.post("/api/app-logout", requireAuth, (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.clearCookie("wa_sender_sid");
    res.json({ ok: true });
  });
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const users = loadUsers().map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "sales",
  }));

  res.json({ users });
});

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const displayName = String(req.body.displayName || username).trim();
  const role = req.body.role === "admin" ? "admin" : "sales";

  if (!username || !password) {
    return res.status(400).json({ error: "Vui long nhap username va password." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Mat khau toi thieu 6 ky tu." });
  }

  const users = loadUsers();
  if (users.some((user) => user.username === username)) {
    return res.status(409).json({ error: "Username da ton tai." });
  }

  const id = username.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  users.push({
    id,
    username,
    displayName,
    role,
    passwordHash: await bcrypt.hash(password, 12),
  });
  saveUsers(users);

  res.status(201).json({
    user: {
      id,
      username,
      displayName,
      role,
    },
  });
});

app.get("/api/status", requireAuth, (req, res) => {
  res.json(statusPayload(getRuntime(req.session.user)));
});

app.get("/api/chats", requireAuth, async (req, res) => {
  const runtime = getRuntime(req.session.user);

  if (!runtime.isClientReady || !runtime.client) {
    return res.status(409).json({ error: "WhatsApp chua san sang. Hay quet QR truoc." });
  }

  try {
    const [chats, contacts] = await Promise.all([
      runtime.client.getChats(),
      runtime.client.getContacts(),
    ]);
    const recipientsById = new Map();

    for (const chat of chats) {
      const id = chat.id?._serialized;
      if (chat.isGroup || !id?.endsWith("@c.us")) {
        continue;
      }

      const item = {
        id,
        name: chat.name || chat.id.user,
        number: chat.id.user,
        source: "chat",
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || 0,
      };
      recipientsById.set(id, item);
      cacheContactName(runtime, id, item.name);
    }

    for (const contact of contacts) {
      const id = contact.id?._serialized;
      if (!id?.endsWith("@c.us")) {
        continue;
      }

      const name = contactDisplayName(contact);
      const number = contact.id.user || contact.number;
      const existing = recipientsById.get(id);
      const item = {
        id,
        name: name || number,
        number,
        source: existing?.source || "contact",
        unreadCount: existing?.unreadCount || 0,
        timestamp: existing?.timestamp || 0,
      };
      recipientsById.set(id, item);
      cacheContactName(runtime, id, item.name);
    }

    const directRecipients = [...recipientsById.values()]
      .filter((item) => item.name && item.number)
      .sort((first, second) => {
        if (second.timestamp !== first.timestamp) {
          return second.timestamp - first.timestamp;
        }

        return first.name.localeCompare(second.name);
      })
      .slice(0, 1000);

    res.json({ chats: directRecipients });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/send", requireAuth, upload.single("attachment"), async (req, res) => {
  const runtime = getRuntime(req.session.user);

  if (!runtime.isClientReady || !runtime.client) {
    return res.status(409).json({ error: "WhatsApp chua san sang. Hay quet QR truoc." });
  }

  if (runtime.activeJob) {
    return res.status(409).json({ error: "Dang co chien dich gui khac dang chay." });
  }

  const selectedChatNames = parseSelectedChatNames(req.body.selectedChatNames);
  const phoneRecipients = parseRecipients(req.body.recipients).map((phone) => ({
    phone,
    chatId: `${phone}@c.us`,
    shouldCheckRegistration: true,
  }));
  const selectedRecipients = parseSelectedChatIds(req.body.selectedChatIds).map((chatId) => ({
    phone: chatId.replace("@c.us", ""),
    chatId,
    name: selectedChatNames[chatId],
    shouldCheckRegistration: false,
  }));
  const recipients = [...phoneRecipients, ...selectedRecipients].filter(
    (recipient, index, allRecipients) =>
      allRecipients.findIndex((item) => item.chatId === recipient.chatId) === index,
  );
  const message = String(req.body.message || "").trim();
  const delaySeconds = Number(req.body.delaySeconds || 20);
  const delayMs = Math.max(delaySeconds * 1000, MIN_DELAY_MS);
  const attachment = req.file;

  if (!recipients.length) {
    return res.status(400).json({ error: "Vui long nhap so dien thoai hoac chon chat can gui." });
  }

  if (!message && !attachment) {
    return res.status(400).json({ error: "Vui long nhap noi dung hoac chon file dinh kem." });
  }

  runtime.activeJob = {
    total: recipients.length,
    sent: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
  };
  emitStatus(req.session.user.id);

  res.json({
    ok: true,
    total: recipients.length,
    delaySeconds: delayMs / 1000,
  });

  let media = null;
  if (attachment) {
    media = new MessageMedia(
      attachment.mimetype,
      attachment.buffer.toString("base64"),
      attachment.originalname,
    );
  }

  for (const recipient of recipients) {
    const { phone, chatId, shouldCheckRegistration } = recipient;
    const recipientName = resolveRecipientName(runtime, recipient);
    const personalizedMessage = renderMessageTemplate(message, {
      ...recipient,
      name: recipientName,
    });
    const historyEntry = {
      phone,
      chatId,
      name: recipientName,
      message: personalizedMessage,
      hasAttachment: Boolean(media),
      sentAt: new Date().toISOString(),
    };

    try {
      if (shouldCheckRegistration) {
        const isRegistered = await withDetachedFrameRetry(() =>
          runtime.client.isRegisteredUser(chatId),
        );
        if (!isRegistered) {
          throw new Error("So nay chua dang ky WhatsApp");
        }
      }

      if (media) {
        await withDetachedFrameRetry(() =>
          runtime.client.sendMessage(chatId, media, { caption: personalizedMessage }),
        );
      } else {
        await withDetachedFrameRetry(() => runtime.client.sendMessage(chatId, personalizedMessage));
      }

      runtime.activeJob.sent += 1;
      appendHistory(req.session.user.id, { ...historyEntry, status: "success" });
      emitLog(req.session.user.id, "success", `Da gui toi ${recipientName} (${phone})`);
    } catch (error) {
      runtime.activeJob.failed += 1;
      appendHistory(req.session.user.id, {
        ...historyEntry,
        status: "failed",
        error: error.message,
      });
      emitLog(req.session.user.id, "error", `Loi ${phone}: ${error.message}`);
    }

    emitStatus(req.session.user.id);

    if (runtime.activeJob.sent + runtime.activeJob.failed < runtime.activeJob.total) {
      await wait(delayMs);
    }
  }

  emitLog(req.session.user.id, "info", "Hoan tat chien dich gui.");
  runtime.activeJob = null;
  emitStatus(req.session.user.id);
});

app.post("/api/logout", requireAuth, async (req, res) => {
  const runtime = getRuntime(req.session.user);

  try {
    if (runtime.client) {
      await runtime.client.logout().catch(() => {});
    }
    await destroyClient(runtime, req.session.user.id);
    runtime.clientState = "logged_out";
    runtime.isClientReady = false;
    runtime.latestQrDataUrl = null;
    runtime.contactNameCache.clear();
    emitStatus(req.session.user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reconnect", requireAuth, async (req, res) => {
  try {
    await initializeClient(req.session.user, { force: true });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

server.listen(PORT, () => {
  ensureBootstrapAdmin();
  console.log(`WhatsApp sender dang chay tai http://localhost:${PORT}`);
});
