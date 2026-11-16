"use strict";

const ALLOWED_BLOCK_TYPES = new Set([
  "HeroBannerBlock",
  "GlassCatalogBlock",
  "EdgingCalculatorBlock",
  "LeadInquiryBlock",
  "LineContactBlock",
]);

const ALLOWED_BORDER_RADII = new Set(["none", "sm", "md", "lg", "full"]);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateBlockProps(type, props) {
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    return `${type}: props must be an object`;
  }
  if (type === "HeroBannerBlock") {
    if (typeof props.heading !== "string" || !props.heading.trim()) return "HeroBannerBlock: heading required";
  } else if (type === "GlassCatalogBlock") {
    if (!Array.isArray(props.displayCategories) || props.displayCategories.some((c) => typeof c !== "string")) {
      return "GlassCatalogBlock: displayCategories must be string[]";
    }
    if (typeof props.showPrices !== "boolean") return "GlassCatalogBlock: showPrices must be boolean";
  } else if (type === "EdgingCalculatorBlock") {
    if (typeof props.defaultEdgingType !== "string" || !props.defaultEdgingType.trim()) {
      return "EdgingCalculatorBlock: defaultEdgingType required";
    }
    if (typeof props.allowCustomDimensions !== "boolean") {
      return "EdgingCalculatorBlock: allowCustomDimensions must be boolean";
    }
  } else if (type === "LeadInquiryBlock") {
    if (typeof props.targetDepartment !== "string" || !props.targetDepartment.trim()) {
      return "LeadInquiryBlock: targetDepartment required";
    }
  } else if (type === "LineContactBlock") {
    if (typeof props.lineOaId !== "string" || !/^@[a-z0-9._-]+$/i.test(props.lineOaId.trim())) {
      return "LineContactBlock: lineOaId must start with @";
    }
  }
  return null;
}

function validateSiteAst(ast) {
  const errors = [];
  if (!ast || typeof ast !== "object" || Array.isArray(ast)) {
    return { valid: false, errors: ["SiteAST must be a non-null object"] };
  }
  if (ast.version !== "1.0.0") errors.push("version must equal '1.0.0'");
  if (typeof ast.siteSlug !== "string" || !/^[a-z0-9-]{3,63}$/.test(ast.siteSlug)) {
    errors.push("siteSlug must match ^[a-z0-9-]{3,63}$");
  }
  if (typeof ast.title !== "string" || !ast.title.trim() || ast.title.length > 120) {
    errors.push("title must be 1..120 characters");
  }
  const theme = ast.theme;
  if (!theme || typeof theme !== "object") {
    errors.push("theme is required");
  } else {
    if (typeof theme.primaryColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(theme.primaryColor)) {
      errors.push("theme.primaryColor must be a 6-digit hex color");
    }
    if (!ALLOWED_BORDER_RADII.has(theme.borderRadius)) {
      errors.push("theme.borderRadius must be one of none, sm, md, lg, full");
    }
    if (typeof theme.fontFamily !== "string" || !theme.fontFamily.trim()) {
      errors.push("theme.fontFamily is required");
    }
  }
  if (!Array.isArray(ast.blocks) || ast.blocks.length === 0 || ast.blocks.length > 25) {
    errors.push("blocks must be a non-empty array of at most 25 blocks");
  } else {
    const seenIds = new Set();
    for (const block of ast.blocks) {
      if (!block || typeof block !== "object") {
        errors.push("block must be an object");
        continue;
      }
      if (typeof block.id !== "string" || !block.id.trim()) {
        errors.push("block.id is required");
      } else if (seenIds.has(block.id)) {
        errors.push(`duplicate block.id '${block.id}'`);
      } else {
        seenIds.add(block.id);
      }
      if (!ALLOWED_BLOCK_TYPES.has(block.type)) {
        errors.push(`unsupported block.type '${block.type}'`);
        continue;
      }
      const propError = validateBlockProps(block.type, block.props);
      if (propError) errors.push(propError);
    }
  }
  return { valid: errors.length === 0, errors };
}

