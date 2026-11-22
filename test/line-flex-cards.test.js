"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
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
} = require("../src/lib/line-flex-cards");
const { DEFAULT_ARIA_WORKFLOW, validateWorkflowSpec, executeWorkflowTurn } = require("../src/lib/workflow-runtime");

const PRIVATE = "fixture-secret-never-print-this-flex";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("All LINE Flex Card builders emit valid, branded, bilingual HTTPS Flex Messages", () => {
  const customBase = "https://demo.neurohands.site/";
  const cards = [
    ["welcome", buildWelcomeFlexCard({ publicBase: customBase })],
    ["activate", buildActivationGuideCard({ publicBase: customBase })],
    ["groupJoin", buildGroupJoinCard({ publicBase: customBase })],
    ["groupBound", buildGroupBoundCard({ sourceType: "group", clientCode: "KNC", responseMode: "mention_only", publicBase: customBase })],
    [
      "quoteNoEdge",
      buildQuoteFlexCard(
        {
          itemName: "Tempered Clear 10mm",
          areaSqft: 64.58,
          ratePerSqft: 120,
          glassTotalThb: 7750,
          edgingCostThb: 0,
          grandTotalThb: 7750,
          sourceLabel: "Current price list",
        },
        { agentName: "Aria", publicBase: customBase },
      ),
    ],
    [
      "quoteWithEdge",
      buildQuoteFlexCard(
        {
          itemName: "Tempered Clear 10mm",
          areaSqft: 64.58,
          ratePerSqft: 120,
          glassTotalThb: 7750,
          edgingCostThb: 600,
          grandTotalThb: 8350,
          sourceLabel: "Approved knowledge base",
        },
        { agentName: "Aria", publicBase: customBase },
      ),
    ],
    [
      "approval",
      buildApprovalFlexCard({
        proposalId: 42,
        summary: "Give 15% discount on 10mm tempered glass order",
        clientCode: "KNC",
        channelType: "line_group",
        publicBase: customBase,
      }),
    ],
    ["handover", buildHandoverFlexCard({ agentName: "Aria", reason: "Customer requested human", clientCode: "KNC", publicBase: customBase })],
    ["leadTime", buildLeadTimeFlexCard({ defaultDays: 7, publicBase: customBase })],
    ...["about", "services", "projects", "contact", "updates", "quote", "support", "agent", "activate"].map((topic) => [
      `brand:${topic}`,
      buildBrandInfoFlexCard(topic, {
        publicBase: customBase,
        customText: topic === "updates" ? "Fresh update text." : undefined,
        agentSummary: topic === "agent" ? { name: "Aria", code: "AGT-001", domains: ["sales", "support"], manager: "Jarvis", memoryCount: 3 } : undefined,
      }),
    ]),
  ];

  for (const [name, card] of cards) {
    const check = validateFlexMessage(card);
    assert.equal(check.valid, true, `${name} failed validation: ${check.errors.join("; ")}`);
    assert.equal(card.type, "flex");
    assert.ok(card.contents.header.backgroundColor === FLEX_BRAND.navy || card.contents.header.backgroundColor === FLEX_BRAND.navyDeep);
    assert.equal(card.contents.body.backgroundColor, FLEX_BRAND.surface);
    if (card.contents.hero) {
      assert.equal(card.contents.hero.aspectRatio, "191:100", `${name} hero aspectRatio must match 1200x628 guides`);
    }
    assert.doesNotMatch(JSON.stringify(card), /tanadanaitan|prototype/i, `${name} must not leak personal or prototype wording`);
  }

  const welcome = cards[0][1];
  assert.equal(welcome.contents.hero.url, "https://demo.neurohands.site/assets/guides/guide-welcome.png");

  const activate = cards[1][1];
  assert.equal(activate.contents.hero.url, "https://demo.neurohands.site/assets/guides/guide-activate-1to1.png");

  const groupJoin = cards[2][1];
  assert.equal(groupJoin.contents.hero.url, "https://demo.neurohands.site/assets/guides/guide-connect-group.png");

  const quoteNoEdgeJson = JSON.stringify(cards[4][1].contents.body);
  assert.match(quoteNoEdgeJson, /Product/);
  assert.match(quoteNoEdgeJson, /Area/);
  assert.match(quoteNoEdgeJson, /Rate/);
  assert.match(quoteNoEdgeJson, /Total THB/);
  assert.match(quoteNoEdgeJson, /7,750 THB/);
  assert.doesNotMatch(quoteNoEdgeJson, /"Edging"/);
  assert.deepEqual(
    cards[4][1].quickReply.items.map((item) => item.action.label),
    ["Talk to Human", "Lead Time", "New Quote"],
  );

  const quoteWithEdgeJson = JSON.stringify(cards[5][1].contents.body);
  assert.match(quoteWithEdgeJson, /"Edging"/);
  assert.match(quoteWithEdgeJson, /600 THB/);
  assert.match(quoteWithEdgeJson, /8,350 THB/);

  const approval = cards[6][1];
  assert.equal(approval.contents.hero.url, "https://demo.neurohands.site/assets/guides/guide-human-control.png");
  const footerActions = approval.contents.footer.contents.map((btn) => ({ label: btn.action.label, text: btn.action.text }));
  assert.deepEqual(footerActions, [
    { label: "Approve", text: "yes" },
    { label: "Reject", text: "no" },
  ]);

  const customerApproval = buildApprovalFlexCard({
    proposalId: 42,
    clientCode: "9999",
    agentName: "Aria",
    audience: "customer",
    publicBase: customBase,
  });
  assert.equal(validateFlexMessage(customerApproval).valid, true);
  assert.equal(customerApproval.contents.hero.aspectRatio, "191:100");
  assert.match(customerApproval.altText, /Approval requested \(#42\)/);
  assert.doesNotMatch(JSON.stringify(customerApproval), /9999|"yes"|"no"|"Approve"|"Reject"/);
  assert.equal(
    customerApproval.contents.footer.contents.some((btn) => btn.action.text === "yes" || btn.action.text === "no"),
    false,
  );
  assert.equal(
    customerApproval.quickReply.items.some((item) => item.action.text === "yes" || item.action.text === "no"),
    false,
  );

  const fallbackHttps = buildWelcomeFlexCard({ publicBase: "http://localhost:3000" });
  assert.equal(validateFlexMessage(fallbackHttps).valid, true);
  assert.equal(fallbackHttps.contents.hero.url.startsWith("https://"), true);
});

test("validateFlexMessage, buildQuickReplies, and normalizeLineMessages enforce LINE API limits", () => {
  assert.equal(validateFlexMessage(null).valid, false);
  assert.equal(validateFlexMessage({ type: "text", text: "hi" }).valid, false);

  const baseCard = buildLeadTimeFlexCard({ defaultDays: 7 });
  assert.equal(validateFlexMessage({ ...baseCard, altText: "" }).valid, false);
  assert.equal(validateFlexMessage({ ...baseCard, altText: "a".repeat(401) }).valid, false);
  assert.equal(validateFlexMessage({ ...baseCard, contents: { type: "box" } }).valid, false);

  const httpHero = structuredClone(buildWelcomeFlexCard());
  httpHero.contents.hero.url = "http://insecure.example/guide.png";
  assert.equal(validateFlexMessage(httpHero).valid, false);

  const jsButton = structuredClone(buildWelcomeFlexCard());
  jsButton.contents.footer.contents[0].action.uri = "javascript:alert(1)";
  assert.equal(validateFlexMessage(jsButton).valid, false);

  const tooManyQuickReplies = structuredClone(baseCard);
  tooManyQuickReplies.quickReply = {
    items: Array.from({ length: 14 }, (_, i) => ({
      type: "action",
      action: { type: "message", label: `Chip ${i}`, text: `chip-${i}` },
    })),
  };
  assert.equal(validateFlexMessage(tooManyQuickReplies).valid, false);

  const overlongChip = structuredClone(baseCard);
  overlongChip.quickReply = {
    items: [{ type: "action", action: { type: "message", label: "Label longer than twenty chars", text: "hi" } }],
  };
  assert.equal(validateFlexMessage(overlongChip).valid, false);

  const builtQr = buildQuickReplies([
    ...Array.from({ length: 16 }, (_, i) => ({ label: `Very Long Chip Title ${i}`, text: `t${i}` })),
    { label: "Bad URI", uri: "http://insecure.example" },
  ]);
  assert.equal(builtQr.items.length, 13);
  assert.equal(builtQr.items.every((item) => item.action.label.length <= 20), true);

  assert.deepEqual(normalizeLineMessages("Hello"), [{ type: "text", text: "Hello" }]);
  assert.deepEqual(normalizeLineMessages(""), []);
  assert.deepEqual(normalizeLineMessages(null), []);
  assert.equal(normalizeLineMessages([baseCard, "a", "b", "c", "d", "e"]).length, 5);

  const degraded = normalizeLineMessages(httpHero);
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].type, "text");
  assert.equal(degraded[0].text, httpHero.altText);
});

