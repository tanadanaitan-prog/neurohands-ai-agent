import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, "..");
const ASSET_DIR = path.join(PLATFORM_DIR, "assets", "rich-menus");
const CONFIG_DIR = path.join(PLATFORM_DIR, "config", "rich-menus");
const WORDMARK_PNG = path.join(ASSET_DIR, "neurohands-wordmark-white.png");

const WIDTH = 2500;
const HEIGHT = 1686;

const SLOTS = [
  { x: 64, y: 290, width: 764, height: 640 },
  { x: 868, y: 290, width: 764, height: 640 },
  { x: 1672, y: 290, width: 764, height: 640 },
  { x: 64, y: 970, width: 764, height: 640 },
  { x: 868, y: 970, width: 764, height: 640 },
  { x: 1672, y: 970, width: 764, height: 640 },
];

const ICONS = {
  globe: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="22"/><ellipse cx="32" cy="32" rx="10" ry="22"/><path d="M10 32h44M14 20h36M14 44h36"/></svg>`,
  layers: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 10 54 22 32 34 10 22 32 10Z"/><path d="M10 33l22 12 22-12"/><path d="M10 44l22 12 22-12"/></svg>`,
  blocks: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="10" width="18" height="18" rx="4"/><rect x="36" y="10" width="18" height="18" rx="4"/><rect x="10" y="36" width="18" height="18" rx="4"/><path d="M45 36v18M36 45h18"/></svg>`,
  chat: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16a6 6 0 0 1 6-6h28a6 6 0 0 1 6 6v22a6 6 0 0 1-6 6H26l-12 9v-9h-2a6 6 0 0 1-6-6V16Z"/><path d="M22 24h20M22 33h13"/></svg>`,
  spark: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 8l5 16 16 5-16 5-5 16-5-16-16-5 16-5 5-16Z"/><path d="M50 10v10M45 15h10"/></svg>`,
  bolt: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M35 8 15 35h16l-3 21 21-28H33l2-20Z"/></svg>`,
  package: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M32 9 53 20v24L32 55 11 44V20L32 9Z"/><path d="M11 20l21 11 21-11M32 31v24M22 14.5l21 11"/></svg>`,
  catalog: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="11" y="10" width="42" height="44" rx="5"/><path d="M20 22h24M20 32h24M20 42h15"/></svg>`,
  clock: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="22"/><path d="M32 19v14l10 6"/></svg>`,
  calc: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="8" width="38" height="48" rx="6"/><rect x="20" y="15" width="24" height="10" rx="2"/><circle cx="23" cy="35" r="2"/><circle cx="32" cy="35" r="2"/><circle cx="41" cy="35" r="2"/><circle cx="23" cy="45" r="2"/><circle cx="32" cy="45" r="2"/><path d="M41 42v6"/></svg>`,
  headset: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 34a20 20 0 0 1 40 0"/><rect x="10" y="33" width="9" height="16" rx="4"/><rect x="45" y="33" width="9" height="16" rx="4"/><path d="M49 49v3a6 6 0 0 1-6 6H34"/></svg>`,
  cpu: `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="18" y="18" width="28" height="28" rx="5"/><rect x="26" y="26" width="12" height="12" rx="2"/><path d="M25 10v8M39 10v8M25 46v8M39 46v8M10 25h8M10 39h8M46 25h8M46 39h8"/></svg>`,
};

const MENUS = {
  public: {
    name: "Neurohands Brand Menu",
    chatBarText: "Neurohands",
    selected: true,
    badge: "LINE OFFICIAL ACCOUNT",
    badgeLive: false,
    subtitle: "Helping humans learn and grow.",
    buttons: [
      { code: "01", title: "ABOUT US", sub: "Global AI Platform", icon: "globe", featured: false, action: { type: "postback", data: "menu=about" } },
      { code: "02", title: "SERVICES", sub: "Custom AI Teams", icon: "layers", featured: false, action: { type: "postback", data: "menu=services" } },
      { code: "03", title: "BUILD AGENT", sub: "Drag & Drop Web", icon: "blocks", featured: true, action: { type: "uri", uri: "https://neurohands-ai-agent-production.up.railway.app/neurohands" } },
      { code: "04", title: "CONTACT", sub: "Book Live Demo", icon: "chat", featured: false, action: { type: "postback", data: "menu=contact" } },
      { code: "05", title: "UPDATES", sub: "Latest Releases", icon: "spark", featured: false, action: { type: "postback", data: "menu=updates" } },
      { code: "06", title: "GET STARTED", sub: "Activate Trial", icon: "bolt", featured: true, action: { type: "postback", data: "menu=activate" } },
    ],
  },
  active: {
    name: "Neurohands Client Menu",
    chatBarText: "My Neurohands",
    selected: false,
    badge: "AI AGENT ACTIVE",
    badgeLive: true,
    subtitle: "Isolated workspace · Human-in-the-loop",
    buttons: [
      { code: "01", title: "ORDER STATUS", sub: "Live Tracking", icon: "package", featured: false, action: { type: "postback", data: "menu=order_status" } },
      { code: "02", title: "PRODUCTS", sub: "Approved Catalog", icon: "catalog", featured: false, action: { type: "postback", data: "menu=products" } },
      { code: "03", title: "LEAD TIME", sub: "Production ETA", icon: "clock", featured: false, action: { type: "postback", data: "menu=lead_time" } },
      { code: "04", title: "QUOTE", sub: "Instant Price Calc", icon: "calc", featured: true, action: { type: "postback", data: "menu=quote" } },
      { code: "05", title: "SUPPORT", sub: "Human Handover", icon: "headset", featured: false, action: { type: "postback", data: "menu=support" } },
      { code: "06", title: "MY AGENT", sub: "Active AI & Rules", icon: "cpu", featured: true, action: { type: "postback", data: "menu=agent" } },
    ],
  },
};

