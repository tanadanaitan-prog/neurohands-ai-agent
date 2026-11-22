import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, "..");
const GUIDE_DIR = path.join(PLATFORM_DIR, "assets", "guides");
const WORDMARK_PNG = path.join(PLATFORM_DIR, "assets", "rich-menus", "neurohands-wordmark-white.png");

const WIDTH = 1200;
const HEIGHT = 628;
const MAX_BYTES = 220 * 1024;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function encodePalettePng256(pngBuf) {
  const sig = pngBuf.subarray(0, 8);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idats = [];
  while (pos < pngBuf.length) {
    const len = pngBuf.readUInt32BE(pos);
    const type = pngBuf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = pngBuf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idats.push(data);
    }
    pos += 12 + len;
  }
  if (colorType !== 6 && colorType !== 2) return pngBuf;

  const srcBpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const srcStride = width * srcBpp;
  const totalPixels = width * height;
  const rgb = Buffer.alloc(totalPixels * 3);
  const prevRow = Buffer.alloc(srcStride);
  const curRow = Buffer.alloc(srcStride);

  const hist = new Map();
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (srcStride + 1)];
    const rowStart = y * (srcStride + 1) + 1;
    for (let i = 0; i < srcStride; i++) {
      const xVal = raw[rowStart + i];
      const a = i >= srcBpp ? curRow[i - srcBpp] : 0;
      const b = prevRow[i];
      const c = i >= srcBpp ? prevRow[i - srcBpp] : 0;
      if (filter === 0) curRow[i] = xVal;
      else if (filter === 1) curRow[i] = (xVal + a) & 0xff;
      else if (filter === 2) curRow[i] = (xVal + b) & 0xff;
      else if (filter === 3) curRow[i] = (xVal + ((a + b) >> 1)) & 0xff;
      else curRow[i] = (xVal + paethPredictor(a, b, c)) & 0xff;
    }
    curRow.copy(prevRow);
    const dstOff = y * width * 3;
    for (let x = 0; x < width; x++) {
      const r = curRow[x * srcBpp];
      const g = curRow[x * srcBpp + 1];
      const b = curRow[x * srcBpp + 2];
      rgb[dstOff + x * 3] = r;
      rgb[dstOff + x * 3 + 1] = g;
      rgb[dstOff + x * 3 + 2] = b;
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      hist.set(key, (hist.get(key) || 0) + 1);
    }
  }

  const bins = [];
  for (const [key, count] of hist.entries()) {
    bins.push({
      key,
      r: ((key >> 12) & 63) * 4 + 2,
      g: ((key >> 6) & 63) * 4 + 2,
      b: (key & 63) * 4 + 2,
      count,
    });
  }

  function makeBox(items) {
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0, total = 0;
    for (const it of items) {
      if (it.r < minR) minR = it.r;
      if (it.r > maxR) maxR = it.r;
      if (it.g < minG) minG = it.g;
      if (it.g > maxG) maxG = it.g;
      if (it.b < minB) minB = it.b;
      if (it.b > maxB) maxB = it.b;
      total += it.count;
    }
    const rangeR = maxR - minR, rangeG = maxG - minG, rangeB = maxB - minB;
    const axis = rangeB >= rangeG && rangeB >= rangeR ? "b" : (rangeG >= rangeR ? "g" : "r");
    return { items, total, axis, span: Math.max(rangeR, rangeG, rangeB) };
  }

  const boxes = [makeBox(bins)];
  while (boxes.length < 256) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < boxes.length; i++) {
      const bx = boxes[i];
      if (bx.items.length < 2) continue;
      const score = bx.span * Math.log2(bx.total + 2);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const bx = boxes.splice(bestIdx, 1)[0];
    bx.items.sort((a, b) => a[bx.axis] - b[bx.axis]);
    let acc = 0;
    let split = 1;
    const half = bx.total / 2;
    for (let i = 0; i < bx.items.length - 1; i++) {
      acc += bx.items[i].count;
      split = i + 1;
      if (acc >= half) break;
    }
    boxes.push(makeBox(bx.items.slice(0, split)), makeBox(bx.items.slice(split)));
  }

  const palette = [];
  const plte = Buffer.alloc(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    let sr = 0, sg = 0, sb = 0, st = 0;
    for (const it of boxes[i].items) {
      sr += it.r * it.count;
      sg += it.g * it.count;
      sb += it.b * it.count;
      st += it.count;
    }
    const r = Math.min(255, Math.round(sr / st));
    const g = Math.min(255, Math.round(sg / st));
    const b = Math.min(255, Math.round(sb / st));
    palette.push([r, g, b]);
    plte[i * 3] = r;
    plte[i * 3 + 1] = g;
    plte[i * 3 + 2] = b;
  }

  const cache = new Map();
  function nearestColor(r, g, b) {
    const k = ((r >> 1) << 14) | ((g >> 1) << 7) | (b >> 1);
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = r - palette[i][0];
      const dg = g - palette[i][1];
      const db = b - palette[i][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    cache.set(k, best);
    return best;
  }

  const bayer4 = [
    [-7, 1, -5, 3],
    [5, -3, 7, -1],
    [-4, 4, -6, 2],
    [8, 0, 6, -2],
  ];

  const indexed = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const outRow = y * (width + 1);
    const inRow = y * width * 3;
    const bRow = bayer4[y & 3];
    indexed[outRow] = 0;
    for (let x = 0; x < width; x++) {
      const d = bRow[x & 3] >> 1;
      const r = Math.max(0, Math.min(255, rgb[inRow + x * 3] + d));
      const g = Math.max(0, Math.min(255, rgb[inRow + x * 3 + 1] + d));
      const b = Math.max(0, Math.min(255, rgb[inRow + x * 3 + 2] + d));
      indexed[outRow + 1 + x] = nearestColor(r, g, b);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 3;
  const compressed = zlib.deflateSync(indexed, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("PLTE", plte), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

function readPngHeader(buf) {
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(magic)) {
    throw new Error("Invalid PNG signature");
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
  };
}

const ICONS = {
  blocks: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="18" height="18" rx="4"/><rect x="36" y="10" width="18" height="18" rx="4"/><rect x="10" y="36" width="18" height="18" rx="4"/><path d="M45 36v18M36 45h18"/></svg>`,
  chatGroup: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 18a6 6 0 0 1 6-6h22a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H23l-9 7v-7h-2a6 6 0 0 1-2-4V18Z"/><path d="M44 24h4a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-2v6l-8-6H28"/></svg>`,
  shieldCheck: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M32 8 52 16v15c0 13-8.5 21.5-20 25-11.5-3.5-20-12-20-25V16L32 8Z"/><path d="m23 32 6 6 12-13"/></svg>`,
  rocket: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M38 12c8-2 14-2 14-2s0 6-2 14c-2 8-8 14-14 20l-12-12c6-6 12-12 14-20Z"/><path d="M24 32 14 35l-4 11 11-4 3-10"/><circle cx="38" cy="24" r="3.5"/></svg>`,
  sendBubble: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6H26l-12 9v-9h-2a6 6 0 0 1-6-6V16Z"/><path d="m24 26 6 6 12-12"/></svg>`,
  menuGrid: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="14" width="44" height="36" rx="6"/><path d="M10 32h44M25 14v36M39 14v36"/></svg>`,
  toggleOn: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="20" width="48" height="24" rx="12"/><circle cx="44" cy="32" r="7" fill="currentColor"/></svg>`,
  usersPlus: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="25" cy="23" r="8"/><path d="M11 49c0-8 6.5-13 14-13s14 5 14 13"/><path d="M47 23v14M40 30h14"/></svg>`,
  atSign: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="10"/><path d="M42 32v4a6 6 0 0 0 12 0v-4a22 22 0 1 0-8 17"/></svg>`,
  bolt: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M35 8 15 35h16l-3 21 21-28H33l2-20Z"/></svg>`,
  headset: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 33a19 19 0 0 1 38 0"/><rect x="10" y="33" width="9" height="15" rx="4"/><rect x="45" y="33" width="9" height="15" rx="4"/><path d="M49 48v3a6 6 0 0 1-6 6h-8"/></svg>`,
  playResume: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="22"/><path d="m27 22 16 10-16 10V22Z" fill="currentColor"/></svg>`,
  arrowRight: `<svg viewBox="0 0 36 36" fill="none"><circle cx="18" cy="18" r="16" fill="rgba(15,140,232,0.18)" stroke="rgba(56,189,248,0.55)" stroke-width="1.6"/><path d="M12 18h11m-4.5-4.5L23.5 18l-5 4.5" stroke="#BAE6FD" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const BASE_CSS = `
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#050B21;font-family:"Segoe UI","Leelawadee UI",system-ui,-apple-system,sans-serif;color:#FFFFFF;-webkit-font-smoothing:antialiased}
  .canvas{position:relative;width:${WIDTH}px;height:${HEIGHT}px;padding:24px 44px 26px;display:flex;flex-direction:column;background:
    radial-gradient(640px 380px at 50% 0%, rgba(15,140,232,0.26) 0%, rgba(8,19,54,0) 70%),
    radial-gradient(480px 320px at 12% 92%, rgba(56,189,248,0.14) 0%, rgba(5,11,33,0) 68%),
    radial-gradient(480px 320px at 88% 88%, rgba(30,64,175,0.22) 0%, rgba(5,11,33,0) 68%),
    linear-gradient(180deg, #060D28 0%, #081337 52%, #04091B 100%)}
  .bg-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .content{position:relative;z-index:2;display:flex;flex-direction:column;height:100%}
  .header{min-height:60px;display:flex;align-items:center;justify-content:space-between;padding-bottom:13px;border-bottom:1.5px solid rgba(56,189,248,0.24)}
  .brand img{height:38px;width:auto;display:block;filter:drop-shadow(0 0 8px rgba(56,189,248,0.32))}
  .header-right{display:flex;align-items:center;gap:16px}
  .header-stack{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
  .kicker-sm{font-size:11px;font-weight:800;letter-spacing:0.22em;color:#38BDF8;text-transform:uppercase;line-height:1}
  .tagline-sm{font-size:15px;font-weight:500;color:rgba(226,238,255,0.88)}
  .pill{display:inline-flex;align-items:center;gap:8px;padding:5px 14px;border-radius:999px;background:rgba(15,140,232,0.18);border:1.5px solid rgba(56,189,248,0.48);font-size:12px;font-weight:800;letter-spacing:0.12em;color:#E0F2FE;text-transform:uppercase;line-height:1.1}
  .pill .dot{width:8px;height:8px;border-radius:50%;background:#38BDF8;box-shadow:0 0 10px #38BDF8}
  .pill.live .dot{background:#34D399;box-shadow:0 0 10px #34D399}
  .pill.live{border-color:rgba(52,211,153,0.52);background:rgba(16,185,129,0.14)}
  .title-block{margin-top:14px;display:flex;flex-direction:column;gap:4px}
  .title-row{display:flex;align-items:baseline;justify-content:space-between;gap:20px}
  .headline{font-size:40px;font-weight:800;letter-spacing:-0.015em;line-height:1.1;color:#FFFFFF}
  .th-sub{font-size:21px;font-weight:600;color:#7DD3FC;letter-spacing:0.01em}
  .card{position:relative;border-radius:22px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(155deg, rgba(17,34,84,0.92) 0%, rgba(8,17,46,0.96) 100%);border:2px solid rgba(56,189,248,0.34);box-shadow:0 16px 36px rgba(2,6,23,0.56), inset 0 1.5px 0 rgba(186,230,253,0.18);overflow:hidden}
  .card.featured{background:linear-gradient(148deg, rgba(16,86,178,0.92) 0%, rgba(11,34,96,0.96) 58%, rgba(8,21,62,0.98) 100%);border:2.5px solid rgba(56,189,248,0.82);box-shadow:0 18px 42px rgba(15,140,232,0.28), inset 0 1.5px 0 rgba(224,242,254,0.38)}
  .card.caution{background:linear-gradient(155deg, rgba(24,38,88,0.94) 0%, rgba(10,18,48,0.97) 100%);border:2px solid rgba(251,191,36,0.58);box-shadow:0 16px 36px rgba(2,6,23,0.56), inset 0 1.5px 0 rgba(253,230,138,0.22)}
  .card-bar{position:absolute;left:24px;right:24px;bottom:0;height:4.5px;border-radius:5px 5px 0 0;background:linear-gradient(90deg, #1E3A8A 0%, #0F8CE8 55%, #38BDF8 100%);opacity:0.82}
  .card.featured .card-bar{opacity:1;height:5.5px;background:linear-gradient(90deg, #38BDF8 0%, #BAE6FD 50%, #0F8CE8 100%)}
  .card.caution .card-bar{opacity:0.95;background:linear-gradient(90deg, #D97706 0%, #FBBF24 55%, #FDE68A 100%)}
  .mono{font-family:ui-monospace,Consolas,monospace}
  .arrow-col{width:38px;flex:0 0 38px;display:flex;align-items:center;justify-content:center}
  .arrow-col svg{width:32px;height:32px;filter:drop-shadow(0 0 8px rgba(56,189,248,0.3))}
`;

function wrapPage(bodyHtml, extraCss = "", nodePos = { x: 960, y: 122 }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${BASE_CSS}${extraCss}</style></head>
<body>
  <div class="canvas">
    <svg class="bg-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="dotgrid" width="26" height="26" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.25" fill="#38BDF8" fill-opacity="0.11"/>
        </pattern>
        <linearGradient id="arc1" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.02"/>
          <stop offset="50%" stop-color="#38BDF8" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#0F8CE8" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#dotgrid)"/>
      <path d="M -40 220 Q 380 68 ${nodePos.x} ${nodePos.y} T 1240 190" fill="none" stroke="url(#arc1)" stroke-width="2.1"/>
      <path d="M -30 480 Q 320 290 600 356 T 1230 430" fill="none" stroke="url(#arc1)" stroke-width="1.7"/>
      <path d="M ${nodePos.x} ${nodePos.y} Q 540 270 150 620" fill="none" stroke="url(#arc1)" stroke-width="1.4"/>
      <path d="M ${nodePos.x} ${nodePos.y} Q 980 280 1120 620" fill="none" stroke="url(#arc1)" stroke-width="1.4"/>
      <circle cx="${nodePos.x}" cy="${nodePos.y}" r="4.5" fill="#7DD3FC" fill-opacity="0.65"/>
      <circle cx="${nodePos.x}" cy="${nodePos.y}" r="16" fill="#38BDF8" fill-opacity="0.13"/>
      <rect x="44" y="613" width="1112" height="2.5" rx="1.25" fill="url(#arc1)"/>
    </svg>
    <div class="content">${bodyHtml}</div>
  </div>
</body></html>`;
}

function renderWelcome(wordmarkDataUri) {
  const extraCss = `
    .hero{margin-top:20px;display:flex;flex-direction:column;gap:8px}
    .hero-kicker{display:inline-flex;align-items:center;gap:12px;font-size:14px;font-weight:800;letter-spacing:0.26em;color:#38BDF8;text-transform:uppercase}
    .hero-kicker .bar{width:30px;height:3px;border-radius:3px;background:linear-gradient(90deg,#0F8CE8,#7DD3FC);box-shadow:0 0 10px #38BDF8}
    .hero-title{font-size:47px;font-weight:800;letter-spacing:-0.018em;line-height:1.08;color:#FFFFFF}
    .grid-3{margin-top:24px;display:grid;grid-template-columns:repeat(3,1fr);gap:22px;flex:1}
    .w-card{padding:24px 26px 26px}
    .w-top{display:flex;align-items:flex-start;justify-content:space-between}
    .icon-box{width:64px;height:64px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg, rgba(56,189,248,0.24), rgba(24,24,75,0.68));border:1.8px solid rgba(56,189,248,0.52);color:#7DD3FC}
    .card.featured .icon-box{background:linear-gradient(145deg, rgba(56,189,248,0.44), rgba(15,140,232,0.28));border-color:#BAE6FD;color:#FFFFFF}
    .icon-box svg{width:36px;height:36px}
    .code{font-size:24px;font-weight:800;letter-spacing:0.12em;color:rgba(125,211,252,0.78);padding-top:4px}
    .card.featured .code{color:#BAE6FD}
    .motif{display:flex;align-items:center;gap:8px;margin-top:20px}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:9px;background:rgba(4,10,28,0.68);border:1px solid rgba(56,189,248,0.32);font-size:13.5px;font-weight:700;color:#BAE6FD}
    .chip.green{border-color:rgba(6,199,85,0.55);background:rgba(6,199,85,0.16);color:#86EFAC}
    .chip.emerald{border-color:rgba(52,211,153,0.5);background:rgba(16,185,129,0.16);color:#6EE7B7}
    .chip-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
    .chip-arrow{color:rgba(125,211,252,0.55);font-size:13px;font-weight:800}
    .w-body{margin-top:18px;display:flex;flex-direction:column;gap:7px}
    .w-title{font-size:28px;font-weight:800;line-height:1.14;color:#FFFFFF;letter-spacing:-0.012em}
    .w-sub{font-size:17.5px;font-weight:600;color:#93C5FD}
    .card.featured .w-sub{color:#E0F2FE}
    .th-foot{margin-top:16px;padding-top:14px;border-top:1px solid rgba(56,189,248,0.22);display:flex;align-items:center;gap:9px;font-size:20px;font-weight:600;color:#E0F2FE}
    .th-dot{width:8px;height:8px;border-radius:50%;background:#38BDF8;box-shadow:0 0 8px #38BDF8;flex-shrink:0}
    .th-dot.live{background:#34D399;box-shadow:0 0 8px #34D399}
  `;

  return wrapPage(`
    <div class="header">
      <div class="brand"><img src="${wordmarkDataUri}" alt="Neurohands"/></div>
      <div class="header-right">
        <div class="tagline-sm">Helping humans learn and grow.</div>
        <div class="pill live"><span class="dot"></span><span>LINE AI PLATFORM</span></div>
      </div>
    </div>
    <div class="hero">
      <div class="hero-kicker"><span class="bar"></span><span>FROM THAILAND TO THE WORLD</span></div>
      <div class="hero-title">Build Your AI Agent Team for LINE</div>
    </div>
    <div class="grid-3">
      <div class="card w-card">
        <div>
          <div class="w-top">
            <div class="icon-box">${ICONS.blocks}</div>
            <div class="code mono">01</div>
          </div>
          <div class="motif">
            <span class="chip">Agent</span><span class="chip-arrow">→</span>
            <span class="chip">Rules</span><span class="chip-arrow">→</span>
            <span class="chip emerald"><span class="chip-dot"></span>60s</span>
          </div>
          <div class="w-body">
            <div class="w-title">Build in 60s</div>
            <div class="w-sub">Drag &amp; Drop Builder</div>
          </div>
        </div>
        <div class="th-foot"><span class="th-dot"></span><span>สร้างเอเจนต์ใน 60 วิ</span></div>
        <div class="card-bar"></div>
      </div>
      <div class="card featured w-card">
        <div>
          <div class="w-top">
            <div class="icon-box">${ICONS.chatGroup}</div>
            <div class="code mono">02</div>
          </div>
          <div class="motif">
            <span class="chip green"><span class="chip-dot"></span>1:1 Chat</span>
            <span class="chip"><span class="chip-dot"></span>Team Groups</span>
          </div>
          <div class="w-body">
            <div class="w-title">LINE 1:1 &amp; Groups</div>
            <div class="w-sub">Direct &amp; Multi-User Rooms</div>
          </div>
        </div>
        <div class="th-foot"><span class="th-dot live"></span><span>เชื่อม LINE 1:1 และกลุ่ม</span></div>
        <div class="card-bar"></div>
      </div>
      <div class="card w-card">
        <div>
          <div class="w-top">
            <div class="icon-box">${ICONS.shieldCheck}</div>
            <div class="code mono">03</div>
          </div>
          <div class="motif">
            <span class="chip emerald"><span class="chip-dot"></span>Approve</span>
            <span class="chip">Pause</span>
            <span class="chip">Take Over</span>
          </div>
          <div class="w-body">
            <div class="w-title">Human Approval<br/>&amp; Control</div>
            <div class="w-sub">Safe Human-in-the-Loop</div>
          </div>
        </div>
        <div class="th-foot"><span class="th-dot live"></span><span>คนอนุมัติและคุมแชทได้ตลอด</span></div>
        <div class="card-bar"></div>
      </div>
    </div>
  `, extraCss, { x: 600, y: 102 });
}

const STEP_CSS = `
  .steps-wrap{margin-top:18px;display:flex;align-items:stretch;flex:1}
  .step-card{flex:1;min-width:0;padding:20px 22px 24px}
  .step-top{display:flex;align-items:center;justify-content:space-between}
  .step-badge{display:inline-flex;align-items:center;gap:8px;padding:5px 12px;border-radius:10px;background:rgba(56,189,248,0.16);border:1.5px solid rgba(56,189,248,0.44);font-size:15px;font-weight:800;letter-spacing:0.1em;color:#BAE6FD}
  .card.featured .step-badge{background:rgba(186,230,253,0.2);border-color:#BAE6FD;color:#FFFFFF}
  .step-icon{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:rgba(15,140,232,0.18);border:1.5px solid rgba(56,189,248,0.42);color:#7DD3FC}
  .card.featured .step-icon{background:rgba(56,189,248,0.34);border-color:#BAE6FD;color:#FFFFFF}
  .step-icon svg{width:24px;height:24px}
  .visual-box{margin:14px 0 18px;height:172px;border-radius:16px;background:rgba(4,10,28,0.82);border:1.5px solid rgba(56,189,248,0.26);padding:15px 16px;display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
  .card.featured .visual-box{border-color:rgba(125,211,252,0.46);background:rgba(3,9,26,0.84)}
  .step-title{font-size:24.5px;font-weight:800;line-height:1.15;color:#FFFFFF;letter-spacing:-0.01em}
  .step-desc{margin-top:8px;font-size:17px;font-weight:500;line-height:1.34;color:#93C5FD}
  .card.featured .step-desc{color:#E0F2FE}
  .step-desc code{font-family:ui-monospace,Consolas,monospace;font-weight:700;color:#FFFFFF;background:rgba(56,189,248,0.18);padding:1px 6px;border-radius:5px}
  .mini-bar{display:flex;align-items:center;justify-content:space-between;padding-bottom:8px;border-bottom:1px solid rgba(148,163,184,0.18)}
  .win-dots{display:flex;gap:5px}
  .win-dots span{width:7px;height:7px;border-radius:50%;background:rgba(148,163,184,0.45)}
  .win-dots span:first-child{background:#38BDF8}
  .url-chip{font-size:13px;font-weight:700;color:#7DD3FC;background:rgba(15,140,232,0.18);border:1px solid rgba(56,189,248,0.36);padding:2px 10px;border-radius:6px}
  .agent-row{display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(12,28,77,0.72);border:1px solid rgba(56,189,248,0.3);border-radius:12px;padding:10px 12px}
  .agent-id{display:flex;align-items:center;gap:10px}
  .avatar{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#0F8CE8,#38BDF8);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:17px;color:#04091B}
  .agent-name{font-size:16px;font-weight:800;color:#FFFFFF;line-height:1.1}
  .agent-role{font-size:12px;font-weight:600;color:#93C5FD}
  .save-btn{padding:6px 12px;border-radius:8px;background:linear-gradient(135deg,#0F8CE8,#38BDF8);font-size:13px;font-weight:800;color:#04091B;white-space:nowrap}
  .line-head{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:700;color:#CBD5E1;padding-bottom:8px;border-bottom:1px solid rgba(148,163,184,0.18)}
  .line-oa{display:flex;align-items:center;gap:7px}
  .line-dot{width:9px;height:9px;border-radius:50%;background:#06C755;box-shadow:0 0 8px #06C755}
  .chat-stage{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;gap:8px;padding-top:6px}
  .chat-row{display:flex;align-items:flex-end;gap:8px}
  .chat-meta{font-size:11.5px;font-weight:600;color:#94A3B8;text-align:right;line-height:1.2}
  .line-bubble{position:relative;background:linear-gradient(135deg, #06C755 0%, #05B34C 100%);color:#FFFFFF;font-size:19.5px;font-weight:800;padding:11px 16px;border-radius:16px 16px 4px 16px;box-shadow:0 8px 22px rgba(6,199,85,0.34);letter-spacing:0.01em;white-space:nowrap}
  .chat-hint{font-size:12px;font-weight:600;color:#86EFAC;display:flex;align-items:center;gap:6px}
  .rm-top{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-weight:800;letter-spacing:0.08em;color:#6EE7B7}
  .rm-live{display:inline-flex;align-items:center;gap:6px}
  .rm-live-dot{width:7px;height:7px;border-radius:50%;background:#34D399;box-shadow:0 0 8px #34D399}
  .rm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:7px 0}
  .rm-tile{height:30px;border-radius:7px;background:rgba(17,34,84,0.9);border:1px solid rgba(56,189,248,0.34);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:800;color:#BAE6FD;letter-spacing:0.04em}
  .rm-tile.hi{background:linear-gradient(145deg,rgba(15,140,232,0.75),rgba(12,42,112,0.95));border-color:#7DD3FC;color:#FFFFFF}
  .rm-bar{height:24px;border-radius:7px;background:rgba(15,140,232,0.22);border:1px solid rgba(56,189,248,0.42);display:flex;align-items:center;justify-content:center;gap:8px;font-size:12.5px;font-weight:800;color:#FFFFFF}
`;

function renderActivate1to1(wordmarkDataUri) {
  return wrapPage(`
    <div class="header">
      <div class="brand"><img src="${wordmarkDataUri}" alt="Neurohands"/></div>
      <div class="header-stack">
        <div class="kicker-sm">FROM THAILAND TO THE WORLD</div>
        <div class="pill live"><span class="dot"></span><span>LINE 1:1 ACTIVATION</span></div>
      </div>
    </div>
    <div class="title-block">
      <div class="headline">Connect LINE 1:1 Chat in 3 Steps</div>
      <div class="th-sub">เชื่อมแชท LINE 1:1 ใน 3 ขั้นตอน</div>
    </div>
    <div class="steps-wrap">
      <div class="card step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 01</div>
            <div class="step-icon">${ICONS.rocket}</div>
          </div>
          <div class="visual-box">
            <div class="mini-bar">
              <div class="win-dots"><span></span><span></span><span></span></div>
              <div class="url-chip mono">/neurohands</div>
            </div>
            <div class="agent-row">
              <div class="agent-id">
                <div class="avatar">A</div>
                <div>
                  <div class="agent-name">Aria</div>
                  <div class="agent-role">Starter AI Agent</div>
                </div>
              </div>
              <div class="save-btn">Save ✓</div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;color:#7DD3FC">
              <span>Code issued:</span>
              <span class="mono" style="color:#FFFFFF">NH-XXXX</span>
            </div>
          </div>
          <div class="step-title">Start Free Trial</div>
          <div class="step-desc">Open <code>/neurohands</code> &amp; save Aria</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-col">${ICONS.arrowRight}</div>

      <div class="card featured step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 02</div>
            <div class="step-icon">${ICONS.sendBubble}</div>
          </div>
          <div class="visual-box">
            <div class="line-head">
              <div class="line-oa"><span class="line-dot"></span><span>Neurohands Official</span></div>
              <span style="font-size:11.5px;color:#7DD3FC">1:1 Chat</span>
            </div>
            <div class="chat-stage">
              <div class="chat-row">
                <div class="chat-meta">Read<br/>09:41</div>
                <div class="line-bubble mono">activate NH-XXXX</div>
              </div>
              <div class="chat-hint">✓ Instant workspace pairing</div>
            </div>
          </div>
          <div class="step-title">Send Code in LINE</div>
          <div class="step-desc">Send <code>activate NH-XXXX</code><br/>in your 1:1 LINE chat</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-col">${ICONS.arrowRight}</div>

      <div class="card step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 03</div>
            <div class="step-icon">${ICONS.menuGrid}</div>
          </div>
          <div class="visual-box">
            <div class="rm-top">
              <span class="rm-live"><span class="rm-live-dot"></span>AI AGENT ACTIVE</span>
              <span style="color:#93C5FD">AUTO-SYNC</span>
            </div>
            <div class="rm-grid">
              <div class="rm-tile">ORDERS</div>
              <div class="rm-tile">CATALOG</div>
              <div class="rm-tile">ETA</div>
              <div class="rm-tile hi">QUOTE</div>
              <div class="rm-tile">SUPPORT</div>
              <div class="rm-tile hi">MY AGENT</div>
            </div>
            <div class="rm-bar"><span>My Neurohands</span><span style="color:#7DD3FC;font-size:10px">▲</span></div>
          </div>
          <div class="step-title">Active Menu Ready</div>
          <div class="step-desc">My Neurohands menu switches automatically</div>
        </div>
        <div class="card-bar"></div>
      </div>
    </div>
  `, STEP_CSS);
}

function renderConnectGroup(wordmarkDataUri) {
  const extraCss = `
    ${STEP_CSS}
    .setting-card{display:flex;align-items:center;justify-content:space-between;gap:10px;background:rgba(12,28,77,0.75);border:1px solid rgba(56,189,248,0.32);border-radius:12px;padding:11px 13px}
    .setting-lbl{font-size:14.5px;font-weight:700;color:#FFFFFF;line-height:1.2}
    .setting-sub{font-size:11.5px;font-weight:600;color:#93C5FD;margin-top:2px}
    .switch{width:46px;height:26px;border-radius:999px;background:linear-gradient(135deg,#06C755,#05B34C);padding:3px;display:flex;justify-content:flex-end;align-items:center;box-shadow:0 0 12px rgba(6,199,85,0.4);flex-shrink:0}
    .switch-knob{width:20px;height:20px;border-radius:50%;background:#FFFFFF}
    .rule-pill{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:5px 11px;border-radius:8px;background:rgba(15,140,232,0.18);border:1px solid rgba(56,189,248,0.4);font-size:12.5px;font-weight:700;color:#BAE6FD}
    .grp-members{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:#86EFAC;background:rgba(6,199,85,0.16);border:1px solid rgba(6,199,85,0.4);padding:2px 8px;border-radius:999px}
    .filter-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 11px;border-radius:10px;background:rgba(15,23,42,0.76);border:1px solid rgba(148,163,184,0.22)}
    .filter-row.muted{opacity:0.78}
    .filter-row.active{background:rgba(15,140,232,0.22);border-color:rgba(56,189,248,0.58)}
    .filter-text{font-size:13.5px;font-weight:600;color:#CBD5E1;white-space:nowrap}
    .mention-tag{display:inline-block;padding:1px 7px;border-radius:6px;background:rgba(56,189,248,0.28);color:#FFFFFF;font-weight:800;margin-right:4px}
    .badge-silent{font-size:11px;font-weight:800;color:#94A3B8;background:rgba(148,163,184,0.16);padding:3px 8px;border-radius:6px;white-space:nowrap}
    .badge-reply{font-size:11px;font-weight:800;color:#04091B;background:#34D399;padding:3px 8px;border-radius:6px;white-space:nowrap}
    .kw-foot{display:flex;align-items:center;justify-content:space-between;font-size:12px;font-weight:700;color:#7DD3FC}
  `;

  return wrapPage(`
    <div class="header">
      <div class="brand"><img src="${wordmarkDataUri}" alt="Neurohands"/></div>
      <div class="header-stack">
        <div class="kicker-sm">FROM THAILAND TO THE WORLD</div>
        <div class="pill"><span class="dot"></span><span>LINE GROUP CONNECT</span></div>
      </div>
    </div>
    <div class="title-block">
      <div class="headline">Connect LINE Group Chat in 3 Steps</div>
      <div class="th-sub">เชื่อมกลุ่ม LINE ใน 3 ขั้นตอน</div>
    </div>
    <div class="steps-wrap">
      <div class="card step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 01</div>
            <div class="step-icon">${ICONS.toggleOn}</div>
          </div>
          <div class="visual-box">
            <div class="line-head">
              <span>LINE OA Manager</span>
              <span style="color:#86EFAC;font-size:11.5px">Settings</span>
            </div>
            <div class="setting-card">
              <div>
                <div class="setting-lbl">Join Group Chats</div>
                <div class="setting-sub">Allow bot in rooms</div>
              </div>
              <div class="switch"><div class="switch-knob"></div></div>
            </div>
            <div class="rule-pill"><span>●</span><span>Policy: 1 OA per group</span></div>
          </div>
          <div class="step-title">Enable Group Access</div>
          <div class="step-desc">LINE OA Manager · 1 OA per group</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-col">${ICONS.arrowRight}</div>

      <div class="card featured step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 02</div>
            <div class="step-icon">${ICONS.usersPlus}</div>
          </div>
          <div class="visual-box">
            <div class="line-head">
              <div class="line-oa"><span class="line-dot"></span><span>Ops Team Group (6)</span></div>
              <span class="grp-members">+ Bot Joined</span>
            </div>
            <div class="chat-stage">
              <div class="chat-row">
                <div class="chat-meta">Read 5<br/>10:15</div>
                <div class="line-bubble mono">bind NH-XXXX</div>
              </div>
              <div class="chat-hint">✓ Group bound to your workspace</div>
            </div>
          </div>
          <div class="step-title">Invite &amp; Bind</div>
          <div class="step-desc">Send <code>bind NH-XXXX</code><br/>inside your LINE group</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-col">${ICONS.arrowRight}</div>

      <div class="card step-card">
        <div>
          <div class="step-top">
            <div class="step-badge mono">STEP 03</div>
            <div class="step-icon">${ICONS.atSign}</div>
          </div>
          <div class="visual-box">
            <div class="filter-row muted">
              <span class="filter-text">"Lunch at 12:30?"</span>
              <span class="badge-silent">SILENT</span>
            </div>
            <div class="filter-row active">
              <span class="filter-text"><span class="mention-tag">@Neurohands</span>ETA?</span>
              <span class="badge-reply">REPLIES</span>
            </div>
            <div class="kw-foot">
              <span>Triggers: @mention · keyword</span>
              <span style="color:#34D399">● Ready</span>
            </div>
          </div>
          <div class="step-title">Mention @Neurohands</div>
          <div class="step-desc">Silent on chatter · replies on @mention or keyword</div>
        </div>
        <div class="card-bar"></div>
      </div>
    </div>
  `, extraCss);
}

function renderHumanControl(wordmarkDataUri) {
  const extraCss = `
    .canvas{padding:22px 44px 24px}
    .header{min-height:56px;padding-bottom:11px}
    .brand img{height:36px}
    .title-block{margin-top:12px;gap:3px}
    .headline{font-size:38px}
    .th-sub{font-size:19.5px}
    .flow-row{margin-top:14px;display:flex;align-items:stretch;height:316px}
    .node-card{flex:1;min-width:0;padding:18px 18px 20px}
    .arrow-sm{width:30px;flex:0 0 30px;display:flex;align-items:center;justify-content:center}
    .arrow-sm svg{width:26px;height:26px;filter:drop-shadow(0 0 6px rgba(56,189,248,0.3))}
    .n-top{display:flex;align-items:center;justify-content:space-between}
    .n-num{font-size:18px;font-weight:800;letter-spacing:0.12em;color:#7DD3FC}
    .card.featured .n-num{color:#BAE6FD}
    .card.caution .n-num{color:#FDE68A}
    .n-icon{width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:rgba(15,140,232,0.18);border:1.5px solid rgba(56,189,248,0.44);color:#7DD3FC}
    .n-icon.emerald{background:rgba(16,185,129,0.18);border-color:rgba(52,211,153,0.55);color:#34D399}
    .n-icon.amber{background:rgba(245,158,11,0.18);border-color:rgba(251,191,36,0.58);color:#FBBF24}
    .card.featured .n-icon{background:rgba(56,189,248,0.34);border-color:#BAE6FD;color:#FFFFFF}
    .n-icon svg{width:22px;height:22px}
    .n-stage{margin:14px 0 14px;height:112px;border-radius:14px;background:rgba(4,10,28,0.82);border:1.5px solid rgba(56,189,248,0.24);padding:12px 13px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;text-align:center}
    .card.caution .n-stage{border-color:rgba(251,191,36,0.42)}
    .card.featured .n-stage{border-color:rgba(125,211,252,0.46)}
    .big-metric{font-size:33px;font-weight:800;line-height:1;letter-spacing:-0.02em}
    .big-metric.emerald{color:#34D399;text-shadow:0 0 14px rgba(52,211,153,0.35)}
    .big-metric.amber{color:#FBBF24;text-shadow:0 0 14px rgba(251,191,36,0.3)}
    .meter-track{width:100%;height:7px;border-radius:999px;background:rgba(148,163,184,0.2);overflow:hidden}
    .meter-fill{width:86%;height:100%;border-radius:999px;background:linear-gradient(90deg,#10B981,#34D399)}
    .micro-lbl{font-size:11.5px;font-weight:800;letter-spacing:0.12em;color:#93C5FD;text-transform:uppercase}
    .gate-btns{display:flex;flex-direction:column;gap:8px;width:100%}
    .gate-btn{width:100%;padding:7px 10px;border-radius:9px;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;gap:7px}
    .gate-btn.approve{background:rgba(16,185,129,0.22);border:1.5px solid #34D399;color:#6EE7B7}
    .gate-btn.reject{background:rgba(244,63,94,0.16);border:1.5px solid rgba(251,113,133,0.68);color:#FDA4AF}
    .pause-pill{padding:5px 12px;border-radius:8px;background:rgba(251,191,36,0.16);border:1.5px solid rgba(251,191,36,0.58);font-size:13px;font-weight:800;color:#FDE68A;letter-spacing:0.06em}
    .resume-btn{padding:10px 18px;border-radius:11px;background:linear-gradient(135deg,#0F8CE8,#38BDF8);color:#04091B;font-size:16px;font-weight:800;box-shadow:0 6px 18px rgba(56,189,248,0.38);display:inline-flex;align-items:center;gap:8px}
    .resume-sub{font-size:12px;font-weight:700;color:#86EFAC;display:inline-flex;align-items:center;gap:6px}
    .n-title{font-size:20.5px;font-weight:800;line-height:1.18;color:#FFFFFF}
    .n-sub{margin-top:6px;font-size:14.5px;font-weight:600;line-height:1.25;color:#93C5FD}
    .card.caution .n-sub{color:#FDE68A}
    .card.featured .n-sub{color:#E0F2FE}
    .kpi-bar{margin-top:16px;height:66px;border-radius:16px;background:linear-gradient(90deg, rgba(11,24,62,0.94), rgba(8,19,54,0.96), rgba(11,24,62,0.94));border:1.5px solid rgba(56,189,248,0.34);display:grid;grid-template-columns:repeat(4,1fr);align-items:center;box-shadow:0 10px 26px rgba(2,6,23,0.48)}
    .kpi-cell{padding:0 20px;display:flex;flex-direction:column;gap:2px;border-right:1px solid rgba(56,189,248,0.22)}
    .kpi-cell:last-child{border-right:none}
    .kpi-lbl{font-size:11px;font-weight:800;letter-spacing:0.14em;color:#93C5FD;text-transform:uppercase}
    .kpi-val{font-size:20px;font-weight:800;color:#FFFFFF;line-height:1.15}
    .kpi-val.emerald{color:#34D399}
    .kpi-val.cyan{color:#38BDF8}
    .kpi-val.amber{color:#FBBF24}
  `;

  return wrapPage(`
    <div class="header">
      <div class="brand"><img src="${wordmarkDataUri}" alt="Neurohands"/></div>
      <div class="header-stack">
        <div class="kicker-sm">FROM THAILAND TO THE WORLD</div>
        <div class="pill live"><span class="dot"></span><span>HUMAN-IN-THE-LOOP</span></div>
      </div>
    </div>
    <div class="title-block">
      <div class="headline">Human-in-the-Loop Control &amp; KPIs</div>
      <div class="th-sub">ควบคุมได้ทุกขั้นตอน + วัดผลจริง</div>
    </div>
    <div class="flow-row">
      <div class="card node-card">
        <div>
          <div class="n-top">
            <div class="n-num mono">01</div>
            <div class="n-icon emerald">${ICONS.bolt}</div>
          </div>
          <div class="n-stage">
            <div class="big-metric emerald mono">&lt;2.5s</div>
            <div class="meter-track"><div class="meter-fill"></div></div>
            <div class="micro-lbl">LIVE RESPONSE SLA</div>
          </div>
          <div class="n-title">AI Active</div>
          <div class="n-sub">&lt;2.5s SLA · Auto-replies</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-sm">${ICONS.arrowRight}</div>

      <div class="card node-card">
        <div>
          <div class="n-top">
            <div class="n-num mono">02</div>
            <div class="n-icon">${ICONS.shieldCheck}</div>
          </div>
          <div class="n-stage">
            <div class="gate-btns">
              <div class="gate-btn approve"><span>✓</span><span>Approve</span></div>
              <div class="gate-btn reject"><span>✕</span><span>Reject</span></div>
            </div>
          </div>
          <div class="n-title">Approval Gate</div>
          <div class="n-sub">Approve / Reject actions</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-sm">${ICONS.arrowRight}</div>

      <div class="card caution node-card">
        <div>
          <div class="n-top">
            <div class="n-num mono">03</div>
            <div class="n-icon amber">${ICONS.headset}</div>
          </div>
          <div class="n-stage">
            <div class="big-metric amber mono">0 AI</div>
            <div class="pause-pill">0 AI REPLY</div>
          </div>
          <div class="n-title">Human Take Over<br/>/ Pause</div>
          <div class="n-sub">Staff owns chat · 0 AI reply</div>
        </div>
        <div class="card-bar"></div>
      </div>

      <div class="arrow-sm">${ICONS.arrowRight}</div>

      <div class="card featured node-card">
        <div>
          <div class="n-top">
            <div class="n-num mono">04</div>
            <div class="n-icon">${ICONS.playResume}</div>
          </div>
          <div class="n-stage">
            <div class="resume-btn"><span>▶</span><span>Resume AI</span></div>
            <div class="resume-sub"><span>●</span><span>1-Click Handoff</span></div>
          </div>
          <div class="n-title">Resume AI</div>
          <div class="n-sub">Instant return · Full audit</div>
        </div>
        <div class="card-bar"></div>
      </div>
    </div>

    <div class="kpi-bar">
      <div class="kpi-cell">
        <div class="kpi-lbl">RESPONSE SLA</div>
        <div class="kpi-val emerald">&lt; 2.5s Live</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-lbl">APPROVAL GATE</div>
        <div class="kpi-val cyan">100% Audited</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-lbl">PAUSE GUARANTEE</div>
        <div class="kpi-val amber">0 AI Replies</div>
      </div>
      <div class="kpi-cell">
        <div class="kpi-lbl">HANDOFF CONTROL</div>
        <div class="kpi-val">Instant Resume</div>
      </div>
    </div>
  `, extraCss);
}

const GUIDES = [
  { file: "guide-welcome.png", render: renderWelcome },
  { file: "guide-activate-1to1.png", render: renderActivate1to1 },
  { file: "guide-connect-group.png", render: renderConnectGroup },
  { file: "guide-human-control.png", render: renderHumanControl },
];

function findChrome() {
  for (const p of [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean)) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Chrome/Edge binary not found");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(80);
  }
  throw new Error(`Timeout waiting for ${label}`);
}

async function main() {
  if (!fs.existsSync(WORDMARK_PNG)) {
    throw new Error(`Missing wordmark PNG: ${WORDMARK_PNG}`);
  }
  fs.mkdirSync(GUIDE_DIR, { recursive: true });

  const wordmarkDataUri = `data:image/png;base64,${fs.readFileSync(WORDMARK_PNG).toString("base64")}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nh-guide-gen-"));
  const profile = path.join(scratch, "profile");
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(findChrome(), [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
  ], { stdio: "ignore" });

  let ws;
  try {
    const port = await until(() => {
      const f = path.join(profile, "DevToolsActivePort");
      if (!fs.existsSync(f)) return null;
      const n = Number(fs.readFileSync(f, "utf8").split(/\r?\n/)[0]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }, "DevToolsActivePort");

    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === "page");
    }, "page target");

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 1;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = id++;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const results = [];
    for (const guide of GUIDES) {
      const htmlPath = path.join(scratch, `${guide.file}.html`);
      fs.writeFileSync(htmlPath, guide.render(wordmarkDataUri), "utf8");
      await send("Page.navigate", { url: `file:///${htmlPath.replace(/\\/g, "/")}` });
      await until(async () => {
        const r = await send("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0)",
          returnByValue: true,
        });
        return r.result?.value === true;
      }, `${guide.file} render`);
      await sleep(150);

      const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const rawBuf = Buffer.from(shot.data, "base64");
      const buf = encodePalettePng256(rawBuf);
      const outPath = path.join(GUIDE_DIR, guide.file);
      fs.writeFileSync(outPath, buf);

      const hdr = readPngHeader(buf);
      if (hdr.width !== WIDTH || hdr.height !== HEIGHT) {
        throw new Error(`${guide.file}: expected ${WIDTH}x${HEIGHT}, got ${hdr.width}x${hdr.height}`);
      }
      if (buf.length >= MAX_BYTES) {
        throw new Error(`${guide.file}: ${buf.length} bytes exceeds ${MAX_BYTES} byte limit`);
      }

      results.push({
        file: guide.file,
        path: outPath,
        width: hdr.width,
        height: hdr.height,
        bytes: buf.length,
        kb: Number((buf.length / 1024).toFixed(1)),
        under220Kb: buf.length < MAX_BYTES,
      });
    }
    console.log(JSON.stringify(results, null, 2));
  } finally {
    if (ws) try { ws.close(); } catch {}
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      chrome.kill("SIGKILL");
    }
    await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
