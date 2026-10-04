import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function createSQLiteStore(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS interviews (
      id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, instrument_version TEXT NOT NULL,
      interviewer TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'in_progress',
      position INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS responses (
      interview_id TEXT NOT NULL REFERENCES interviews(id), question_id TEXT NOT NULL,
      answer TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (interview_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS import_keys (
      fingerprint TEXT PRIMARY KEY, interview_id TEXT NOT NULL REFERENCES interviews(id)
    );`);
  function nextCode() {
    let seq = db.prepare('SELECT COUNT(*) AS n FROM interviews').get().n + 1;
    let code;
    do { code = `BIO-${new Date().getFullYear()}-${String(seq++).padStart(6, '0')}`; }
    while (db.prepare('SELECT 1 FROM interviews WHERE code=?').get(code));
    return code;
  }
  function duplicate(row) {
    return !!(row.code && db.prepare('SELECT 1 FROM interviews WHERE code=?').get(row.code)
      || db.prepare('SELECT 1 FROM import_keys WHERE fingerprint=?').get(row.fingerprint));
  }
  function get(id) {
    const row = db.prepare('SELECT * FROM interviews WHERE id=?').get(id);
    if (!row) fail(404, 'Entrevista não encontrada.');
    const answers = Object.fromEntries(db.prepare('SELECT question_id,answer FROM responses WHERE interview_id=?').all(id).map(r => [r.question_id, JSON.parse(r.answer)]));
    return { ...row, answers };
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return {
    info: { provider: 'sqlite', label: 'Banco local', scope: 'local' },
    get,
    list: () => db.prepare('SELECT id FROM interviews ORDER BY started_at DESC').all().map(r => get(r.id)),
    findDuplicates: rows => rows.map(duplicate),
    create: ({ interviewer, instrument_version }) => transaction(() => {
      const id = randomUUID(), date = new Date().toISOString();
      db.prepare('INSERT INTO interviews (id,code,instrument_version,interviewer,started_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, nextCode(), instrument_version, interviewer, date, date);
      return get(id);
    }),
    save: ({ id, revision, answers, position, status, instrument_version }) => transaction(() => {
      const existing = get(id);
      if (existing.status !== 'in_progress' || existing.revision !== revision) fail(409, 'A entrevista foi alterada ou encerrada em outra sessão. Recarregue antes de continuar.');
      const date = new Date().toISOString();
      const upsert = db.prepare('INSERT INTO responses (interview_id,question_id,answer,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(interview_id,question_id) DO UPDATE SET answer=excluded.answer,updated_at=excluded.updated_at');
      for (const [key, answer] of Object.entries(answers)) {
        if (JSON.stringify(existing.answers[key]) !== JSON.stringify(answer)) upsert.run(id, key, JSON.stringify(answer), date, date);
      }
      db.prepare('UPDATE interviews SET position=?,status=?,revision=revision+1,updated_at=?,ended_at=?,instrument_version=? WHERE id=?').run(position, status, date, status === 'in_progress' ? null : date, instrument_version, id);
      return get(id);
    }),
    importRows: rows => transaction(() => {
      const ids = []; let skipped = 0;
      for (const row of rows) {
        if (row.duplicate || duplicate(row)) { skipped++; continue; }
        const id = randomUUID(), timestamp = new Date().toISOString();
        db.prepare('INSERT INTO interviews (id,code,instrument_version,interviewer,status,position,started_at,updated_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, row.code || nextCode(), row.instrument_version, row.interviewer, row.status, row.position, row.started_at || timestamp, row.updated_at || timestamp, row.status === 'in_progress' ? null : row.ended_at || timestamp);
        const insert = db.prepare('INSERT INTO responses (interview_id,question_id,answer,created_at,updated_at) VALUES (?,?,?,?,?)');
        for (const [key, answer] of Object.entries(row.answers)) insert.run(id, key, JSON.stringify(answer), timestamp, timestamp);
        db.prepare('INSERT INTO import_keys (fingerprint,interview_id) VALUES (?,?)').run(row.fingerprint, id);
        ids.push(id);
      }
      return { imported: ids.length, skipped, ids };
    }),
    health: () => ({ schema_version: 1 }),
    close: () => db.close(),
  };
}
