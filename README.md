# Clippers Pro

Estudio web propio para canales de YouTube *faceless* (sin mostrar la cara). Funciona con **tus propias claves API**: solo pagas lo que uses en cada proveedor.

## Qué hace

| Sección | Función |
|---|---|
| **Convertir a Shorts** | Subes un vídeo largo (o pegas un enlace). Se transcribe con Whisper y la IA elige los mejores momentos, con nota del 1 al 10 y una frase de gancho. Se renderiza cada Short en 1080×1920 con **fondo difuminado** o recorte, el gancho arriba durante 4 s y subtítulos palabra a palabra. Puedes ajustar inicio/fin ±1 s, editar el gancho, *Aplicar cambios*, traducir a otro idioma, publicar en YouTube o descargar un **.zip**. |
| **Clips virales (en Convertir a Shorts)** | Puntuación combinada: criterios de la IA (gancho, historia, emoción, valor, final) + señales medidas (picos de energía del audio, risas, ritmo de habla, cambios de plano). Encuadre **"Seguir la cara"**, que detecta a quien habla (UltraFace, en WASM) y mueve el recorte vertical con cortes o desplazamientos suaves. **4 estilos de subtítulos** (Clásico, Marcador, Impacto, Minimalista), palabras clave en color y **emojis animados** sincronizados con la palabra. |
| **Clips de directos** | Pegas el enlace de un directo (YouTube, Twitch o Kick en tu PC; en Vercel, enlaces `.m3u8`). Se graba por segmentos sin huecos, la IA analiza cada uno mientras sigue el directo y corta los momentos con nota viral alta, incluidos los que cruzan de un segmento a otro. Se detiene con un botón, al terminar el directo o al llegar al máximo de minutos. |
| **Vídeo completo** | Tema → guion con IA (editable) → voz en off (OpenAI TTS / ElevenLabs) → vídeos de stock de Pixabay o Pexels → subtítulos → MP4 horizontal o vertical. |
| **Buscador de nichos** | La IA propone nichos rentables con RPM estimado, competencia e ideas de vídeos. |
| **Mis canales** | Canales con nicho e idioma, conectados a YouTube mediante OAuth para publicar. |
| **Calendario de contenido** | Planificación mensual. La IA puede generar el plan de un canal. |
| **Mis vídeos / Papelera** | Historial de proyectos y papelera con borrado definitivo. |
| **Personaje IA** | Personaje con aspecto, personalidad y voz. Genera imágenes coherentes y lo usa como narrador. |
| **Creador de anuncios IA** | Producto + fotos → anuncio vertical con gancho, voz, subtítulos y llamada a la acción. |
| **Montar mi material** | Tus clips e imágenes + narración con IA (o tu guion) → vídeo terminado. |
| **Analizador** | Estadísticas y diagnóstico con IA de cualquier canal o vídeo de YouTube. |
| **Estado del servidor** | Base de datos, almacenamiento y cola de trabajos con reintentos. |
| **Ajustes y claves** | Claves API cifradas (AES-256-GCM) en tu servidor y selección de proveedor y modelo. |

### Proveedores de IA compatibles

- **Texto:** OpenAI, Anthropic (Claude), Google Gemini, OpenRouter
- **Transcripción:** OpenAI Whisper o Groq (más barato)
- **Voz:** OpenAI TTS o ElevenLabs
- **Imágenes:** OpenAI, Gemini ("Nano Banana") o Pollinations (gratis), con respaldo automático
- **Stock:** Pixabay (gratis) o Pexels
- **Publicación:** YouTube Data API v3 (OAuth de Google)

## Arquitectura

- **Base de datos:** Postgres. En Vercel usa **Neon** (`DATABASE_URL`). En local, si no hay `DATABASE_URL`, usa Postgres embebido (PGlite) en `./data`.
- **Archivos:** **Vercel Blob** si existe `BLOB_READ_WRITE_TOKEN` (los vídeos se suben directamente desde el navegador). Si no, se guardan en disco (`./data/files`).
- **Renders:** cola de trabajos en la base de datos, dividida en pasos cortos (< 5 min) para funcionar en las funciones serverless de Vercel. ffmpeg viene incluido (`ffmpeg-static`) con las fuentes de `fonts/`.
- **Worker:** en Vercel la API se despierta a sí misma para procesar la cola. En un servidor propio, el worker corre en el mismo proceso. Si un vídeo es muy pesado para Vercel, ejecuta `npm run worker` en un VPS o PC con la misma `DATABASE_URL` y `BLOB_READ_WRITE_TOKEN`: procesará la cola compartida.

## Despliegue en Vercel + Neon

1. Importa el repositorio en Vercel (framework: *Other*).
2. En **Storage**, conecta una base de datos **Neon** (crea `DATABASE_URL`) y un **Blob store** (crea `BLOB_READ_WRITE_TOKEN`).
3. Añade las variables `APP_PASSWORD` y `APP_SECRET` (`openssl rand -hex 32`).
4. Vuelve a desplegar. Las tablas se crean solas en el primer arranque.

Límites en Vercel: cada paso tiene un máximo de 300 s y no se pueden importar vídeos desde enlaces de YouTube (sube el archivo).

## App de escritorio (Windows y Mac)

Descarga el instalador en la página **Releases** del repositorio:

- **Windows:** `ClippersPro-Setup-x.y.z.exe`. Si aparece "Windows protegió su PC", pulsa *Más información → Ejecutar de todas formas* (la app no tiene firma de pago de Microsoft).
- **Mac con Apple Silicon (M1–M4):** `ClippersPro-x.y.z-mac-arm64.dmg`. **Mac Intel:** `…-mac-x64.dmg`. Arrastra la app a *Aplicaciones*. Como no está firmada por Apple, la primera vez abre la Terminal y ejecuta:
  `xattr -cr "/Applications/Clippers Pro.app"`, y después ábrela normalmente.

