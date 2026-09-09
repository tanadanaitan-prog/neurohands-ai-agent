const READ_TOOLS = Object.freeze([
  "get_recent_orders", "get_order_status", "get_product_info", "get_edging_info", "get_lead_time",
  "recall_customer", "list_tasks", "list_documents", "read_document",
]);
const ACTION_TOOLS = Object.freeze(["create_task", "create_support_case", "request_human", "remember_customer"]);
const CATEGORIES = ["general", "learning", "market"];
const FIELD_LIMITS = {
  order_number: 100, query: 200, doc_code: 160, title: 300, domain: 80,
  subject: 300, detail: 3000, urgency: 20, reason: 1000, content: 500, memory_type: 40,
};
const ACTION_REQUIRED = {
  create_task: ["title"], create_support_case: ["subject", "detail"],
  request_human: ["reason"], remember_customer: ["content", "memory_type"],
};

class ToolInputError extends Error {}
const reject = (message) => { throw new ToolInputError(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const textField = (maxLength, extra = {}) => ({ type: "string", minLength: 1, maxLength, ...extra });

function validateArgs(value, schema) {
  if (!object(value)) reject("Tool arguments must be an object.");
  const properties = schema.properties || {};
  if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) reject("Unexpected tool argument.");
  if ((schema.required || []).some((key) => !Object.hasOwn(value, key))) reject("A required tool argument is missing.");
  const clean = {};
  for (const [key, raw] of Object.entries(value)) {
    const spec = properties[key];
    if (spec.type === "object") clean[key] = validateArgs(raw, spec);
    else {
      if (typeof raw !== "string") reject("Tool argument must be text.");
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > (spec.maxLength || 3000)) reject("Tool argument is empty or too long.");
      if (spec.enum && !spec.enum.includes(trimmed)) reject("Tool argument has an unsupported value.");
      clean[key] = trimmed;
    }
  }
  return clean;
}

function boundedInput(args) {
  try {
    const encoded = JSON.stringify(args);
    if (typeof encoded === "string" && encoded.length <= 10000) return JSON.parse(encoded);
  } catch { /* Retain the failure without serializing unbounded or cyclic input. */ }
  return { rejected_input: true };
}

