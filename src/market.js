// 闲鱼 / 淘宝 session and search, driven through one persistent Edge profile owned by this app.
// The profile keeps the login between runs. The browser is headless and never shown: login is by QR scan
// in the app's own dialog, and a risk-control challenge is reported, not worked around.
// Nothing here orders, chats or pays.
import { chromium } from 'playwright-core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreListing } from './listing_rules.js';
import { isWantedOnly, isBuyAndSell, notRealByText, uniformPricing } from './listing_flags.js';
import * as favorites from './favorites.js';
import { readImages, findLinks } from './extract.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = process.env.BOM_DESK_PROFILE || path.join(ROOT, '.profile');
const IMPORTED = path.join(ROOT, '.secrets', 'imported-cookies.json');
const LAST_STATE = path.join(ROOT, 'runs', 'login-state.json');
const XIANYU_SEARCH_API = '/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';

export const PLATFORMS = {
  xianyu: {
    label: '闲鱼',
    app: '闲鱼 App',
    loginUrl: 'https://www.goofish.com/',
    cookieUrl: 'https://www.goofish.com',
    qrFrame: f => f.url().includes('passport.goofish.com/mini_login'),
  },
  taobao: {
    label: '淘宝',
    app: '淘宝 App',
    loginUrl: 'https://login.taobao.com/havanaone/login/login.htm?bizName=taobao&redirectURL=https%3A%2F%2Fwww.taobao.com%2F',
    cookieUrl: 'https://www.taobao.com',
    qrFrame: f => f === f.page().mainFrame(),
  },
};

// A session is one cookie jar plus the login pages opened in it. `main` is the persistent profile that
// searches run in. "Log in again" gets a throwaway session of its own, so the code on screen belongs to a
// clean jar: abandon it and the main login is untouched, finish it and its cookies replace the main ones.
// 淘宝's result list never loads for a browser that reports navigator.webdriver, so that marker is left off.
const LAUNCH = { channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled'], ignoreDefaultArgs: ['--enable-automation'] };
const CONTEXT = { viewport: { width: 1280, height: 860 }, locale: 'zh-CN' };
const COOKIE_DOMAINS = { taobao: /(^|\.)(taobao|tmall)\.com$/, xianyu: /(^|\.)goofish\.com$/ };
const newSession = ctx => ({ ctx, loginPages: {}, qrIssuedAt: {}, settling: new Set(), xianyuProbe: null });

// 闲鱼 keeps its login (cookie2, unb, _tb_token_, csg) in session cookies, and the profile drops those every
// time the browser closes - that is, every time the editor quits - so each start asked for a new scan.
// Store them again with an expiry: they then sit in the profile's own (DPAPI-encrypted) cookie store like
// 淘宝's do. The site still decides when the session ends; a pinned cookie only outlives the browser.
// Chromium writes cookie changes to disk in batches about every 30 s, so pin as soon as a login is seen.
const PIN_DAYS = Number(process.env.BOM_DESK_PIN_DAYS || 30);
async function pinSessionCookies(ctx) {
  const loose = (await ctx.cookies()).filter(c => c.expires === -1 && Object.values(COOKIE_DOMAINS).some(re => re.test(c.domain)));
  if (!loose.length) return 0;
  const expires = Math.floor(Date.now() / 1000) + PIN_DAYS * 86400;
  await ctx.addCookies(loose.map(c => ({ ...c, expires })));
  return loose.length;
}

let mainPromise = null;
let desktopUa = null;
const relogin = {};  // platform -> { browser, session }
const cache = new Map();
// Both sites push back on parallel page loads from one profile; run browser work one at a time.
let chain = Promise.resolve();
const serial = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

function mainSession() {
  if (!mainPromise) {
    mainPromise = (async () => {
      // Headless: no browser window ever appears; the login code is shown in the app's own dialog.
      // Both sites turn away a browser that announces itself as headless, so the stock Edge UA is kept.
      const launch = userAgent => chromium.launchPersistentContext(PROFILE, { ...LAUNCH, ...CONTEXT, ...(userAgent ? { userAgent } : {}) });
      let ctx = await launch(desktopUa);
      if (!desktopUa) {
        const page = ctx.pages()[0] ?? await ctx.newPage();
        const ua = await page.evaluate(() => navigator.userAgent);
        desktopUa = ua.replace(/Headless/g, '');
        if (ua !== desktopUa) { await ctx.close(); ctx = await launch(desktopUa); }
      }
      ctx.on('close', () => { mainPromise = null; });
      return newSession(ctx);
    })();
    mainPromise.catch(() => { mainPromise = null; });
  }
  return mainPromise;
}
const context = async () => (await mainSession()).ctx;

export function browserOpen() { return Boolean(mainPromise); }

export async function importSavedCookies() {
  const saved = JSON.parse(await readFile(IMPORTED, 'utf8'));
  const ctx = await context();
  await ctx.addCookies(saved.cookies || []);
  return (saved.cookies || []).length;
}

async function nickname(ctx, platform) {
  const jar = await ctx.cookies(PLATFORMS[platform].cookieUrl);
  const raw = jar.find(c => c.name === 'tracknick')?.value || jar.find(c => c.name === '_nk_')?.value || '';
  try { return decodeURIComponent(raw.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))); } catch { return raw; }
}

