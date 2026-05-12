const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const [username, password, displayName, roleInput] = process.argv.slice(2);
const usersFile = path.join(__dirname, "..", "users.json");

if (!username || !password) {
  console.error("Usage: node scripts/create-user.js <username> <password> [displayName]");
  process.exit(1);
}

const users = fs.existsSync(usersFile)
  ? JSON.parse(fs.readFileSync(usersFile, "utf8"))
  : [];

if (users.some((user) => user.username === username)) {
  console.error(`User "${username}" already exists.`);
  process.exit(1);
}

users.push({
  id: username.toLowerCase().replace(/[^a-z0-9_-]/g, "_"),
  username,
  displayName: displayName || username,
  role: roleInput === "admin" ? "admin" : "sales",
  passwordHash: bcrypt.hashSync(password, 12),
});

fs.writeFileSync(usersFile, `${JSON.stringify(users, null, 2)}\n`, "utf8");
console.log(`Created user "${username}" in users.json`);
