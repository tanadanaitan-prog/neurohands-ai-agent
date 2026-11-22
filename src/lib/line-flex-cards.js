"use strict";

const DEFAULT_PUBLIC_BASE = "https://neurohands-ai-agent-production.up.railway.app";

const FLEX_BRAND = Object.freeze({
  navy: "#060D28",
  navyDeep: "#081337",
  cyan: "#0F8CE8",
  cyanBright: "#38BDF8",
  surface: "#FFFFFF",
  surfaceMuted: "#F1F5F9",
  border: "#E2E8F0",
  textDark: "#0F172A",
  textMuted: "#475569",
  textOnDarkMuted: "#CBD5E1",
  success: "#0F9D58",
  warning: "#D97706",
  danger: "#DC2626",
  defaultPublicBase: DEFAULT_PUBLIC_BASE,
  previewUrl: `${DEFAULT_PUBLIC_BASE}/neurohands`,
  guides: Object.freeze({
    welcome: "guide-welcome.png",
    activate: "guide-activate-1to1.png",
    group: "guide-connect-group.png",
    humanControl: "guide-human-control.png",
  }),
});

const VALID_BOX_LAYOUTS = new Set(["vertical", "horizontal", "baseline"]);
const VALID_ACTION_TYPES = new Set([
  "uri",
  "message",
  "postback",
  "datetimepicker",
  "clipboard",
  "camera",
  "cameraRoll",
  "location",
  "richmenuswitch",
]);

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function resolveHttpsBase(publicBase) {
  if (isHttpsUrl(publicBase)) return publicBase.trim().replace(/\/+$/, "");
  return FLEX_BRAND.defaultPublicBase;
}

function resolvePreviewUrl(previewUrl, publicBase) {
  if (isHttpsUrl(previewUrl)) return previewUrl.trim();
  return `${resolveHttpsBase(publicBase)}/neurohands`;
}

function resolveGuideImageUrl(guideFile, publicBase) {
  return `${resolveHttpsBase(publicBase)}/assets/guides/${guideFile}`;
}

function clampText(value, maxLen, fallback = "-") {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

function formatThb(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

function buildQuickReplies(items = []) {
  if (!Array.isArray(items) || !items.length) return undefined;
  const out = [];
  for (const raw of items) {
    if (out.length >= 13) break;
    if (!raw || typeof raw !== "object") continue;

    let action = raw.type === "action" && raw.action && typeof raw.action === "object"
      ? { ...raw.action }
      : null;

    if (!action) {
      const label = clampText(raw.label, 20, "");
      if (!label) continue;
      if (raw.type === "uri" || raw.uri) {
        if (!isHttpsUrl(raw.uri)) continue;
        action = { type: "uri", label, uri: raw.uri.trim() };
      } else if (raw.type === "postback" || raw.data) {
        const data = String(raw.data || "").trim().slice(0, 300);
        if (!data) continue;
        action = {
          type: "postback",
          label,
          data,
          ...(raw.displayText ? { displayText: clampText(raw.displayText, 300, label) } : {}),
        };
      } else {
        const text = String(raw.text || raw.label || "").trim().slice(0, 300);
        if (!text) continue;
        action = { type: "message", label, text };
      }
    } else {
      const label = clampText(action.label, 20, "");
      if (!label) continue;
      action.label = label;
      if (action.type === "uri" && !isHttpsUrl(action.uri)) continue;
      if (action.type === "message" && (!action.text || typeof action.text !== "string")) continue;
      if (action.type === "postback" && (!action.data || typeof action.data !== "string")) continue;
    }

    out.push({ type: "action", action });
  }
  return out.length ? { items: out } : undefined;
}

function validateAction(action, pathLabel, errors, { isQuickReply = false } = {}) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  if (!VALID_ACTION_TYPES.has(action.type)) {
    errors.push(`${pathLabel}.type '${action.type}' is unsupported`);
    return;
  }
  if (isQuickReply) {
    if (typeof action.label !== "string" || !action.label.trim() || action.label.length > 20) {
      errors.push(`${pathLabel}.label must be 1..20 chars`);
    }
  } else if (action.label !== undefined) {
    if (typeof action.label !== "string" || !action.label.trim() || action.label.length > 40) {
      errors.push(`${pathLabel}.label must be 1..40 chars`);
    }
  }
  if (action.type === "uri") {
    if (!isHttpsUrl(action.uri)) errors.push(`${pathLabel}.uri must be a valid https:// URL`);
  } else if (action.type === "message") {
    if (typeof action.text !== "string" || !action.text.trim() || action.text.length > 300) {
      errors.push(`${pathLabel}.text must be 1..300 chars`);
    }
  } else if (action.type === "postback") {
    if (typeof action.data !== "string" || !action.data.trim() || action.data.length > 300) {
      errors.push(`${pathLabel}.data must be 1..300 chars`);
    }
  }
}

function validateFlexNode(node, pathLabel, errors) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  if (node.action !== undefined) {
    validateAction(node.action, `${pathLabel}.action`, errors);
  }
  if (node.type === "box") {
    if (!VALID_BOX_LAYOUTS.has(node.layout)) {
      errors.push(`${pathLabel}.layout must be vertical, horizontal, or baseline`);
    }
    if (!Array.isArray(node.contents)) {
      errors.push(`${pathLabel}.contents must be an array`);
      return;
    }
    node.contents.forEach((child, idx) => validateFlexNode(child, `${pathLabel}.contents[${idx}]`, errors));
    return;
  }
  if (node.type === "text") {
    const hasSpans = Array.isArray(node.contents) && node.contents.length > 0;
    if (!hasSpans && (typeof node.text !== "string" || !node.text.trim())) {
      errors.push(`${pathLabel}.text must be a non-empty string`);
    }
    return;
  }
  if (node.type === "image") {
    if (!isHttpsUrl(node.url)) errors.push(`${pathLabel}.url must be a valid https:// URL`);
    return;
  }
  if (node.type === "button") {
    if (!node.action) errors.push(`${pathLabel}.action is required`);
    return;
  }
  if (node.type === "separator" || node.type === "filler" || node.type === "icon" || node.type === "span") {
    if (node.type === "icon" && !isHttpsUrl(node.url)) {
      errors.push(`${pathLabel}.url must be a valid https:// URL`);
    }
    return;
  }
  errors.push(`${pathLabel}.type '${node.type}' is unsupported`);
}

