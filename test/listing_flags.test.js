import test from 'node:test';
import assert from 'node:assert/strict';
import { isWantedOnly, isBuyAndSell, notRealByText, uniformPricing } from '../src/listing_flags.js';

test('wanted-only posts are recognised, buy-and-sell traders are kept', () => {
  assert.equal(isWantedOnly('高价回收TPS65632 各种电源芯片 有的联系'), true);
  assert.equal(isWantedOnly('收 STM32F103C8T6 拆机也要'), true);
  assert.equal(isWantedOnly('求购 TC358870XBG 两片'), true);
  // real posts seen on 闲鱼: buyers describing what they want with seller-sounding words
  assert.equal(isWantedOnly('长期现金收购全新原装IC、各类电子元器件 MCU、射频、车规器件 诚信双赢，中介重酬！'), true);
  assert.equal(isWantedOnly('高价回收ic芯片 电子元器件 原装IC 内存 MCU工厂库存 电子余料'), true);
  // buys and sells: stays in, tagged
  assert.equal(isWantedOnly('长期回收电子元器件，同时现货出售TPS65632RTER 全新原装'), false);
  assert.equal(isBuyAndSell('长期回收电子元器件，同时现货出售TPS65632RTER 全新原装'), true);
  // an ordinary sale that mentions 回收 late, or starts with a 收-word that is not buying
  assert.equal(isWantedOnly('TPS65632RTER 全新原装现货 包邮，以后不用了也可以找我回收'), false);
  assert.equal(isWantedOnly('收纳盒里翻出来的 STM32 开发板'), false);
});

test('text that says the listed number is not the price', () => {
  assert.deepEqual(notRealByText('TPS65632RTER 现货 价格以询价为准'), ['写明需询价', '写明标价非实价']);
  assert.deepEqual(notRealByText('TC358870XBG 拍下改价'), ['写明拍下改价']);
  assert.deepEqual(notRealByText('可小刀 诚心要的来'), ['写明可议价/面议']);
  assert.deepEqual(notRealByText('RT4720A 全新原装 一片也发 包邮'), []);
});

const shelf = (prices, titles) => prices.map((price, i) => ({ price, title: titles?.[i] ?? `型号${i} 芯片 全新` }));

test('one price across a shelf is a placeholder price', () => {
  const v = uniformPricing(shelf([1, 1, 1, 1, 1, 1, 1, 1, 1, 25]));
  assert.equal(v.price, 1);
  assert.equal(v.same, 9);
});

test('exceptions: few listings, one item under several links, mixed prices', () => {
  assert.equal(uniformPricing(shelf([10])), null);                              // sells only this
  assert.equal(uniformPricing(shelf([10, 10, 10])), null);                      // two or three links
  assert.equal(uniformPricing(shelf([10, 10, 10, 10, 10, 10], Array(6).fill('TPS65632RTER 全新原装现货'))), null);  // same thing relisted
  assert.equal(uniformPricing(shelf([8.4, 8.4, 17.4, 19, 8.4, 6, 6.7, 13, 8.8, 53])), null);  // a real shop
});
