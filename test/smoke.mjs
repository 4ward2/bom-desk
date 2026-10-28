// Smoke test against a running server: BOM parsing, then a stock-only match for a short list.
//   node test/smoke.mjs [bom-file]
import { readFile } from 'node:fs/promises';
const base = process.env.BOM_DESK || 'http://127.0.0.1:18790';
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', body, headers });

console.log('state', JSON.stringify(await (await fetch(base + '/api/state')).json()));
if (process.argv[2]) {
  const parsed = await (await post('/api/bom/parse', await readFile(process.argv[2]))).json();
  console.log('file ->', parsed.lines.map(l => `${l.mpn}|${l.lcsc}|x${l.qty}|${l.designator}|passive=${l.passive}`).join('  ;  '));
}
const list = 'TC358870XBG x1\nTPS65632RTER x20\nC2040, 3\nNOSUCHPART9999ZZ\n0603WAF1001T5E 10\nRT4720A';
const { lines } = await (await post('/api/bom/parse', list)).json();
console.log('list ->', lines.map(l => `${l.mpn || l.lcsc} x${l.qty} passive=${l.passive}`).join(' ; '));
const res = await post('/api/match', JSON.stringify({ lines, platforms: process.env.PLATFORMS ? process.env.PLATFORMS.split(',') : [], scope: 'missing' }), { 'content-type': 'application/json' });
for (const row of (await res.text()).trim().split('\n').map(JSON.parse)) {
  if (row.type === 'stock') console.log(`  #${row.id} ${row.stock.status} ${row.stock.code ?? ''} ${row.stock.model ?? ''} stock=${row.stock.stock ?? '-'} ¥${row.stock.unitPrice ?? '-'}`);
  else if (row.type === 'market') console.log(`  #${row.id} ${row.result.platform}: ${row.result.error ?? (row.result.best ? `¥${row.result.best.landedCny} ${row.result.best.title.slice(0, 40)}` : `no match of ${row.result.scanned}`)}`);
  else if (row.type !== 'searching') console.log(' ', JSON.stringify(row));
}