function validateBubble(bubble, pathLabel, errors) {
  if (!bubble || typeof bubble !== "object" || Array.isArray(bubble)) {
    errors.push(`${pathLabel} must be an object`);
    return;
  }
  if (bubble.type !== "bubble") {
    errors.push(`${pathLabel}.type must be 'bubble'`);
    return;
  }
  const hasSection = Boolean(bubble.header || bubble.hero || bubble.body || bubble.footer);
  if (!hasSection) {
    errors.push(`${pathLabel} must contain at least one section`);
    return;
  }
  if (bubble.hero !== undefined) validateFlexNode(bubble.hero, `${pathLabel}.hero`, errors);
  for (const section of ["header", "body", "footer"]) {
    if (bubble[section] !== undefined) {
      if (bubble[section]?.type !== "box") {
        errors.push(`${pathLabel}.${section} must be a box`);
      } else {
        validateFlexNode(bubble[section], `${pathLabel}.${section}`, errors);
      }
    }
  }
}

function validateFlexMessage(msg) {
  const errors = [];
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return { valid: false, errors: ["Flex message must be a non-null object"] };
  }
  if (msg.type !== "flex") errors.push("type must be 'flex'");
  if (typeof msg.altText !== "string" || !msg.altText.trim() || msg.altText.length > 400) {
    errors.push("altText must be a non-empty string up to 400 characters");
  }
  if (!msg.contents || typeof msg.contents !== "object" || Array.isArray(msg.contents)) {
    errors.push("contents must be a Flex container object");
  } else if (msg.contents.type === "bubble") {
    validateBubble(msg.contents, "contents", errors);
  } else if (msg.contents.type === "carousel") {
    if (!Array.isArray(msg.contents.contents) || !msg.contents.contents.length || msg.contents.contents.length > 12) {
      errors.push("carousel contents must contain 1..12 bubbles");
    } else {
      msg.contents.contents.forEach((b, idx) => validateBubble(b, `contents.contents[${idx}]`, errors));
    }
  } else {
    errors.push("contents.type must be 'bubble' or 'carousel'");
  }

  if (msg.quickReply !== undefined) {
    if (!msg.quickReply || typeof msg.quickReply !== "object" || !Array.isArray(msg.quickReply.items)) {
      errors.push("quickReply.items must be an array");
    } else if (msg.quickReply.items.length === 0 || msg.quickReply.items.length > 13) {
      errors.push("quickReply.items must contain 1..13 items");
    } else {
      msg.quickReply.items.forEach((item, idx) => {
        if (!item || typeof item !== "object" || item.type !== "action") {
          errors.push(`quickReply.items[${idx}].type must be 'action'`);
          return;
        }
        validateAction(item.action, `quickReply.items[${idx}].action`, errors, { isQuickReply: true });
      });
    }
  }

  if (msg.contents && typeof msg.contents === "object") {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(msg.contents), "utf8");
      if (bytes > 50000) errors.push("contents exceeds LINE 50KB Flex limit");
    } catch {
      errors.push("contents must be JSON-serializable");
    }
  }

  return { valid: errors.length === 0, errors };
}

function normalizeSingleLineMessage(item) {
  if (typeof item === "string") {
    if (!item) return null;
    return { type: "text", text: item.slice(0, 4900) };
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (item.type === "text") {
    const text = String(item.text || "").slice(0, 4900);
    if (!text) return null;
    const out = { type: "text", text };
    if (item.quickReply?.items?.length) out.quickReply = item.quickReply;
    return out;
  }
  if (item.type === "flex") {
    const check = validateFlexMessage(item);
    if (check.valid) return item;
    // Degrade invalid Flex to plain altText so LINE API never drops the reply with HTTP 400.
    const fallback = String(item.altText || "").trim().slice(0, 4900);
    return fallback ? { type: "text", text: fallback } : null;
  }
  if (typeof item.type === "string" && item.type.trim()) return item;
  return null;
}

function normalizeLineMessages(payload) {
  if (payload == null || payload === false) return [];
  const rawList = Array.isArray(payload) ? payload : [payload];
  const out = [];
  for (const entry of rawList) {
    if (out.length >= 5) break;
    const normalized = normalizeSingleLineMessage(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

function makeHeader({ eyebrow, title, thaiHint, backgroundColor = FLEX_BRAND.navy }) {
  const contents = [
    { type: "text", text: clampText(eyebrow, 48), color: FLEX_BRAND.cyanBright, size: "xxs", weight: "bold" },
    { type: "text", text: clampText(title, 80), color: FLEX_BRAND.surface, size: "lg", weight: "bold", wrap: true, margin: "xs" },
  ];
  if (thaiHint) {
    contents.push({
      type: "text",
      text: clampText(thaiHint, 90),
      color: FLEX_BRAND.textOnDarkMuted,
      size: "xs",
      wrap: true,
      margin: "xs",
    });
  }
  return {
    type: "box",
    layout: "vertical",
    backgroundColor,
    paddingAll: "lg",
    contents,
  };
}

function makeHero(guideFile, publicBase) {
  return {
    type: "image",
    url: resolveGuideImageUrl(guideFile, publicBase),
    size: "full",
    aspectRatio: "191:100",
    aspectMode: "cover",
  };
}

function makeBulletRow(text) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      { type: "text", text: "•", color: FLEX_BRAND.cyan, size: "sm", weight: "bold", flex: 0 },
      { type: "text", text: clampText(text, 140), color: FLEX_BRAND.textDark, size: "sm", wrap: true, flex: 1 },
    ],
  };
}

function makeKeyValueRow(label, value, { valueColor = FLEX_BRAND.textDark, boldValue = true } = {}) {
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    contents: [
      { type: "text", text: clampText(label, 40), color: FLEX_BRAND.textMuted, size: "sm", flex: 4 },
      {
        type: "text",
        text: clampText(value, 100),
        color: valueColor,
        size: "sm",
        weight: boldValue ? "bold" : "regular",
        align: "end",
        wrap: true,
        flex: 6,
      },
    ],
  };
}

