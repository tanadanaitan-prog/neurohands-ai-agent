const { createClient } = require("@supabase/supabase-js");
const { HttpError } = require("./validation");

function publicConfiguration(env) {
  const key = env.SUPABASE_PUBLISHABLE_KEY || "";
  const url = env.SUPABASE_URL || "";
  let validUrl = false;
  try { validUrl = new URL(url).protocol === "https:"; } catch {}
  const configured = validUrl && key.startsWith("sb_publishable_");
  return { configured, supabaseUrl: configured ? url : null, supabasePublishableKey: configured ? key : null };
}

function userClient(env, token) {
  const config = publicConfiguration(env);
  if (!config.configured) throw new HttpError(503, "Configure the Supabase URL and publishable key to enable the workspace");
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
async function verifiedIdentity(env, token) {
  const client = userClient(env, token);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.id) throw new HttpError(401, "Your session has expired. Please sign in again.");
  return { user: data.user, repository: new WorkspaceRepository(client) };
}

async function result(query) {
  const { data, error } = await query;
  if (!error) return data;
  if (["42P01", "PGRST205", "PGRST202"].includes(error.code)) throw new HttpError(503, "The workspace database migration has not been installed");
  if (["42501", "PGRST301"].includes(error.code)) throw new HttpError(403, "You do not have permission for this action");
  if (["40001", "23505"].includes(error.code)) throw new HttpError(409, "This record changed or already exists. Reload and try again.");
  if (["23503", "23514", "22023", "22P02"].includes(error.code)) throw new HttpError(400, "Check the selected department, team and agent details");
  throw new HttpError(502, "The database could not complete this request");
}

class WorkspaceRepository {
  constructor(client) { this.client = client; }
  listWorkspaces() { return result(this.client.from("nh_workspaces").select("*").order("created_at")); }
  createWorkspace(name) { return result(this.client.rpc("nh_create_workspace", { p_name: name })); }
  async permission(workspaceId, mode) {
    const allowed = await result(this.client.rpc("nh_can_access", { p_workspace_id: workspaceId, p_permission: mode }));
    if (!allowed) throw new HttpError(403, "You do not have permission for this workspace");
  }
  async state(workspaceId) {
    const [departments, teams, agents, versions, canManage] = await Promise.all([
      result(this.client.from("nh_departments").select("*").eq("workspace_id", workspaceId).order("sort_order").order("name")),
      result(this.client.from("nh_teams").select("*").eq("workspace_id", workspaceId).order("name")),
      result(this.client.from("nh_agents").select("*").eq("workspace_id", workspaceId).order("sort_order").order("name")),
      result(this.client.from("nh_agent_versions").select("id,agent_id,revision,published_at").eq("workspace_id", workspaceId).order("published_at", { ascending: false })),
      result(this.client.rpc("nh_can_access", { p_workspace_id: workspaceId, p_permission: "manage" })),
    ]);
    return { departments, teams, agents, versions, canManage };
  }
  createDepartment(workspaceId, name) { return result(this.client.from("nh_departments").insert({ workspace_id: workspaceId, name }).select().single()); }
  createTeam(workspaceId, departmentId, name) { return result(this.client.from("nh_teams").insert({ workspace_id: workspaceId, department_id: departmentId, name }).select().single()); }
  createAgent(workspaceId, data) { return result(this.client.from("nh_agents").insert({ ...data, workspace_id: workspaceId }).select().single()); }
  async updateAgent(workspaceId, agentId, version, changes) {
    const data = await result(this.client.from("nh_agents").update(changes).eq("workspace_id", workspaceId).eq("id", agentId).eq("version", version).select().maybeSingle());
    if (!data) throw new HttpError(409, "The agent changed. Reload before saving your changes.");
    return data;
  }
  async publishAgent(workspaceId, agentId, version) {
    const agent = await result(this.client.from("nh_agents").select("id").eq("workspace_id", workspaceId).eq("id", agentId).maybeSingle());
    if (!agent) throw new HttpError(404, "Agent not found");
    return result(this.client.rpc("nh_publish_agent", { p_agent_id: agentId, p_expected_version: version }));
  }
}
module.exports = { WorkspaceRepository, publicConfiguration, verifiedIdentity };
