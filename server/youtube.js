import crypto from 'node:crypto';
import { q, one } from './db.js';
import { getSetting, requireKey, internalSecret } from './settings.js';
import { readStream, fileSize } from './storage.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const baseUrl = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
const redirectUri = req => `${baseUrl(req)}/api/youtube/callback`;
const signState = id => `${id}.${crypto.createHmac('sha256', internalSecret()).update(String(id)).digest('hex').slice(0, 16)}`;

export async function authUrl(req, channelId) {
  const qs = new URLSearchParams({
    client_id: await requireKey('google_client_id', 'conectar YouTube'),
    redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state: signState(channelId),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + qs;
}

async function token(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: await requireKey('google_client_id'), client_secret: await requireKey('google_client_secret', 'conectar YouTube'), ...params,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google OAuth: ${j.error_description || j.error || r.status}`);
  return j;
}

export async function handleCallback(req) {
  const { code, state = '' } = req.query;
  const id = String(state).split('.')[0];
  if (signState(id) !== state) throw new Error('Estado OAuth no válido.');
  const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: 'Bearer ' + t.access_token } });
  const ch = (await r.json()).items?.[0];
  await q('UPDATE channels SET yt_refresh_token = $1, yt_channel_id = $2, yt_title = $3 WHERE id = $4',
    [t.refresh_token || null, ch?.id || null, ch?.snippet?.title || null, Number(id)]);
}

async function accessToken(channelId) {
  const ch = await one('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (!ch?.yt_refresh_token) throw new Error('Este canal no está conectado a YouTube. Conéctalo en "Mis canales".');
  return (await token({ refresh_token: ch.yt_refresh_token, grant_type: 'refresh_token' })).access_token;
}

/** Sube un vídeo (referencia de almacenamiento) con subida reanudable. publishAt (ISO) programa la publicación. */
export async function uploadVideo(channelId, ref, { title, description = '', tags = [], privacy = 'public', publishAt } = {}) {
  const at = await accessToken(channelId);
  const meta = {
    snippet: { title: String(title).slice(0, 100), description: String(description).slice(0, 5000), tags, categoryId: '22' },
    status: { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, ...(publishAt ? { publishAt } : {}) },
  };
  const size = await fileSize(ref);
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', ...(size ? { 'x-upload-content-length': String(size) } : {}) },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`YouTube (${init.status}): ${(await init.text()).slice(0, 300)}`);
  const up = await fetch(init.headers.get('location'), {
    method: 'PUT', headers: { 'content-type': 'video/mp4', ...(size ? { 'content-length': String(size) } : {}) },
    body: await readStream(ref), duplex: 'half',
  });
  const j = await up.json();
  if (!up.ok) throw new Error(`YouTube (${up.status}): ${j.error?.message || JSON.stringify(j).slice(0, 300)}`);
  return j.id;
}

export const youtubeConfigured = async () => !!((await getSetting('google_client_id')) && (await getSetting('google_client_secret')));

/** GET a la YouTube Data API usando la API key, o el token de un canal conectado. */
export async function ytGet(pathname, params) {
  const key = await getSetting('youtube_api_key');
  const headers = {};
  const qs = new URLSearchParams(params);
  if (key) qs.set('key', key);
  else {
    const ch = await one('SELECT id FROM channels WHERE yt_refresh_token IS NOT NULL LIMIT 1');
    if (!ch) throw new Error('Añade una "YouTube Data API key" en Ajustes y claves (o conecta un canal) para usar el Analizador.');
    headers.authorization = 'Bearer ' + await accessToken(ch.id);
  }
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${pathname}?${qs}`, { headers });
  const j = await r.json();
  if (!r.ok) throw new Error(`YouTube API (${r.status}): ${j.error?.message || 'error'}`);
  return j;
}