test("executeWorkflowTurn attaches structured quoteData for catalog, edging, and knowledgeEntries quotes", async () => {
  const catalogSpec = validateWorkflowSpec(DEFAULT_ARIA_WORKFLOW);
  const catalogRows = [
    { product_code: "TMP-CLR-10", glass_name: "Tempered Clear 10mm", thickness_mm: 10, price_per_sqft: 120, active: true },
  ];

  const catOut = await executeWorkflowTurn({
    spec: catalogSpec,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    message: "Quote 10mm tempered glass 2x3m bevel edge",
    catalogRows,
  });
  assert.ok(catOut.quoteData);
  assert.equal(catOut.quoteData.itemName, "Tempered Clear 10mm");
  assert.equal(catOut.quoteData.areaSqft, 64.58);
  assert.equal(catOut.quoteData.ratePerSqft, 120);
  assert.equal(catOut.quoteData.glassTotalThb, 7750);
  assert.equal(catOut.quoteData.edgingCostThb, 600);
  assert.equal(catOut.quoteData.grandTotalThb, 8350);
  assert.equal(catOut.quoteData.sourceLabel, "Current price list");
  assert.equal(validateFlexMessage(buildQuoteFlexCard(catOut.quoteData)).valid, true);

  const kbSpec = validateWorkflowSpec({
    ...DEFAULT_ARIA_WORKFLOW,
    knowledgeEntries: [{ title: "Laminated 12mm", pricePerSqft: 180, content: "Safety laminated glass" }],
  });
  const kbOut = await executeWorkflowTurn({
    spec: kbSpec,
    tenant: { clientAccountId: 1, clientCode: "KNC" },
    message: "Quote laminated 12mm 2x2m",
    catalogRows: [],
  });
  assert.ok(kbOut.quoteData);
  assert.equal(kbOut.quoteData.itemName, "Laminated 12mm");
  assert.equal(kbOut.quoteData.edgingCostThb, 0);
  assert.equal(kbOut.quoteData.sourceLabel, "Approved knowledge base");
});

