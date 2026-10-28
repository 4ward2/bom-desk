// What a listing's text and its seller's other listings say about it: is it a "wanted" post, and is the
// price on it a real asking price. Pure functions, no browser.

// 求购帖 put 收/回收 at the very start of the text; sellers mention 回收 far later, so only the head counts.
const WANTED_HEAD = [
  /求购|收购|回收|专收|秒收|急收|求收|谁有|有出的|想收/,
  /(高价|现金|大量|长期|专业|上门|全国|诚心?)\s*收/,
  /^\s*[【\[（(]?\s*收(?![纳藏音货割据入费银到])/,
];
// A trader who buys and sells says so in the same post, with a word for selling; those stay. Words that a
// pure buyer also uses for what they want ("全新原装", "工厂库存", "现货") do not count.
const ALSO_SELLS = /出售|在售|有售|销售|也卖|也出|收售|买卖|供应|批发|零售|现货(出|供|销|秒发|直拍)|可直接拍|直接拍下/;

export function isWantedOnly(text) {
  const head = String(text).toLowerCase().slice(0, 24);
  return WANTED_HEAD.some(re => re.test(head)) && !ALSO_SELLS.test(String(text));
}
export function isBuyAndSell(text) {
  const head = String(text).toLowerCase().slice(0, 24);
  return WANTED_HEAD.some(re => re.test(head)) && ALSO_SELLS.test(String(text));
}

// The seller says outright that the number on the listing is not the price.
const NOT_REAL_TEXT = [
  ['写明需询价', /询价|单询|详询|问价|咨询价|价格咨询|咨询为准|需要?咨询|咨询客服|联系客服|报价为准|以报价为准|看货报价|量大价优.{0,4}(私聊|咨询)/],
  ['写明可议价/面议', /议价|面议|可谈|可小刀|价格可商量|价格好商量|价格好说/],
  ['写明价格私聊', /价格私[信聊]|私[信聊].{0,6}(价|报价)|具体价格.{0,6}(私|聊|问)|带价来聊/],
  ['写明拍下改价', /拍下改价|改价|补差价|差价/],
  ['写明标价非实价', /非实价|不是实价|不是实际价|价格不实|乱标|随便标|标价无效|标价仅供参考|价格仅供参考|以实际(价格|报价)?为准|价格以.{0,6}为准|价格(每天|随时|实时).{0,4}(变|浮动|波动)|行情价/],
];
export const notRealByText = text => NOT_REAL_TEXT.filter(([, re]) => re.test(String(text))).map(([reason]) => reason);

const sameThing = title => String(title).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 14);

// A shop that hangs one number on (nearly) everything it lists is using the price as a placeholder.
// Not a placeholder: a seller with only a few listings, or one item put up under two or three links.
export function uniformPricing(sellerItems, { minItems = 5, share = 0.8, minDistinct = 4 } = {}) {
  const priced = sellerItems.filter(x => x.price > 0);
  if (priced.length < minItems) return null;
  const byPrice = new Map();
  for (const item of priced) byPrice.set(item.price, [...(byPrice.get(item.price) || []), item]);
  const [price, group] = [...byPrice.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (group.length / priced.length < share) return null;
  if (new Set(group.map(x => sameThing(x.title))).size < minDistinct) return null;
  return { price, same: group.length, of: priced.length, reason: `店内 ${priced.length} 件有 ${group.length} 件同标 ¥${price}` };
}
