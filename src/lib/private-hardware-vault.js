"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isFreshRecord } = require("./document-parser");
const { calculateEdgingCost } = require("./liff-builder");

const CLIENT_CODE_RE = /^[A-Z0-9_-]{2,24}$/;
const ALLOWED_COLLECTIONS = new Set(["products", "documents", "prices", "customers", "orders"]);
const BACKUP_AAD_PREFIX = "neurohands-backup-v1:";

function normalizeClientCode(raw) {
  const code = String(raw || "").trim().toUpperCase();
  if (!CLIENT_CODE_RE.test(code)) throw new RangeError("Invalid tenant client code");
  return code;
}

function assertCollection(collection) {
  const name = String(collection || "").trim().toLowerCase();
  if (!ALLOWED_COLLECTIONS.has(name)) throw new RangeError(`Unsupported vault collection: ${collection}`);
  return name;
}

function assertSafeChildPath(baseDir, ...segments) {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, ...segments);
  const rel = path.relative(resolvedBase, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new RangeError("Unsafe vault path traversal blocked");
  }
  return target;
}

const STRICT_AES256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;

function decodeAes256Key(encryptionKeyBase64) {
  if (typeof encryptionKeyBase64 !== "string" || !STRICT_AES256_BASE64_RE.test(encryptionKeyBase64.trim())) {
    throw new RangeError("Encryption key must be a strict base64-encoded 32-byte key");
  }
  return Buffer.from(encryptionKeyBase64.trim(), "base64");
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function createPrivateHardwareVault({ baseDir } = {}) {
  if (!baseDir || typeof baseDir !== "string") {
    throw new Error("baseDir is required for private hardware storage");
  }
  const resolvedRoot = path.resolve(baseDir);

  function collectionFile(clientCode, collection) {
    const code = normalizeClientCode(clientCode);
    const col = assertCollection(collection);
    return assertSafeChildPath(resolvedRoot, code, `${col}.json`);
  }

  function readCollection(clientCode, collection) {
    const filePath = collectionFile(clientCode, collection);
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.records) ? parsed.records : [];
  }

  function saveRecord(clientCode, collection, record = {}) {
    const code = normalizeClientCode(clientCode);
    const col = assertCollection(collection);
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new RangeError("record must be an object");
    }
    const expiresAt = record.expires_at ?? record.expiresAt ?? null;
    if (expiresAt != null && !Number.isFinite(typeof expiresAt === "number" ? expiresAt : Date.parse(String(expiresAt)))) {
      throw new RangeError("expires_at must be null, epoch ms, or an ISO-8601 timestamp");
    }
    const records = readCollection(code, col);
    const id = record.id ? String(record.id) : crypto.randomUUID();
    const normalized = {
      ...record,
      id,
      client_code: code,
      storage_mode: "private_hardware",
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    };
    delete normalized.expiresAt;

    const existingIndex = records.findIndex((item) => item.id === id);
    if (existingIndex >= 0) records[existingIndex] = normalized;
    else records.push(normalized);

    atomicWriteJson(collectionFile(code, col), {
      client_code: code,
      collection: col,
      storage_mode: "private_hardware",
      records,
    });
    return normalized;
  }

  function listRecords(clientCode, collection, { activeOnly = true, nowMs = Date.now() } = {}) {
    const rows = readCollection(clientCode, collection);
    if (!activeOnly) return rows;
    return rows.filter((row) => isFreshRecord(row, nowMs));
  }

  function quoteFromVault(clientCode, { productQuery, widthCm, heightCm, quantity = 1, includeEdging = true, nowMs = Date.now() } = {}) {
    const code = normalizeClientCode(clientCode);
    const qty = Number(quantity);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 10_000) {
      throw new RangeError("quantity must be a positive integer");
    }
    const w = Number(widthCm);
    const h = Number(heightCm);
    if (!Number.isFinite(w) || w <= 0 || w > 1000 || !Number.isFinite(h) || h <= 0 || h > 1000) {
      throw new RangeError("widthCm and heightCm must be finite positive numbers up to 1000 cm");
    }
    const query = String(productQuery || "").trim().toLowerCase();
    if (!query) throw new RangeError("productQuery is required");

    const allProducts = readCollection(code, "products");
    const matching = allProducts.filter((item) => {
      const candidates = [item.sku, item.code, item.name].filter(Boolean).map((v) => String(v).toLowerCase());
      return candidates.some((c) => c === query || c.includes(query));
    });
    const exactFresh = matching.find((item) => isFreshRecord(item, nowMs) && [item.sku, item.code, item.name].some((v) => String(v || "").toLowerCase() === query));
    const matched = exactFresh || matching.find((item) => isFreshRecord(item, nowMs)) || matching[0];
    if (!matched) {
      return { found: false, quoted: false, reason: "Product not found in private hardware catalog", clientCode: code };
    }
    if (!isFreshRecord(matched, nowMs)) {
      return { found: true, quoted: false, expired: true, reason: "Catalog price expired; manual confirmation required", clientCode: code };
    }

    const areaSqm = (w / 100) * (h / 100);
    const unitPricePerSqm = Number(matched.unit_price_per_sqm ?? matched.pricePerSqm);
    if (!Number.isFinite(unitPricePerSqm) || unitPricePerSqm <= 0) {
      return { found: true, quoted: false, reason: "Unit price per sqm is missing or non-positive", clientCode: code };
    }
    const ratePerMeter = Number(matched.edging_rate_per_meter ?? matched.edgingRatePerMeter ?? 40);
    if (!Number.isFinite(ratePerMeter) || ratePerMeter < 0) {
      throw new RangeError("edging_rate_per_meter must be a non-negative finite number");
    }
    const edging = includeEdging
      ? calculateEdgingCost({ widthCm: w, heightCm: h, ratePerMeter })
      : { perimeterMeters: 0, totalBaht: 0 };

    const basePanelBaht = Math.round(areaSqm * unitPricePerSqm * 100) / 100;
    const unitTotalBaht = Math.round((basePanelBaht + edging.totalBaht) * 100) / 100;
    const grandTotalBaht = Math.round(unitTotalBaht * qty * 100) / 100;

    return {
      found: true,
      quoted: true,
      deterministic: true,
      storageMode: "private_hardware",
      clientCode: code,
      product: matched.name || matched.sku || matched.code,
      widthCm: w,
      heightCm: h,
      areaSqm: Math.round(areaSqm * 10000) / 10000,
      unitPricePerSqm,
      basePanelBaht,
      edgingMeters: edging.perimeterMeters,
      edgingBaht: edging.totalBaht,
      unitTotalBaht,
      quantity: qty,
      grandTotalBaht,
      expiresAt: matched.expires_at,
    };
  }

  function exportTenantSnapshot(clientCode, { encryptionKeyBase64 } = {}) {
    const code = normalizeClientCode(clientCode);
    const payload = {};
    for (const col of ALLOWED_COLLECTIONS) {
      payload[col] = readCollection(code, col);
    }
    return sealEncryptedBackup({ clientCode: code, data: payload, encryptionKeyBase64 });
  }

  return {
    saveRecord,
    listRecords,
    quoteFromVault,
    exportTenantSnapshot,
  };
}

