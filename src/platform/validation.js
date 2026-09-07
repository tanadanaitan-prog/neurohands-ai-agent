class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const TOOL_CATALOG = Object.freeze([
  { id: "search_knowledge", name: "Search knowledge", description: "Retrieve cited information from this workspace's documents." },
  { id: "read_document", name: "Read documents", description: "Read documents assigned to the agent." },
  { id: "list_tasks", name: "Review tasks", description: "Inspect the workspace's assigned work." },
  { id: "create_task", name: "Create a task", description: "Record a follow-up with its source and owner." },
  { id: "request_human", name: "Ask for approval", description: "Escalate a decision to a person." },
]);
function uuid(value, label = "ID") {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, `${label} is invalid`);
  return value;
}
function text(value, label, max, { empty = false } = {}) {
  if (typeof value !== "string" || value.trim().length > max || (!empty && !value.trim())) throw new HttpError(400, `${label} must be ${empty ? '0' : '1'}–${max} characters`);
  return value.trim();
}
function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 2147483646) throw new HttpError(400, `${label} is invalid`);
  return value;
}
function agentInput(input, partial = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Agent details are required");
  const fields = new Set(["name", "role", "responsibilities", "instructions", "department_id", "team_id", "tool_ids", "model_provider", "model_id", "sort_order", "status", "expected_version"]);
  if (Object.keys(input).some((key) => !fields.has(key))) throw new HttpError(400, "Unknown agent field");
  const out = {};
  for (const [field, max] of [["name", 80], ["role", 160], ["instructions", 12000], ["model_id", 160]]) {
    if (input[field] !== undefined) out[field] = text(input[field], field, max, { empty: ["instructions", "model_id"].includes(field) });
  }
  if (input.department_id !== undefined) out.department_id = uuid(input.department_id, "Department");
  if (input.team_id !== undefined) out.team_id = input.team_id === null ? null : uuid(input.team_id, "Team");
  if (input.responsibilities !== undefined) {
    if (!Array.isArray(input.responsibilities) || input.responsibilities.length > 30) throw new HttpError(400, "Use at most 30 responsibilities");
    out.responsibilities = input.responsibilities.map((item) => text(item, "Responsibility", 500));
  }
  if (input.tool_ids !== undefined) {
    if (!Array.isArray(input.tool_ids) || input.tool_ids.some((id) => !TOOL_CATALOG.some((tool) => tool.id === id))) throw new HttpError(400, "Unknown tool permission");
    out.tool_ids = [...new Set(input.tool_ids)];
  }
  if (input.model_provider !== undefined) {
    if (!["gemini", "groq"].includes(input.model_provider)) throw new HttpError(400, "Unsupported model provider");
    out.model_provider = input.model_provider;
  }
  if (input.sort_order !== undefined) out.sort_order = integer(input.sort_order, "Position");
  if (input.status !== undefined) {
    if (!["draft", "paused"].includes(input.status)) throw new HttpError(400, "Use the publish action to mark a definition ready");
    out.status = input.status;
  }
  if (!partial) for (const field of ["name", "role", "department_id"]) if (!out[field]) throw new HttpError(400, `${field} is required`);
  if (partial && !Object.keys(out).length) throw new HttpError(400, "No changes supplied");
  return out;
}
module.exports = { HttpError, TOOL_CATALOG, uuid, text, integer, agentInput };
