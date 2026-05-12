let socket = null;

const loginView = document.querySelector("#loginView");
const loginForm = document.querySelector("#loginForm");
const loginError = document.querySelector("#loginError");
const authTitle = document.querySelector("#authTitle");
const authSubtitle = document.querySelector("#authSubtitle");
const loginTabBtn = document.querySelector("#loginTabBtn");
const registerTabBtn = document.querySelector("#registerTabBtn");
const displayNameLabel = document.querySelector("#displayNameLabel");
const authSubmitBtn = document.querySelector("#authSubmitBtn");
const appShell = document.querySelector(".shell");
const userText = document.querySelector("#userText");
const adminPanel = document.querySelector("#adminPanel");
const createUserForm = document.querySelector("#createUserForm");
const refreshUsersBtn = document.querySelector("#refreshUsersBtn");
const adminMessage = document.querySelector("#adminMessage");
const usersList = document.querySelector("#usersList");
const statusBadge = document.querySelector("#statusBadge");
const statusText = document.querySelector("#statusText");
const qrBox = document.querySelector("#qrBox");
const sendForm = document.querySelector("#sendForm");
const sendBtn = document.querySelector("#sendBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const appLogoutBtn = document.querySelector("#appLogoutBtn");
const reconnectBtn = document.querySelector("#reconnectBtn");
const logs = document.querySelector("#logs");
const progressText = document.querySelector("#progressText");
const progressBar = document.querySelector("#progressBar");
const refreshChatsBtn = document.querySelector("#refreshChatsBtn");
const chatSearch = document.querySelector("#chatSearch");
const chatList = document.querySelector("#chatList");
const selectedChatIds = document.querySelector("#selectedChatIds");
const selectedChatNames = document.querySelector("#selectedChatNames");

let isReady = false;
let chats = [];
let authMode = "login";
const selectedChats = new Set();

function setAuthMode(mode) {
  authMode = mode;
  const isRegister = mode === "register";
  authTitle.textContent = isRegister ? "Đăng ký WhatsApp Sender" : "Đăng nhập WhatsApp Sender";
  authSubtitle.textContent = isRegister
    ? "Tạo tài khoản riêng, sau đó tự quét QR WhatsApp của bạn."
    : "Đăng nhập để dùng session WhatsApp riêng của bạn.";
  displayNameLabel.hidden = !isRegister;
  authSubmitBtn.textContent = isRegister ? "Đăng ký" : "Đăng nhập";
  loginTabBtn.classList.toggle("active", !isRegister);
  registerTabBtn.classList.toggle("active", isRegister);
  loginError.textContent = "";
}

function showApp(user) {
  loginView.hidden = true;
  appShell.hidden = false;
  userText.textContent = `Đang đăng nhập: ${user.displayName || user.username}`;
  adminPanel.hidden = user.role !== "admin";

  if (user.role === "admin") {
    loadUsers();
  }
}

function showLogin() {
  loginView.hidden = false;
  appShell.hidden = true;
  isReady = false;
  chats = [];
  selectedChats.clear();
  syncSelectedChatsInput();

  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function addLog(level, message) {
  const item = document.createElement("li");
  item.className = level;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logs.prepend(item);

  while (logs.children.length > 120) {
    logs.lastElementChild.remove();
  }
}

function humanStatus(state) {
  const map = {
    starting: "Đang khởi động",
    qr_required: "Cần quét QR",
    authenticated: "Đã xác thực",
    ready: "Sẵn sàng",
    idle: "Chưa kết nối",
    auth_failure: "Lỗi đăng nhập",
    disconnected: "Mất kết nối",
    logged_out: "Đã đăng xuất",
  };

  return map[state] || state;
}

function renderQr(qr) {
  qrBox.innerHTML = "";

  if (qr) {
    const image = document.createElement("img");
    image.src = qr;
    image.alt = "WhatsApp QR code";
    qrBox.appendChild(image);
    return;
  }

  const text = document.createElement("p");
  text.className = "muted";
  text.textContent = "Không có QR mới. Nếu chưa kết nối, hãy chờ vài giây hoặc khởi động lại server.";
  qrBox.appendChild(text);
}

function renderProgress(activeJob) {
  if (!activeJob) {
    progressText.textContent = "Chưa chạy";
    progressBar.style.width = "0%";
    return;
  }

  const done = activeJob.sent + activeJob.failed;
  const percent = activeJob.total ? Math.round((done / activeJob.total) * 100) : 0;
  progressText.textContent = `${done}/${activeJob.total} - OK ${activeJob.sent}, lỗi ${activeJob.failed}`;
  progressBar.style.width = `${percent}%`;
}

function renderUsers(users) {
  usersList.innerHTML = "";

  if (!users.length) {
    usersList.innerHTML = '<p class="muted">Chưa có tài khoản nào.</p>';
    return;
  }

  for (const user of users) {
    const row = document.createElement("div");
    row.className = "user-row";
    row.innerHTML = `<strong>${user.displayName}</strong><span>${user.username} · ${user.role}</span>`;
    usersList.appendChild(row);
  }
}

async function loadUsers() {
  try {
    const response = await fetch("/api/admin/users");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Không tải được danh sách user.");
    }

    renderUsers(result.users || []);
  } catch (error) {
    adminMessage.textContent = error.message;
  }
}

function syncSelectedChatsInput() {
  selectedChatIds.value = [...selectedChats].join(",");
  selectedChatNames.value = JSON.stringify(
    chats
      .filter((chat) => selectedChats.has(chat.id))
      .reduce((names, chat) => {
        names[chat.id] = chat.name || chat.number;
        return names;
      }, {}),
  );
}

function renderChats() {
  const search = chatSearch.value.trim().toLowerCase();
  const visibleChats = chats.filter((chat) => {
    const label = `${chat.name} ${chat.number}`.toLowerCase();
    return label.includes(search);
  });

  chatList.innerHTML = "";

  if (!visibleChats.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = chats.length ? "Không tìm thấy chat phù hợp." : "Chưa có dữ liệu chat.";
    chatList.appendChild(empty);
    return;
  }

  for (const chat of visibleChats) {
    const row = document.createElement("label");
    row.className = "chat-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedChats.has(chat.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedChats.add(chat.id);
      } else {
        selectedChats.delete(chat.id);
      }

      syncSelectedChatsInput();
    });

    const text = document.createElement("span");
    const name = document.createElement("strong");
    const number = document.createElement("small");
    name.textContent = chat.name || chat.number;
    number.textContent = chat.number;
    text.append(name, number);

    row.append(checkbox, text);
    chatList.appendChild(row);
  }
}