function sealEncryptedBackup({ clientCode, data, encryptionKeyBase64 }) {
  const code = normalizeClientCode(clientCode);
  const key = decodeAes256Key(encryptionKeyBase64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${BACKUP_AAD_PREFIX}${code}`, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(data ?? {}), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: "aes-256-gcm",
    clientCode: code,
    createdAt: new Date().toISOString(),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: encrypted.toString("base64"),
  };
}

function unsealEncryptedBackup({ envelope, encryptionKeyBase64, expectedClientCode = null }) {
  if (!envelope || envelope.version !== 1 || envelope.alg !== "aes-256-gcm") {
    throw new RangeError("Unsupported encrypted backup envelope");
  }
  const code = normalizeClientCode(envelope.clientCode);
  if (expectedClientCode != null && normalizeClientCode(expectedClientCode) !== code) {
    throw new RangeError("Backup envelope belongs to a different tenant");
  }
  const key = decodeAes256Key(encryptionKeyBase64);
  const iv = Buffer.from(String(envelope.iv || ""), "base64");
  const tag = Buffer.from(String(envelope.tag || ""), "base64");
  if (iv.length !== 12 || tag.length !== 16) {
    throw new RangeError("Invalid AES-256-GCM IV or 16-byte authentication tag");
  }
  const ciphertext = Buffer.from(String(envelope.ciphertext || ""), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(`${BACKUP_AAD_PREFIX}${code}`, "utf8"));
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

module.exports = {
  createPrivateHardwareVault,
  sealEncryptedBackup,
  unsealEncryptedBackup,
};