test("GET /assets/guides/:file serves allowlisted guide PNGs with caching and blocks traversal", async (t) => {
  const { app } = require("../src/server");
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  for (const name of [
    "guide-welcome.png",
    "guide-activate-1to1.png",
    "guide-connect-group.png",
    "guide-human-control.png",
  ]) {
    const res = await fetch(`${base}/assets/guides/${name}`);
    assert.equal(res.status, 200, `Expected 200 for ${name}`);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]), `${name} must be a PNG`);
  }

  for (const badPath of [
    "/assets/guides/..%2Fserver.js",
    "/assets/guides/..%2F..%2Fpackage.json",
    "/assets/guides/guide-welcome.jpg",
    "/assets/guides/GUIDE-WELCOME.PNG",
    "/assets/guides/nonexistent-guide.png",
    "/assets/guides/nested/guide-welcome.png",
  ]) {
    const res = await fetch(`${base}${badPath}`);
    assert.equal(res.status, 404, `Expected 404 for ${badPath}`);
  }
});

test("Gateway handleEvent delivers validated Flex Cards on follow & rich-menu postbacks while keeping menu=products text-safe", async (t) => {
  const previous = {
    LINE_CHANNEL_SECRET: process.env.LINE_CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    WEBHOOK_ENCRYPTION_KEY: process.env.WEBHOOK_ENCRYPTION_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    PUBLIC_URL: process.env.PUBLIC_URL,
  };
  Object.assign(process.env, {
    LINE_CHANNEL_SECRET: PRIVATE,
    LINE_CHANNEL_ACCESS_TOKEN: PRIVATE,
    WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    SUPABASE_URL: "https://flex-test.invalid",
    SUPABASE_SERVICE_KEY: "sb_secret_fixture-only",
    PUBLIC_URL: "https://neurohands-ai-agent-production.up.railway.app",
  });
  t.after(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete require.cache[require.resolve("../src/server")];
  });

  const linePayloads = [];
  t.mock.method(globalThis, "fetch", async (address, options = {}) => {
    const url = new URL(String(address));
    if (url.hostname === "api.line.me") {
      linePayloads.push(JSON.parse(options.body));
      return json({});
    }
    if (url.hostname === "flex-test.invalid") {
      if (url.pathname.endsWith("/settings")) {
        const key = url.searchParams.get("key");
        if (key === "eq.default_lead_time_days") return json([{ value: "5" }]);
        return json([]);
      }
      if (url.pathname.endsWith("/agent_registry")) {
        return json([{ agent_code: "AGT-001", callsign: "Aria", agent_name: "Aria", domains: ["sales"], manager: "Jarvis" }]);
      }
      return json([]);
    }
    return json({}, 404);
  });

  delete require.cache[require.resolve("../src/server")];
  const gateway = require("../src/server");

  await gateway.handleEvent({ type: "follow", replyToken: "rt-follow", source: { type: "user", userId: "Uvisitor1" } });
  const followMsg = linePayloads.at(-1).messages[0];
  assert.equal(followMsg.type, "flex");
  assert.equal(validateFlexMessage(followMsg).valid, true);
  assert.match(followMsg.contents.hero.url, /\/assets\/guides\/guide-welcome\.png$/);

  for (const menu of ["about", "services", "projects", "contact", "activate", "updates", "lead_time", "quote", "support", "agent"]) {
    await gateway.handleEvent({
      type: "postback",
      replyToken: `rt-${menu}`,
      source: { type: "user", userId: "Uvisitor1" },
      postback: { data: `menu=${menu}` },
    });
    const msg = linePayloads.at(-1).messages[0];
    assert.equal(msg.type, "flex", `menu=${menu} must return Flex Card`);
    assert.equal(validateFlexMessage(msg).valid, true, `menu=${menu} Flex Card must validate`);
  }

  await gateway.handleEvent({
    type: "postback",
    replyToken: "rt-products",
    source: { type: "user", userId: "Uvisitor1" },
    postback: { data: "menu=products" },
  });
  const productsMsg = linePayloads.at(-1).messages[0];
  assert.equal(productsMsg.type, "text");
  assert.match(productsMsg.text, /Please activate first/);

  await gateway.pushToLine("Uvisitor1", buildLeadTimeFlexCard({ defaultDays: 5 }));
  assert.equal(linePayloads.at(-1).to, "Uvisitor1");
  assert.equal(linePayloads.at(-1).messages[0].type, "flex");
});