La app de escritorio incluye el servidor completo, ffmpeg y yt-dlp. Funcionan los enlaces de YouTube, Twitch y Kick (también en directo), sin límite de 5 minutos ni de espacio. Todo se guarda en tu ordenador: menú *Archivo → Abrir carpeta de datos*. Tus claves API se configuran en *Ajustes y claves*, igual que en la web.

**Compilar los instaladores:** se generan solos con GitHub Actions al crear una etiqueta (`git tag v0.2.0 && git push --tags`), o a mano en *Actions → App de escritorio → Run workflow* escribiendo la versión. Para probar en local: `npm install -D electron electron-builder` y después `npx electron-builder --config desktop/electron-builder.yml --linux dir`.

## Instalación en tu PC con Linux (espacio ilimitado)

Todo se guarda en tu disco: sin límite de espacio, sin el límite de 5 minutos de Vercel y renders más rápidos.

```bash
curl -fsSL https://raw.githubusercontent.com/AlanReyes9/Faceless-yt/main/deploy/install-linux.sh | bash
```

Opciones (añádelas con `bash -s --` al final):
- `--data /media/disco/faceless`: guarda los vídeos en otro disco
- `--tunnel`: dirección pública gratis con Cloudflare Tunnel para usarla desde el móvil
- `--port 3000`: puerto web

Por ejemplo: `curl -fsSL …/install-linux.sh | bash -s -- --tunnel`

El instalador instala Node 22 (sin sudo), ffmpeg y yt-dlp (en local sí funcionan los enlaces de YouTube). También crea la configuración con una clave aleatoria y un servicio que arranca solo al encender el PC. Para actualizar, vuelve a ejecutarlo.

## Almacenamiento gratuito con Cloudflare R2 (recomendado)

Vercel Blob cobra cada descarga, y los vídeos de móvil son muy pesados. **Cloudflare R2** ofrece 10 GB gratis y **descargas ilimitadas gratis**. También sirve cualquier almacenamiento compatible con S3 (Backblaze B2, MinIO…).

1. En Cloudflare: **R2 Object Storage** → **Create bucket** (por ejemplo `faceless-studio`).
2. **R2 → Manage API tokens → Create API token**: permiso **Object Read & Write** sobre ese bucket (o *Admin Read & Write* si quieres que la app configure CORS sola). Copia el *Access Key ID*, el *Secret Access Key* y el endpoint `https://<ID_DE_CUENTA>.r2.cloudflarestorage.com`.
3. En el bucket: **Settings → CORS policy** y pega (cambia el dominio por el tuyo):
   ```json
   [{"AllowedOrigins":["https://TU-APP.vercel.app"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag","Content-Length"],"MaxAgeSeconds":3600}]
   ```
4. En Vercel → Settings → Environment Variables añade `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` y `S3_SECRET_ACCESS_KEY` (para Backblaze B2 añade también `S3_REGION`, por ejemplo `us-west-004`). Después haz **Redeploy**.

**Limpieza automática:** para ahorrar espacio, los vídeos originales (y las fotos o clips subidos en anuncios y montajes) se borran 7 días después de terminar el proyecto. Se puede cambiar en *Ajustes y claves → Almacenamiento* (0 = nunca) o desactivar por proyecto con "Conservar original". Los Shorts y vídeos terminados se conservan siempre. No se borra nada de proyectos en proceso o con clips con error.

Si S3 está configurado, tiene prioridad sobre Vercel Blob. Los proyectos antiguos guardados en Blob siguen funcionando.

## Instalación local

Requisitos: Node.js ≥ 22.13, `ffmpeg` y, opcionalmente, `yt-dlp` para importar desde enlaces.

```bash
npm install
cp .env.example .env    # edita APP_PASSWORD y APP_SECRET
npm start               # http://localhost:3000
```

Después ve a **Ajustes y claves** y pega tus claves.

## Instalación en un VPS (Docker)

```bash
cp .env.example .env   # pon APP_PASSWORD, APP_SECRET y PUBLIC_URL=https://tu-dominio
docker compose up -d --build
```

Ponlo detrás de un proxy con HTTPS (Caddy, Nginx…). Los datos se guardan en `./data`.

## Conectar YouTube

1. En Google Cloud Console crea un proyecto y activa **YouTube Data API v3**.
2. Configura la pantalla de consentimiento OAuth (Externo) y añade tu correo como usuario de prueba.
3. Crea un **ID de cliente OAuth → Aplicación web** con la URI de redirección `https://tu-dominio/api/youtube/callback`.
4. Pega el Client ID y el Secret en *Ajustes y claves*. Después pulsa **Conectar YouTube** en *Mis canales*.

> Los proyectos de Google sin verificar suben los vídeos como privados hasta que superes la auditoría de la API de YouTube.

## Estructura

```
server/
  index.js        API REST y servidor de la web
  db.js           SQLite (node:sqlite)
  settings.js     claves API cifradas
  jobs.js         cola de renders
  youtube.js      OAuth y subida reanudable
  ai/llm.js       OpenAI / Claude / Gemini / OpenRouter
  ai/transcribe.js Whisper (OpenAI / Groq) con marcas por palabra
  ai/media.js     TTS, vídeos de stock (Pixabay/Pexels) e imágenes
  video/shorts.js pipeline de Shorts (selección de clips + render)
  video/longform.js pipeline de vídeo completo
  video/ass.js    subtítulos estilo Shorts
public/           interfaz (HTML/CSS/JS sin compilación)
```
