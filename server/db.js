import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
export const OUTPUT_DIR = path.join(DATA_DIR, 'output');
export const WORK_DIR = path.join(DATA_DIR, 'work');
for (const d of [DATA_DIR, UPLOADS_DIR, OUTPUT_DIR, WORK_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, niche TEXT, language TEXT DEFAULT 'es', notes TEXT,
  yt_channel_id TEXT, yt_title TEXT, yt_refresh_token TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,               -- 'shorts' | 'long'
  title TEXT, channel_id INTEGER,
  status TEXT DEFAULT 'pending',    -- pending|processing|ready|error
  progress TEXT, error TEXT,
  source_path TEXT, source_url TEXT, duration REAL,
  data TEXT DEFAULT '{}',           -- JSON: transcript, options, script...
  output_path TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  idx INTEGER, start REAL, end REAL,
  title TEXT, hook TEXT, score INTEGER, reason TEXT,
  layout TEXT DEFAULT 'blur',       -- blur | crop
  status TEXT DEFAULT 'pending',    -- pending|rendering|ready|error
  error TEXT, file TEXT,
  include_zip INTEGER DEFAULT 1,
  variants TEXT DEFAULT '{}',       -- JSON {lang: file}
  yt_video_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS calendar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, title TEXT NOT NULL, notes TEXT,
  channel_id INTEGER, kind TEXT DEFAULT 'short', done INTEGER DEFAULT 0
);
`);

export const json = (s, fallback = {}) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

export function getProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (p) p.data = json(p.data);
  return p;
}
export function updateProject(id, fields) {
  const f = { ...fields };
  if (f.data && typeof f.data !== 'string') f.data = JSON.stringify(f.data);
  const keys = Object.keys(f);
  if (!keys.length) return;
  db.prepare(`UPDATE projects SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => f[k] ?? null), id);
}
export function getClip(id) {
  const c = db.prepare('SELECT * FROM clips WHERE id = ?').get(id);
  if (c) c.variants = json(c.variants);
  return c;
}
export function updateClip(id, fields) {
  const f = { ...fields };
  if (f.variants && typeof f.variants !== 'string') f.variants = JSON.stringify(f.variants);
  const keys = Object.keys(f);
  if (!keys.length) return;
  db.prepare(`UPDATE clips SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => f[k] ?? null), id);
}
