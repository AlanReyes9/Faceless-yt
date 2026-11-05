// Cola de trabajos en memoria: los renders pesados se ejecutan de uno en uno.
const queue = [];
let running = 0;
const CONCURRENCY = Number(process.env.JOB_CONCURRENCY || 1);

export function enqueue(name, fn) {
  return new Promise((resolve, reject) => {
    queue.push({ name, fn, resolve, reject });
    tick();
  });
}

function tick() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    Promise.resolve().then(job.fn)
      .then(job.resolve, e => { console.error(`[job ${job.name}]`, e.message); job.reject(e); })
      .finally(() => { running--; tick(); });
  }
}

export const queueStatus = () => ({ running, waiting: queue.length });