function createJarvisTools({ db, isStaff, normalizeDepartment, departments, toolSchemas, toolHandlers, proposeNote, buildDailyDigest }) {
  const scope = { client_code: textField(24), department: textField(40) };
  const parameters = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
  const withBounds = (properties) => Object.fromEntries(Object.entries(properties).map(([key, value]) =>
    [key, { ...structuredClone(value), minLength: 1, maxLength: FIELD_LIMITS[key] || 300 }]));
  const reads = READ_TOOLS.map((name) => {
    const schema = structuredClone(toolSchemas[name]);
    if (!schema?.parameters) throw new Error(`Missing Jarvis tool schema: ${name}`);
    schema.parameters = parameters({ ...withBounds(schema.parameters.properties || {}), ...scope },
      [...new Set([...(schema.parameters.required || []), "client_code", "department", ...(name === "read_document" ? ["doc_code"] : [])])]);
    return schema;
  });
  const actionParameters = Object.fromEntries(ACTION_TOOLS.map((name) => {
    if (!toolSchemas[name]?.parameters) throw new Error(`Missing Jarvis action schema: ${name}`);
    const properties = withBounds(toolSchemas[name].parameters.properties || {});
    if (properties.urgency) properties.urgency.enum = ["low", "normal", "high", "urgent"];
    if (properties.memory_type) properties.memory_type.enum = ["preference", "follow_up", "product_interest", "language", "order_reference"];
    return [name, parameters(properties, ACTION_REQUIRED[name])];
  }));
  const schemas = [
    { name: "list_clients", description: "List active client codes and company names. Use these codes to scope business tools.", parameters: parameters({}) },
    { name: "operations_status", description: "Read the live operations digest of delayed orders, cases, tasks and checklist.", parameters: parameters({}) },
    ...reads,
    { name: "propose_note", description: "Propose an owner note for approval. It is pending until the same operator replies yes; this does not confirm or execute anything.",
      parameters: parameters({ content: textField(2000), category: textField(20, { enum: CATEGORIES }) }, ["content", "category"]) },
    { name: "propose_action", description: "Propose one client-scoped action for owner approval; never execute it. Use create_task(title, domain), create_support_case(subject, detail, urgency), request_human(reason), or remember_customer(content, memory_type). Only supply that action's arguments.",
      parameters: parameters({ ...scope, tool_name: textField(40, { enum: ACTION_TOOLS }),
        tool_args: parameters(Object.assign({}, ...Object.values(actionParameters).map((item) => item.properties))) },
      ["client_code", "department", "tool_name", "tool_args"]) },
  ];
  const byName = new Map(schemas.map((schema) => [schema.name, schema]));
  const proposalRuns = new WeakMap();

  async function resolveScope(args) {
    const clientCode = args.client_code.toUpperCase();
    if (!/^[A-Z0-9_-]{2,24}$/.test(clientCode)) reject("Client code is invalid.");
    const department = normalizeDepartment(args.department);
    if (!Object.hasOwn(departments, department)) reject("Department is invalid.");
    const rows = await db(`client_accounts?client_code=eq.${encodeURIComponent(clientCode)}&active=eq.true&select=id,client_code,company,active&limit=1`);
    if (!Array.isArray(rows)) throw new Error("Account lookup failed");
    const account = rows[0];
    if (!account || account.active !== true || String(account.client_code).toUpperCase() !== clientCode || !/^[1-9][0-9]*$/.test(String(account.id))) {
      reject("Active client account not found.");
    }
    return { account, department };
  }

  function reserveProposal(ctx, runId) {
    const runs = proposalRuns.get(ctx) || new Set();
    if (ctx.proposal || runs.has(runId)) reject("Only one proposal can be created in this run. Review the pending proposal first.");
    runs.add(runId);
    proposalRuns.set(ctx, runs);
  }

  async function saveProposal(ctx, runId, content, category, toolName = null, toolArgs = null, accountId = null, department = null) {
    // Reserve before awaiting the insert. A failed/uncertain insert must not be retried in this run.
    reserveProposal(ctx, runId);
    const id = await proposeNote(content, category, ctx.lineUserId, toolName, toolArgs, accountId, department, runId);
    if (!/^[1-9][0-9]*$/.test(String(id))) throw new Error("Proposal persistence failed");
    ctx.proposal = { id, content };
    return { proposed: true, proposal_id: id, content, requires_approval: true, executed: false };
  }

  async function execute(ctx, runId, name, args = {}) {
    let allowed = false;
    let status = "success";
    let output;
    try {
      if (typeof ctx.lineUserId !== "string" || !ctx.lineUserId.trim() || !await isStaff(ctx.lineUserId)) {
        status = "blocked";
        reject("Operator access is required for Jarvis tools.");
      }
      if (!byName.has(name)) {
        status = "blocked";
        reject("This tool is not available to Jarvis.");
      }
      allowed = true;
      const clean = validateArgs(args, byName.get(name).parameters);
      if (name === "list_clients") {
        const clients = await db("client_accounts?active=eq.true&select=client_code,company&order=client_code&limit=50");
        if (!Array.isArray(clients)) throw new Error("Client listing failed");
        output = { clients: clients.map(({ client_code, company }) => ({ client_code, company })) };
      } else if (name === "operations_status") {
        const digest = await buildDailyDigest();
        if (typeof digest !== "string" || !digest.trim()) throw new Error("Digest unavailable");
        output = { digest };
      } else if (name === "propose_note") {
        output = await saveProposal(ctx, runId, clean.content, clean.category);
      } else {
        const { account, department } = await resolveScope(clean);
        if (name === "propose_action") {
          const actionArgs = validateArgs(clean.tool_args, actionParameters[clean.tool_name]);
          const content = `Run ${clean.tool_name} for ${account.client_code}/${department}: ${JSON.stringify(actionArgs)}`;
          output = await saveProposal(ctx, runId, content, "general", clean.tool_name, actionArgs, account.id, department);
        } else {
          const { client_code, department: _department, ...handlerArgs } = clean;
          output = await toolHandlers[name]({ lineUserId: ctx.lineUserId, clientAccountId: account.id, department,
            allowedTools: [name], agentCode: null, runId }, handlerArgs);
          if (output == null || output.error) throw new Error("Business tool failed");
        }
      }
    } catch (error) {
      if (status !== "blocked") status = "error";
      output = { error: error instanceof ToolInputError ? error.message : "Jarvis tool could not complete. No successful result is available." };
    }
    if (status !== "success") ctx.toolFailed = true;
    const auditName = typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "invalid_tool";
    try {
      const logged = await db("tool_calls", { method: "POST", body: { run_id: runId, agent_code: null,
        tool_name: auditName, input: boundedInput(args), output, allowed, status } });
      if (!logged?.[0]?.id) throw new Error("Missing tool evidence");
    } catch {
      ctx.toolFailed = true;
      throw new Error("Jarvis tool evidence could not be saved");
    }
    return output;
  }

  return { schemas, execute };
}

module.exports = { createJarvisTools };
