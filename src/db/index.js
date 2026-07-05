const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

let db = null;

// Opens (and migrates) the database. Tests pass ':memory:' for isolation.
function connect(dbPath = config.dbPath) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Writers briefly block each other under WAL; wait instead of failing.
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not connected — call connect() first');
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { connect, getDb, close };