function makeBadge(label, backgroundColor = FLEX_BRAND.cyan) {
  return {
    type: "box",
    layout: "horizontal",
    contents: [
      {
        type: "box",
        layout: "vertical",
        backgroundColor,
        cornerRadius: "xl",
        paddingStart: "md",
        paddingEnd: "md",
        paddingTop: "xs",
        paddingBottom: "xs",
        flex: 0,
        contents: [
          { type: "text", text: clampText(label, 40), color: FLEX_BRAND.surface, size: "xxs", weight: "bold" },
        ],
      },
    ],
  };
}

function makeThaiHintBox(hint) {
  return {
    type: "box",
    layout: "vertical",
    backgroundColor: FLEX_BRAND.surfaceMuted,
    cornerRadius: "md",
    paddingAll: "sm",
    margin: "md",
    contents: [
      { type: "text", text: clampText(hint, 160), color: FLEX_BRAND.textMuted, size: "xs", wrap: true },
    ],
  };
}

function makeFlexCard({ altText, header, hero, bodyContents, footerButtons, footerLayout = "vertical", quickReplyItems }) {
  const bubble = {
    type: "bubble",
    ...(hero ? { hero } : {}),
    header,
    body: {
      type: "box",
      layout: "vertical",
      backgroundColor: FLEX_BRAND.surface,
      spacing: "sm",
      paddingAll: "lg",
      contents: bodyContents,
    },
  };
  if (Array.isArray(footerButtons) && footerButtons.length) {
    bubble.footer = {
      type: "box",
      layout: footerLayout,
      backgroundColor: FLEX_BRAND.surface,
      spacing: "sm",
      paddingAll: "md",
      contents: footerButtons,
    };
  }
  const quickReply = buildQuickReplies(quickReplyItems);
  return {
    type: "flex",
    altText: clampText(altText, 400, "Neurohands"),
    contents: bubble,
    ...(quickReply ? { quickReply } : {}),
  };
}

function buildWelcomeFlexCard({ publicBase, previewUrl } = {}) {
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);
  return makeFlexCard({
    altText: "Welcome to Neurohands — Build your custom AI Agent for LINE or tap Activate to connect.",
    hero: makeHero(FLEX_BRAND.guides.welcome, publicBase),
    header: makeHeader({
      eyebrow: "NEUROHANDS • LINE AI PLATFORM",
      title: "Welcome to Neurohands",
      thaiHint: "ผู้ช่วย AI สำหรับธุรกิจบน LINE",
    }),
    bodyContents: [
      makeBulletRow("Custom AI team for quotes, orders & 24/7 customer replies"),
      makeBulletRow("Private hardware data ownership + 24/7 cloud operation"),
      makeBulletRow("Human Approval Gate before any sensitive action"),
      makeThaiHintBox("แตะปุ่มด้านล่างเพื่อทดลองสร้าง AI หรือเปิดใช้งานด้วยรหัส NH-"),
    ],
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "uri", label: "Build Your AI Agent", uri: builderUrl },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "postback", label: "Activate with Code", data: "menu=activate", displayText: "Activate" },
      },
    ],
    quickReplyItems: [
      { label: "Open Builder", uri: builderUrl },
      { label: "How to Activate", data: "menu=activate", displayText: "How to Activate" },
      { label: "Services", data: "menu=services", displayText: "Services" },
      { label: "Book Demo", text: "demo" },
    ],
  });
}

function buildActivationGuideCard({ publicBase, previewUrl } = {}) {
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);
  return makeFlexCard({
    altText: "Activate Neurohands: Send 'activate NH-YOUR-CODE' in this 1-to-1 chat or open the Builder to start.",
    hero: makeHero(FLEX_BRAND.guides.activate, publicBase),
    header: makeHeader({
      eyebrow: "1-TO-1 ACTIVATION GUIDE",
      title: "Activate Your AI Agent",
      thaiHint: "เปิดใช้งานผู้ช่วย AI ในแชตนี้",
    }),
    bodyContents: [
      makeBulletRow("1. Copy your full private code starting with NH- (not the shortened hint)"),
      makeBulletRow("2. Send: activate NH-YOUR-CODE right in this chat"),
      makeBulletRow("3. New to Neurohands? Send demo or build a live preview online"),
      makeThaiHintBox("พิมพ์ activate ตามด้วยรหัส NH- เต็ม หรือพิมพ์ demo เพื่อขอนัดสาธิต"),
    ],
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "uri", label: "Get Code in Builder", uri: builderUrl },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "message", label: "Request a Demo", text: "demo" },
      },
    ],
    quickReplyItems: [
      { label: "Book Demo", text: "demo" },
      { label: "Open Builder", uri: builderUrl },
      { label: "Contact Us", data: "menu=contact", displayText: "Contact Us" },
    ],
  });
}

