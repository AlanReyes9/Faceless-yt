// Base de datos: Postgres (Neon) si existe DATABASE_URL; si no, Postgres embebido (PGlite) en ./data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IS_VERCEL = !!process.env.VERCEL;
export const DATA_DIR = path.resolve(process.env.DATA_DIR || (IS_VERCEL ? path.join(os.tmpdir(), 'fs-data') : './data'));
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const WORK_DIR = IS_VERCEL ? path.join(os.tmpdir(), 'fs-work') : path.join(DATA_DIR, 'work');
for (const d of [DATA_DIR, FILES_DIR]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });

const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
export const DB_MODE = DB_URL ? 'postgres' : 'pglite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, niche TEXT, language TEXT DEFAULT 'es', notes TEXT,
  yt_channel_id TEXT, yt_title TEXT, yt_refresh_token TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,                -- shorts | long | ad | montage
  title TEXT, channel_id INT,
  status TEXT DEFAULT 'pending',     -- pending | processing | ready | error
  progress TEXT, error TEXT,
  source TEXT, source_url TEXT, duration REAL,
  data JSONB DEFAULT '{}'::jsonb,
  output TEXT, deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clips (
  id SERIAL PRIMARY KEY, project_id INT NOT NULL, idx INT, start REAL, "end" REAL,
  title TEXT, hook TEXT, score INT, reason TEXT, layout TEXT DEFAULT 'blur',
  status TEXT DEFAULT 'pending', error TEXT, file TEXT, include_zip BOOLEAN DEFAULT true,
  variants JSONB DEFAULT '{}'::jsonb, yt_video_id TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clips_project ON clips(project_id);
CREATE TABLE IF NOT EXISTS calendar (
  id SERIAL PRIMARY KEY, date TEXT NOT NULL, title TEXT NOT NULL, notes TEXT,
  channel_id INT, kind TEXT DEFAULT 'short', done BOOLEAN DEFAULT false
);
CREATE TABLE IF NOT EXISTS characters (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, personality TEXT, style TEXT,
  voice TEXT, images JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analyses (
  id SERIAL PRIMARY KEY, target TEXT, kind TEXT, result JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY, type TEXT NOT NULL, payload JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'queued',      -- queued | running | failed
  attempts INT DEFAULT 0, error TEXT, locked_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, id);
`;

let ready;
async function connect() {
  let client;
  if (DB_MODE === 'postgres') {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: DB_URL, max: IS_VERCEL ? 3 : 10, ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(DB_URL) ? false : { rejectUnauthorized: false } });
    client = { query: (s, p) => pool.query(s, p), exec: s => pool.query(s) };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite(path.join(DATA_DIR, 'pg'));
    await db.waitReady;
    client = { query: (s, p) => db.query(s, p), exec: s => db.exec(s) };
  }
  await client.exec(SCHEMA);
  return client;
}
const conn = () => (ready ||= connect().catch(e => { ready = null; throw e; }));

/** Ejecuta SQL y devuelve las filas. */
export async function q(sql, params = []) {
  const c = await conn();
  return (await c.query(sql, params)).rows;
}
export const one = async (sql, params) => (await q(sql, params))[0];

/** UPDATE dinámico: update('projects', id, {status:'ready', data:{...}}) */
export async function update(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const vals = keys.map(k => (fields[k] !== null && typeof fields[k] === 'object' && !(fields[k] instanceof Date)) ? JSON.stringify(fields[k]) : fields[k] ?? null);
  await q(`UPDATE ${table} SET ${keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...vals, id]);
}
export async function insert(table, fields) {
  const keys = Object.keys(fields);
  const vals = keys.map(k => (fields[k] !== null && typeof fields[k] === 'object') ? JSON.stringify(fields[k]) : fields[k] ?? null);
  return one(`INSERT INTO ${table} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
}

export const getProject = id => one('SELECT * FROM projects WHERE id = $1', [id]);
export const updateProject = (id, f) => update('projects', id, f);
export const getClip = id => one('SELECT * FROM clips WHERE id = $1', [id]);
export const updateClip = (id, f) => update('clips', id, f);
