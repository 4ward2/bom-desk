// Live run against the running service: every listed part is searched on both platforms (scope "all").
//   node test/live.mjs "TPS65632RTER x2" "RT4720A" ...
const base = process.env.BOM_DESK || 'http://127.0.0.1:18790';
const list = process.argv.slice(2).join('\n') || 'RT4720A x2';
const { lines } = await (await fetch(base + '/api/bom/parse', { method: 'POST', body: list })).json();
const res = await fetch(base + '/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines, platforms: ['taobao', 'xianyu'], scope: 'all' }) });
const name = id => lines.find(l => l.id === id)?.query;
for (const ev of (await res.text()).trim().split('\n').map(JSON.parse)) {
  if (ev.type === 'start') console.log('platforms in use:', ev.platforms.join(', ') || 'none', '| skipped:', ev.skippedPlatforms.join(', ') || 'none');
  if (ev.type === 'stock') console.log(`\n### ${name(ev.id)}  立创: ${ev.stock.status} ${ev.stock.code ?? ''} stock=${ev.stock.stock ?? '-'}`);
  if (ev.type === 'line') console.log(`  => verdict ${ev.verdict}`);
  if (ev.type !== 'market') continue;
  const m = ev.result;
  if (m.error) { console.log(`  [${m.platform}] ERROR ${m.error}`); continue; }
  console.log(`  [${m.platform}] scanned ${m.scanned}, matched ${m.count}, wanted-only dropped ${m.wantedOnly}, not-real ${m.notRealCount}, median ¥${m.median ?? '-'}, best ${m.best ? '¥' + m.best.landedCny : 'none'}`);
  for (const x of m.listings.slice(0, 8)) {
    const marks = [x.notReal.length ? 'NOT-REAL(' + x.notReal.join('; ') + ')' : '', x.risks.join(','), x.buysToo ? '连收带卖' : '', x.sellerChecked ? `shelf-checked(在售${x.sellerOnSale ?? '?'})` : ''].filter(Boolean).join(' ');
    console.log(`     ¥${x.price} 到手¥${x.landedCny} | img=${x.image ? 'y' : 'n'} | ${x.seller || '-'} | ${x.title.replace(/\s+/g, ' ').slice(0, 46)} ${marks ? '| ' + marks : ''}`);
  }
}