function buildBrandInfoFlexCard(topic = "about", { publicBase, previewUrl, customText, agentSummary } = {}) {
  const key = String(topic || "about").toLowerCase().trim();
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);

  if (key === "activate") return buildActivationGuideCard({ publicBase, previewUrl: builderUrl });

  if (key === "services") {
    return makeFlexCard({
      altText: `What Neurohands Does — Custom AI customer service, instant B2B quotes with Approval Gate, and Private Hardware data storage. ${builderUrl}`,
      hero: makeHero(FLEX_BRAND.guides.welcome, publicBase),
      header: makeHeader({
        eyebrow: "NEUROHANDS SERVICES",
        title: "AI Team Built for Business",
        thaiHint: "บริการผู้ช่วย AI สำหรับธุรกิจ B2B",
      }),
      bodyContents: [
        makeBulletRow("24/7 customer service, enquiries & live order tracking"),
        makeBulletRow("Instant B2B price quotes with owner Approval Gate (Jarvis)"),
        makeBulletRow("Verified catalog & uploaded document answers"),
        makeBulletRow("Private hardware data storage + 24/7 cloud backup"),
        makeThaiHintBox("ออกแบบและทดสอบทีม AI ของคุณได้ฟรีบนหน้า Builder"),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "uri", label: "Build & Preview Agent", uri: builderUrl },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "postback", label: "Get Started", data: "menu=activate", displayText: "Get Started" },
        },
      ],
      quickReplyItems: [
        { label: "Open Builder", uri: builderUrl },
        { label: "Book Demo", text: "demo" },
        { label: "About Us", data: "menu=about", displayText: "About Us" },
        { label: "Contact Us", data: "menu=contact", displayText: "Contact Us" },
      ],
    });
  }

  if (key === "projects") {
    return makeFlexCard({
      altText: `Neurohands Custom AI Agent Builder — Tailored for Glass & Aluminium, Building Materials, Auto Parts, and B2B teams. ${builderUrl}`,
      hero: makeHero(FLEX_BRAND.guides.welcome, publicBase),
      header: makeHeader({
        eyebrow: "INDUSTRY SOLUTIONS",
        title: "Custom AI Agent Builder",
        thaiHint: "โซลูชัน AI สำหรับงานขายและบริการ",
      }),
      bodyContents: [
        makeBulletRow("Glass & Aluminium, Building Materials, Auto Parts & B2B"),
        makeBulletRow("Aria (service & orders), Suri (quotes), Mira (marketing), Jarvis (approvals)"),
        makeBulletRow("Keep company data on private hardware with 24/7 cloud routing"),
        makeThaiHintBox("ลองปรับแต่งบทบาทและราคาสินค้าของคุณเองได้ทันที"),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "uri", label: "Launch Agent Builder", uri: builderUrl },
        },
      ],
      quickReplyItems: [
        { label: "Open Builder", uri: builderUrl },
        { label: "Services", data: "menu=services", displayText: "Services" },
        { label: "Book Demo", text: "demo" },
      ],
    });
  }

  if (key === "contact") {
    return makeFlexCard({
      altText: `Contact Neurohands — Hours 08:00–18:00 Mon–Sat (Bangkok time). Send demo in chat or visit ${builderUrl}`,
      hero: makeHero(FLEX_BRAND.guides.humanControl, publicBase),
      header: makeHeader({
        eyebrow: "DIRECT SUPPORT",
        title: "Contact Neurohands",
        thaiHint: "ช่องทางติดต่อทีมงาน Neurohands",
      }),
      bodyContents: [
        makeKeyValueRow("Channel", "This LINE chat"),
        makeKeyValueRow("Hours", "08:00–18:00 Mon–Sat (BKT)"),
        makeKeyValueRow("Demo", 'Send "demo" in chat'),
        makeThaiHintBox("พิมพ์ demo เพื่อขอนัดสาธิตระบบ หรือเปิดหน้า Builder ออนไลน์ได้เลย"),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "message", label: "Book a Demo", text: "demo" },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "uri", label: "Open Agent Builder", uri: builderUrl },
        },
      ],
      quickReplyItems: [
        { label: "Book Demo", text: "demo" },
        { label: "Open Builder", uri: builderUrl },
        { label: "How to Activate", data: "menu=activate", displayText: "How to Activate" },
      ],
    });
  }

  if (key === "updates") {
    const bodyContents = [
      makeBulletRow("Interactive LINE AI Agent Builder (English & Thai)"),
      makeBulletRow("Private Hardware Data Ownership + 24/7 Cloud Backup"),
      makeBulletRow("1-tap LINE Group connection & Human Takeover controls"),
    ];
    if (typeof customText === "string" && customText.trim()) {
      const compactNote = clampText(customText, 240, "");
      if (compactNote) {
        bodyContents.push({ type: "separator", margin: "sm" });
        bodyContents.push({ type: "text", text: compactNote, size: "xs", color: FLEX_BRAND.textMuted, wrap: true });
      }
    }
    bodyContents.push(makeThaiHintBox("พิมพ์ demo ได้ทุกเมื่อเพื่อขอนัดสาธิตระบบสำหรับธุรกิจของคุณ"));
    return makeFlexCard({
      altText: `Neurohands Updates — Build your own AI Agent for LINE with Private Hardware ownership + 24/7 cloud operation. ${builderUrl}`,
      hero: makeHero(FLEX_BRAND.guides.welcome, publicBase),
      header: makeHeader({
        eyebrow: "LATEST UPDATES",
        title: "What's New in Neurohands",
        thaiHint: "อัปเดตความสามารถล่าสุด",
      }),
      bodyContents,
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "uri", label: "Try Agent Builder", uri: builderUrl },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "message", label: "Book a Demo", text: "demo" },
        },
      ],
      quickReplyItems: [
        { label: "Open Builder", uri: builderUrl },
        { label: "Book Demo", text: "demo" },
        { label: "How to Activate", data: "menu=activate", displayText: "How to Activate" },
      ],
    });
  }

  if (key === "quote") {
    return makeFlexCard({
      altText: "Instant Quotation — Send product, size (W x H), and quantity. Example: Quote 10mm tempered glass 2x3m",
      header: makeHeader({
        eyebrow: "INSTANT QUOTATION",
        title: "Request a Price Quote",
        thaiHint: "ขอราคาประเมินทันทีจากรายการสินค้า",
      }),
      bodyContents: [
        makeBulletRow("Share product name or thickness (e.g. 10mm tempered glass)"),
        makeBulletRow("Include dimensions (e.g. 2x3m or 120x240 cm)"),
        makeBulletRow("Standard rates are instant; formal quotes confirmed by sales"),
        makeThaiHintBox('ตัวอย่าง: "Quote 10mm tempered glass 2x3m" หรือ "ขอราคา กระจก 10mm 2x3m"'),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "message", label: "Try Sample Quote", text: "Quote 10mm tempered glass 2x3m" },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "message", label: "Talk to Human", text: "human" },
        },
      ],
      quickReplyItems: [
        { label: "New Quote", text: "Quote 10mm tempered glass 2x3m" },
        { label: "Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
        { label: "Talk to Human", text: "human" },
      ],
    });
  }

  if (key === "support") {
    return makeFlexCard({
      altText: "Support — Describe your issue with your order number (e.g. Order PO12345 glass cracked on delivery) or tap Talk to Human.",
      hero: makeHero(FLEX_BRAND.guides.humanControl, publicBase),
      header: makeHeader({
        eyebrow: "CUSTOMER SUPPORT",
        title: "How Can We Help?",
        thaiHint: "แจ้งปัญหาหรือติดต่อเจ้าหน้าที่โดยตรง",
      }),
      bodyContents: [
        makeBulletRow("Describe the issue and include your order number if available"),
        makeBulletRow('Example: "Order PO12345 glass cracked on delivery"'),
        makeBulletRow("Need a real person immediately? Tap Talk to Human below"),
        makeThaiHintBox("แจ้งเลขที่ออเดอร์พร้อมรายละเอียด หรือกดปุ่มเพื่อคุยกับเจ้าหน้าที่ทันที"),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "message", label: "Talk to Human", text: "human" },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "postback", label: "Check Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
        },
      ],
      quickReplyItems: [
        { label: "Talk to Human", text: "human" },
        { label: "Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
        { label: "Contact Us", data: "menu=contact", displayText: "Contact Us" },
      ],
    });
  }

  if (key === "agent") {
    const info = agentSummary && typeof agentSummary === "object" ? agentSummary : {};
    const name = info.name || "Aria";
    const code = info.code || "AGT-001";
    const domains = Array.isArray(info.domains) && info.domains.length ? info.domains.join(" • ") : "Sales & Support";
    const manager = info.manager || "Jarvis";
    const memCount = Number.isFinite(Number(info.memoryCount)) ? Number(info.memoryCount) : 0;
    return makeFlexCard({
      altText: `Your AI Agent: ${name} (${code}) — Domains: ${domains}. Manager: ${manager} (human approval).`,
      hero: makeHero(FLEX_BRAND.guides.activate, publicBase),
      header: makeHeader({
        eyebrow: "ACTIVE WORKSPACE AGENT",
        title: `${name} (${code})`,
        thaiHint: "ผู้ช่วย AI ที่พร้อมดูแลคุณในแชตนี้",
      }),
      bodyContents: [
        makeBadge("ONLINE • VERIFIED DATA ONLY", FLEX_BRAND.success),
        makeKeyValueRow("Domains", domains),
        makeKeyValueRow("Approval Gate", `${manager} (Human)`),
        makeKeyValueRow("Saved Memory", `${memCount} fact(s)`),
        makeThaiHintBox("ถามราคา ระยะเวลาผลิต ออเดอร์ หรือพิมพ์ upload เพื่ออัปโหลดเอกสาร"),
      ],
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "postback", label: "Get a Quote", data: "menu=quote", displayText: "Get a Quote" },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: { type: "postback", label: "Check Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
        },
      ],
      quickReplyItems: [
        { label: "Get a Quote", data: "menu=quote", displayText: "Get a Quote" },
        { label: "Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
        { label: "Talk to Human", text: "human" },
      ],
    });
  }

  return makeFlexCard({
    altText: `About Neurohands — Custom AI Agent Platform for LINE with Private Hardware Data Storage and 24/7 Cloud Operation with automatic backup. ${builderUrl}`,
    hero: makeHero(FLEX_BRAND.guides.welcome, publicBase),
    header: makeHeader({
      eyebrow: "ABOUT NEUROHANDS",
      title: "Your Custom AI Agent Team",
      thaiHint: "แพลตฟอร์ม AI Agent สำหรับ LINE Official Account",
    }),
    bodyContents: [
      makeBulletRow("Dedicated AI roles: Aria (service), Suri (quotes), Mira (marketing), Jarvis (approvals)"),
      makeBulletRow("Private Hardware Storage: your data stays on your own hardware"),
      makeBulletRow("24/7 Cloud Operation & Automatic Backup keeps LINE always responsive"),
      makeThaiHintBox("ทดลองสร้างและดูตัวอย่าง AI Agent ของคุณได้ทันทีบนเว็บ"),
    ],
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "uri", label: "Open Agent Builder", uri: builderUrl },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "message", label: "Book a Demo", text: "demo" },
      },
    ],
    quickReplyItems: [
      { label: "Open Builder", uri: builderUrl },
      { label: "Services", data: "menu=services", displayText: "Services" },
      { label: "How to Activate", data: "menu=activate", displayText: "How to Activate" },
      { label: "Book Demo", text: "demo" },
    ],
  });
}

