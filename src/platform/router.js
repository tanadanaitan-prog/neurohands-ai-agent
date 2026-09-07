const express = require("express");
const { publicConfiguration, verifiedIdentity } = require("./repository");
const { HttpError, TOOL_CATALOG, uuid, text, integer, agentInput } = require("./validation");
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createStudioRouter({ environment = process.env, authenticate = (token) => verifiedIdentity(environment, token) } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/config", (_req, res) => res.json({ ...publicConfiguration(environment), runtimeConnected: false }));
  router.use(route(async (req, _res, next) => {
    const match = String(req.headers.authorization || "").match(/^Bearer (\S+)$/);
    if (!match || match[1].length > 8192) throw new HttpError(401, "Sign in to open your workspace");
    const identity = await authenticate(match[1]);
    if (!identity?.user?.id || !identity.repository) throw new HttpError(401, "Sign in to open your workspace");
    req.identity = identity;
    next();
  }));
  router.get("/me", (req, res) => res.json({ id: req.identity.user.id, email: req.identity.user.email }));
  router.get("/tools", (_req, res) => res.json({ tools: TOOL_CATALOG }));
  router.get("/workspaces", route(async (req, res) => res.json({ workspaces: await req.identity.repository.listWorkspaces() })));
  router.post("/workspaces", route(async (req, res) => {
    const id = await req.identity.repository.createWorkspace(text(req.body?.name, "Workspace name", 100));
    res.status(201).json({ id });
  }));
  router.use("/workspaces/:workspaceId", route(async (req, _res, next) => {
    req.workspaceId = uuid(req.params.workspaceId, "Workspace");
    await req.identity.repository.permission(req.workspaceId, req.method === "GET" ? "view" : "manage");
    next();
  }));
  router.get("/workspaces/:workspaceId", route(async (req, res) => res.json(await req.identity.repository.state(req.workspaceId))));
  router.post("/workspaces/:workspaceId/departments", route(async (req, res) => {
    res.status(201).json(await req.identity.repository.createDepartment(req.workspaceId, text(req.body?.name, "Department name", 80)));
  }));
  router.post("/workspaces/:workspaceId/teams", route(async (req, res) => {
    res.status(201).json(await req.identity.repository.createTeam(req.workspaceId, uuid(req.body?.department_id, "Department"), text(req.body?.name, "Team name", 80)));
  }));
  router.post("/workspaces/:workspaceId/agents", route(async (req, res) => {
    res.status(201).json(await req.identity.repository.createAgent(req.workspaceId, agentInput(req.body)));
  }));
  router.patch("/workspaces/:workspaceId/agents/:agentId", route(async (req, res) => {
    res.json(await req.identity.repository.updateAgent(req.workspaceId, uuid(req.params.agentId, "Agent"), integer(req.body?.expected_version, "Version", 1), agentInput(req.body, true)));
  }));
  router.post("/workspaces/:workspaceId/agents/:agentId/publish", route(async (req, res) => {
    const id = await req.identity.repository.publishAgent(req.workspaceId, uuid(req.params.agentId, "Agent"), integer(req.body?.expected_version, "Version", 1));
    res.status(201).json({ version_id: id, message: "Definition published. Channel deployment is a separate step." });
  }));
  router.use((error, _req, res, _next) => {
    if (!error.status) console.error("Workspace request failed:", error.name);
    res.status(error.status || 500).json({ error: error.status ? error.message : "The workspace could not complete this request" });
  });
  return router;
}
module.exports = { createStudioRouter };