function renderHtml(menu, wordmarkDataUri) {
  const cards = menu.buttons.map((b, i) => {
    const slot = SLOTS[i];
    return `
      <div class="card${b.featured ? " featured" : ""}" style="left:${slot.x}px;top:${slot.y}px;width:${slot.width}px;height:${slot.height}px">
        <div class="card-top">
          <div class="icon-wrap">${ICONS[b.icon]}</div>
          <div class="card-code">${b.code}</div>
        </div>
        <div class="card-body">
          <div class="card-title">${b.title}</div>
          <div class="card-sub">${b.sub}</div>
        </div>
        <div class="card-bar"></div>
      </div>`;
  }).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#050B21;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:#fff;-webkit-font-smoothing:antialiased}
  .canvas{position:relative;width:${WIDTH}px;height:${HEIGHT}px;background:
    radial-gradient(1200px 760px at 50% 0%, rgba(15,140,232,0.24) 0%, rgba(8,19,54,0) 70%),
    radial-gradient(900px 600px at 14% 88%, rgba(56,189,248,0.14) 0%, rgba(5,11,33,0) 68%),
    radial-gradient(900px 600px at 88% 84%, rgba(30,64,175,0.20) 0%, rgba(5,11,33,0) 68%),
    linear-gradient(180deg, #060D28 0%, #081337 52%, #04091B 100%)}
  .bg-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .header{position:absolute;left:64px;right:64px;top:48px;height:186px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:2px solid rgba(56,189,248,0.22)}
  .brand{display:flex;align-items:center;gap:28px}
  .brand img{height:106px;width:auto;display:block;filter:drop-shadow(0 0 10px rgba(56,189,248,0.28))}
  .meta{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:14px}
  .kicker{font-size:26px;font-weight:700;letter-spacing:0.24em;color:#38BDF8;text-transform:uppercase}
  .meta-row{display:flex;align-items:center;gap:22px}
  .tagline{font-size:32px;font-weight:500;color:rgba(226,238,255,0.88);letter-spacing:0.01em}
  .pill{display:inline-flex;align-items:center;gap:14px;padding:12px 26px;border-radius:999px;background:rgba(15,140,232,0.16);border:2px solid rgba(56,189,248,0.45);font-size:24px;font-weight:700;letter-spacing:0.12em;color:#E0F2FE}
  .pill .dot{width:16px;height:16px;border-radius:50%;background:${menu.badgeLive ? "#34D399" : "#38BDF8"};box-shadow:0 0 16px ${menu.badgeLive ? "#34D399" : "#38BDF8"}}
  .card{position:absolute;border-radius:42px;padding:54px 56px 52px;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(155deg, rgba(17,34,84,0.92) 0%, rgba(8,17,46,0.96) 100%);border:3px solid rgba(56,189,248,0.32);box-shadow:0 24px 56px rgba(2,6,23,0.58), inset 0 2px 0 rgba(186,230,253,0.16)}
  .card.featured{background:linear-gradient(148deg, rgba(16,86,178,0.92) 0%, rgba(11,34,96,0.96) 58%, rgba(8,21,62,0.98) 100%);border:3.5px solid rgba(56,189,248,0.78);box-shadow:0 28px 64px rgba(15,140,232,0.28), inset 0 2px 0 rgba(224,242,254,0.36)}
  .card-top{display:flex;align-items:flex-start;justify-content:space-between}
  .icon-wrap{width:148px;height:148px;border-radius:34px;display:flex;align-items:center;justify-content:center;background:linear-gradient(145deg, rgba(56,189,248,0.24), rgba(24,24,75,0.65));border:2.5px solid rgba(56,189,248,0.5);color:#7DD3FC}
  .card.featured .icon-wrap{background:linear-gradient(145deg, rgba(56,189,248,0.42), rgba(15,140,232,0.28));border-color:#BAE6FD;color:#FFFFFF}
  .icon-wrap svg{width:82px;height:82px}
  .card-code{font-family:ui-monospace,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:0.12em;color:rgba(125,211,252,0.72);padding-top:10px}
  .card.featured .card-code{color:#BAE6FD}
  .card-body{display:flex;flex-direction:column;gap:16px}
  .card-title{font-size:74px;font-weight:800;letter-spacing:0.03em;line-height:1.05;color:#FFFFFF}
  .card-sub{font-size:40px;font-weight:500;line-height:1.2;color:#93C5FD;letter-spacing:0.01em}
  .card.featured .card-sub{color:#E0F2FE}
  .card-bar{position:absolute;left:56px;right:56px;bottom:0;height:8px;border-radius:8px 8px 0 0;background:linear-gradient(90deg, #1E3A8A 0%, #0F8CE8 55%, #38BDF8 100%);opacity:0.75}
  .card.featured .card-bar{opacity:1;height:10px;background:linear-gradient(90deg, #38BDF8 0%, #BAE6FD 50%, #0F8CE8 100%)}
</style></head>
<body>
  <div class="canvas">
    <svg class="bg-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="dotgrid" width="44" height="44" patternUnits="userSpaceOnUse">
          <circle cx="4" cy="4" r="2.2" fill="#38BDF8" fill-opacity="0.11"/>
        </pattern>
        <linearGradient id="arc1" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.02"/>
          <stop offset="50%" stop-color="#38BDF8" stop-opacity="0.34"/>
          <stop offset="100%" stop-color="#0F8CE8" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#dotgrid)"/>
      <path d="M -80 560 Q 720 120 1250 250 T 2580 480" fill="none" stroke="url(#arc1)" stroke-width="4"/>
      <path d="M -60 1260 Q 640 760 1250 930 T 2560 1120" fill="none" stroke="url(#arc1)" stroke-width="3"/>
      <path d="M 1250 250 Q 820 620 260 1650" fill="none" stroke="url(#arc1)" stroke-width="2.5"/>
      <path d="M 1250 250 Q 1720 620 2260 1650" fill="none" stroke="url(#arc1)" stroke-width="2.5"/>
      <circle cx="1250" cy="250" r="10" fill="#7DD3FC" fill-opacity="0.7"/>
      <circle cx="1250" cy="250" r="34" fill="#38BDF8" fill-opacity="0.14"/>
      <rect x="64" y="1648" width="2372" height="4" rx="2" fill="url(#arc1)"/>
    </svg>
    <div class="header">
      <div class="brand">
        <img src="${wordmarkDataUri}" alt="Neurohands"/>
      </div>
      <div class="meta">
        <div class="kicker">FROM THAILAND TO THE WORLD</div>
        <div class="meta-row">
          <div class="tagline">${menu.subtitle}</div>
          <div class="pill"><span class="dot"></span><span>${menu.badge}</span></div>
        </div>
      </div>
    </div>
    ${cards}
  </div>
</body></html>`;
}

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
  const wordmarkDataUri = `data:image/png;base64,${fs.readFileSync(WORDMARK_PNG).toString("base64")}`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nh-rm-gen-"));
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

    const summary = {};
    for (const [kind, def] of Object.entries(MENUS)) {
      const htmlPath = path.join(scratch, `richmenu-${kind}.html`);
      fs.writeFileSync(htmlPath, renderHtml(def, wordmarkDataUri), "utf8");
      await send("Page.navigate", { url: `file:///${htmlPath.replace(/\\/g, "/")}` });
      await until(async () => {
        const r = await send("Runtime.evaluate", { expression: "document.readyState === 'complete' && document.images[0]?.complete", returnByValue: true });
        return r.result?.value === true;
      }, `${kind} render`);
      await sleep(150);
      const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const rawBuf = Buffer.from(shot.data, "base64");
      const buf = encodePalettePng256(rawBuf);
      const pngPath = path.join(ASSET_DIR, `richmenu-${kind}.png`);
      fs.writeFileSync(pngPath, buf);

      const jsonPayload = {
        size: { width: WIDTH, height: HEIGHT },
        selected: def.selected,
        name: def.name,
        chatBarText: def.chatBarText,
        areas: def.buttons.map((b, idx) => ({
          bounds: SLOTS[idx],
          action: b.action,
        })),
      };
      const jsonPath = path.join(CONFIG_DIR, `richmenu-${kind}.json`);
      fs.writeFileSync(jsonPath, `${JSON.stringify(jsonPayload, null, 2)}\n`, "utf8");
      summary[kind] = { width: WIDTH, height: HEIGHT, bytes: buf.length, under1Mb: buf.length <= 1000000 };
    }
    console.log(JSON.stringify(summary, null, 2));
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
