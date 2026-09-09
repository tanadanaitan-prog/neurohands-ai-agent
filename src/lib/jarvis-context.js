const JARVIS_OBJECTIVE = "Assist the Neurohands operator with verified business information and approved actions.";
const HISTORY_RUN_LIMIT = 4;
const NOTE_LIMIT = 10;

function boundedText(value, limit) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

async function loadJarvisContext(db, lineUserId) {
  if (typeof db !== "function" || typeof lineUserId !== "string" || !lineUserId.trim()) {
    throw new TypeError("Jarvis context requires a database reader and operator identity");
  }
  const operator = encodeURIComponent(lineUserId);
  const [noteRows, runRows] = await Promise.all([
    db(`jarvis_notes?proposed_by=eq.${operator}&status=eq.confirmed&tool_name=is.null&select=id,category,content,confirmed_at,status,proposed_by,tool_name&order=confirmed_at.desc,id.desc&limit=${NOTE_LIMIT}`),
    db(`agent_runs?line_user_id=eq.${operator}&run_kind=eq.operator&client_account_id=is.null&agent_code=is.null&department=eq.operations&objective=eq.${encodeURIComponent(JARVIS_OBJECTIVE)}&status=eq.completed&delivered_at=not.is.null&select=id,input,output,created_at,delivered_at,status,line_user_id,run_kind,client_account_id,agent_code,department,objective&order=created_at.desc,id.desc&limit=${HISTORY_RUN_LIMIT}`),
  ]);
  if (!Array.isArray(noteRows) || !Array.isArray(runRows)) {
    throw new Error("Jarvis context could not be loaded");
  }

  const notes = noteRows.filter((row) => row?.status === "confirmed" && row.proposed_by === lineUserId && row.tool_name === null)
    .map((row) => ({ category: boundedText(row.category, 64), content: boundedText(row.content, 1000) }))
    .filter((note) => note.category && note.content).slice(0, NOTE_LIMIT);

  // The database returns the newest runs first. Keep complete pairs and present them oldest first.
  const history = runRows.filter((row) => row?.status === "completed" && row.line_user_id === lineUserId &&
      typeof row.delivered_at === "string" && Number.isFinite(Date.parse(row.delivered_at)) &&
      row.run_kind === "operator" && row.client_account_id === null && row.agent_code === null &&
      row.department === "operations" && row.objective === JARVIS_OBJECTIVE)
    .map((row) => ({ input: boundedText(row.input, 1500), output: boundedText(row.output, 1500) }))
    .filter((run) => run.input && run.output).slice(0, HISTORY_RUN_LIMIT).reverse()
    .flatMap((run) => [{ role: "user", content: run.input }, { role: "assistant", content: run.output }]);

  return { history, notes };
}

module.exports = { JARVIS_OBJECTIVE, loadJarvisContext };
