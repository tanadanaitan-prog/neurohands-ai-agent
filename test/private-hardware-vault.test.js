"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  createPrivateHardwareVault,
  sealEncryptedBackup,
  unsealEncryptedBackup,
} = require("../src/lib/private-hardware-vault");

test("start-studio-daemon --check verifies loopback configuration and server isolation", () => {
  const daemonPath = path.join(__dirname, "../scripts/start-studio-daemon.mjs");
  const out = execFileSync(process.execPath, [daemonPath, "--check"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal(parsed.port, 2024);
  assert.ok(Array.isArray(parsed.graphs) && parsed.graphs.includes("neurohands_jarvis"));

  const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  assert.doesNotMatch(serverSource, /start-studio-daemon/);
});

test("private hardware vault isolates tenants, enforces expiry via isFreshRecord, and quotes deterministically", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh-vault-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const vault = createPrivateHardwareVault({ baseDir: tmpDir });
  assert.throws(() => vault.saveRecord("../escape", "products", { name: "x" }), /Invalid tenant client code/);
  assert.throws(() => vault.saveRecord("KNC", "secrets", { name: "x" }), /Unsupported vault collection/);

  vault.saveRecord("KNC", "products", {
    id: "tempered-10",
    sku: "TG-10MM",
    name: "Tempered Clear 10mm",
    unit_price_per_sqm: 1200,
    edging_rate_per_meter: 40,
    expires_at: "2030-12-31T23:59:59.000Z",
  });
  vault.saveRecord("KNC", "products", {
    id: "expired-6",
    sku: "AG-06MM",
    name: "Annealed 6mm Expired",
    unit_price_per_sqm: 500,
    expires_at: "2020-01-01T00:00:00.000Z",
  });
  vault.saveRecord("OTHER", "products", {
    id: "other-12",
    sku: "TG-12MM",
    name: "Other Tenant Glass",
    unit_price_per_sqm: 1500,
  });

  const activeKnc = vault.listRecords("KNC", "products", { nowMs: Date.parse("2026-11-17T00:00:00Z") });
  assert.equal(activeKnc.length, 1);
  assert.equal(activeKnc[0].sku, "TG-10MM");
  assert.equal(activeKnc[0].storage_mode, "private_hardware");

  const expiredQuote = vault.quoteFromVault("KNC", {
    productQuery: "AG-06MM",
    widthCm: 100,
    heightCm: 200,
    nowMs: Date.parse("2026-11-17T00:00:00Z"),
  });
  assert.equal(expiredQuote.quoted, false);
  assert.equal(expiredQuote.expired, true);

  const crossTenantQuote = vault.quoteFromVault("KNC", {
    productQuery: "TG-12MM",
    widthCm: 100,
    heightCm: 200,
  });
  assert.equal(crossTenantQuote.found, false);
  assert.equal(crossTenantQuote.quoted, false);

  assert.throws(() => vault.quoteFromVault("KNC", { productQuery: "TG-10MM", widthCm: -100, heightCm: 200, includeEdging: false }), /positive numbers/);
  assert.throws(() => vault.quoteFromVault("KNC", { productQuery: "TG-10MM", widthCm: 0, heightCm: 200, includeEdging: false }), /positive numbers/);
  assert.throws(() => vault.saveRecord("KNC", "products", { id: "bad-exp", expires_at: "not-a-date" }), /expires_at/);

  const quote = vault.quoteFromVault("KNC", {
    productQuery: "Tempered Clear",
    widthCm: 100,
    heightCm: 200,
    quantity: 2,
    nowMs: Date.parse("2026-11-17T00:00:00Z"),
  });
  assert.equal(quote.quoted, true);
  assert.equal(quote.deterministic, true);
  assert.equal(quote.areaSqm, 2);
  assert.equal(quote.basePanelBaht, 2400);
  assert.equal(quote.edgingMeters, 6);
  assert.equal(quote.edgingBaht, 240);
  assert.equal(quote.unitTotalBaht, 2640);
  assert.equal(quote.grandTotalBaht, 5280);
});

test("AES-256-GCM cloud backup seals tenant snapshot and detects tampering or wrong tenant", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nh-backup-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const vault = createPrivateHardwareVault({ baseDir: tmpDir });
  vault.saveRecord("KNC", "prices", { id: "p1", item: "Clear 10mm", cost: 1200 });
  const keyB64 = crypto.randomBytes(32).toString("base64");

  const envelope = vault.exportTenantSnapshot("KNC", { encryptionKeyBase64: keyB64 });
  assert.equal(envelope.alg, "aes-256-gcm");
  assert.equal(envelope.clientCode, "KNC");
  assert.doesNotMatch(envelope.ciphertext, /Clear 10mm|1200/);

  const restored = unsealEncryptedBackup({ envelope, encryptionKeyBase64: keyB64 });
  assert.equal(restored.prices[0].item, "Clear 10mm");

  const wrongTenant = { ...envelope, clientCode: "EVIL" };
  assert.throws(() => unsealEncryptedBackup({ envelope: wrongTenant, encryptionKeyBase64: keyB64 }));

  const wrongKey = crypto.randomBytes(32).toString("base64");
  assert.throws(() => unsealEncryptedBackup({ envelope, encryptionKeyBase64: wrongKey }));

  const truncatedTag = { ...envelope, tag: Buffer.from(envelope.tag, "base64").subarray(0, 4).toString("base64") };
  assert.throws(() => unsealEncryptedBackup({ envelope: truncatedTag, encryptionKeyBase64: keyB64 }), /16-byte authentication tag/);
  assert.throws(() => unsealEncryptedBackup({ envelope, encryptionKeyBase64: keyB64, expectedClientCode: "OTHER" }), /different tenant/);

  assert.throws(() => sealEncryptedBackup({ clientCode: "KNC", data: {}, encryptionKeyBase64: `!!!${keyB64}` }), /strict base64/);
  assert.throws(() => sealEncryptedBackup({ clientCode: "KNC", data: {}, encryptionKeyBase64: "short" }), /strict base64/);
});