function buildGroupJoinCard({ publicBase, previewUrl } = {}) {
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);
  return makeFlexCard({
    altText: "Neurohands joined this group. Send bind NH-YOUR-CODE to connect your AI agent. Note: LINE allows one Official Account per group.",
    hero: makeHero(FLEX_BRAND.guides.group, publicBase),
    header: makeHeader({
      eyebrow: "LINE GROUP SETUP",
      title: "Neurohands Joined Group",
      thaiHint: "พร้อมเชื่อมต่อ AI เข้าสู่กลุ่ม LINE นี้",
    }),
    bodyContents: [
      {
        type: "box",
        layout: "vertical",
        backgroundColor: FLEX_BRAND.surfaceMuted,
        cornerRadius: "md",
        paddingAll: "md",
        contents: [
          { type: "text", text: "SEND IN THIS GROUP", color: FLEX_BRAND.textMuted, size: "xxs", weight: "bold" },
          { type: "text", text: "bind NH-YOUR-CODE", color: FLEX_BRAND.navy, size: "md", weight: "bold", margin: "xs" },
        ],
      },
      makeBulletRow("Only replies when @mentioned by default (never spams team chat)"),
      makeBulletRow("Note: LINE allows one Official Account per group"),
      makeThaiHintBox("พิมพ์ bind NH-รหัสของคุณ ในกลุ่มนี้เพื่อเชื่อมต่อกับระบบของบริษัท"),
    ],
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "uri", label: "Get Group Code Online", uri: builderUrl },
      },
    ],
    quickReplyItems: [
      { label: "Open Builder", uri: builderUrl },
      { label: "How to Activate", data: "menu=activate", displayText: "How to Activate" },
    ],
  });
}

