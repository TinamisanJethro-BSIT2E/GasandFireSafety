const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const configuredPath = process.env.DATABASE_PATH || './data/gas-safety.db';
const databasePath = path.resolve(configuredPath);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gas_value INTEGER NOT NULL,
    flame_detected INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Normal', 'Gas Leak', 'Fire Detected')),
    fan_on INTEGER NOT NULL,
    pump_on INTEGER NOT NULL,
    buzzer_on INTEGER NOT NULL,
    regulator_open INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_readings_created ON readings(created_at DESC);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    gas_value INTEGER,
    actions TEXT NOT NULL DEFAULT '[]',
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    gas_threshold INTEGER NOT NULL DEFAULT 1800,
    detection_delay INTEGER NOT NULL DEFAULT 5,
    telegram_enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS device_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
`);

db.prepare(`
  INSERT INTO settings (id, gas_threshold, detection_delay, telegram_enabled)
  VALUES (1, 1800, 5, 0)
  ON CONFLICT(id) DO NOTHING
`).run();

const adminUsername = process.env.ADMIN_USERNAME || 'admin';
const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
if (!db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername)) {
  const passwordHash = bcrypt.hashSync(adminPassword, 12);
  db.prepare(`
    INSERT INTO users (username, password_hash, role, must_change_password)
    VALUES (?, ?, 'admin', 1)
  `).run(adminUsername, passwordHash);
  console.log(`Seeded first-run administrator account: ${adminUsername}`);
}

module.exports = db;
