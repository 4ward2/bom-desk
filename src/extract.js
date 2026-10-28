// Pull links out of pictures: QR codes via OpenCV, printed text via the Windows OCR engine.
// Sellers put the "资料下载" address inside the description images, where there is no text to read.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HELPERS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers');

// OCR returns CJK with a space between every character; Latin runs keep their own spacing.
const CJK = '\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef';
export const tidy = line => String(line).replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g'), '').replace(/\s+/g, ' ').trim();

const URL_RE = /(?:https?\s*[:：]\s*\/\s*\/|www\s*\.)\s*[\w\-./?=&%#:+~ ]{6,}/gi;
const HINT_RE = /资料|下载|网盘|百度云|链接|提取码|数据手册|规格书|手册|例程|源码|原理图|datasheet/i;

// Links and link-ish lines found in OCR text. OCR misreads characters, so every hit keeps the line it came
// from and is for a person to check, not to follow blindly.
export function findLinks(lines) {
  const links = [], hints = [];
  for (const raw of lines) {
    const line = tidy(raw);
    const urls = [...line.matchAll(URL_RE)].map(m => m[0].replace(/\s+/g, '').replace(/：/g, ':').replace(/[.,;，。]+$/, ''));
    for (const url of urls) links.push({ url: /^www\./i.test(url) ? 'http://' + url : url, line });
    const code = line.match(/提取码\s*[:：]?\s*([a-z0-9]{4})\b/i);
    if (code) hints.push({ kind: '提取码', text: code[1], line });
    else if (!urls.length && HINT_RE.test(line) && line.length <= 80) hints.push({ kind: '提示', text: line, line });
  }
  return { links, hints };
}

// images: [{ name, buffer }] -> { qr: [{ image, text }], text: [{ image, lines: [...] }] }
export async function readImages(images) {
  if (!images.length) return { qr: [], text: [] };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bom-desk-img-'));
  try {
    for (const img of images) await writeFile(path.join(dir, img.name), img.buffer);
    const prep = JSON.parse((await run('python', ['-I', path.join(HELPERS, 'prep_images.py'), dir], { maxBuffer: 16e6, timeout: 60000 })).stdout);
    const byImage = new Map();
    if (prep.tiles.length) {
      const list = path.join(dir, 'tiles.txt');
      await writeFile(list, prep.tiles.map(t => t.path).join('\n'), 'utf8');
      const out = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HELPERS, 'ocr.ps1'), list], { maxBuffer: 32e6, timeout: 120000 });
      const ocr = JSON.parse(out.stdout);
      const imageOf = new Map(prep.tiles.map(t => [t.path, t.image]));
      for (const tile of ocr) byImage.set(imageOf.get(tile.path), [...(byImage.get(imageOf.get(tile.path)) || []), ...(tile.lines || [])]);
    }
    return { qr: prep.qr, text: [...byImage.entries()].map(([image, lines]) => ({ image, lines })) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
