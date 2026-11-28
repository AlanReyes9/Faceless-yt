// Copia de seguridad: ajustes (opcionalmente con las claves), plantillas, canales, personajes, calendario, proyectos y clips
// en un solo archivo .json. Los vídeos no van dentro (pueden ocupar muchos GB): se quedan en la carpeta de datos de la app.
import { q, one } from './db.js';
import { FIELDS, getSetting, setSettings } from './settings.js';

const TABLES = ['channels', 'characters', 'calendar', 'projects', 'clips'];
const STRIP = { channels: ['yt_refresh_token'] }; // credenciales que no se copian aunque se incluyan las claves

export async function makeBackup({ keys = false } = {}) {
  const settings = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    if (f.secret && !keys) continue;
    if (k === 'queue_paused') continue;
    const v = await getSetting(k).catch(() => null);
    if (v != null && v !== '' && v !== f.default) settings[k] = v;
  }
  const data = {};
  for (const t of TABLES) {
    const rows = await q(`SELECT * FROM ${t} ${t === 'projects' ? 'WHERE deleted_at IS NULL' : ''} ORDER BY id`).catch(() => []);
    data[t] = rows.map(r => { const o = { ...r }; for (const k of STRIP[t] || []) if (!keys) delete o[k]; return o; });
  }
  return { app: 'Clippers Pro', kind: 'backup', version: 1, created_at: new Date().toISOString(), withKeys: !!keys, settings, data };
}

/** Restaura una copia: ajustes y datos se AÑADEN (no se borra nada); los ids se renumeran. */
export async function restoreBackup(b, { settings = true } = {}) {
  if (b?.kind !== 'backup' || !b.data) throw new Error('El archivo no es una copia de seguridad de Clippers Pro.');
  if (settings && b.settings) await setSettings(Object.fromEntries(Object.entries(b.settings).filter(([k]) => FIELDS[k])));
  const map = { channels: new Map(), projects: new Map() };
  const count = {};
  const insertRow = async (t, row, fix = r => r) => {
    const r = fix({ ...row }); delete r.id;
    const cols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t])).map(c => c.column_name);
    const keys = Object.keys(r).filter(k => cols.includes(k));
    if (!keys.length) return null;
    const vals = keys.map(k => r[k] !== null && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k]);
    const res = await one(`INSERT INTO ${t} (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, vals);
    count[t] = (count[t] || 0) + 1;
    return res?.id;
  };
  for (const r of b.data.channels || []) map.channels.set(r.id, await insertRow('channels', r));
  for (const r of b.data.characters || []) await insertRow('characters', r);
  for (const r of b.data.calendar || []) await insertRow('calendar', r, x => ({ ...x, channel_id: map.channels.get(x.channel_id) ?? null }));
  for (const r of b.data.projects || []) map.projects.set(r.id, await insertRow('projects', r, x => ({ ...x, channel_id: map.channels.get(x.channel_id) ?? null,
    // lo que estaba a medias se marca como terminado con error (no se reanuda solo en el otro equipo)
    ...(['processing', 'pending'].includes(x.status) ? { status: 'error', error: 'Restaurado de una copia: pulsa «Reintentar» si hace falta.' } : {}) })));
  for (const r of b.data.clips || []) { const pid = map.projects.get(r.project_id); if (pid) await insertRow('clips', r, x => ({ ...x, project_id: pid, ...(x.status === 'rendering' ? { status: 'error', error: 'Restaurado de una copia.' } : {}) })); }
  return count;
}
