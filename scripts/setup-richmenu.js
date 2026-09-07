// Creates BOTH rich menus, uploads images, sets public as default,
// stores both menu IDs in Supabase settings.
const fs = require("fs");
const path = require("path");
const { supabaseHeaders } = require("../src/lib/security");

const { LINE_CHANNEL_ACCESS_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;

function loadMenu(kind) {
  const root = path.resolve(__dirname, "..");
  const menu = JSON.parse(fs.readFileSync(path.join(root, "config", "rich-menus", `richmenu-${kind}.json`), "utf8"));
  const image = fs.readFileSync(path.join(root, "assets", "rich-menus", `richmenu-${kind}.png`));
  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error(`${kind}: invalid PNG`);
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  if (image.length > 1000000 || width < 800 || width > 2500 || height < 250 || width / height < 1.45) throw new Error(`${kind}: image exceeds LINE limits`);
  if (menu.size?.width !== width || menu.size?.height !== height) throw new Error(`${kind}: JSON dimensions must match the PNG (${width} x ${height})`);
  if (!menu.areas?.length || menu.areas.length > 20) throw new Error(`${kind}: invalid number of areas`);
  for (const { bounds, action } of menu.areas) {
    const { x, y, width: w, height: h } = bounds || {};
    if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) throw new Error(`${kind}: area outside image`);
    if (action?.type !== "postback" || !/^menu=[a-z_]+$/.test(action.data)) throw new Error(`${kind}: unexpected action`);
  }
  console.log(`${kind}: ${width} x ${height}, ${menu.areas.length} buttons, ${image.length} bytes — valid`);
  return { menu, image };
}

async function line(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) { console.error("LINE error", res.status, text); throw new Error("LINE API error"); }
  return text ? JSON.parse(text) : {};
}

async function db(pathname, options = {}) {
  const method = options.method || "GET";
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers: {
      ...supabaseHeaders(SUPABASE_SERVICE_KEY),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase settings update failed (${res.status})`);
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

async function saveSetting(key, value) {
  await db("settings", {
    method: "POST",
    body: { key, value },
    headers: { Prefer: "return=representation,resolution=merge-duplicates" },
  });
}

async function createMenu({ menu, image }) {
  const created = await line("https://api.line.me/v2/bot/richmenu", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(menu),
  });
  const richMenuId = created.richMenuId;
  if (!richMenuId) throw new Error("LINE did not return a menu ID");
  console.log("Created menu:", richMenuId);

  const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "image/png" },
    body: image,
  });
  if (!up.ok) { console.error("Image upload failed", up.status, await up.text()); throw new Error("image upload failed"); }
  return richMenuId;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/setup-richmenu.js [--check]");
  // Validate both files before any remote action. --check never uses credentials.
  const publicMenu = loadMenu("public");
  const activeMenu = loadMenu("active");
  if (args.includes("--check")) return;
  if (!LINE_CHANNEL_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error("Set LINE_CHANNEL_ACCESS_TOKEN, SUPABASE_URL and SUPABASE_SERVICE_KEY first");
  console.log("Creating public brand menu...");
  const publicId = await createMenu(publicMenu);

  console.log("Creating active client menu...");
  const activeId = await createMenu(activeMenu);

  await saveSetting("richmenu_public_id", publicId);
  await saveSetting("richmenu_active_id", activeId);
  console.log("Setting public menu as default for all users...");
  await line(`https://api.line.me/v2/bot/user/all/richmenu/${publicId}`, { method: "POST" });

  console.log("Done. public:", publicId, "active:", activeId);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { loadMenu };
