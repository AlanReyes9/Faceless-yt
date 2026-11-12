// Arranque local / VPS: servidor web + worker en el mismo proceso.
import { app } from './app.js';
import { startLocalWorker } from './jobs.js';
import { runCleanup } from './cleanup.js';
import { DB_MODE } from './db.js';
import { STORAGE_MODE } from './storage.js';

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Clippers Pro en http://localhost:${PORT}  ·  base de datos: ${DB_MODE}  ·  archivos: ${STORAGE_MODE}${process.env.APP_PASSWORD ? '' : '  ·  ⚠ sin contraseña (define APP_PASSWORD)'}`);
  if (process.env.WORKER !== '0') {
    startLocalWorker();
    // Limpieza de originales: al arrancar y cada 6 horas
    const clean = () => runCleanup().catch(e => console.error('limpieza:', e.message));
    setTimeout(clean, 60000); setInterval(clean, 6 * 3600e3);
  }
});
