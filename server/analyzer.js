// Analizador de canales y vídeos de YouTube (datos públicos + diagnóstico con IA).
import { ytGet } from './youtube.js';
import { chatJSON } from './ai/llm.js';

const isoDur = s => { const m = String(s).match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function parseTarget(input) {
  const s = String(input).trim();
  const vid = s.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/)?.[1] || (/^[\w-]{11}$/.test(s) ? s : null);
  if (vid) return { type: 'video', id: vid };
  const handle = s.match(/@([\w.-]+)/)?.[1];
  if (handle) return { type: 'channel', handle };
  const cid = s.match(/(UC[\w-]{22})/)?.[1];
  if (cid) return { type: 'channel', id: cid };
  return { type: 'channel', handle: s.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^c\//, '').split(/[/?]/)[0] };
}

async function videosStats(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const r = await ytGet('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of r.items || []) out.push({
      id: v.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt, tags: v.snippet.tags || [],
      description: v.snippet.description, duration: isoDur(v.contentDetails.duration),
      views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0, comments: +v.statistics.commentCount || 0,
      thumbnail: v.snippet.thumbnails?.medium?.url,
    });
  }
  return out;
}

export async function analyzeChannel(input) {
  const t = parseTarget(input);
  if (t.type === 'video') return analyzeVideo(t.id);
  const ch = (await ytGet('channels', { part: 'snippet,statistics,contentDetails', ...(t.id ? { id: t.id } : { forHandle: t.handle }) })).items?.[0];
  if (!ch) throw new Error('No se encontró el canal. Prueba con la URL completa o el @usuario.');
  const uploads = ch.contentDetails.relatedPlaylists.uploads;
  const ids = [];
  let pageToken;
  for (let i = 0; i < 2; i++) { // últimos ~100 vídeos
    const pl = await ytGet('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    ids.push(...(pl.items || []).map(x => x.contentDetails.videoId));
    if (!(pageToken = pl.nextPageToken)) break;
  }
  const videos = await videosStats(ids);
  const shorts = videos.filter(v => v.duration <= 180), longs = videos.filter(v => v.duration > 180);
  const dates = videos.map(v => +new Date(v.publishedAt)).sort();
  const weeks = dates.length > 1 ? (dates.at(-1) - dates[0]) / (7 * 864e5) : 1;
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const byDay = {};
  for (const v of videos) { const d = days[new Date(v.publishedAt).getDay()]; (byDay[d] ||= []).push(v.views); }
  const stats = {
    channel: { id: ch.id, title: ch.snippet.title, description: ch.snippet.description, thumbnail: ch.snippet.thumbnails?.default?.url, country: ch.snippet.country,
      subscribers: +ch.statistics.subscriberCount || 0, views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0, created: ch.snippet.publishedAt },
    analyzed: videos.length,
    perWeek: +(videos.length / Math.max(1, weeks)).toFixed(1),
    shorts: { count: shorts.length, medianViews: median(shorts.map(v => v.views)) },
    longs: { count: longs.length, medianViews: median(longs.map(v => v.views)) },
    bestDays: Object.entries(byDay).map(([d, a]) => ({ day: d, medianViews: median(a), count: a.length })).sort((a, b) => b.medianViews - a.medianViews),
    top: [...videos].sort((a, b) => b.views - a.views).slice(0, 8),
    recent: videos.slice(0, 8),
  };
  const ai = await chatJSON('Eres un consultor experto en crecimiento de canales de YouTube, especialmente canales faceless.',
    `Analiza este canal y da un diagnóstico accionable en español.
Canal: ${stats.channel.title} (${stats.channel.subscribers} suscriptores, ${stats.channel.videos} vídeos)
Descripción: ${stats.channel.description.slice(0, 500)}
Frecuencia: ${stats.perWeek} vídeos/semana. Shorts: ${stats.shorts.count} (mediana ${stats.shorts.medianViews} vistas). Largos: ${stats.longs.count} (mediana ${stats.longs.medianViews}).
Top vídeos: ${stats.top.map(v => `"${v.title}" ${v.views} vistas`).join('; ')}
Recientes: ${stats.recent.map(v => `"${v.title}" ${v.views} vistas`).join('; ')}
JSON: {"summary":"resumen en 2-3 frases","niche":"nicho detectado","strengths":["..."],"weaknesses":["..."],"title_patterns":["patrones de los títulos que funcionan"],"recommendations":["acciones concretas"],"video_ideas":["8 ideas de vídeos nuevos basadas en lo que funciona"],"faceless_score":"1-10 qué tan replicable es como canal faceless y por qué"}`,
    { maxTokens: 4000 });
  return { kind: 'channel', target: stats.channel.title, stats, ai };
}

export async function analyzeVideo(id) {
  const [v] = await videosStats([id]);
  if (!v) throw new Error('No se encontró el vídeo.');
  let comments = [];
  try {
    const c = await ytGet('commentThreads', { part: 'snippet', videoId: id, maxResults: 60, order: 'relevance', textFormat: 'plainText' });
    comments = (c.items || []).map(x => x.snippet.topLevelComment.snippet.textDisplay.slice(0, 200));
  } catch {}
  const ageDays = Math.max(1, (Date.now() - new Date(v.publishedAt)) / 864e5);
  const stats = { video: v, viewsPerDay: Math.round(v.views / ageDays), likeRate: v.views ? +(v.likes / v.views * 100).toFixed(2) : 0, commentRate: v.views ? +(v.comments / v.views * 100).toFixed(3) : 0 };
  const ai = await chatJSON('Eres un consultor experto en YouTube: títulos, miniaturas, SEO, retención y comunidad.',
    `Analiza este vídeo en español.
Título: ${v.title}
Duración: ${v.duration}s · ${v.views} vistas · ${stats.viewsPerDay}/día · likes ${stats.likeRate}% · comentarios ${stats.commentRate}%
Etiquetas: ${v.tags.join(', ')}
Descripción: ${v.description.slice(0, 800)}
Comentarios destacados: ${comments.slice(0, 40).join(' || ')}
JSON: {"summary":"...","title_score":"1-10","better_titles":["5 títulos alternativos"],"seo":["mejoras de descripción/etiquetas"],"audience_sentiment":"qué opina la audiencia","audience_requests":["lo que piden en comentarios"],"shorts_ideas":["5 ideas de Shorts derivados"],"recommendations":["..."]}`,
    { maxTokens: 3000 });
  return { kind: 'video', target: v.title, stats, ai };
}
