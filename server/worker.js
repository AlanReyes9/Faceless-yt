// Worker independiente (opcional): procesa la cola sin servir la web.
// Útil para usar Vercel como web y un VPS/PC para renders largos: comparte la misma DATABASE_URL.
import './app.js';
import { startLocalWorker } from './jobs.js';
console.log('Worker de Faceless Studio procesando la cola…');
startLocalWorker();