// Ask the site itself rather than trusting cookie presence: an expired jar still carries tracknick.
async function loggedIn(session, platform) {
  const { ctx } = session;
  if (platform === 'taobao') {
    const r = await ctx.request.fetch('https://i.taobao.com/my_itaobao', { maxRedirects: 0, timeout: 20000 });
    return r.status() === 200;
  }
  // 闲鱼 has no plain endpoint for this (passport's hasLogin.do answers "expired" even for a live session),
  // so go by what its own page does: logged out, it puts up the passport login frame.
  const hasUid = (await ctx.cookies(PLATFORMS.xianyu.cookieUrl)).some(c => c.name === 'unb');
  if (!hasUid) return false;
  const open = session.loginPages.xianyu && !session.loginPages.xianyu.isClosed() ? session.loginPages.xianyu : null;
  if (open) {
    // While the login page is (re)loading the frame is briefly absent; that is not a login.
    const ok = !session.settling.has('xianyu') && !open.frames().some(PLATFORMS.xianyu.qrFrame);
    session.xianyuProbe = { at: Date.now(), ok };
    return ok;
  }
  if (session.xianyuProbe && Date.now() - session.xianyuProbe.at < 60_000) return session.xianyuProbe.ok;
  const page = await ctx.newPage();
  try {
    await page.goto(PLATFORMS.xianyu.loginUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    let walled = false;
    for (let i = 0; i < 10 && !walled; i++) { walled = page.frames().some(PLATFORMS.xianyu.qrFrame); if (!walled) await page.waitForTimeout(500); }
    session.xianyuProbe = { at: Date.now(), ok: !walled };
    return !walled;
  } finally { await page.close().catch(() => {}); }
}

// The login lives in the Edge profile, which is only opened on demand; remember the last answer so the page
// can say "logged in last time" without starting a browser alongside the editor.
let lastState = null;
async function remembered() {
  if (!lastState) lastState = await readFile(LAST_STATE, 'utf8').then(JSON.parse, () => ({}));
  return lastState;
}
async function remember(platform, entry) {
  const all = await remembered();
  if (JSON.stringify(all[platform]) === JSON.stringify(entry)) return;
  all[platform] = entry;
  await mkdir(path.dirname(LAST_STATE), { recursive: true });
  await writeFile(LAST_STATE, JSON.stringify(all));
}

async function closeLoginPage(session, platform) {
  await session.loginPages[platform]?.close().catch(() => {});
  delete session.loginPages[platform];
}

// Without `wake`, a browser that is not running stays that way and the last known answer is reported.
export async function status(platform, { wake = false } = {}) {
  if (!browserOpen() && !wake) return { platform, state: 'idle', last: (await remembered())[platform] ?? null };
  try {
    const session = await mainSession();
    const ok = await loggedIn(session, platform);
    if (ok) { await closeLoginPage(session, platform); await pinSessionCookies(session.ctx); }
    const nick = ok ? await nickname(session.ctx, platform) : '';
    await remember(platform, { state: ok ? 'in' : 'out', nick });
    return { platform, state: ok ? 'in' : 'out', nick };
  } catch (e) {
    return { platform, state: 'error', error: String(e.message ?? e).split('\n')[0] };
  }
}

// A login code is only good for a few minutes. Rather than trust the page to say when it lapsed, the login
// page is reloaded once the code on it is older than this, so the dialog never shows a dead code.
const QR_MAX_AGE_MS = Number(process.env.QR_MAX_AGE_MS || 100_000);

async function loginPage(session, platform, fresh = false) {
  let page = session.loginPages[platform];
  if (!page || page.isClosed()) {
    page = session.loginPages[platform] = await session.ctx.newPage();
    fresh = true;
  }
  if (fresh) {
    await page.goto(PLATFORMS[platform].loginUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    session.qrIssuedAt[platform] = Date.now();
  }
  return page;
}

async function qrBox(page, platform) {
  let frame = null;
  for (let i = 0; i < 20 && !frame; i++) {
    frame = page.frames().find(PLATFORMS[platform].qrFrame) ?? null;
    if (!frame) await page.waitForTimeout(500);
  }
  if (!frame) return null;
  const box = frame.locator('.qrcode-img').first();
  try { await box.waitFor({ state: 'visible', timeout: 12000 }); } catch { return null; }
  // The page's own "expired, click to refresh" overlay, if it got there first.
  const expired = frame.locator('.qrcode-login :text-matches("刷新|重新获取|已失效|已过期")').first();
  if (await expired.isVisible().catch(() => false)) return null;
  return box;
}

async function qrFrom(session, platform) {
  const stale = Date.now() - (session.qrIssuedAt[platform] ?? 0) > QR_MAX_AGE_MS;
  session.settling.add(platform);
  let box;
  try {
    let page = await loginPage(session, platform, stale && Boolean(session.loginPages[platform]));
    box = await qrBox(page, platform);
    if (!box) {  // expired overlay or a login box that never rendered: one reload
      page = await loginPage(session, platform, true);
      box = await qrBox(page, platform);
    }
  } finally { session.settling.delete(platform); }
  if (!box) return { state: 'out', error: '暂时取不到二维码，稍后会自动重试' };
  return { state: 'out', png: await box.screenshot({ type: 'png' }), issuedAt: session.qrIssuedAt[platform], maxAgeMs: QR_MAX_AGE_MS };
}

async function reloginSession(platform) {
  if (!relogin[platform]) {
    await mainSession();  // settles desktopUa
    const browser = await chromium.launch(LAUNCH);
    relogin[platform] = { browser, session: newSession(await browser.newContext({ ...CONTEXT, userAgent: desktopUa })) };
  }
  relogin[platform].touched = Date.now();
  return relogin[platform].session;
}
// A dialog that went away without saying so (page closed mid-scan) must not leave its browser running.
setInterval(() => {
  for (const [platform, pending] of Object.entries(relogin)) if (Date.now() - pending.touched > 3 * 60_000) cancelRelogin(platform);
}, 60_000).unref();

// Drop a "log in again" attempt. The main login is as it was.
export async function cancelRelogin(platform) {
  const pending = relogin[platform];
  delete relogin[platform];
  await pending?.browser.close().catch(() => {});
}

// The new login replaces the old one: this platform's cookies in the main profile are swapped for the fresh set.
async function adoptRelogin(platform) {
  const fresh = (await relogin[platform].session.ctx.cookies()).filter(c => COOKIE_DOMAINS[platform].test(c.domain));
  const main = await mainSession();
  await closeLoginPage(main, platform);
  await main.ctx.clearCookies({ domain: COOKIE_DOMAINS[platform] });
  await main.ctx.addCookies(fresh);
  await pinSessionCookies(main.ctx);
  if (platform === 'xianyu') main.xianyuProbe = null;
  for (const key of cache.keys()) if (key.startsWith(platform + ':')) cache.delete(key);
  await cancelRelogin(platform);
}

// PNG of the login QR code, or a reason why there is none right now. With `again`, a code is issued even
// though the platform is already logged in.
export function loginQr(platform, { again = false } = {}) {
  return serial(async () => {
    if (again || relogin[platform]) {
      const session = await reloginSession(platform);
      if (await loggedIn(session, platform)) { await adoptRelogin(platform); return { state: 'in', replaced: true }; }
      return qrFrom(session, platform);
    }
    const main = await mainSession();
    if (await loggedIn(main, platform)) { await pinSessionCookies(main.ctx); return { state: 'in' }; }
    return qrFrom(main, platform);
  });
}

// ---- search (ported from xianyu-pc-helper, trimmed to what BOM matching needs)

const priceNumber = parts => {
  const raw = Array.isArray(parts) ? parts.map(x => x?.text ?? '').join('') : String(parts ?? '');
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const httpsUrl = url => String(url || '').replace(/^http:/, 'https:').replace(/^\/\//, 'https://');

function parseXianyu(payload) {
  return (payload?.data?.resultList || []).map(row => {
    const main = row?.data?.item?.main?.exContent || {};
    const args = row?.data?.item?.main?.clickParam?.args || {};
    const id = main.itemId || args.item_id || '';
    return {
      // On 闲鱼 the "title" is the whole description the seller wrote.
      id, title: main.title || '', price: priceNumber(main.price), image: httpsUrl(main.picUrl),
      area: main.area || '', seller: main.userNickName || '', sellerId: args.seller_id || '', wants: Number(args.wantNum || 0),
      fishTags: Object.values(main.fishTags || {}).flatMap(g => (g?.tagList || []).map(t => t?.data?.content || '')).filter(t => t && !/Icon$/.test(t)),
      link: id ? `https://www.goofish.com/item?id=${id}` : '',
    };
  }).filter(x => x.price && x.price > 0 && x.link);
}

// Things that are not the part at all. These never count as a source.
const XIANYU_RISKS = [
  ['拆机/故障', /拆机件?坏|不包好坏|好坏不包|坏的|故障|报废|尸体|仅供拆件/],
  ['虚拟商品', /资料|教程|原理图|源码|固件|pdf|手册|代画|代做|设计服务/],
];
const TAOBAO_RISKS = [
  ['定金/订金', /定金|订金/],
  ['非主体商品', /空盒|包装盒|转接板|测试座|烧录座|适配座|散热器|外壳|支架/],
  ['租赁', /租赁|出租/],
];
const risksOf = (title, rules) => rules.filter(([, re]) => re.test(String(title).toLowerCase())).map(([n]) => n);

// A listing counts for a part only if every alphanumeric chunk of the part number is in its title.
export function titleMatchesPart(title, query) {
  const hay = String(title).toLowerCase().replace(/[\s\-_/.()（）]+/g, '');
  const core = String(query).toLowerCase().replace(/\(.*?\)/g, '');
  const tokens = core.match(/[a-z0-9]+/g) || [];
  return tokens.length > 0 && tokens.every(t => hay.includes(t));
}

function median(values) {
  const v = values.filter(x => x > 0).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

const isRiskControl = payload => /FAIL_SYS_USER_VALIDATE|RGV587/.test(JSON.stringify(payload?.ret || []));

async function searchXianyu(ctx, keyword) {
  const page = await ctx.newPage();
  try {
    const pending = page.waitForResponse(r => r.url().includes(XIANYU_SEARCH_API) && r.request().method() === 'POST', { timeout: 25000 }).then(r => r.json());
    pending.catch(() => {});
    await page.goto(`https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const payload = await pending.catch(() => null);
    if (!payload) throw new Error('闲鱼没有返回结果，请稍后重试');
    // There is no window to solve a slider in; say so instead of waiting on it.
    if (isRiskControl(payload)) throw new Error('闲鱼要求滑块验证，本次跳过；过一会儿再试，或重新扫码登录');
    const all = parseXianyu(payload);
    const matched = all.filter(x => titleMatchesPart(x.title, keyword));
    const selling = matched.filter(x => !isWantedOnly(x.title));
    return {
      all: all.length, wantedOnly: matched.length - selling.length,
      items: selling.map(x => ({ ...x, risks: risksOf(x.title, XIANYU_RISKS), buysToo: isBuyAndSell(x.title) })),
    };
  } finally { await page.close().catch(() => {}); }
}

// The seller's own shelf: what else they list and at what price. One page (20 items) is enough to see a pattern.
const sellerCache = new Map();
async function sellerShelf(ctx, sellerId) {
  const hit = sellerCache.get(sellerId);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.shelf;
  const page = await ctx.newPage();
  try {
    const pending = page.waitForResponse(r => r.url().includes('/h5/mtop.idle.web.xyh.item.list/1.0/'), { timeout: 20000 }).then(r => r.json());
    pending.catch(() => {});
    await page.goto(`https://www.goofish.com/personal?userId=${encodeURIComponent(sellerId)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const payload = await pending.catch(() => null);
    if (!payload || isRiskControl(payload)) return null;  // unknown, and not worth caching
    const onSale = (payload.data?.itemGroupList || []).find(g => g.groupName === '在售')?.itemNumber ?? null;
    const items = (payload.data?.cardList || []).map(c => ({ title: c.cardData?.title || '', price: Number(c.cardData?.priceInfo?.price) || 0 })).filter(x => x.price > 0);
    const shelf = { onSale, items };
    sellerCache.set(sellerId, { at: Date.now(), shelf });
    return shelf;
  } finally { await page.close().catch(() => {}); }
}

function parseTaobaoCard(text, href, image) {
  const lines = String(text).split(/\n+/).map(x => x.trim()).filter(Boolean);
  const yen = lines.findIndex(x => x === '¥' || x === '￥');
  let price = yen >= 0 ? Number((lines[yen + 1] || '').replace(/[^\d.]/g, '')) || null : null;
  if (price == null) price = Number(String(text).match(/[¥￥]\s*([\d.]+)/)?.[1]) || null;
  const title = lines.slice(0, yen >= 0 ? yen : 1).join(' ').trim();
  const payment = lines.find(x => /人付款|人收货|已售/.test(x)) || '';
  const shop = [...lines].reverse().find(x => /店$|旗舰店$|企业店$|专营店$|有限公司$/.test(x)) || '';
  let id = '';
  try { id = new URL(href).searchParams.get('id') || ''; } catch {}
  return { id, title, price, payment, shop, seller: shop, image: httpsUrl(image), link: id && !href.includes('click.simba') ? `https://item.taobao.com/item.htm?id=${id}` : href };
}

async function searchTaobao(ctx, keyword) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    if (/login\.taobao\.com/.test(page.url())) throw new Error('淘宝要求登录，请先扫码登录');
    const selector = 'a[href*="item.htm?id="], a[href*="click.simba.taobao.com"][href*="id="]';
    await page.waitForSelector(selector, { timeout: 12000 }).catch(() => {});
    const cards = await page.locator(selector).evaluateAll(nodes => nodes.map(a => {
      const img = a.querySelector('img');
      // The shop link sits inside the card, its text prefixed by badges ("企业购", "10年老店"); the shop
      // name is the longest piece of text in it, and appUid in its address identifies the shop.
      const shopLink = a.querySelector('a[href*="store.taobao.com"], a[href*="shop"]');
      const pieces = [];
      if (shopLink) for (const w = document.createTreeWalker(shopLink, NodeFilter.SHOW_TEXT); w.nextNode();) pieces.push(w.currentNode.textContent.trim());
      const shop = pieces.sort((x, y) => y.length - x.length)[0] || '';
      let shopKey = '';
      try { shopKey = new URL(shopLink.href).searchParams.get('appUid') || ''; } catch {}
      return { text: a.innerText, href: a.href, image: img?.currentSrc || img?.src || img?.getAttribute('data-src') || '', shop, shopKey };
    }).filter(x => x.text && x.text.includes('¥')));
    const seen = new Set();
    const all = cards.map(x => ({ ...parseTaobaoCard(x.text, x.href, x.image), ...(x.shop ? { shop: x.shop, seller: x.shop } : {}), sellerId: x.shopKey })).filter(x => x.price && x.link && !seen.has(x.id || x.link) && seen.add(x.id || x.link));
    const matched = all.filter(x => titleMatchesPart(x.title, keyword) && !x.link.includes('click.simba'));  // drop ads
    return { all: all.length, wantedOnly: 0, items: matched.map(x => ({ ...x, risks: risksOf(x.title, TAOBAO_RISKS), buysToo: false })) };
  } finally { await page.close().catch(() => {}); }
}

const SELLER_CHECKS_PER_SEARCH = 6;

// Why the number on this listing may not be what the part costs, as far as the search results alone can tell.
function notRealReasons(item, items, mid, platform) {
  const reasons = notRealByText(item.title);
  if (mid && item.price < mid * (platform === 'xianyu' ? 0.4 : 0.2)) reasons.push('远低于同类报价');
  // Same seller, same number, on several different listings in this one result page.
  const key = item.sellerId || item.seller;
  if (key) {
    const same = uniformPricing(items.filter(x => (x.sellerId || x.seller) === key), { minItems: 3, share: 1, minDistinct: 3 });
    if (same) reasons.push(`同一卖家本页 ${same.same} 件同标 ¥${same.price}`);
  }
  return reasons;
}

// Listings for one part on one platform, real-priced ones first.
//   listings[]: { title, image, link, seller, price, landedCny, buyQty, flags, risks, notReal[], buysToo, sellerChecked }
//   best: the first listing that is the part itself at a real price, or null.
export function searchPart(platform, keyword, needQty = 1) {
  const key = `${platform}:${keyword}`;
  const hit = cache.get(key);
  const raw = hit && Date.now() - hit.at < 10 * 60_000
    ? Promise.resolve(hit.data)
    : serial(async () => {
      const ctx = await context();
      const data = await (platform === 'xianyu' ? searchXianyu : searchTaobao)(ctx, keyword);
      await pinSessionCookies(ctx);  // a search can hand out a renewed session cookie
      cache.set(key, { at: Date.now(), data });
      return data;
    });
  return raw.then(async data => {
    const mid = median(data.items.filter(x => !x.risks.length && !notRealByText(x.title).length).map(x => x.price));
    const listings = [];
    for (const item of data.items) {
      const scored = scoreListing(item, needQty, platform);
      if (!scored) continue;
      listings.push({
        ...scored, id: item.id || '', sellerKey: item.sellerId || '', image: item.image || '', area: item.area || '', tags: [item.payment, ...(item.fishTags || [])].filter(Boolean).slice(0, 4),
        sellerId: item.sellerId || '', buysToo: item.buysToo, notReal: notRealReasons(item, data.items, mid, platform), sellerChecked: false,
      });
    }
    const favs = await favorites.all();
    for (const row of listings) row.favorite = favorites.match(favs, platform, row)?.id ?? null;
    const rank = row => (row.risks.length ? 2 : row.notReal.length ? 1 : 0);
    // Within the real-priced group a favourite shop goes first, whatever its price.
    const order = () => listings.sort((a, b) => rank(a) - rank(b) || (a.favorite ? 0 : 1) - (b.favorite ? 0 : 1)
      || (a.ship.kind === 'free' ? 0 : 1) - (b.ship.kind === 'free' ? 0 : 1) || a.landedCny - b.landedCny);
    order();

    // 闲鱼 only: look at the shelf of the sellers that are about to be recommended. A shop with one price on
    // everything drops out of the clean group, which promotes the next seller, who is then checked in turn.
    if (platform === 'xianyu') {
      const ctx = await context();
      for (let checks = 0; checks < SELLER_CHECKS_PER_SEARCH; checks++) {
        const next = listings.slice(0, 4).find(row => rank(row) === 0 && !row.sellerChecked && row.sellerId);
        if (!next) break;
        const shelf = await serial(() => sellerShelf(ctx, next.sellerId)).catch(() => null);
        const verdict = shelf && uniformPricing(shelf.items);
        for (const row of listings) {
          if (row.sellerId !== next.sellerId) continue;
          row.sellerChecked = true;
          row.sellerOnSale = shelf?.onSale ?? null;
          if (verdict) row.notReal.push(verdict.reason);
        }
        order();
      }
    }
    const clean = listings.filter(row => rank(row) === 0);
    return {
      platform, keyword, scanned: data.all, count: listings.length, wantedOnly: data.wantedOnly, median: mid,
      notRealCount: listings.filter(row => row.notReal.length).length,
      best: clean[0] ?? null, listings: listings.slice(0, 12).map(({ sellerId, ...row }) => row),
    };
  });
}

// ---- 淘宝 item detail: the documents a seller attached, and what the description pictures say

const detailCache = new Map();
const MAX_DESC_IMAGES = 16;

// { shop, docs: [{ name, type, url }], qr: [{ image, text }], links: [{ url, line, image }], hints: [...], images }
// docs are the listing's 技术文档 attachments (real files). links/hints/qr are read out of the description
// pictures by OCR and QR decoding, so they point at the picture they came from for checking.
export function taobaoDetail(id) {
  if (!/^\d+$/.test(String(id))) return Promise.reject(new Error('商品 id 不对'));
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return Promise.resolve(hit.data);
  return serial(async () => {
    const ctx = await context();
    const page = await ctx.newPage();
    // The same facts reach the page two ways, neither reliably: embedded in the server-rendered HTML, or in
    // follow-up API calls. Take both and merge.
    const api = { docs: [], shop: null, pics: [] };
    const jsonp = text => JSON.parse(String(text).replace(/^[^({]*\(/, '').replace(/\)\s*;?\s*$/, ''));
    try {
      page.on('response', async r => {
        const name = r.url().match(/\/h5\/(mtop\.[\w.]+)\//)?.[1];
        if (name !== 'mtop.taobao.pcdetail.data.adjust' && name !== 'mtop.taobao.detail.getdesc') return;
        const body = await r.text().then(jsonp).catch(() => null);
        const vo = body?.data?.componentsVO;
        if (vo?.industrialSpecVO?.industrialSpecList) api.docs = vo.industrialSpecVO.industrialSpecList;
        if (vo?.storeCardVO?.shopName) api.shop = { name: vo.storeCardVO.shopName, url: vo.storeCardVO.shopUrl || '' };
        const parts = body?.data?.components?.componentData;
        if (parts) api.pics = Object.values(parts).map(c => c?.model?.picUrl).filter(Boolean);
      });
      await page.goto(`https://item.taobao.com/item.htm?id=${id}`, { waitUntil: 'domcontentloaded', timeout: 40000, referer: 'https://s.taobao.com/' });
      if (/login\.taobao\.com/.test(page.url())) throw new Error('淘宝要求登录，请先扫码登录');
      await page.waitForTimeout(3500);
      if (await page.locator('iframe[src*="punish"], #baxia-dialog-content, .baxia-dialog').count()) throw new Error('淘宝要求滑块验证，本次跳过；过几分钟再试');

      const readPage = () => page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        let docs = [];
        const at = html.indexOf('industrialSpecList');
        if (at >= 0) {
          const start = html.indexOf('[', at), end = html.indexOf(']', start);
          try { docs = JSON.parse(html.slice(start, end + 1).replace(/\\"/g, '"').replace(/\\\//g, '/')); } catch {}
        }
        const shopLink = [...document.querySelectorAll('a[href]')].find(a => /\/\/shop\d+\.(taobao|tmall)\.com\//.test(a.href) && a.textContent.trim().length > 3);
        const pics = [...document.querySelectorAll('.descV8-container img, #imageTextInfo-content img, [class*="desc-root"] img')]
          .map(i => i.currentSrc || i.src || i.getAttribute('data-src') || '').filter(u => u && !/^data:/.test(u));
        // The shop link's text runs on into the rating ("…有限公司4.988VIP好评率"); cut at the first digit.
        return { docs, shop: shopLink ? { name: shopLink.textContent.trim().replace(/\d[\d.]*.*$/, '').trim(), url: shopLink.href.split('?')[0] } : null, pics, height: document.documentElement.scrollHeight };
      });
      // The description pictures appear only as the page is scrolled through.
      await page.mouse.move(640, 500);
      let seen = await readPage(), still = 0;
      for (let i = 0; i < 36 && still < 4; i++) {
        await page.mouse.wheel(0, 1100);
        await page.waitForTimeout(450);
        const now = await readPage();
        still = now.pics.length === seen.pics.length && now.height === seen.height ? still + 1 : 0;
        seen = now;
      }
      const shop = api.shop || seen.shop || { name: '', url: '' };
      const rawDocs = api.docs.length ? api.docs : seen.docs || [];
      const docs = rawDocs.map(f => ({ name: f.fileName || '技术文档', type: f.fileType || '', url: httpsUrl(f.fileUrl) })).filter(f => f.url);
      const rawPics = api.pics.length ? api.pics : seen.pics;
      // 淘宝 serves a stripped page (no description at all) to a profile that opened many items in a row.
      if (!rawPics.length && !docs.length && seen.height < 2500) throw new Error('淘宝这次没有给出详情内容（短时间内打开过多商品时会这样），过十几分钟再试');
      // Drop Taobao's own boilerplate pictures (price notice, coin banner) that sit under every listing.
      const pics = [...new Set(rawPics.map(httpsUrl))].filter(u => !/-tps-\d+-\d+\.(png|jpg)/.test(u)).slice(0, MAX_DESC_IMAGES);
      const images = [];
      for (const [i, url] of pics.entries()) {
        const r = await ctx.request.get(url, { timeout: 20000 }).catch(() => null);
        if (!r?.ok()) continue;
        const ext = (url.split('?')[0].match(/\.(jpe?g|png|gif|webp)$/i)?.[1] || 'jpg').toLowerCase();
        images.push({ name: `d${String(i + 1).padStart(2, '0')}.${ext}`, url, buffer: await r.body() });
      }
      const read = await readImages(images);
      const urlOf = Object.fromEntries(images.map(x => [x.name, x.url]));
      const links = [], hints = [];
      for (const { image, lines } of read.text) {
        const found = findLinks(lines);
        links.push(...found.links.map(x => ({ ...x, image: urlOf[image] })));
        hints.push(...found.hints.map(x => ({ ...x, image: urlOf[image] })));
      }
      const data = { id, shop, docs, qr: read.qr.map(q => ({ text: q.text, image: urlOf[q.image] })), links, hints, images: images.length };
      detailCache.set(id, { at: Date.now(), data });
      return data;
    } finally { await page.close().catch(() => {}); }
  });
}

export async function shutdown() {
  for (const platform of Object.keys(relogin)) await cancelRelogin(platform);
  if (mainPromise) {
    const { ctx } = await mainPromise;
    await pinSessionCookies(ctx).catch(() => {});
    await ctx.close().catch(() => {});
  }
}
