// Poll the login-code endpoint the way the dialog does and report when the code is replaced.
//   node test/qr_refresh.mjs <platform> [seconds]     run the server with a short QR_MAX_AGE_MS to see a refresh quickly
import { createHash } from 'node:crypto';
const base = process.env.BOM_DESK || 'http://127.0.0.1:18790';
const platform = process.argv[2] || 'xianyu';
const until = Date.now() + Number(process.argv[3] || 45) * 1000;
let lastId = null, lastHash = null, renewals = 0;
while (Date.now() < until) {
  const r = await fetch(`${base}/api/login/${platform}/qr`);
  if (r.headers.get('content-type').startsWith('image/')) {
    const id = r.headers.get('x-qr-id');
    const hash = createHash('sha1').update(Buffer.from(await r.arrayBuffer())).digest('hex').slice(0, 10);
    const renewed = lastId && id !== lastId;
    if (renewed) renewals++;
    console.log(`png ${hash} left=${r.headers.get('x-qr-seconds-left')}s${renewed ? `  <- new code (image ${hash === lastHash ? 'UNCHANGED' : 'changed'})` : ''}`);
    lastId = id; lastHash = hash;
  } else console.log('json', JSON.stringify(await r.json()));
  await new Promise(res => setTimeout(res, 3000));
}
console.log('renewals seen:', renewals);
