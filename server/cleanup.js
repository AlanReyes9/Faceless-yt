// Borrado automático de los vídeos originales para ahorrar espacio.
// Se conservan los Shorts/vídeos terminados, la transcripción y los datos del proyecto.
import { q, updateProject } from './db.js';
import { getSetting } from './settings.js';
import { removeFile, fileSize } from './storage.js';

/** Archivos originales (no resultados) que pertenecen a un proyecto. */
function originals(p) {
  const files = [];
  if (p.source) files.push(p.source);
  for (const m of p.data?.options?.media || []) files.push(m);
  for (const r of p.liveRefs || []) files.push(r); // segmentos grabados de un directo
  for (const it of p.data?.options?.items || []) if (it.source) files.push(it.source); // clips subidos para un ranking
  for (const r of p.data?.parts || []) if (p.type === 'ranking') files.push(r); // clips ya preparados del ranking
  return [...new Set(files.filter(Boolean))];
}

/**
 * Proyectos terminados hace más de `days` días con originales que se pueden borrar.
 * No toca proyectos en proceso, con errores, marcados para conservar, ni con clips renderizándose o con error
 * (podrías querer reintentarlos).
 */
export async function candidates(days) {
  if (!(days > 0)) return [];
  const rows = await q(`SELECT p.* FROM projects p
    WHERE p.status = 'ready'
      AND COALESCE(p.ready_at, p.created_at) < now() - make_interval(days => $1::int)
      AND COALESCE((p.data->>'keepSource')::boolean, false) = false
      AND NOT EXISTS (SELECT 1 FROM clips c WHERE c.project_id = p.id AND c.status IN ('rendering', 'pending', 'error'))
    ORDER BY p.id LIMIT 200`, [days]);
  for (const p of rows.filter(r => r.type === 'live')) p.liveRefs = (await q('SELECT ref FROM live_segments WHERE project_id = $1 AND ref IS NOT NULL', [p.id])).map(r => r.ref);
  return rows.filter(p => originals(p).length);
}

/** Vista previa: qué se borraría y cuánto espacio se liberaría (aprox.). */
export async function preview(days) {
  days = days ?? Number(await getSetting('cleanup_days'));
  const list = await candidates(days);
  let bytes = 0;
  const items = [];
  for (const p of list.slice(0, 60)) {
    let size = 0;
    for (const f of originals(p)) size += await fileSize(f).catch(() => 0);
    bytes += size;
    items.push({ id: p.id, title: p.title, type: p.type, ready_at: p.ready_at || p.created_at, files: originals(p).length, bytes: size });
  }
  return { days, count: list.length, bytes, items };
}

/** Borra los originales. Devuelve cuántos proyectos y archivos se limpiaron. */
export async function runCleanup({ days } = {}) {
  days = days ?? Number(await getSetting('cleanup_days'));
  const list = await candidates(days);
  let files = 0;
  for (const p of list) {
    for (const f of originals(p)) { await removeFile(f); files++; }
    const data = { ...p.data, sourceDeletedAt: new Date().toISOString() };
    if (data.options?.media) data.options = { ...data.options, media: [] };
    await updateProject(p.id, { source: null, data });
    if (p.type === 'live') await q('UPDATE live_segments SET ref = NULL WHERE project_id = $1', [p.id]);
  }
  if (list.length) console.log(`Limpieza: ${list.length} proyectos, ${files} originales borrados (>${days} días)`);
  return { days, projects: list.length, files };
}
