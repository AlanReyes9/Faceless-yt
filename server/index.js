// Arranque local / VPS: servidor web + worker en el mismo proceso.
import { app } from './app.js';
import { startLocalWorker } from './jobs.js';
import { DB_MODE } from './db.js';
import { STORAGE_MODE } from './storage.js';

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Faceless Studio en http://localhost:${PORT}  ·  base de datos: ${DB_MODE}  ·  archivos: ${STORAGE_MODE}${process.env.APP_PASSWORD ? '' : '  ·  ⚠ sin contraseña (define APP_PASSWORD)'}`);
  if (process.env.WORKER !== '0') startLocalWorker();
});