function buildGroupBoundCard({ sourceType = "group", clientCode = "WORKSPACE", responseMode = "mention_only", publicBase, previewUrl } = {}) {
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);
  const modeLabel = responseMode === "mention_only"
    ? "@Mention Only"
    : responseMode === "keyword"
      ? "@Mention & Keywords"
      : responseMode === "off"
        ? "Paused"
        : String(responseMode);
  return makeFlexCard({
    altText: `Connected this LINE ${sourceType} to ${clientCode}. Response rule: ${responseMode}. Mention @Neurohands whenever you want the agent to reply.`,
    hero: makeHero(FLEX_BRAND.guides.group, publicBase),
    header: makeHeader({
      eyebrow: "GROUP CONNECTED",
      title: `Connected to ${clientCode}`,
      thaiHint: "เชื่อมต่อกลุ่มกับพื้นที่ทำงานสำเร็จแล้ว",
    }),
    bodyContents: [
      makeBadge("ACTIVE • READY IN GROUP", FLEX_BRAND.success),
      makeKeyValueRow("Channel", `LINE ${sourceType}`),
      makeKeyValueRow("Workspace", clientCode),
      makeKeyValueRow("Reply Rule", modeLabel),
      makeThaiHintBox("แท็ก @Neurohands ทุกครั้งเมื่อต้องการให้ AI ช่วยคำนวณราคาหรือตอบคำถาม"),
    ],
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "message", label: "Try Sample Quote", text: "@Neurohands Quote 10mm tempered glass 2x3m" },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "uri", label: "Manage in Builder", uri: builderUrl },
      },
    ],
    quickReplyItems: [
      { label: "Lead Time", text: "@Neurohands what is the lead time?" },
      { label: "Talk to Human", text: "@Neurohands human" },
    ],
  });
}

