// Shops the user trusts. Kept locally in data/favorites.json; nothing is followed on the platforms themselves.
// An entry matches a listing by seller key (stable id from the platform) or, when added by hand, by a piece
// of the shop name, so "优信电子" can be favourited before it ever shows up in a result.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'favorites.json');
let list = null;

async function load() {
  if (!list) list = await readFile(FILE, 'utf8').then(JSON.parse, () => []);
  return list;
}
async function save() {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(list, null, 1));
}

export const all = () => load();

export async function add({ platform, name, key = '', url = '' }) {
  name = String(name || '').trim();
  if (!['taobao', 'xianyu'].includes(platform) || !name) throw new Error('需要平台和商家名');
  const items = await load();
  const same = items.find(f => f.platform === platform && (key ? f.key === key : !f.key && f.name === name));
  if (same) return same;
  const entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), platform, name, key, url, addedAt: new Date().toISOString() };
  items.push(entry);
  await save();
  return entry;
}

export async function remove(id) {
  const items = await load();
  list = items.filter(f => f.id !== id);
  await save();
}

// The favourite a listing belongs to, or null.
export function match(favorites, platform, listing) {
  const sellerName = String(listing.seller || '');
  return favorites.find(f => f.platform === platform && (
    (f.key && f.key === listing.sellerKey) || (!f.key && sellerName && sellerName.includes(f.name))
  )) ?? null;
}