function calculateEdgingCost({ widthCm, heightCm, ratePerMeter }) {
  const w = Number(widthCm);
  const h = Number(heightCm);
  const rate = Number(ratePerMeter);
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(rate) || w <= 0 || h <= 0 || rate < 0) {
    throw new RangeError("widthCm and heightCm must be > 0 and ratePerMeter >= 0");
  }
  const perimeterMeters = 2 * ((w + h) / 100);
  const totalBaht = Math.round(perimeterMeters * rate * 100) / 100;
  return { perimeterMeters: Math.round(perimeterMeters * 1000) / 1000, totalBaht };
}

function compileSiteHtml(ast, { clientCode = "KNC" } = {}) {
  const check = validateSiteAst(ast);
  if (!check.valid) {
    throw new Error(`Invalid SiteAST: ${check.errors.join("; ")}`);
  }
  const safeTitle = escapeHtml(ast.title);
  const safeClient = escapeHtml(String(clientCode).toLowerCase());
  const canonicalUrl = `https://${safeClient}-${escapeHtml(ast.siteSlug)}.neurohands.site`;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: ast.title,
    url: canonicalUrl,
  }).replace(/</g, "\\u003c");

  const renderedBlocks = ast.blocks.map((block) => {
    const id = escapeHtml(block.id);
    const p = block.props || {};
    if (block.type === "HeroBannerBlock") {
      return `<section data-block-id="${id}" data-block-type="HeroBannerBlock" class="nh-hero"><h1>${escapeHtml(p.heading)}</h1><p>${escapeHtml(p.subheading || "")}</p></section>`;
    }
    if (block.type === "GlassCatalogBlock") {
      const cats = (p.displayCategories || []).map(escapeHtml).join(", ");
      return `<section data-block-id="${id}" data-block-type="GlassCatalogBlock" data-show-prices="${Boolean(p.showPrices)}"><h2>Glass Catalog (${cats})</h2></section>`;
    }
    if (block.type === "EdgingCalculatorBlock") {
      return `<section data-block-id="${id}" data-block-type="EdgingCalculatorBlock" data-edging="${escapeHtml(p.defaultEdgingType)}"><h2>Edging Calculator</h2></section>`;
    }
    if (block.type === "LeadInquiryBlock") {
      return `<section data-block-id="${id}" data-block-type="LeadInquiryBlock" data-department="${escapeHtml(p.targetDepartment)}"><h2>Lead Inquiry</h2></section>`;
    }
    const oa = escapeHtml(String(p.lineOaId || "").trim());
    return `<section data-block-id="${id}" data-block-type="LineContactBlock"><a href="https://line.me/R/ti/p/${oa}">${escapeHtml(p.buttonText || "Chat on LINE")}</a></section>`;
  }).join("\n    ");

  return [
    "<!doctype html>",
    '<html lang="th">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">',
    `  <title>${safeTitle}</title>`,
    `  <link rel="canonical" href="${canonicalUrl}">`,
    `  <script type="application/ld+json">${jsonLd}</script>`,
    "  <style>",
    "    .liff-builder-viewport { min-height: 100dvh; overscroll-behavior-y: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y; }",
    "    .builder-drag-handle { touch-action: none; overscroll-behavior-y: contain; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; cursor: grab; }",
    "  </style>",
    "</head>",
    `<body class="liff-builder-viewport" data-primary-color="${escapeHtml(ast.theme.primaryColor)}">`,
    `  <main id="nh-site-root">\n    ${renderedBlocks}\n  </main>`,
    '  <div id="builder-bottom-dock"></div>',
    "  <script>",
    "    if (window.visualViewport) {",
    "      const syncViewport = () => {",
    "        const vv = window.visualViewport;",
    "        const dock = document.getElementById('builder-bottom-dock');",
    "        if (dock) dock.style.transform = 'translateY(-' + Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px)';",
    "      };",
    "      window.visualViewport.addEventListener('resize', syncViewport);",
    "      window.visualViewport.addEventListener('scroll', syncViewport);",
    "    }",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function buildLineProposalFlexMessage(ast, { liveUrl, liffId }) {
  const check = validateSiteAst(ast);
  if (!check.valid) throw new Error(`Invalid SiteAST: ${check.errors.join("; ")}`);
  if (typeof liveUrl !== "string" || !/^https:\/\//.test(liveUrl)) {
    throw new Error("liveUrl must be an https:// URL");
  }
  if (typeof liffId !== "string" || !/^[A-Za-z0-9._-]+$/.test(liffId)) {
    throw new Error("liffId is required");
  }
  return {
    type: "flex",
    altText: `Industrial Proposal: ${ast.title}`,
    contents: {
      type: "bubble",
      header: {
        type: "box",
        layout: "vertical",
        backgroundColor: "#0F172A",
        contents: [
          { type: "text", text: "NEUROHANDS INDUSTRIAL PROPOSAL", color: "#38BDF8", size: "xs", weight: "bold" },
          { type: "text", text: ast.title, color: "#FFFFFF", size: "lg", weight: "bold", wrap: true },
        ],
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: `Active Blocks: ${ast.blocks.length} sections`, size: "sm", color: "#64748B" },
          { type: "separator" },
          { type: "text", text: "Tap below to view live deployment or inspect interactive specifications.", size: "sm", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            color: ast.theme.primaryColor,
            action: { type: "uri", label: "View Live Proposal", uri: liveUrl },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "uri", label: "Open in Builder", uri: `https://liff.line.me/${liffId}?site=${ast.siteSlug}` },
          },
        ],
      },
    },
  };
}

