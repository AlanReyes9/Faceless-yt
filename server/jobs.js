// Cola de trabajos persistente en la base de datos.
// Cada trabajo es un paso corto (< 5 min) para que funcione en funciones serverless de Vercel.
//  - Local / VPS: un bucle en el propio proceso procesa la cola.
//  - Vercel: tras encolar, la API se "despierta" a sí misma (POST /api/worker) y procesa en segundo plano.
import { q, one, IS_VERCEL } from './db.js';
import { internalSecret } from './settings.js';

const handlers = {};
/** Registra un tipo de trabajo. onFail se llama cuando se agotan los reintentos. */
export function register(type, fn, onFail) { handlers[type] = { fn, onFail }; }

const MAX_ATTEMPTS = 3;
// Una invocación de Vercel dura como máximo 300 s: un trabajo "running" más viejo que esto murió con ella.
const STALE = IS_VERCEL ? "interval '330 seconds'" : "interval '30 minutes'";
// Tiempo disponible por invocación (deja margen para guardar el resultado antes del corte de 300 s)
const INVOCATION_BUDGET_MS = Number(process.env.WORKER_BUDGET_MS || 280000);
// Solo se empieza un trabajo nuevo si la invocación lleva menos de esto (así cada trabajo pesado tiene ~4,5 min)
const START_WINDOW_MS = Math.min(25000, INVOCATION_BUDGET_MS * 0.1);
let baseUrl = process.env.PUBLIC_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
// En producción en Vercel siempre se usa la URL de producción (las URLs de cada despliegue pueden estar protegidas).
const fixedBase = !!process.env.PUBLIC_URL || (process.env.VERCEL_ENV === 'production' && !!process.env.VERCEL_PROJECT_PRODUCTION_URL);
export const setBaseUrl = u => { if (u && !fixedBase) baseUrl = u; };

// Carriles: la grabación de directos va aparte para que los análisis/renders no la retrasen (sin huecos).
export const LANES = ['live', 'work'];
const laneOf = type => type === 'live.capture' ? 'live' : 'work';

export async function enqueue(type, payload = {}) {
  const job = await one('INSERT INTO jobs (type, payload, lane) VALUES ($1, $2, $3) RETURNING id', [type, JSON.stringify(payload), laneOf(type)]);
  kick();
  return job.id;
}

async function claim(lane = 'work') {
  return one(`UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE COALESCE(lane, 'work') = $1 AND (status = 'queued' OR (status = 'running' AND locked_at < now() - ${STALE}))
                ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`, [lane]);
}

/**
 * Procesa un trabajo. Devuelve false si la cola está vacía.
 * El manejador recibe ctx = { attempt, deadline (ms epoch), remaining() }.
 */
