"use strict";

function validateLineUserId(lineUserId) {
  if (typeof lineUserId !== "string" || !lineUserId.trim() || lineUserId.trim().length > 128) {
    throw new TypeError("A non-empty bounded lineUserId is required");
  }
  return lineUserId.trim();
}

function validateRetentionDays(retentionDays) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new RangeError("retentionDays must be an integer between 1 and 3650");
  }
  return retentionDays;
}

function createPdpaRetention({ db }) {
  if (typeof db !== "function") throw new TypeError("A db RPC function is required");

  async function eraseLineUserData(lineUserId, clientAccountId = null) {
    const cleanUser = validateLineUserId(lineUserId);
    if (clientAccountId !== null && (!Number.isSafeInteger(Number(clientAccountId)) || Number(clientAccountId) <= 0)) {
      throw new TypeError("clientAccountId must be null or a positive integer");
    }
    const result = await db("rpc/nh_erase_line_user_data", {
      method: "POST",
      body: {
        p_line_user_id: cleanUser,
        p_client_account_id: clientAccountId === null ? null : Number(clientAccountId),
      },
    });
    const payload = Array.isArray(result) ? result[0] : result;
    if (!payload || payload.erased !== true) throw new Error("PDPA erasure receipt was not confirmed");
    return payload;
  }

  async function purgeExpiredCustomerData(retentionDays = 365) {
    const cleanDays = validateRetentionDays(retentionDays);
    const result = await db("rpc/nh_purge_expired_customer_data", {
      method: "POST",
      body: { p_retention_days: cleanDays },
    });
    const payload = Array.isArray(result) ? result[0] : result;
    if (!payload || payload.purged !== true) throw new Error("PDPA retention purge receipt was not confirmed");
    return payload;
  }

  return Object.freeze({ eraseLineUserData, purgeExpiredCustomerData });
}

module.exports = { createPdpaRetention, validateLineUserId, validateRetentionDays };
