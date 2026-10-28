// 配料台: local web app. 立创商城 stock for every BOM line, then 淘宝 / 闲鱼 for what 立创 cannot supply.
//   node src/server.js            http://127.0.0.1:18790
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, parseBom } from './bom.js';
import { lookup } from './lcsc.js';
import * as market from './market.js';
import * as favorites from './favorites.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 18790);
const EDA_BRIDGE = process.env.EDA_BRIDGE || 'http://127.0.0.1:9151';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

async function readBody(req, limit = 5_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('请求过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function edaTool(name, args = {}) {
  const r = await fetch(`${EDA_BRIDGE}/v1/tools/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(120000) });
  const body = await r.json();
  if (!body.ok) throw new Error(body.error?.message || `${name} 调用失败`);
  return body.data;
}

async function edaConnected() {
  try {
    const r = await fetch(`${EDA_BRIDGE}/v1/status`, { signal: AbortSignal.timeout(1500) });
    return Boolean((await r.json())?.bridge?.connected);
  } catch { return false; }
}

async function bomFromEda() {
  const dir = path.join(ROOT, 'runs', 'eda');
  await mkdir(dir, { recursive: true });
  const out = await edaTool('jlc.pcb.export', { kind: 'bom', fileType: 'csv', savePath: dir, fileName: 'eda_bom' });
  return parseBom(decode(await readFile(out.savedTo)));
}

function verdict(stock, markets) {
  const found = markets.some(m => m.best);
  if (stock.status === 'ok') return 'ok';
  if (stock.status === 'short') return found ? 'short-fill' : 'short';
  return found ? 'market' : 'none';
}

// NDJSON stream: one object per line so the page can fill the table as results arrive.
async function match(req, res) {
  const { lines = [], platforms = [], scope = 'missing', passives = false } = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  let gone = false;
  res.on('close', () => { gone = true; });
  const send = obj => { if (!gone) res.write(JSON.stringify(obj) + '\n'); };

  const usable = [];
  for (const p of platforms) if (market.PLATFORMS[p] && (await market.status(p, { wake: true })).state === 'in') usable.push(p);
  send({ type: 'start', total: lines.length, platforms: usable, skippedPlatforms: platforms.filter(p => !usable.includes(p)) });

  for (const line of lines) {
    if (gone) break;
    let stock;
    try { stock = await lookup(line); } catch (e) { stock = { status: 'error', error: String(e.message ?? e) }; }
    send({ type: 'stock', id: line.id, stock });
    const query = line.query || stock.model || '';
    const wanted = stock.status !== 'error' && query.length >= 3 && (scope === 'all' ? !line.passive || passives : stock.status !== 'ok' && (!line.passive || passives));
    const markets = [];
    if (wanted) {
      for (const p of usable) {
        if (gone) break;
        send({ type: 'searching', id: line.id, platform: p });
        try { markets.push(await market.searchPart(p, query, line.qty)); }
        catch (e) { markets.push({ platform: p, error: String(e.message ?? e).split('\n')[0] }); }
        send({ type: 'market', id: line.id, result: markets.at(-1) });
      }
    }
    send({ type: 'line', id: line.id, verdict: stock.status === 'error' ? 'error' : verdict(stock, markets), wanted });
  }
  send({ type: 'done' });
  res.end();
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (p === '/api/state') {
      const [xianyu, taobao, eda] = await Promise.all([market.status('xianyu'), market.status('taobao'), edaConnected()]);
      return json(res, 200, { browser: market.browserOpen(), platforms: { xianyu, taobao }, imported: existsSync(path.join(ROOT, '.secrets', 'imported-cookies.json')), eda });
    }
    const login = p.match(/^\/api\/login\/(xianyu|taobao)\/qr$/);
    if (login) {
      const out = await market.loginQr(login[1], { again: url.searchParams.get('again') === '1' });
      if (out.png) {
        const left = Math.max(0, Math.round((out.issuedAt + out.maxAgeMs - Date.now()) / 1000));
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-qr-id': String(out.issuedAt), 'x-qr-seconds-left': String(left) });
        return res.end(out.png);
      }
      return json(res, 200, out);
    }
    const cancel = p.match(/^\/api\/login\/(xianyu|taobao)\/cancel$/);
    if (cancel && req.method === 'POST') { await market.cancelRelogin(cancel[1]); return json(res, 200, { ok: true }); }
    if (p === '/api/cookies/import' && req.method === 'POST') {
      const n = await market.importSavedCookies();
      return json(res, 200, { imported: n, platforms: { xianyu: await market.status('xianyu'), taobao: await market.status('taobao') } });
    }
    if (p === '/api/bom/parse' && req.method === 'POST') return json(res, 200, { lines: parseBom(decode(await readBody(req))) });
    if (p === '/api/bom/eda') return json(res, 200, { lines: await bomFromEda() });
    if (p === '/api/match' && req.method === 'POST') return await match(req, res);
    const detail = p.match(/^\/api\/detail\/taobao\/(\d+)$/);
    if (detail) return json(res, 200, await market.taobaoDetail(detail[1]));
    if (p === '/api/favorites' && req.method === 'GET') return json(res, 200, { favorites: await favorites.all() });
    if (p === '/api/favorites' && req.method === 'POST') return json(res, 200, { favorite: await favorites.add(JSON.parse((await readBody(req)).toString('utf8') || '{}')), favorites: await favorites.all() });
    const fav = p.match(/^\/api\/favorites\/([a-z0-9]+)$/);
    if (fav && req.method === 'DELETE') { await favorites.remove(fav[1]); return json(res, 200, { favorites: await favorites.all() }); }
    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: 'not found' });
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    if (!res.headersSent) json(res, 500, { error: String(e.message ?? e).split('\n')[0] }); else res.end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`配料台 http://127.0.0.1:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await market.shutdown(); process.exit(0); });
