import { ROLE_TOOLS } from "./skills.mjs";

const PROFILE_FIELDS = Object.freeze([
  "agentId", "displayName", "role", "departmentId", "responsibilities",
  "allowedTools", "allowedDelegateIds", "version",
]);
const IDENTIFIER = /^[a-z][a-z0-9-]{1,79}$/;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function assertExactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} must contain exactly: ${fields.join(", ")}.`);
  }
}

function assertTextList(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 300)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a nonempty"} array of short strings.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} cannot contain duplicates.`);
}

export function validateAgentProfiles(input) {
  if (!Array.isArray(input) || input.length !== 5) throw new Error("The named-agent registry must contain exactly five profiles.");
  const profiles = structuredClone(input);
  const ids = new Set();
  const departments = new Set();
  for (const [index, profile] of profiles.entries()) {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error(`Agent profile ${index + 1} must be an object.`);
    assertExactFields(profile, PROFILE_FIELDS, `Agent profile ${index + 1}`);
    if (!IDENTIFIER.test(profile.agentId)) throw new Error(`Agent profile ${index + 1} has an invalid agentId.`);
    if (ids.has(profile.agentId)) throw new Error(`Duplicate agentId: ${profile.agentId}.`);
    ids.add(profile.agentId);
    if (typeof profile.displayName !== "string" || !profile.displayName.trim() || profile.displayName.length > 80) throw new Error(`${profile.agentId} has an invalid displayName.`);
    if (!Object.hasOwn(ROLE_TOOLS, profile.role)) throw new Error(`${profile.agentId} has an unsupported base role.`);
    if (!IDENTIFIER.test(profile.departmentId) || departments.has(profile.departmentId)) throw new Error(`${profile.agentId} must have a unique valid departmentId.`);
    departments.add(profile.departmentId);
    assertTextList(profile.responsibilities, `${profile.agentId}.responsibilities`);
    assertTextList(profile.allowedTools, `${profile.agentId}.allowedTools`, { allowEmpty: true });
    if (profile.allowedTools.some((name) => !ROLE_TOOLS[profile.role].includes(name))) throw new Error(`${profile.agentId} contains a tool unavailable to its base role.`);
    assertTextList(profile.allowedDelegateIds, `${profile.agentId}.allowedDelegateIds`, { allowEmpty: true });
    if (!Number.isSafeInteger(profile.version) || profile.version < 1) throw new Error(`${profile.agentId} has an invalid version.`);
  }
  for (const profile of profiles) {
    if (profile.allowedDelegateIds.includes(profile.agentId)) throw new Error(`${profile.agentId} cannot delegate to itself.`);
    if (profile.allowedDelegateIds.some((agentId) => !ids.has(agentId))) throw new Error(`${profile.agentId} delegates to an unknown agent.`);
  }
  return deepFreeze(profiles);
}

export const AGENT_PROFILES = validateAgentProfiles([
  {
    agentId: "sales-suri",
    displayName: "Suri",
    role: "aria",
    departmentId: "sales",
    responsibilities: ["Gather client requirements", "Prepare a grounded quotation brief"],
    allowedTools: ["lookup_company", "calculate", "get_order_status", "read_document", "list_tasks", "create_task"],
    allowedDelegateIds: ["marketing-mira", "ai-qa-quinn"],
    version: 1,
  },
  {
    agentId: "marketing-mira",
    displayName: "Mira",
    role: "aria",
    departmentId: "marketing",
    responsibilities: ["Turn verified requirements into an evidence-grounded proposal"],
    allowedTools: ["lookup_company", "calculate", "read_document", "list_tasks", "create_task"],
    allowedDelegateIds: ["it-ivo"],
    version: 1,
  },
  {
    agentId: "it-ivo",
    displayName: "Ivo",
    role: "aria",
    departmentId: "it",
    responsibilities: ["Check connector readiness", "Verify tool permissions and client boundaries"],
    allowedTools: ["calculate", "read_document", "list_tasks", "create_task"],
    allowedDelegateIds: ["backend-beck"],
    version: 1,
  },
  {
    agentId: "backend-beck",
    displayName: "Beck",
    role: "aria",
    departmentId: "backend-engineering",
    responsibilities: ["Design idempotent CRM persistence", "Define recoverable backend delivery steps"],
    allowedTools: ["calculate", "read_document", "list_tasks", "create_task", "remember", "recall"],
    allowedDelegateIds: ["ai-qa-quinn"],
    version: 1,
  },
  {
    agentId: "ai-qa-quinn",
    displayName: "Quinn",
    role: "jarvis",
    departmentId: "ai-engineering-quality",
    responsibilities: ["Perform evidence-based quality checks", "Issue the final verified result or a concrete blocker"],
    allowedTools: ["lookup_company", "calculate", "read_document", "list_tasks", "create_task"],
    allowedDelegateIds: [],
    version: 1,
  },
]);

export const AGENT_PROFILE_BY_ID = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(AGENT_PROFILES.map((profile) => [profile.agentId, profile]))));

export function getAgentProfile(agentId) {
  const profile = typeof agentId === "string" ? AGENT_PROFILE_BY_ID[agentId] : undefined;
  if (!profile) throw new Error("Unknown named agent.");
  return profile;
}