function buildQuoteFlexCard(quoteData = {}, { agentName = "Aria", altText, publicBase } = {}) {
  const itemName = clampText(quoteData.itemName, 90, "Glass Product");
  const areaSqft = Number.isFinite(Number(quoteData.areaSqft)) ? Number(quoteData.areaSqft) : 0;
  const ratePerSqft = Number.isFinite(Number(quoteData.ratePerSqft)) ? Number(quoteData.ratePerSqft) : 0;
  const edgingCostThb = Number.isFinite(Number(quoteData.edgingCostThb)) ? Number(quoteData.edgingCostThb) : 0;
  const glassTotalThb = Number.isFinite(Number(quoteData.glassTotalThb))
    ? Number(quoteData.glassTotalThb)
    : Math.round(areaSqft * ratePerSqft);
  const grandTotalThb = Number.isFinite(Number(quoteData.grandTotalThb))
    ? Number(quoteData.grandTotalThb)
    : glassTotalThb + edgingCostThb;
  const sourceLabel = clampText(quoteData.sourceLabel, 50, "Current price list");

  const bodyContents = [
    makeBadge(`SOURCE: ${sourceLabel.toUpperCase()}`, FLEX_BRAND.cyan),
    makeKeyValueRow("Product", itemName),
    makeKeyValueRow("Area", `${areaSqft} sqft`),
    makeKeyValueRow("Rate", `${formatThb(ratePerSqft)} THB/sqft`),
  ];
  if (edgingCostThb > 0) {
    bodyContents.push(makeKeyValueRow("Edging", `${formatThb(edgingCostThb)} THB`));
  }
  bodyContents.push(
    { type: "separator", margin: "md" },
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      alignItems: "center",
      contents: [
        { type: "text", text: "Total THB", color: FLEX_BRAND.navy, size: "md", weight: "bold", flex: 4 },
        {
          type: "text",
          text: `${formatThb(grandTotalThb)} THB`,
          color: FLEX_BRAND.cyan,
          size: "xl",
          weight: "bold",
          align: "end",
          flex: 6,
        },
      ],
    },
    makeThaiHintBox("ราคาประเมินจากข้อมูลที่ยืนยันแล้ว ทีมขายจะเป็นผู้ยืนยันใบเสนอราคาทางการ"),
  );

  const computedAlt = altText || `${itemName} (${areaSqft} sqft @ ${formatThb(ratePerSqft)} THB/sqft = ${formatThb(grandTotalThb)} THB) — ${sourceLabel}`;
  return makeFlexCard({
    altText: computedAlt,
    header: makeHeader({
      eyebrow: `INSTANT QUOTE • ${String(agentName || "Aria").toUpperCase()}`,
      title: itemName,
      thaiHint: "ใบประเมินราคาเบื้องต้น",
    }),
    bodyContents,
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "message", label: "Talk to Human", text: "human" },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "message", label: "Check Lead Time", text: "What is the lead time?" },
      },
    ],
    quickReplyItems: [
      { label: "Talk to Human", text: "human" },
      { label: "Lead Time", text: "What is the lead time?" },
      { label: "New Quote", text: "Quote 10mm tempered glass 2x3m" },
    ],
  });
}

function buildApprovalFlexCard({
  proposalId,
  summary,
  clientCode,
  agentName = "Jarvis",
  channelType,
  threadId,
  publicBase,
  audience = "operator",
} = {}) {
  const hasProposalId = proposalId != null && String(proposalId).trim().length > 0;
  const idLabel = hasProposalId ? `#${proposalId}` : "Pending";

  if (audience === "customer") {
    const bodyContents = [
      makeBadge("AWAITING TEAM CONFIRMATION", FLEX_BRAND.warning),
      ...(hasProposalId ? [makeKeyValueRow("Reference", idLabel)] : []),
      {
        type: "text",
        text: "A human team member has been notified and will confirm shortly.",
        color: FLEX_BRAND.textDark,
        size: "sm",
        wrap: true,
        margin: "sm",
      },
      makeThaiHintBox("รอทีมงานยืนยันคำขอของคุณ เจ้าหน้าที่จะตอบกลับโดยเร็วที่สุดครับ"),
    ];
    return makeFlexCard({
      altText: `Approval requested${hasProposalId ? ` (${idLabel})` : ""} — a human team member has been notified and will confirm shortly.`,
      hero: makeHero(FLEX_BRAND.guides.humanControl, publicBase),
      header: makeHeader({
        eyebrow: `HUMAN REVIEW • ${String(agentName || "Aria").toUpperCase()}`,
        title: "Approval Requested",
        thaiHint: "รอทีมงานยืนยัน",
        backgroundColor: FLEX_BRAND.navyDeep,
      }),
      bodyContents,
      footerButtons: [
        {
          type: "button",
          style: "primary",
          color: FLEX_BRAND.cyan,
          height: "sm",
          action: { type: "message", label: "Talk to Human", text: "human" },
        },
      ],
      quickReplyItems: [
        { label: "Talk to Human", text: "human" },
        { label: "Lead Time", text: "What is the lead time?" },
      ],
    });
  }

  const summaryText = clampText(
    summary,
    240,
    "This request requires human approval before execution."
  );
  const bodyContents = [
    makeBadge("AWAITING HUMAN APPROVAL", FLEX_BRAND.warning),
    makeKeyValueRow("Proposal", idLabel),
  ];
  if (clientCode) bodyContents.push(makeKeyValueRow("Workspace", String(clientCode)));
  if (channelType) bodyContents.push(makeKeyValueRow("Channel", String(channelType)));
  bodyContents.push(
    { type: "separator", margin: "sm" },
    {
      type: "box",
      layout: "vertical",
      backgroundColor: FLEX_BRAND.surfaceMuted,
      cornerRadius: "md",
      paddingAll: "md",
      contents: [
        { type: "text", text: "REQUEST DETAILS", color: FLEX_BRAND.textMuted, size: "xxs", weight: "bold" },
        { type: "text", text: summaryText, color: FLEX_BRAND.textDark, size: "sm", wrap: true, margin: "xs" },
      ],
    },
    makeThaiHintBox("ผู้ดูแลกดปุ่ม Approve (yes) เพื่ออนุมัติ หรือ Reject (no) เพื่อยกเลิก"),
  );

  return makeFlexCard({
    altText: `Approval required (${idLabel}): ${summaryText}. Tap Approve (yes) or Reject (no).`,
    hero: makeHero(FLEX_BRAND.guides.humanControl, publicBase),
    header: makeHeader({
      eyebrow: `APPROVAL GATE • ${String(agentName || "Jarvis").toUpperCase()}`,
      title: `Proposal ${idLabel}`,
      thaiHint: "ต้องได้รับการอนุมัติจากผู้ดูแลก่อนดำเนินการ",
      backgroundColor: FLEX_BRAND.navyDeep,
    }),
    bodyContents,
    footerLayout: "horizontal",
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.success,
        height: "sm",
        action: { type: "message", label: "Approve", text: "yes" },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "message", label: "Reject", text: "no" },
      },
    ],
    quickReplyItems: [
      { label: "Approve", text: "yes" },
      { label: "Reject", text: "no" },
      { label: "Check Pending", text: "pending" },
    ],
  });
}

