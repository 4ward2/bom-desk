// Run one part through the page with both platforms and screenshot the expanded listing detail (runs/ui/).
//   node test/ui_detail.mjs "TPS65632RTER x2"
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runs', 'ui');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto(process.env.BOM_DESK || 'http://127.0.0.1:18790/');
await page.fill('#bomText', process.argv[2] || 'TPS65632RTER x2');
await page.check('[name=scope][value=all]');
await page.waitForFunction(() => document.querySelector('#lineCount').textContent.length > 0);
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#run').textContent === '重新配料', null, { timeout: 300000 });
await page.locator('#rows button.link').first().click();
await page.waitForSelector('.listing img');
await page.waitForTimeout(2500);  // thumbnails
const shot = async name => (await page.locator('#result').screenshot({ path: path.join(out, name) }));
await shot('4_detail_hide_notreal.png');
console.log('cards (non-real hidden):', await page.locator('.listing').count(), '| images loaded:', await page.locator('.listing img').evaluateAll(imgs => imgs.filter(i => i.naturalWidth > 0).length));
await page.uncheck('#hideNotReal');
await page.waitForTimeout(1500);
await shot('5_detail_show_notreal.png');
console.log('cards (non-real shown):', await page.locator('.listing').count(), '| flagged:', await page.locator('.listing .tag.warn').count());
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