async function loadChats() {
  if (!isReady) {
    addLog("warn", "WhatsApp chưa sẵn sàng, hãy quét QR trước.");
    return;
  }

  refreshChatsBtn.disabled = true;
  chatList.innerHTML = '<p class="muted">Đang tải danh sách chat...</p>';

  try {
    const response = await fetch("/api/chats");
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Không tải được danh sách chat.");
    }

    chats = result.chats || [];
    renderChats();
    addLog("info", `Đã tải ${chats.length} contact/chat WhatsApp.`);
  } catch (error) {
    chatList.innerHTML = `<p class="muted">${error.message}</p>`;
    addLog("error", error.message);
  } finally {
    refreshChatsBtn.disabled = false;
  }
}

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io();

  socket.on("status", (payload) => {
  const wasReady = isReady;
  isReady = payload.ready;
  statusBadge.textContent = humanStatus(payload.state);
  statusBadge.classList.toggle("ready", payload.ready);
  statusBadge.classList.toggle("error", ["auth_failure", "disconnected"].includes(payload.state));
  sendBtn.disabled = !payload.ready || Boolean(payload.activeJob);
  refreshChatsBtn.disabled = !payload.ready;
  reconnectBtn.disabled = ["starting", "authenticated"].includes(payload.state);

  if (payload.ready) {
    statusText.textContent = "WhatsApp đã sẵn sàng. Bạn có thể gửi tin nhắn.";
    qrBox.innerHTML = '<p class="muted">Đã kết nối WhatsApp.</p>';
    if (!wasReady && chats.length === 0) {
      loadChats();
    }
  } else if (payload.state === "idle" || payload.state === "logged_out") {
    statusText.textContent = "Bấm “Tạo QR mới / đăng nhập lại” khi bạn cần kết nối WhatsApp.";
    qrBox.innerHTML = '<p class="muted">WhatsApp chưa khởi động để trang tải nhanh hơn.</p>';
  } else {
    statusText.textContent = "Mở WhatsApp trên điện thoại > Thiết bị liên kết > Liên kết thiết bị để quét QR.";
    renderQr(payload.qr);
  }

  renderProgress(payload.activeJob);
  });

  socket.on("log", ({ level, message }) => {
    addLog(level, message);
  });
}

async function checkSession() {
  try {
    const response = await fetch("/api/me");
    const result = await response.json();

    if (!response.ok || !result.authenticated) {
      showLogin();
      return;
    }

    showApp(result.user);
    connectSocket();
  } catch {
    showLogin();
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";

  try {
    const formData = new FormData(loginForm);
    const response = await fetch(authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
        displayName: formData.get("displayName"),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Không đăng nhập được.");
    }

    loginForm.reset();
    showApp(result.user);
    connectSocket();
  } catch (error) {
    loginError.textContent = error.message;
  }
});

loginTabBtn.addEventListener("click", () => setAuthMode("login"));
registerTabBtn.addEventListener("click", () => setAuthMode("register"));

createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  adminMessage.textContent = "";

  try {
    const formData = new FormData(createUserForm);
    const response = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: formData.get("username"),
        displayName: formData.get("displayName"),
        password: formData.get("password"),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Không tạo được tài khoản.");
    }

    adminMessage.textContent = `Đã tạo tài khoản ${result.user.username}.`;
    createUserForm.reset();
    loadUsers();
  } catch (error) {
    adminMessage.textContent = error.message;
  }
});

refreshUsersBtn.addEventListener("click", loadUsers);

refreshChatsBtn.addEventListener("click", loadChats);
chatSearch.addEventListener("input", renderChats);

reconnectBtn.addEventListener("click", async () => {
  reconnectBtn.disabled = true;
  addLog("info", "Đang tạo QR đăng nhập mới...");

  try {
    const response = await fetch("/api/reconnect", { method: "POST" });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Không tạo được QR mới.");
    }
  } catch (error) {
    addLog("error", error.message);
    reconnectBtn.disabled = false;
  }
});

sendForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  sendBtn.disabled = true;

  try {
    const formData = new FormData(sendForm);
    const response = await fetch("/api/send", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Khong gui duoc chien dich.");
    }

    addLog("info", `Da bat dau gui ${result.total} so, delay ${result.delaySeconds}s.`);
  } catch (error) {
    addLog("error", error.message);
    sendBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  if (!confirm("Dang xuat session WhatsApp tren may nay?")) {
    return;
  }

  try {
    const response = await fetch("/api/logout", { method: "POST" });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Khong dang xuat duoc.");
    }

    addLog("info", "Da dang xuat session WhatsApp.");
  } catch (error) {
    addLog("error", error.message);
  }
});

appLogoutBtn.addEventListener("click", async () => {
  try {
    await fetch("/api/app-logout", { method: "POST" });
  } finally {
    showLogin();
  }
});

checkSession();
