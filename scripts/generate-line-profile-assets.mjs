import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, "..");
const BRAND_DIR = path.join(PLATFORM_DIR, "assets", "brand");
const WORDMARK_PNG = path.join(PLATFORM_DIR, "assets", "rich-menus", "neurohands-wordmark-white.png");

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

function decodeRgbaPng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idats = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") {
      idats.push(data);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const off = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const xv = raw[off + i];
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (f === 0) cur[i] = xv;
      else if (f === 1) cur[i] = (xv + a) & 255;
      else if (f === 2) cur[i] = (xv + b) & 255;
      else if (f === 3) cur[i] = (xv + ((a + b) >> 1)) & 255;
      else cur[i] = (xv + paethPredictor(a, b, c)) & 255;
    }
    cur.copy(prev);
    cur.copy(rgba, y * stride);
  }
  return { width, height, rgba };
}

function encodeRgbaPng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowOff = y * (width * 4 + 1);
    raw[rowOff] = 0;
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

function cropHandshakeMarkDataUri(wordmarkBuf) {
  const src = decodeRgbaPng(wordmarkBuf);
  const sx = 6;
  const sy = 6;
  const sw = 276;
  const sh = 154;
  const cropped = Buffer.alloc(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const srcOff = ((sy + y) * src.width + sx) * 4;
    src.rgba.copy(cropped, y * sw * 4, srcOff, srcOff + sw * 4);
  }
  return `data:image/png;base64,${encodeRgbaPng(sw, sh, cropped).toString("base64")}`;
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

function renderCoverHtml(wordmarkDataUri) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1080px;height:878px;overflow:hidden;background:#060D28;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:#FFFFFF;-webkit-font-smoothing:antialiased}
  .canvas{position:relative;width:1080px;height:878px;display:flex;align-items:center;justify-content:center;background:
    radial-gradient(660px 440px at 50% 42%, rgba(15,140,232,0.34) 0%, rgba(8,19,55,0) 70%),
    radial-gradient(520px 360px at 14% 80%, rgba(56,189,248,0.16) 0%, rgba(6,13,40,0) 65%),
    radial-gradient(540px 360px at 88% 22%, rgba(37,99,235,0.22) 0%, rgba(6,13,40,0) 65%),
    linear-gradient(180deg, #04091B 0%, #060D28 24%, #0B173D 56%, #060D28 84%, #04091B 100%)}
  .bg-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .safe-center{position:relative;z-index:2;width:920px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:22px;padding:36px 28px}
  .eyebrow{display:inline-flex;align-items:center;gap:14px;font-size:18px;font-weight:800;letter-spacing:0.28em;color:#38BDF8;text-transform:uppercase}
  .eyebrow span.line{width:42px;height:2px;background:linear-gradient(90deg,transparent,#38BDF8)}
  .eyebrow span.line.r{background:linear-gradient(90deg,#38BDF8,transparent)}
  .logo-wrap{padding:10px 0 4px}
  .logo-wrap img{display:block;height:112px;width:auto;filter:drop-shadow(0 0 22px rgba(56,189,248,0.36))}
  .tagline{font-size:28px;font-weight:500;color:#E2E8F0;letter-spacing:0.015em}
  .pill{display:inline-flex;align-items:center;gap:12px;margin-top:4px;padding:12px 26px;border-radius:999px;background:rgba(8,19,55,0.82);border:1.5px solid rgba(56,189,248,0.48);box-shadow:0 10px 28px rgba(2,6,23,0.45),inset 0 1px 0 rgba(186,230,253,0.22);font-size:17px;font-weight:700;letter-spacing:0.12em;color:#E0F2FE;text-transform:uppercase}
  .pill i{width:11px;height:11px;border-radius:50%;background:#38BDF8;box-shadow:0 0 14px #38BDF8;display:inline-block}
</style></head>
<body>
  <div class="canvas">
    <svg class="bg-svg" viewBox="0 0 1080 878" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.4" fill="#38BDF8" fill-opacity="0.14"/>
        </pattern>
        <linearGradient id="arc" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.02"/>
          <stop offset="50%" stop-color="#38BDF8" stop-opacity="0.38"/>
          <stop offset="100%" stop-color="#0F8CE8" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <rect width="1080" height="878" fill="url(#dots)"/>
      <path d="M -60 280 Q 320 90 540 190 T 1140 260" fill="none" stroke="url(#arc)" stroke-width="2.5"/>
      <path d="M -60 660 Q 340 500 540 690 T 1140 610" fill="none" stroke="url(#arc)" stroke-width="2.5"/>
      <circle cx="540" cy="439" r="320" fill="none" stroke="rgba(56,189,248,0.12)" stroke-width="1.5"/>
      <circle cx="540" cy="439" r="415" fill="none" stroke="rgba(56,189,248,0.07)" stroke-width="1.5"/>
      <rect x="80" y="728" width="920" height="3" rx="2" fill="url(#arc)"/>
    </svg>
    <div class="safe-center">
      <div class="eyebrow"><span class="line"></span>FROM THAILAND TO THE WORLD<span class="line r"></span></div>
      <div class="logo-wrap"><img src="${wordmarkDataUri}" alt="Neurohands"/></div>
      <div class="tagline">Helping humans learn and grow.</div>
      <div class="pill"><i></i><span>AI Agent Teams for LINE Official Accounts</span></div>
    </div>
  </div>
</body></html>`;
}

function renderAvatarHtml(handshakeDataUri) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:640px;height:640px;overflow:hidden;background:#060D28}
  .canvas{position:relative;width:640px;height:640px;display:flex;align-items:center;justify-content:center;background:
    radial-gradient(400px 400px at 50% 46%, rgba(15,140,232,0.38) 0%, rgba(11,23,61,0.88) 54%, #060D28 100%)}
  .bg-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .mark{position:relative;z-index:2;width:424px;height:auto;display:block;filter:drop-shadow(0 0 26px rgba(56,189,248,0.48))}
</style></head>
<body>
  <div class="canvas">
    <svg class="bg-svg" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <pattern id="avdots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.2" fill="#38BDF8" fill-opacity="0.14"/>
        </pattern>
        <linearGradient id="ring" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.72"/>
          <stop offset="50%" stop-color="#0F8CE8" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#7DD3FC" stop-opacity="0.68"/>
        </linearGradient>
      </defs>
      <rect width="640" height="640" fill="url(#avdots)"/>
      <circle cx="320" cy="320" r="274" fill="none" stroke="url(#ring)" stroke-width="4"/>
      <circle cx="320" cy="320" r="250" fill="none" stroke="rgba(56,189,248,0.16)" stroke-width="1.5"/>
    </svg>
    <img class="mark" src="${handshakeDataUri}" alt="Neurohands"/>
  </div>
</body></html>`;
}

function renderProfilePreviewHtml(coverDataUri, avatarDataUri) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:390px;height:844px;overflow:hidden;background:#FFFFFF;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:#111827;-webkit-font-smoothing:antialiased}
  .statusbar{height:42px;background:#04091B;color:#FFFFFF;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:13px;font-weight:700}
  .cover-wrap{position:relative;width:390px;height:218px;overflow:hidden;background:#060D28}
  .cover-wrap img{width:100%;height:100%;object-fit:cover;object-position:center;display:block}
  .cover-nav{position:absolute;top:12px;right:14px;display:flex;gap:14px;color:#E2E8F0;font-size:18px;font-weight:700}
  .profile-body{padding:18px 20px 24px}
  .id-row{display:flex;align-items:center;gap:14px}
  .avatar{width:64px;height:64px;border-radius:50%;overflow:hidden;border:2px solid rgba(56,189,248,0.45);box-shadow:0 6px 18px rgba(6,13,40,0.22);flex:none}
  .avatar img{width:100%;height:100%;object-fit:cover;display:block}
  .name-row{display:flex;align-items:center;gap:8px}
  .name-row h1{font-size:20px;font-weight:800;color:#060D28}
  .unv{font-size:11px;font-weight:600;color:#64748B;background:#F1F5F9;border-radius:5px;padding:2px 7px}
  .friends{font-size:13px;color:#475569;margin-top:2px}
  .status-msg{font-size:13px;color:#0F8CE8;font-weight:600;margin-top:4px}
  .chat-pill{display:inline-flex;align-items:center;gap:7px;margin-top:18px;padding:9px 20px;border-radius:8px;border:1px solid #CBD5E1;background:#FFFFFF;color:#060D28;font-size:13.5px;font-weight:700}
  .handle{text-align:center;color:#94A3B8;font-size:13px;margin-top:138px}
  .footer-card{margin-top:28px;background:#F8FAFC;border-top:1px solid #E2E8F0;padding:22px 20px 26px;text-align:center}
  .footer-card h2{font-size:15px;font-weight:800;color:#060D28;margin-bottom:18px}
  .icons{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:24px;font-size:12px;color:#475569}
  .ic-circle{width:46px;height:46px;border-radius:50%;background:#FFFFFF;border:1px solid #E2E8F0;margin:0 auto 6px;display:grid;place-items:center;color:#060D28;font-weight:800}
  .bottom-cta{width:100%;height:46px;border-radius:8px;background:linear-gradient(90deg,#060D28 0%,#0B173D 55%,#0F8CE8 100%);color:#FFFFFF;display:flex;align-items:center;justify-content:center;gap:8px;font-size:15px;font-weight:700;box-shadow:0 8px 20px rgba(6,13,40,0.22)}
  .country{text-align:right;font-size:11.5px;color:#64748B;margin-top:8px}
</style></head>
<body>
  <div class="statusbar"><span>00:25</span><span>4G · 100%</span></div>
  <div class="cover-wrap">
    <img src="${coverDataUri}" alt="Cover"/>
    <div class="cover-nav"><span>⋮</span><span>✕</span></div>
  </div>
  <div class="profile-body">
    <div class="id-row">
      <div class="avatar"><img src="${avatarDataUri}" alt="Avatar"/></div>
      <div>
        <div class="name-row"><h1>Neurohands</h1><span class="unv">Official Account</span></div>
        <div class="friends">Friends 4</div>
        <div class="status-msg">Custom AI Agent Teams for LINE</div>
      </div>
    </div>
    <div class="chat-pill">💬 Chat</div>
    <div class="handle">@865sirgf</div>
  </div>
  <div class="footer-card">
    <h2>Find more official accounts</h2>
    <div class="icons">
      <div><div class="ic-circle">★</div>See list</div>
      <div><div class="ic-circle">✓</div>My coupons</div>
      <div><div class="ic-circle">⌕</div>Search</div>
    </div>
    <div class="bottom-cta">💬 Chat</div>
    <div class="country">Country or region: Thailand</div>
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
  throw new Error("No Chrome/Edge binary found to render LINE OA profile assets");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(60);
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

async function withChrome(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "nh-profile-"));
  const profile = path.join(scratch, "profile");
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn(findChrome(), [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((r) => chrome.once("exit", r));
  let ws = null;
  try {
    const port = await until(() => {
      const file = path.join(profile, "DevToolsActivePort");
      if (!fs.existsSync(file)) return null;
      const num = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      return Number.isInteger(num) && num > 0 ? num : null;
    }, "DevToolsActivePort");
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((t) => t.type === "page");
    }, "page target");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout on ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send("Page.enable");
    return await fn({ send });
  } finally {
    if (ws) {
      try {
        ws.onmessage = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      } catch {}
    }
    await sleep(50);
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    else chrome.kill("SIGKILL");
    await Promise.race([exited, sleep(1500)]);
    await fs.promises.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }
}

async function captureHtml(send, html, width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const { frameTree } = await send("Page.getFrameTree");
  await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await sleep(180);
  const { data } = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  return Buffer.from(data, "base64");
}

function checkOnly() {
  const checks = [
    { file: "line-oa-cover.png", width: 1080, height: 878 },
    { file: "line-oa-avatar.png", width: 640, height: 640 },
  ];
  for (const item of checks) {
    const full = path.join(BRAND_DIR, item.file);
    if (!fs.existsSync(full)) throw new Error(`Missing brand asset: ${full}`);
    const buf = fs.readFileSync(full);
    const hdr = readPngHeader(buf);
    if (hdr.width !== item.width || hdr.height !== item.height) {
      throw new Error(`${item.file} dimensions mismatch: got ${hdr.width}x${hdr.height}, expected ${item.width}x${item.height}`);
    }
    if (buf.length > 2 * 1024 * 1024) {
      throw new Error(`${item.file} exceeds 2MB LINE OA upload limit: ${buf.length} bytes`);
    }
    console.log(`${item.file}: ${hdr.width}x${hdr.height}, ${buf.length.toLocaleString("en-US")} bytes — valid`);
  }
}

async function main() {
  if (process.argv.includes("--check")) {
    checkOnly();
    return;
  }
  const wordmarkBuf = fs.readFileSync(WORDMARK_PNG);
  const wordmarkDataUri = `data:image/png;base64,${wordmarkBuf.toString("base64")}`;
  const handshakeDataUri = cropHandshakeMarkDataUri(wordmarkBuf);

  fs.mkdirSync(BRAND_DIR, { recursive: true });
  const previewOut = process.env.PROFILE_PREVIEW_OUT || "";
  const desktopCopyDir = process.env.DESKTOP_COPY_DIR || "";

  await withChrome(async ({ send }) => {
    const coverBuf = await captureHtml(send, renderCoverHtml(wordmarkDataUri), 1080, 878);
    const avatarBuf = await captureHtml(send, renderAvatarHtml(handshakeDataUri), 640, 640);

    fs.writeFileSync(path.join(BRAND_DIR, "line-oa-cover.png"), coverBuf);
    fs.writeFileSync(path.join(BRAND_DIR, "line-oa-avatar.png"), avatarBuf);

    if (desktopCopyDir) {
      fs.mkdirSync(desktopCopyDir, { recursive: true });
      fs.writeFileSync(path.join(desktopCopyDir, "line-oa-cover.png"), coverBuf);
      fs.writeFileSync(path.join(desktopCopyDir, "line-oa-avatar.png"), avatarBuf);
    }

    if (previewOut) {
      const coverUri = `data:image/png;base64,${coverBuf.toString("base64")}`;
      const avatarUri = `data:image/png;base64,${avatarBuf.toString("base64")}`;
      const previewBuf = await captureHtml(send, renderProfilePreviewHtml(coverUri, avatarUri), 390, 844);
      fs.mkdirSync(path.dirname(previewOut), { recursive: true });
      fs.writeFileSync(previewOut, previewBuf);
    }
  });

  checkOnly();
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