export async function runOne(deadline = Infinity, lane = 'work') {
  const job = await claim(lane);
  if (!job) return false;
  const ctx = { attempt: job.attempts, deadline, remaining: () => deadline - Date.now(), jobId: job.id };
  const h = handlers[job.type];
  const fail = async msg => {
    await q("UPDATE jobs SET status = 'failed', error = $1 WHERE id = $2", [msg, job.id]);
    try { await h?.onFail?.(job.payload, msg); } catch (e) { console.error('onFail', e); }
  };
  if (!h) { await fail('Tipo de trabajo desconocido: ' + job.type); return true; }
  if (job.attempts > MAX_ATTEMPTS) {
    await fail('Este paso superó varias veces el tiempo máximo del servidor (5 min en Vercel). Pulsa "Reintentar": se usará una calidad más rápida. Si sigue fallando, prueba un clip más corto.');
    return true;
  }
  const t0 = Date.now();
  console.log(`[job ${job.id} ${job.type}] inicio (intento ${job.attempts}) ${JSON.stringify(job.payload)}`);
  try {
    await h.fn(job.payload, ctx);
    await q('DELETE FROM jobs WHERE id = $1', [job.id]);
    console.log(`[job ${job.id} ${job.type}] ok en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    console.error(`[job ${job.id} ${job.type}] error tras ${((Date.now() - t0) / 1000).toFixed(1)} s:`, e.message);
    // Errores de configuración (falta clave, 4xx) no se reintentan.
    const permanent = /Falta la clave|\((400|401|403|404|410|413|422)\)|no está conectado|No se pudo leer/.test(e.message);
    if (permanent || job.attempts >= MAX_ATTEMPTS) await fail(e.message);
    else await q("UPDATE jobs SET status = 'queued', error = $1, locked_at = NULL WHERE id = $2", [e.message, job.id]);
  }
  return true;
}

const busy = { work: false, live: false };
/**
 * Procesa trabajos de la cola. En Vercel: un trabajo pesado por invocación y nunca dos a la vez
 * en la misma instancia (con "fluid compute" varias peticiones comparten la misma CPU).
 * Devuelve true si la cola quedó vacía.
 */
export async function drain() {
  // Los dos carriles en paralelo: grabar un directo apenas usa CPU (copia el vídeo sin recodificar).
  // Mientras un carril sigue trabajando, los demás vuelven a mirar la cola (un directo genera análisis y renders).
  const working = new Set(); // carriles que están ejecutando un trabajo ahora mismo
  const res = await Promise.all(LANES.map(l => drainLane(l, () => [...working].some(x => x !== l), on => on ? working.add(l) : working.delete(l))));
  return res.every(Boolean);
}
async function drainLane(lane, othersActive = () => false, mark = () => {}) {
  if (busy[lane]) return true; // ya hay un trabajo de este carril en esta instancia; ese se encargará de seguir
  busy[lane] = true;
  const start = Date.now();
  const deadline = IS_VERCEL ? start + INVOCATION_BUDGET_MS : Infinity;
  try {
    for (;;) {
      if (IS_VERCEL && Date.now() - start > START_WINDOW_MS) {
        // Dejar el siguiente a una invocación nueva, sin esperar al otro carril (la grabación de un directo no puede tener huecos)
        if (await one(`SELECT 1 FROM jobs WHERE COALESCE(lane, 'work') = $1 AND status = 'queued' LIMIT 1`, [lane]).catch(() => null)) setTimeout(() => kick(true), 50);
        return false;
      }
      mark(true);
      const did = await runOne(deadline, lane).finally(() => mark(false));
      if (did) continue;
      if (IS_VERCEL || !othersActive()) return true;
      await new Promise(r => setTimeout(r, 2000));
    }
  } finally { busy[lane] = false; }
}

// ---------- Disparadores ----------
let lastKick = 0;
/** En Vercel lanza una invocación del worker sin esperar. Fuera de Vercel no hace nada (hay bucle local). */
export function kick(force = false) {
  if (!IS_VERCEL || !baseUrl) return;
  if (!force && Date.now() - lastKick < 1500) return;
  lastKick = Date.now();
  const p = fetch(`${baseUrl}/api/worker`, { method: 'POST', headers: { 'x-worker-secret': internalSecret(), ...bypassHeader() } })
    .then(r => r.text()).catch(e => console.warn('kick:', e.message));
  import('@vercel/functions').then(({ waitUntil }) => waitUntil(p)).catch(() => {});
}
const bypassHeader = () => process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};

/** Si hay trabajos pendientes y nadie los está procesando, despierta al worker (red de seguridad). */
export async function ensureWorker() {
  if (!IS_VERCEL) return;
  const rows = await q(`SELECT COALESCE(lane, 'work') AS lane,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'running' AND locked_at > now() - ${STALE})::int AS running,
      COUNT(*) FILTER (WHERE status = 'running' AND locked_at <= now() - ${STALE})::int AS stale
    FROM jobs GROUP BY 1`);
  if (rows.some(r => (r.queued && !r.running) || r.stale)) kick(true);
}

export async function queueStatus() {
  return one(`SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS waiting,
    COUNT(*) FILTER (WHERE status = 'running')::int AS running,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
    EXTRACT(EPOCH FROM now() - MIN(locked_at) FILTER (WHERE status = 'running'))::int AS running_for_s,
    STRING_AGG(type || ':' || status || ':' || attempts, ',' ORDER BY id) FILTER (WHERE status <> 'failed') AS pending FROM jobs`);
}

/** Bucle local (servidor normal / VPS). */
export function startLocalWorker() {
  const n = Number(process.env.JOB_CONCURRENCY || 1);
  // un bucle para grabar directos + N bucles para el resto de trabajos
  for (const lane of ['live', ...Array(n).fill('work')]) (async function loop() {
    for (;;) {
      try { if (!(await runOne(Infinity, lane))) await new Promise(r => setTimeout(r, 1500)); }
      catch (e) { console.error('worker:', e.message); await new Promise(r => setTimeout(r, 5000)); }
    }
  })();
}
