// 立创商城 stock and price for a BOM line, through the anonymous product search that 嘉立创EDA itself uses.

const API = 'https://pro.lceda.cn/api/eda/product/search';
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) bom-desk/0.1', accept: 'application/json' };
const cache = new Map();
let lastCall = 0;

// One request at a time, 400 ms apart: the endpoint sits behind a WAF that cools down hard on bursts.
let chain = Promise.resolve();
function paced(fn) {
  const run = chain.then(async () => {
    const wait = lastCall + 400 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); } finally { lastCall = Date.now(); }
  });
  chain = run.catch(() => {});
  return run;
}

export const normalizeMpn = s => String(s || '').toUpperCase().replace(/\(.*?\)/g, '').replace(/[\s\-_/.,]+/g, '');

async function search(keyword) {
  if (cache.has(keyword) && Date.now() - cache.get(keyword).at < 10 * 60_000) return cache.get(keyword).list;
  const list = await paced(async () => {
    const r = await fetch(`${API}?keyword=${encodeURIComponent(keyword)}&currPage=1&pageSize=10`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`立创商城查询失败 (${r.status})`);
    const body = await r.json();
    return body?.result?.productList || [];
  });
  cache.set(keyword, { at: Date.now(), list });
  return list;
}

function unitPrice(priceList, qty) {
  const tiers = (priceList || []).filter(t => t.price > 0).sort((a, b) => a.startNumber - b.startNumber);
  if (!tiers.length) return null;
  const tier = [...tiers].reverse().find(t => qty >= t.startNumber) ?? tiers[0];
  return tier.price;
}

const shape = (p, qty) => ({
  code: p.code, model: p.model, brand: p.brandName || '', pkg: p.standard || '', name: p.name || '',
  stock: Number(p.stockNumber) || 0, unitPrice: unitPrice(p.priceList, qty), minOrder: (p.priceList || [])[0]?.startNumber ?? 1,
  smt: p['JLCPCB Part Class'] || '', url: `https://item.szlcsc.com/${p.id}.html`,
});

// status: ok (stock covers qty) | short (some stock, not enough) | out (listed, zero stock) | unlisted
export async function lookup({ lcsc, mpn, qty = 1 }) {
  const code = String(lcsc || '').trim().toUpperCase();
  let picked = null, others = [];
  if (/^C\d+$/.test(code)) {
    picked = (await search(code)).find(p => String(p.code).toUpperCase() === code) ?? null;
  }
  if (!picked && mpn) {
    const want = normalizeMpn(mpn);
    const list = (await search(String(mpn).trim())).filter(p => p.model);
    const exact = list.filter(p => normalizeMpn(p.model) === want);
    const prefix = list.filter(p => normalizeMpn(p.model).startsWith(want) || want.startsWith(normalizeMpn(p.model)));
    // Several C-numbers can carry one part number (reel vs cut tape); take the one with stock.
    const pool = (exact.length ? exact : prefix).sort((a, b) => Number(b.stockNumber) - Number(a.stockNumber));
    picked = pool[0] ?? null;
    others = pool.slice(1, 4);
  }
  if (!picked) return { status: 'unlisted' };
  const part = shape(picked, qty);
  const status = part.stock >= qty ? 'ok' : part.stock > 0 ? 'short' : 'out';
  return { status, ...part, alternates: others.map(p => shape(p, qty)) };
}
