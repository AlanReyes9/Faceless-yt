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

export async function enqueue(type, payload = {}) {
  const job = await one('INSERT INTO jobs (type, payload) VALUES ($1, $2) RETURNING id', [type, JSON.stringify(payload)]);
  kick();
  return job.id;
}

async function claim() {
  return one(`UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (SELECT id FROM jobs WHERE status = 'queued' OR (status = 'running' AND locked_at < now() - ${STALE})
                ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`);
}

/**
 * Procesa un trabajo. Devuelve false si la cola está vacía.
 * El manejador recibe ctx = { attempt, deadline (ms epoch), remaining() }.
 */
export async function runOne(deadline = Infinity) {
  const job = await claim();
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

let busy = false;
/**
 * Procesa trabajos de la cola. En Vercel: un trabajo pesado por invocación y nunca dos a la vez
 * en la misma instancia (con "fluid compute" varias peticiones comparten la misma CPU).
 * Devuelve true si la cola quedó vacía.
 */
export async function drain() {
  if (busy) return true; // ya hay un trabajo en esta instancia; ese se encargará de seguir
  busy = true;
  const start = Date.now();
  const deadline = IS_VERCEL ? start + INVOCATION_BUDGET_MS : Infinity;
  try {
    for (;;) {
      if (IS_VERCEL && Date.now() - start > START_WINDOW_MS) return false; // dejar el siguiente a una invocación nueva
      if (!(await runOne(deadline))) return true;
    }
  } finally { busy = false; }
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
  const r = await one(`SELECT
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE status = 'running' AND locked_at > now() - ${STALE})::int AS running,
      COUNT(*) FILTER (WHERE status = 'running' AND locked_at <= now() - ${STALE})::int AS stale
    FROM jobs`);
  if ((r.queued && !r.running) || r.stale) kick(true);
}

export async function queueStatus() {
  return one(`SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS waiting,
    COUNT(*) FILTER (WHERE status = 'running')::int AS running,
    COUNT(*) FILTER (WHERE status = 'failed')::int AS failed FROM jobs`);
}

/** Bucle local (servidor normal / VPS). */
export function startLocalWorker() {
  const n = Number(process.env.JOB_CONCURRENCY || 1);
  for (let i = 0; i < n; i++) (async function loop() {
    for (;;) {
      try { if (!(await runOne(Infinity))) await new Promise(r => setTimeout(r, 1500)); }
      catch (e) { console.error('worker:', e.message); await new Promise(r => setTimeout(r, 5000)); }
    }
  })();
}
