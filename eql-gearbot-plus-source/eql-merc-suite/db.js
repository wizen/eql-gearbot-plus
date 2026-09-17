const path = require('path');
const crypto = require('crypto');
const dbPath = path.join(__dirname, 'gear_inventory.db');

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch (err) {
  // If better-sqlite3 C++ bindings failed to compile in the container,
  // gracefully fall back to Node v22's built-in native SQLite engine (zero compilation required).
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(dbPath);
  if (!db.transaction) {
    db.transaction = (fn) => {
      return (...args) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      };
    };
  }
}

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS gear_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_item_name TEXT NOT NULL,
    upgrade_level TEXT DEFAULT '+0',
    wiki_url TEXT NOT NULL,
    added_by_user_id TEXT NOT NULL,
    added_by_username TEXT NOT NULL,
    requested_by_user_id TEXT DEFAULT NULL,
    requested_by_username TEXT DEFAULT NULL,
    exalts_json TEXT DEFAULT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    skill_required TEXT DEFAULT 'Crafting',
    skill_level_required INTEGER DEFAULT NULL,
    source_type TEXT DEFAULT 'crafted',
    requester_character TEXT NOT NULL,
    requester_discord_id TEXT DEFAULT NULL,
    requester_discord_name TEXT DEFAULT NULL,
    claimed_by_discord_id TEXT DEFAULT NULL,
    claimed_by_discord_name TEXT DEFAULT NULL,
    status TEXT DEFAULT 'unclaimed',
    notes TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME DEFAULT NULL,
    delivered_at DATETIME DEFAULT NULL,
    cancelled_at DATETIME DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    session_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

// Apprentice previously synced full character inventories (every item,
// storage location, bag, accessibility) into this database so /g-vault and
// /g-find could display them. That was scope creep - a guild gear bank
// should only ever know what's been deposited, not rifle through a
// player's entire bags - so it's been removed (see commands/gFind.js,
// api/routes/apprentice.js). These DROPs clear out any rows a prior build
// already collected; Apprentice's real job is only submitting/checking
// work orders (see api/routes/workOrders.js), which never touched these
// tables.
try {
  db.exec(`DROP TABLE IF EXISTS apprentice_inventories`);
} catch (e) {}
try {
  db.exec(`DROP TABLE IF EXISTS apprentice_crafting_targets`);
} catch (e) {}

// Migrate existing table if columns don't exist yet
try {
  db.exec(`ALTER TABLE gear_items ADD COLUMN requested_by_user_id TEXT DEFAULT NULL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE gear_items ADD COLUMN requested_by_username TEXT DEFAULT NULL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE gear_items ADD COLUMN exalts_json TEXT DEFAULT NULL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE work_orders ADD COLUMN skill_level_required INTEGER DEFAULT NULL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE work_orders ADD COLUMN delivered_at DATETIME DEFAULT NULL`);
} catch (e) {}
try {
  db.exec(`ALTER TABLE work_orders ADD COLUMN cancelled_at DATETIME DEFAULT NULL`);
} catch (e) {}

// Status vocabulary changed with the unclaimed -> claimed -> complete -> delivered
// lifecycle (delivered orders are purged 24h later, see cleanupDeliveredWorkOrders).
// Rename any rows still using the old open/in_progress/completed values so a
// live database upgraded in place doesn't end up with two status vocabularies
// mixed together.
try {
  db.exec(`UPDATE work_orders SET status = 'unclaimed' WHERE status = 'open'`);
  db.exec(`UPDATE work_orders SET status = 'claimed' WHERE status = 'in_progress'`);
  db.exec(`UPDATE work_orders SET status = 'complete' WHERE status = 'completed'`);
} catch (e) {}

