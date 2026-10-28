// Normalise 淘宝/闲鱼 listings to a landed cost for the BOM quantity: pack size, MOQ, shipping.
// Port of EDAMax tools/listing_rules.py.

const BAIT = /询价为准|以询价为准|以询为准|欢迎询价|询价|价格咨询为准|咨询为准|价格咨询|价格私[信聊]|私[信聊](拿货|报价|询价|细节|看图|看货)|细节私[信聊]|需要.{0,6}私[信聊]|拍下改价|改价出|价格面议|面议为准|看货报价|单询|详询|有意向?(私聊|私信)/;
const PACK_EXPLICIT = /(\d{1,5})\s*(?:\+|＋)?\s*(?:片|个|只|颗|条|块|pcs)/i;
const PACK_REEL = /(?:整盘|整卷|一盘|一卷)(?:约)?(\d{2,5})?/;
const PACK_EACH = /按个|按只|按片|散装|单片|单只|单颗|零售/;
const MOQ = /(?:起订|起售|最少)\s*(\d{1,5})/;
const SHIP_FREE = /包邮|免邮/;
const SHIP_PAID = /不包邮|到付|邮费另算|运费另计|偏远不包/;
const SHIP_THRESHOLD = /满\s*(\d+(?:\.\d+)?)\s*包邮/;

const blobOf = item => [item.title, item.area, item.payment, item.shop, item.seller, ...(item.fishTags || [])].filter(Boolean).join(' ');

export function isBait(item) {
  return (item.risks || []).some(r => r === '询价引流' || r === '虚拟商品') || BAIT.test(String(item.title || ''));
}

export function packQty(item) {
  const text = blobOf(item);
  if (PACK_EACH.test(text)) return [1, 'each'];
  const reel = text.match(PACK_REEL);
  if (reel) return reel[1] ? [Number(reel[1]), 'reel'] : [0, 'reel-unknown'];
  const hit = text.match(PACK_EXPLICIT);
  if (hit && Number(hit[1]) > 0) return [Number(hit[1]), 'pack'];
  return [1, 'assumed-each'];
}

export function shipping(item, unknownCny, listPrice) {
  const text = blobOf(item);
  if (SHIP_PAID.test(text)) return { kind: 'paid', cny: unknownCny, label: '不包邮' };
  const bar = text.match(SHIP_THRESHOLD);
  if (bar) {
    const n = Number(bar[1]);
    return listPrice >= n ? { kind: 'free', cny: 0, label: `满${n}包邮` } : { kind: 'threshold', cny: unknownCny, label: `满${n}包邮` };
  }
  if (SHIP_FREE.test(text)) return { kind: 'free', cny: 0, label: '包邮' };
  return { kind: 'unknown', cny: unknownCny, label: '邮费未标' };
}

function lotsNeeded(need, pack, moq) {
  let lots = Math.ceil(Math.max(need, 1) / Math.max(pack, 1));
  while (lots * Math.max(pack, 1) < moq) lots++;
  return lots;
}

export function scoreListing(item, needQty, platform, unknownShip = 6) {
  const price = Number(item.price);
  if (!(price > 0)) return null;
  const [pack, packKind] = packQty(item);
  if (packKind === 'reel-unknown' || pack <= 0) return null;
  const ship = shipping(item, unknownShip, price);
  const moq = Math.max(Number(blobOf(item).match(MOQ)?.[1] || 1), 1);
  const lots = lotsNeeded(needQty, pack, moq);
  const buyQty = lots * pack;
  const flags = [];
  if (packKind === 'assumed-each') flags.push('单位按1只估');
  if (pack > Math.max(needQty, 1) * 5) flags.push('起订远大于用量');
  if (ship.kind !== 'free') flags.push(ship.label);
  if (buyQty > needQty) flags.push(`多买${buyQty - needQty}只`);
  return {
    platform, title: item.title, link: item.link, seller: item.seller || item.shop || '', price,
    risks: [...(item.risks || [])], pack, lots, buyQty, ship,
    unitCny: +((price + ship.cny) / pack).toFixed(4), landedCny: +(lots * (price + ship.cny)).toFixed(2), flags,
  };
}

export function rankListings(items, needQty, platform, { unknownShip = 6, preferFreeShip = true, median = null } = {}) {
  const floor = platform === 'xianyu' ? 0.4 : 0.2;
  const ranked = [];
  for (const item of items) {
    if (isBait(item)) continue;
    if (platform === 'taobao' && String(item.link || '').includes('click.simba')) continue;  // ads
    if ((item.risks || []).length) continue;
    if (median && item.price < median * floor) continue;  // far below market: bait or a different thing
    const scored = scoreListing(item, needQty, platform, unknownShip);
    if (scored) ranked.push(scored);
  }
  const shipRank = row => (!preferFreeShip || row.ship.kind === 'free' ? 0 : 1);
  return ranked.sort((a, b) => shipRank(a) - shipRank(b) || a.landedCny - b.landedCny || a.unitCny - b.unitCny || a.buyQty - b.buyQty);
}
