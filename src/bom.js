// BOM text -> lines { designator, mpn, lcsc, qty, footprint, value, maker, passive }.
// Accepts the CSV/TSV that 嘉立创EDA exports (UTF-16 with BOM, tab separated) and plain pasted lists.

const COLUMNS = {
  qty: /^(quantity|qty|数量|用量)$/i,
  mpn: /^(manufacturer part|manufacturer part number|mpn|part number|型号|厂家型号|制造商料号)$/i,
  lcsc: /^(supplier part|lcsc part|lcsc|立创编号|商城编号|供应商编号)$/i,
  designator: /^(designator|位号|reference|ref)$/i,
  footprint: /^(footprint|package|封装)$/i,
  value: /^(value|值)$/i,
  maker: /^(manufacturer|品牌|厂家|制造商)$/i,
  comment: /^(comment|name|名称|描述)$/i,
};

const PASSIVE_MPN = /^(?:0201|0402|0603|0805|1206|1210|GRM|GCM|CL[0-3][0-9]|CC0[468]|BLM|SDCL|ERA[0-9]|RC-?0[26]|RC\d{4})/i;
const PASSIVE_WORDS = /电阻|电容|电感|磁珠|排阻|resistor|capacitor|inductor/i;
const PASSIVE_DESIGNATOR = /^(?:R|C|L|FB)\d/i;
const REEL_TAIL = /-(?:REEL|R|TR|T\/?R|ND|CT)\b.*$/i;

export function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  const text = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
  return text.includes('�') ? new TextDecoder('gbk').decode(buffer) : text;
}

function splitRow(row, sep) {
  if (sep === '\t') return row.split('\t').map(s => s.trim());
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (quoted) { if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function isPassive(line) {
  const blob = `${line.mpn} ${line.comment || ''} ${line.value || ''}`;
  if (PASSIVE_MPN.test(line.mpn)) return true;
  // A resistor with a branded part number still counts; a "0.1uF"-style value with no real part number too.
  return PASSIVE_WORDS.test(blob) || (PASSIVE_DESIGNATOR.test(line.designator || '') && !/[A-Za-z]{3,}\d{3,}/.test(line.mpn));
}

export const searchQuery = line => String(line.mpn || '').replace(REEL_TAIL, '').slice(0, 80);

function collapse(lines) {
  const byKey = new Map();
  for (const line of lines) {
    const key = line.lcsc || line.mpn.toUpperCase();
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...line });
    else { seen.qty += line.qty; if (line.designator) seen.designator = [seen.designator, line.designator].filter(Boolean).join(','); }
  }
  return [...byKey.values()];
}

export function parseBom(text) {
  const rows = String(text).split(/\r?\n/).map(r => r.trimEnd()).filter(r => r.trim());
  if (!rows.length) return [];
  const sep = rows[0].includes('\t') ? '\t' : rows[0].includes(',') ? ',' : rows[0].includes(';') ? ';' : null;
  const head = sep ? splitRow(rows[0], sep) : [];
  const index = {};
  head.forEach((h, i) => { for (const [k, re] of Object.entries(COLUMNS)) if (index[k] === undefined && re.test(h)) index[k] = i; });

  const lines = [];
  if (index.mpn !== undefined || index.lcsc !== undefined || index.comment !== undefined) {
    for (const row of rows.slice(1)) {
      const c = splitRow(row, sep);
      const get = k => (index[k] === undefined ? '' : c[index[k]] || '');
      const mpn = get('mpn') || get('comment');
      const lcsc = /^C\d+$/i.test(get('lcsc')) ? get('lcsc').toUpperCase() : '';
      if (!mpn && !lcsc) continue;
      const designator = get('designator');
      const qty = Number(get('qty')) || (designator ? designator.split(/[,\s]+/).filter(Boolean).length : 1);
      lines.push({ designator, mpn, lcsc, qty: Math.max(1, qty), footprint: get('footprint'), value: get('value'), maker: get('maker'), comment: get('comment') });
    }
  } else {
    // Plain list: "TPS65632RTER x2", "C2040, 3", or just a part number per line.
    for (const row of rows) {
      const m = row.trim().match(/^(.+?)(?:\s*[,;\t]\s*|\s+[x×*]\s*|\s+)(\d{1,6})$/i);
      const name = (m ? m[1] : row).trim();
      if (!name) continue;
      const lcsc = /^C\d+$/i.test(name) ? name.toUpperCase() : '';
      lines.push({ designator: '', mpn: lcsc ? '' : name, lcsc, qty: m ? Number(m[2]) : 1, footprint: '', value: '', maker: '', comment: '' });
    }
  }
  return collapse(lines).map((line, i) => ({ id: i + 1, ...line, passive: isPassive(line), query: searchQuery(line) }));
}