async function verifyLiffIdTokenAndMintJwt({
  idToken,
  channelId,
  verifySignature,
  resolveBinding,
  signSupabaseJwt,
  nowSec = Math.floor(Date.now() / 1000),
}) {
  if (typeof idToken !== "string" || !idToken.trim()) {
    return { ok: false, status: 401, code: "MISSING_ID_TOKEN" };
  }
  if (typeof channelId !== "string" || !channelId.trim()) {
    return { ok: false, status: 503, code: "LIFF_AUTH_UNCONFIGURED" };
  }
  const claims = await verifySignature(idToken);
  if (!claims || typeof claims !== "object") {
    return { ok: false, status: 401, code: "INVALID_ID_TOKEN" };
  }
  if (claims.iss !== "https://access.line.me") {
    return { ok: false, status: 401, code: "INVALID_ISSUER" };
  }
  if (String(claims.aud) !== String(channelId)) {
    return { ok: false, status: 401, code: "INVALID_AUDIENCE" };
  }
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSec) {
    return { ok: false, status: 401, code: "TOKEN_EXPIRED" };
  }
  if (typeof claims.sub !== "string" || !/^U[0-9a-f]{32}$/i.test(claims.sub)) {
    return { ok: false, status: 401, code: "INVALID_SUBJECT" };
  }
  const binding = await resolveBinding(claims.sub);
  if (!binding || !binding.active || !Number.isInteger(binding.client_account_id)) {
    return { ok: false, status: 403, code: "TENANT_BINDING_REQUIRED" };
  }
  const exp = nowSec + 3600;
  const payload = {
    aud: "authenticated",
    role: "authenticated",
    sub: `line:${claims.sub}`,
    app_metadata: { provider: "line" },
    user_metadata: {
      line_user_id: claims.sub,
      client_account_id: binding.client_account_id,
      client_code: binding.client_code,
      role: binding.role || "staff",
    },
    exp,
  };
  const supabaseToken = await signSupabaseJwt(payload);
  return { ok: true, status: 200, supabaseToken, claims: payload, expiresAt: exp };
}

module.exports = {
  ALLOWED_BLOCK_TYPES,
  validateSiteAst,
  calculateEdgingCost,
  compileSiteHtml,
  buildLineProposalFlexMessage,
  verifyLiffIdTokenAndMintJwt,
};
