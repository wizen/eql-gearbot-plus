const { Store } = require('express-session');
const db = require('../db');

/**
 * A session store backed by this app's own SQLite database (see db.js's
 * "WEBSITE SESSIONS" section) instead of express-session's default
 * MemoryStore. MemoryStore keeps every login in a plain in-process Map
 * that nothing ever evicts on its own - express-session's own docs warn it
 * "will leak memory" and call it explicitly not designed for production.
 * That's a real problem on a long-running, low-RAM host like Wispbyte's
 * free/cheap tiers, not just a cosmetic warning to silence.
 *
 * No new dependency was added for this - db.js already abstracts over
 * better-sqlite3 (with a built-in fallback to Node's own node:sqlite if
 * the native bindings fail to compile), so sessions just ride on whichever
 * of those is already running the rest of the database. As a bonus,
 * logins now survive a bot restart instead of silently signing everyone
 * out.
 */
class SqliteSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    // Sweep expired rows on a timer rather than on every request - once an
    // hour is plenty for a guild-sized user base. unref() so this timer
    // never by itself keeps the process running.
    const pruneIntervalMs = options.pruneIntervalMs || 60 * 60 * 1000;
    this._pruneTimer = setInterval(() => {
      try {
        db.pruneExpiredSessions();
      } catch (err) {
        console.error('Session prune failed:', err.message);
      }
    }, pruneIntervalMs);
    this._pruneTimer.unref();
  }

  get(sid, callback) {
    try {
      const row = db.getSessionRow(sid);
      if (!row || row.expires_at <= Date.now()) {
        return callback(null, null);
      }
      callback(null, JSON.parse(row.session_json));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, session, callback) {
    try {
      const maxAge = session?.cookie?.maxAge;
      const expiresAt = Date.now() + (typeof maxAge === 'number' ? maxAge : 24 * 60 * 60 * 1000);
      db.upsertSession(sid, JSON.stringify(session), expiresAt);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      db.deleteSession(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  // Called on every authenticated request to refresh a rolling expiry -
  // just re-runs set() so activity keeps a session alive.
  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }
}

module.exports = { SqliteSessionStore };