const addGear = db.prepare(`
  INSERT INTO gear_items (base_item_name, upgrade_level, wiki_url, added_by_user_id, added_by_username, exalts_json)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const getAllGear = db.prepare(`
  SELECT * FROM gear_items ORDER BY id ASC
`);

const removeGearStmt = db.prepare(`
  DELETE FROM gear_items WHERE id = ?
`);

const getGearById = db.prepare(`
  SELECT * FROM gear_items WHERE id = ?
`);

const claimGear = db.prepare(`
  UPDATE gear_items 
  SET requested_by_user_id = ?, requested_by_username = ? 
  WHERE id = ? AND (requested_by_user_id IS NULL OR requested_by_user_id = '')
`);

const withdrawGear = db.prepare(`
  UPDATE gear_items 
  SET requested_by_user_id = NULL, requested_by_username = NULL 
  WHERE id = ? AND requested_by_user_id = ?
`);

/**
 * Compact the IDs in gear_items to remain contiguous (1, 2, 3...)
 * after any item is deleted.
 */
function compactInventoryIds() {
  const compactTransaction = db.transaction(() => {
    // Read all remaining items ordered by id
    const items = db.prepare(`SELECT * FROM gear_items ORDER BY id ASC`).all();
    // Clear the table
    db.prepare(`DELETE FROM gear_items`).run();
    // Re-insert each with contiguous 1-based IDs
    const insertStmt = db.prepare(`
      INSERT INTO gear_items (id, base_item_name, upgrade_level, wiki_url, added_by_user_id, added_by_username, requested_by_user_id, requested_by_username, exalts_json, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item, index) => {
      insertStmt.run(
        index + 1,
        item.base_item_name,
        item.upgrade_level,
        item.wiki_url,
        item.added_by_user_id,
        item.added_by_username,
        item.requested_by_user_id,
        item.requested_by_username,
        item.exalts_json || null,
        item.timestamp
      );
    });

    // Reset sqlite autoincrement sequence counter
    try {
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'gear_items'`).run();
      if (items.length > 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('gear_items', ?)`).run(items.length);
      }
    } catch (e) {
      // Ignored if sqlite_sequence is unavailable
    }
  });

  compactTransaction();
}

function removeGearById(id) {
  const result = removeGearStmt.run(id);
  if (result.changes > 0) {
    compactInventoryIds();
  }
  return result;
}

// ----------------------------------------------------
// API TOKENS (Apprentice desktop client <-> Bot API)
// ----------------------------------------------------
// Apprentice runs locally on a player's machine and has no browser session
// to hold a Discord OAuth cookie, so it authenticates with a long-lived
// personal API token instead. A player generates/rotates their token with
// the /g-apikey Discord command (DMed to them, never posted in a channel)
// and Apprentice stores it locally to call the bot's API.

function createOrRotateApiToken(discordUserId, discordUsername) {
  const token = crypto.randomBytes(24).toString('hex');
  const deleteTransaction = db.transaction(() => {
    db.prepare(`DELETE FROM api_tokens WHERE discord_user_id = ?`).run(discordUserId);
    db.prepare(`
      INSERT INTO api_tokens (discord_user_id, discord_username, token)
      VALUES (?, ?, ?)
    `).run(discordUserId, discordUsername, token);
  });
  deleteTransaction();
  return token;
}

function getUserByApiToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT * FROM api_tokens WHERE token = ?`).get(token);
  if (!row) return null;
  db.prepare(`UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  return row;
}

// ----------------------------------------------------
// WORK ORDERS INTERFACE (Apprentice -> Bot DB -> Discord)
// ----------------------------------------------------

function createWorkOrder(data) {
  const insertStmt = db.prepare(`
    INSERT INTO work_orders (
      item_name, quantity, skill_required, skill_level_required, source_type, requester_character, requester_discord_id, requester_discord_name, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unclaimed')
  `);
  const result = insertStmt.run(
    data.itemName,
    data.quantity || 1,
    data.skillRequired || 'Crafting',
    data.skillLevelRequired || null,
    data.sourceType || 'crafted',
    data.requesterCharacter || 'Adventurer',
    data.requesterDiscordId || null,
    data.requesterDiscordName || null,
    data.notes || null
  );
  return { id: result.lastInsertRowid, ...data, status: 'unclaimed' };
}

/**
 * @param statusFilter one of 'unclaimed' | 'claimed' | 'complete' | 'delivered' |
 *   'cancelled' | 'all' (or null, same as 'all').
 * @param requesterDiscordId when set, only returns orders that Discord user
 *   requested — this is what Apprentice's hourly check calls with, since it
 *   only ever cares about the status of orders it itself created.
 */
