import session from 'express-session';

export class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.select = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires_at > ?');
    this.upsert = db.prepare('INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at');
    this.remove = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.extend = db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?');
    this.cleanupStatement = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  }

  get(sid, callback) {
    try {
      const row = this.select.get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }

  set(sid, data, callback) {
    try {
      const expiry = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      this.upsert.run(sid, JSON.stringify(data), expiry);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }

  destroy(sid, callback) {
    try { this.remove.run(sid); callback?.(null); } catch (error) { callback?.(error); }
  }

  touch(sid, data, callback) {
    try {
      const expiry = data.cookie?.expires ? new Date(data.cookie.expires).getTime() : Date.now() + 7 * 86400000;
      this.extend.run(expiry, sid);
      callback?.(null);
    } catch (error) { callback?.(error); }
  }

  cleanup() { this.cleanupStatement.run(Date.now()); }
}
