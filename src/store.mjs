import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
export class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS purchases (provider TEXT NOT NULL, reference TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
        kind TEXT NOT NULL, active INTEGER DEFAULT 0, expires_at TEXT, status TEXT, revoked_at INTEGER DEFAULT 0, checked_at INTEGER DEFAULT 0,
        checkout_url TEXT, created INTEGER NOT NULL,
        PRIMARY KEY(provider, reference));
      CREATE TABLE IF NOT EXISTS events (provider TEXT NOT NULL, id TEXT NOT NULL, received INTEGER NOT NULL, PRIMARY KEY(provider,id));`);
  }
  session() {
    const accountId = randomUUID(), token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO accounts VALUES (?,?,?)').run(accountId, hash(token), Date.now());
    return { accountId, token };
  }
  authenticate(token) { return this.db.prepare('SELECT id FROM accounts WHERE token_hash=?').get(hash(token))?.id; }
  // Alta perezosa: el token firmado identifica la cuenta sin depender de esta tabla.
  ensure(account) {
    this.db.prepare('INSERT OR IGNORE INTO accounts VALUES (?,?,?)').run(account, 'signed:' + randomBytes(16).toString('hex'), Date.now());
  }
  exists(account) { return Boolean(this.db.prepare('SELECT id FROM accounts WHERE id=?').get(account)); }
  bind(provider, reference, account, kind, url = null) {
    const old = this.db.prepare('SELECT account_id FROM purchases WHERE provider=? AND reference=?').get(provider, reference);
    if (old && old.account_id !== account) throw Object.assign(new Error('Purchase belongs to a different account'), { status: 409 });
    this.db.prepare('INSERT OR IGNORE INTO purchases(provider,reference,account_id,kind,checkout_url,created,status) VALUES(?,?,?,?,?,?,?)')
      .run(provider, reference, account, kind, url, Date.now(), 'pending');
  }
  rows(account) { return this.db.prepare('SELECT * FROM purchases WHERE account_id=?').all(account); }
  update(provider, reference, value) {
    this.db.prepare('UPDATE purchases SET active=?, expires_at=?, status=?, checked_at=? WHERE provider=? AND reference=?')
      .run(value.active ? 1 : 0, value.expiresAt || null, value.status || 'inactive', Date.now(), provider, reference);
  }
  revoke(provider, reference, at) {
    this.db.prepare('UPDATE purchases SET revoked_at=MAX(revoked_at,?),active=0,status=? WHERE provider=? AND reference=?')
      .run(at, 'revoked', provider, reference);
  }
  revokeAccount(provider, account, at) {
    this.db.prepare('UPDATE purchases SET revoked_at=MAX(revoked_at,?),active=0,status=? WHERE provider=? AND account_id=?')
      .run(at, 'revoked', provider, account);
  }
  seen(provider, id) { return Boolean(this.db.prepare('SELECT id FROM events WHERE provider=? AND id=?').get(provider,id)); }
  event(provider, id) { this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)').run(provider,id,Date.now()); }
  close() { this.db.close(); }
}
