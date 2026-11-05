# Faceless Studio

Estudio web propio para canales de YouTube *faceless* (sin mostrar la cara). Funciona con **tus propias claves API**: solo pagas lo que uses en cada proveedor.

## Qué hace

| Sección | Función |
|---|---|
| **Convertir a Shorts** | Subes un vídeo largo (o pegas un enlace). Se transcribe con Whisper y la IA elige los mejores momentos, con nota del 1 al 10 y una frase de gancho. Se renderiza cada Short en 1080×1920 con **fondo difuminado** o recorte, el gancho arriba durante 4 s y subtítulos palabra a palabra. Puedes ajustar inicio/fin ±1 s, editar el gancho, *Aplicar cambios*, traducir a otro idioma, publicar en YouTube o descargar un **.zip**. |
| **Vídeo completo** | Tema → guion con IA (editable) → voz en off (OpenAI TTS / ElevenLabs) → vídeos de stock de Pexels → subtítulos → MP4 horizontal o vertical. |
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
- **Stock:** Pexels (gratis)
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
  ai/media.js     TTS y Pexels
  video/shorts.js pipeline de Shorts (selección de clips + render)
  video/longform.js pipeline de vídeo completo
  video/ass.js    subtítulos estilo Shorts
public/           interfaz (HTML/CSS/JS sin compilación)
```
