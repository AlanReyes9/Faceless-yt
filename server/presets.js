// Mis plantillas: estilo de subtítulos, texto fijo, letra, color, imagen, vídeo final, edición automática y marca (logo/marco),
// guardados con un nombre para aplicarlos al crear clips o a varios clips a la vez. Varias plantillas = varias marcas.
import crypto from 'node:crypto';
import { getSetting, setSettings } from './settings.js';
import { getBrand } from './brand.js';
import { publicUrl } from './storage.js';

export const PRESET_KEYS = ['captions', 'font', 'titleBar', 'hookOn', 'emojis', 'grade', 'adjust', 'mirror', 'motion', 'speed', 'format', 'outro', 'autocut', 'brand'];

export async function getPresets() {
  try { const v = JSON.parse(await getSetting('style_presets') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
const save = list => setSettings({ style_presets: JSON.stringify(list) });
export const presetOut = p => ({ ...p, brandProfile: p.brandProfile ? { ...p.brandProfile, logoUrl: p.brandProfile.logo ? publicUrl(p.brandProfile.logo) : null, frameUrl: p.brandProfile.frame ? publicUrl(p.brandProfile.frame) : null } : null });

/** Guarda una plantilla con los ajustes de un clip (edit) y, si se pide, la marca actual de Ajustes. */
export async function addPreset({ name, edit, withBrand = true }) {
  const look = {};
  for (const k of PRESET_KEYS) if (edit?.[k] !== undefined) look[k] = edit[k];
  if (look.titleBar) look.titleBar = { ...look.titleBar, text: '' };
  if (JSON.stringify(look).length > 20000) throw new Error('La plantilla es demasiado grande.');
  let brandProfile = null;
  if (withBrand) { const b = await getBrand(); if (b.logo || b.frame) brandProfile = { logo: b.logo, frame: b.frame, pos: b.pos, size: b.size, opacity: b.opacity }; }
  const list = await getPresets();
  if (list.length >= 30) throw new Error('Tienes 30 plantillas (el máximo): borra alguna.');
  const p = { id: crypto.randomBytes(4).toString('hex'), name: String(name || 'Mi plantilla').trim().slice(0, 40) || 'Mi plantilla', edit: look, brandProfile, at: new Date().toISOString() };
  await save([...list, p]);
  return p;
}
export async function removePreset(id) { await save((await getPresets()).filter(p => p.id !== id)); }
export async function renamePreset(id, name) {
  const list = await getPresets();
  const p = list.find(x => x.id === id); if (!p) throw new Error('Plantilla no encontrada.');
  p.name = String(name || p.name).trim().slice(0, 40) || p.name;
  await save(list);
  return p;
}

/** Ajustes resultantes de aplicar la plantilla a un clip (conserva encuadre, recortes y textos propios del clip). */
export async function presetEditFor(id, clip) {
  const p = (await getPresets()).find(x => x.id === id);
  if (!p) return null;
  const prev = clip.edit || {};
  const edit = { ...prev, ...structuredClone(p.edit) };
  if (edit.titleBar) edit.titleBar = { ...edit.titleBar, text: prev.titleBar?.text || '' };
  if (p.brandProfile) { edit.brandProfile = p.brandProfile; edit.brand = true; } else delete edit.brandProfile;
  return edit;
}