function buildHandoverFlexCard({ agentName = "Aria", reason, threadId, clientCode, publicBase, previewUrl } = {}) {
  const builderUrl = resolvePreviewUrl(previewUrl, publicBase);
  const bodyContents = [
    makeBadge("AI PAUSED • HUMAN TAKEOVER", FLEX_BRAND.warning),
    {
      type: "text",
      text: `${clampText(agentName, 40, "Aria")} has paused automated replies and notified a human team member to take over this conversation.`,
      color: FLEX_BRAND.textDark,
      size: "sm",
      wrap: true,
    },
  ];
  if (clientCode) bodyContents.push(makeKeyValueRow("Workspace", String(clientCode)));
  if (reason) bodyContents.push(makeKeyValueRow("Status", clampText(reason, 80)));
  bodyContents.push(makeThaiHintBox("ระบบหยุดการตอบอัตโนมัติแล้ว เจ้าหน้าที่จะเข้ามาดูแลคุณต่อโดยตรงครับ"));

  return makeFlexCard({
    altText: `${agentName} paused automated replies and notified a human team member to take over this conversation.`,
    hero: makeHero(FLEX_BRAND.guides.humanControl, publicBase),
    header: makeHeader({
      eyebrow: "HUMAN HANDOVER",
      title: "Human Team Notified",
      thaiHint: "ส่งต่อการสนทนาให้เจ้าหน้าที่เรียบร้อยแล้ว",
    }),
    bodyContents,
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "postback", label: "Check Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
      },
    ],
    quickReplyItems: [
      { label: "Lead Time", data: "menu=lead_time", displayText: "Lead Time" },
      { label: "Contact Us", data: "menu=contact", displayText: "Contact Us" },
      { label: "Open Builder", uri: builderUrl },
    ],
  });
}

function buildLeadTimeFlexCard({ defaultDays = 7, orderNo, promisedDate, publicBase } = {}) {
  const days = Number.isFinite(Number(defaultDays)) && Number(defaultDays) > 0 ? Number(defaultDays) : 7;
  const bodyContents = [
    {
      type: "box",
      layout: "vertical",
      backgroundColor: FLEX_BRAND.surfaceMuted,
      cornerRadius: "md",
      paddingAll: "md",
      alignItems: "center",
      contents: [
        { type: "text", text: `${days} Days`, color: FLEX_BRAND.cyan, size: "xxl", weight: "bold" },
        { type: "text", text: "Standard Production Lead Time", color: FLEX_BRAND.textMuted, size: "xs", margin: "xs" },
      ],
    },
  ];
  if (orderNo) bodyContents.push(makeKeyValueRow("Order No.", String(orderNo)));
  if (promisedDate) bodyContents.push(makeKeyValueRow("Promised Date", String(promisedDate)));
  bodyContents.push(
    makeKeyValueRow("Order Check", 'Send "Check order PO12345"'),
    makeThaiHintBox("พิมพ์เลขที่ออเดอร์ เช่น Check order PO12345 เพื่อเช็กวันส่งมอบเฉพาะงาน"),
  );

  return makeFlexCard({
    altText: `Standard production lead time is ${days} days. Share your order number (e.g. Check order PO12345) for an order-specific date.`,
    header: makeHeader({
      eyebrow: "PRODUCTION SCHEDULE",
      title: "Standard Lead Time",
      thaiHint: "ระยะเวลาการผลิตมาตรฐาน",
    }),
    bodyContents,
    footerButtons: [
      {
        type: "button",
        style: "primary",
        color: FLEX_BRAND.cyan,
        height: "sm",
        action: { type: "postback", label: "Get Instant Quote", data: "menu=quote", displayText: "Get a Quote" },
      },
      {
        type: "button",
        style: "secondary",
        height: "sm",
        action: { type: "message", label: "Talk to Human", text: "human" },
      },
    ],
    quickReplyItems: [
      { label: "Get a Quote", data: "menu=quote", displayText: "Get a Quote" },
      { label: "Talk to Human", text: "human" },
      { label: "Contact Us", data: "menu=contact", displayText: "Contact Us" },
    ],
  });
}

module.exports = {
  FLEX_BRAND,
  validateFlexMessage,
  normalizeLineMessages,
  buildQuickReplies,
  buildWelcomeFlexCard,
  buildBrandInfoFlexCard,
  buildActivationGuideCard,
  buildGroupJoinCard,
  buildGroupBoundCard,
  buildQuoteFlexCard,
  buildApprovalFlexCard,
  buildHandoverFlexCard,
  buildLeadTimeFlexCard,
};
