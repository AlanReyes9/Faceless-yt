import fs from 'node:fs';
import { db } from './db.js';
import { getSetting, requireKey } from './settings.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const redirectUri = req => `${process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`}/api/youtube/callback`;

export function authUrl(req, channelId) {
  const q = new URLSearchParams({
    client_id: requireKey('google_client_id', 'conectar YouTube'),
    redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state: String(channelId),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

async function token(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireKey('google_client_id'), client_secret: requireKey('google_client_secret', 'conectar YouTube'), ...params,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google OAuth: ${j.error_description || j.error || r.status}`);
  return j;
}

export async function handleCallback(req) {
  const { code, state } = req.query;
  const t = await token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: 'Bearer ' + t.access_token } });
  const ch = (await r.json()).items?.[0];
  db.prepare('UPDATE channels SET yt_refresh_token = ?, yt_channel_id = ?, yt_title = ? WHERE id = ?')
    .run(t.refresh_token || null, ch?.id || null, ch?.snippet?.title || null, Number(state));
}

async function accessToken(channelId) {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!ch?.yt_refresh_token) throw new Error('Este canal no está conectado a YouTube. Conéctalo en "Mis canales".');
  return (await token({ refresh_token: ch.yt_refresh_token, grant_type: 'refresh_token' })).access_token;
}

/** Sube un vídeo con subida reanudable. publishAt (ISO) programa la publicación. */
export async function uploadVideo(channelId, file, { title, description = '', tags = [], privacy = 'public', publishAt } = {}) {
  const at = await accessToken(channelId);
  const meta = {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), tags, categoryId: '22' },
    status: { privacyStatus: publishAt ? 'private' : privacy, selfDeclaredMadeForKids: false, ...(publishAt ? { publishAt } : {}) },
  };
  const size = fs.statSync(file).size;
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + at, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': String(size) },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`YouTube (${init.status}): ${(await init.text()).slice(0, 300)}`);
  const up = await fetch(init.headers.get('location'), {
    method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
    body: fs.createReadStream(file), duplex: 'half',
  });
  const j = await up.json();
  if (!up.ok) throw new Error(`YouTube (${up.status}): ${j.error?.message || JSON.stringify(j).slice(0, 300)}`);
  return j.id;
}

export const youtubeConfigured = () => !!(getSetting('google_client_id') && getSetting('google_client_secret'));