function getAllWorkOrders(statusFilter = null, requesterDiscordId = null) {
  const clauses = [];
  const params = [];
  if (statusFilter && statusFilter !== 'all') {
    clauses.push('status = ?');
    params.push(statusFilter);
  }
  if (requesterDiscordId) {
    clauses.push('requester_discord_id = ?');
    params.push(requesterDiscordId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM work_orders ${where} ORDER BY id DESC`).all(...params);
}

function getWorkOrderById(id) {
  return db.prepare(`SELECT * FROM work_orders WHERE id = ?`).get(id);
}

function claimWorkOrder(id, crafterId, crafterName) {
  const stmt = db.prepare(`
    UPDATE work_orders
    SET claimed_by_discord_id = ?, claimed_by_discord_name = ?, status = 'claimed'
    WHERE id = ? AND status = 'unclaimed'
  `);
  return stmt.run(crafterId, crafterName, id);
}

function completeWorkOrder(id) {
  const stmt = db.prepare(`
    UPDATE work_orders
    SET status = 'complete', completed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'claimed'
  `);
  return stmt.run(id);
}

/**
 * Crafter has finished the item AND it's actually been handed over in-game.
 * Only valid once an order is 'complete' — this is a separate step from
 * completeWorkOrder because "made it" and "gave it to the requester" aren't
 * the same moment. Delivered orders are swept away 24h later by
 * cleanupDeliveredWorkOrders so the list doesn't accumulate forever.
 */
function deliverWorkOrder(id) {
  const stmt = db.prepare(`
    UPDATE work_orders
    SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'complete'
  `);
  return stmt.run(id);
}

function cancelWorkOrder(id) {
  const stmt = db.prepare(`
    UPDATE work_orders
    SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('unclaimed', 'claimed')
  `);
  return stmt.run(id);
}

/**
 * Immediate, permanent removal — no status restriction, no 24h grace
 * period. This is the officer moderation tool: unlike cancel (which only
 * works pre-completion and still waits out its 24h window via
 * cleanupExpiredWorkOrders), an officer can delete a work order in ANY
 * status, right away — a duplicate, spam, or something posted by mistake.
 * Callers must enforce the officer check themselves (see requireOfficer in
 * api/routes/workOrders.js and the isOfficer check in index.js's
 * workorder_select_action_ handler).
 */
function deleteWorkOrder(id) {
  return db.prepare(`DELETE FROM work_orders WHERE id = ?`).run(id);
}

/**
 * Purges work orders that have sat in a terminal status for 24+ hours:
 * 'delivered' (fulfilled) or 'cancelled' (withdrawn). Both get the same
 * grace window so a cancelled order doesn't just disappear instantly, but
 * also doesn't linger forever. Called on an interval from index.js — not
 * on every read — so listings stay fast and the table doesn't grow
 * unbounded with orders nobody needs to look at again.
 */
function cleanupExpiredWorkOrders() {
  const result = db.prepare(`
    DELETE FROM work_orders
    WHERE (status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at <= datetime('now', '-24 hours'))
       OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_at <= datetime('now', '-24 hours'))
  `).run();
  return result.changes;
}

// ----------------------------------------------------
// WEBSITE SESSIONS (backs api/sessionStore.js)
// ----------------------------------------------------
// express-session's default MemoryStore keeps every login in a plain
// in-process Map that nothing ever evicts on its own - express-session
// itself warns this "will leak memory" and isn't fit for production. This
// table is what replaces it: sessions live here instead, in the same
// gear_inventory.db file everything else already uses, get pruned once
// they expire, and survive a bot restart instead of silently logging
// everyone out.

function upsertSession(sid, sessionJson, expiresAt) {
  const upsertTransaction = db.transaction(() => {
    db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
    db.prepare(`INSERT INTO sessions (sid, session_json, expires_at) VALUES (?, ?, ?)`).run(sid, sessionJson, expiresAt);
  });
  upsertTransaction();
}

function getSessionRow(sid) {
  return db.prepare(`SELECT session_json, expires_at FROM sessions WHERE sid = ?`).get(sid);
}

function deleteSession(sid) {
  return db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
}

/**
 * Sweeps rows past their expiry. Called on a timer from api/sessionStore.js
 * rather than on every request - an expired-but-not-yet-pruned row is
 * harmless (get() below always checks expires_at itself), this just keeps
 * the table from growing forever.
 */
function pruneExpiredSessions() {
  const result = db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
  return result.changes;
}

module.exports = {
  addGear: (baseName, upgrade, wikiUrl, userId, username, exaltsJson = null) => 
    addGear.run(baseName, upgrade, wikiUrl, userId, username, exaltsJson),
  getAllGear: () => getAllGear.all(),
  removeGearById,
  compactInventoryIds,
  getGearById: (id) => getGearById.get(id),
  claimGear: (id, userId, username) => claimGear.run(userId, username, id),
  withdrawGear: (id, userId) => withdrawGear.run(id, userId),
  // API tokens (Apprentice auth)
  createOrRotateApiToken,
  getUserByApiToken,
  // Work Orders
  createWorkOrder,
  getAllWorkOrders,
  getWorkOrderById,
  claimWorkOrder,
  completeWorkOrder,
  deliverWorkOrder,
  cancelWorkOrder,
  deleteWorkOrder,
  cleanupExpiredWorkOrders,
  // Website sessions (api/sessionStore.js)
  upsertSession,
  getSessionRow,
  deleteSession,
  pruneExpiredSessions
};