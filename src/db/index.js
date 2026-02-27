const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('../config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  used_by INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user1_id INTEGER NOT NULL,
  user2_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_states (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  payload TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shopping_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  executor_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  creator_chat_id INTEGER,
  executor_chat_id INTEGER,
  creator_message_id INTEGER,
  executor_message_id INTEGER
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL,
  item_order INTEGER NOT NULL,
  text TEXT NOT NULL,
  qty TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alias_sessions (
  user_id INTEGER PRIMARY KEY,
  difficulty TEXT NOT NULL,
  score INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_word TEXT,
  last_word TEXT,
  used_words TEXT,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  executor_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  due_at INTEGER,
  status TEXT NOT NULL,
  remind_stage INTEGER NOT NULL DEFAULT 0,
  reminders_sent_count INTEGER NOT NULL DEFAULT 0,
  next_remind_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

function now() {
  return Date.now();
}

function upsertUser(from) {
  const stmt = db.prepare(`
    INSERT INTO users (tg_id, username, first_name, last_name, created_at)
    VALUES (@tg_id, @username, @first_name, @last_name, @created_at)
    ON CONFLICT(tg_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name
  `);
  stmt.run({
    tg_id: from.id,
    username: from.username || null,
    first_name: from.first_name || '',
    last_name: from.last_name || '',
    created_at: now(),
  });
}

function getState(userId) {
  return db.prepare('SELECT * FROM user_states WHERE user_id = ?').get(userId);
}

function setState(userId, state, payload = null) {
  db.prepare(`
    INSERT INTO user_states (user_id, state, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, payload=excluded.payload, updated_at=excluded.updated_at
  `).run(userId, state, payload ? JSON.stringify(payload) : null, now());
}

function clearState(userId) {
  db.prepare('DELETE FROM user_states WHERE user_id = ?').run(userId);
}

function getActiveLinkForUser(userId) {
  return db.prepare(`
    SELECT * FROM links
    WHERE status = 'active' AND (user1_id = ? OR user2_id = ?)
    LIMIT 1
  `).get(userId, userId);
}

module.exports = {
  db,
  now,
  upsertUser,
  getState,
  setState,
  clearState,
  getActiveLinkForUser,
};
