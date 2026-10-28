// Drive the page in a headless Edge and save screenshots to runs/ui/: result table, then each QR dialog.
//   node test/ui_shot.mjs [qr]      pass "qr" to also open the 淘宝 and 闲鱼 scan dialogs (starts the app's Edge window)
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs', 'ui');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(process.env.BOM_DESK || 'http://127.0.0.1:18790/');
await page.click('#fromSample');
await page.waitForFunction(() => document.querySelector('#lineCount').textContent.length > 0);
await page.screenshot({ path: path.join(out, '1_intake.png') });
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#run').textContent === '重新配料', null, { timeout: 180000 });
await page.screenshot({ path: path.join(out, '2_result.png'), fullPage: true });
console.log('tiles', await page.$$eval('.tile', ts => ts.map(t => t.innerText.replace(/\s+/g, ' ')).join(' | ')));
if (process.argv[2] === 'qr') {
  for (const platform of ['taobao', 'xianyu']) {
    await page.click(`.platform.${platform} [data-role=login]`);
    const got = await page.waitForSelector('#qrBox img', { timeout: 60000 }).then(() => true, () => false);
    console.log(platform, 'qr image shown:', got, '|', await page.textContent('#scanState'));
    await page.screenshot({ path: path.join(out, `3_qr_${platform}.png`) });
    await page.click('#dlgClose');
  }
}
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
