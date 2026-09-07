import { createClient } from '@supabase/supabase-js';
import './style.css';

const app = document.querySelector('#app');
const dialog = document.querySelector('#editor');
const notice = document.querySelector('#notice');
const state = { client: null, session: null, workspaces: [], workspaceId: null, departments: [], teams: [], agents: [], versions: [], tools: [], canManage: false, view: 'builder', query: '', busy: false };
let authEpoch = 0;
let noticeTimer;
const escape = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => ({ plus: '+', board: '▦', versions: '◷', arrow: '↗', move: '↔', bot: '✦' }[name] || '');
const logo = '<span class="brand-mark">n<span>↗</span></span><span>neurohands<small>AGENT WORKSPACE</small></span>';
const showNotice = (message, error = false) => {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.className = `notice visible ${error ? 'error' : ''}`;
  noticeTimer = setTimeout(() => { notice.className = 'notice'; }, 6500);
};
async function api(path, { method = 'GET', body } = {}) {
  const { data } = await state.client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again.');
  const response = await fetch(`/api/studio${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
function modal(title, description, contents) {
  dialog.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">WORKSPACE</p><h2>${escape(title)}</h2></div><button type="button" class="icon-button" id="close-dialog" aria-label="Close dialog">×</button></div><p class="dialog-description">${escape(description)}</p>${contents}`;
  dialog.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
  if (!dialog.open) dialog.showModal();
}
async function submitForm(event, action) {
  event.preventDefault();
  const submit = event.target.querySelector('[type="submit"]');
  submit.disabled = true;
  try { await action(new FormData(event.target)); dialog.close(); }
  catch (error) { showNotice(error.message, true); }
  finally { submit.disabled = false; }
}
function renderAuth(configured = true) {
  app.innerHTML = `<main class="auth-shell"><section class="auth-brand"><a class="brand" href="/studio/">${logo}</a><div class="auth-story"><span class="capsule">YOUR ORGANIZATION, CONNECTED</span><h1>A place for every agent.<br>A team behind every task.</h1><p>Define your agents, give them responsibilities, and organize the work across your business.</p><div class="org-art" aria-hidden="true"><div class="art-node manager">✦ <span>Jarvis<small>Operations monitor</small></span></div><div class="art-line"></div><div class="art-row"><div class="art-node">Sales</div><div class="art-node">Research</div><div class="art-node">Operations</div></div></div></div><div class="auth-footer">Neurohands AI Agent · Your people stay in control.</div></section><section class="auth-form-wrap"><div class="auth-form"><p class="eyebrow">WELCOME TO YOUR WORKSPACE</p><h2>Let’s get to work.</h2><p>Sign in with your Neurohands app account.</p>${!configured ? '<div class="setup-note">Workspace sign-in is being configured. The administrator needs to connect Supabase Auth before you can continue.</div>' : ''}<form id="signin-form"><label>Email<input name="email" type="email" autocomplete="username" placeholder="you@company.com" required></label><label>Password<input name="password" type="password" autocomplete="current-password" minlength="8" required></label><button type="submit" class="primary full" ${!configured ? 'disabled' : ''}>Sign in <span>→</span></button></form><button class="text-button" id="signup" ${!configured ? 'disabled' : ''}>Create an app account</button><p class="auth-note">This app account is separate from your Supabase dashboard account. Your workspace data is only available to its authorized members.</p></div></section></main>`;
  app.querySelector('#signin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const button = event.target.querySelector('button');
    button.disabled = true;
    try {
      const { error } = await state.client.auth.signInWithPassword({ email: form.get('email'), password: form.get('password') });
      if (error) throw error;
    } catch (error) { showNotice(error.message, true); button.disabled = false; }
  });
  app.querySelector('#signup').addEventListener('click', () => {
    modal('Create your app account', 'Use an email you can access. You may need to confirm it before signing in.', `<form id="signup-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><div class="dialog-actions"><button type="submit" class="primary">Create account</button></div></form>`);
    dialog.querySelector('form').addEventListener('submit', (event) => submitForm(event, async (form) => {
      const { error } = await state.client.auth.signUp({ email: form.get('email'), password: form.get('password'), options: { emailRedirectTo: `${location.origin}/studio/` } });
      if (error) throw error;
      showNotice('Account request received. Check your inbox if email confirmation is required.');
    }));
  });
}
async function loadWorkspace() {
  if (!state.workspaceId) return;
  const workspaceId = state.workspaceId;
  const data = await api(`/workspaces/${workspaceId}`);
  if (workspaceId !== state.workspaceId) return;
  Object.assign(state, data);
}
async function loadAccount() {
  const epoch = ++authEpoch;
  app.innerHTML = '<div class="boot">Loading your organization…</div>';
  try {
    const [identity, workspaces, tools] = await Promise.all([api('/me'), api('/workspaces'), api('/tools')]);
    if (epoch !== authEpoch) return;
    state.user = identity;
    state.workspaces = workspaces.workspaces;
    state.tools = tools.tools;
    state.workspaceId = state.workspaces.find((item) => item.id === state.workspaceId)?.id || state.workspaces[0]?.id || null;
    await loadWorkspace();
    if (epoch === authEpoch) render();
  } catch (error) {
    if (epoch !== authEpoch) return;
    app.innerHTML = `<main class="blocked-state"><span class="brand-mark">n↗</span><h1>Your workspace needs attention.</h1><p>${escape(error.message)}</p><button id="retry" class="primary">Try again</button><button id="exit" class="secondary">Sign out</button></main>`;
    app.querySelector('#retry').onclick = loadAccount;
    app.querySelector('#exit').onclick = () => state.client.auth.signOut();
  }
}
function agentCard(agent) {
  const team = state.teams.find((item) => item.id === agent.team_id);
  return `<article class="agent-card" draggable="${state.canManage}" data-agent="${agent.id}"><div class="agent-card-top"><span class="agent-avatar">${escape(agent.name.slice(0, 1).toUpperCase())}</span><span class="status ${agent.status}">${agent.status === 'ready' ? 'Definition ready' : escape(agent.status)}</span></div><button class="agent-title" data-edit="${agent.id}" ${state.canManage ? '' : 'disabled'}>${escape(agent.name)}</button><p class="agent-role">${escape(agent.role)}</p><p class="agent-responsibility">${escape(agent.responsibilities[0] || 'Add a responsibility to get started.')}</p><div class="agent-card-bottom"><span>${escape(team?.name || 'No team assigned')}</span><button class="move-button" data-move="${agent.id}" ${state.canManage ? '' : 'disabled'} aria-label="Move ${escape(agent.name)}">${icon('move')}</button></div></article>`;
}
function renderBoard() {
  return `<div class="toolbar"><label class="search"><span>⌕</span><input id="search" type="search" placeholder="Find an agent or role" value="${escape(state.query)}" aria-label="Find an agent or role"></label><span class="toolbar-hint">Drag agents between departments, or use ↔ to move.</span></div><div class="department-grid">${state.departments.map((department) => {
    const agents = state.agents.filter((agent) => agent.department_id === department.id && `${agent.name} ${agent.role}`.toLowerCase().includes(state.query.toLowerCase()));
    return `<section class="department" data-department="${department.id}" aria-label="${escape(department.name)} department"><div class="department-heading"><span class="department-dot"></span><h2>${escape(department.name)}</h2><span class="count">${agents.length}</span><button class="icon-button" data-add="${department.id}" aria-label="Add agent to ${escape(department.name)}" ${state.canManage ? '' : 'disabled'}>+</button></div><div class="department-agents">${agents.map(agentCard).join('') || '<div class="empty-department">A place for your next agent</div>'}</div></section>`;
  }).join('')}</div>`;
}
function renderVersions() {
  return `<div class="version-intro">Published definitions preserve the instructions and permissions for a specific revision. Connecting a definition to a website or LINE channel is a separate deployment step.</div>${state.versions.length ? `<div class="version-list">${state.versions.map((version) => `<article><span class="agent-avatar">✦</span><div><h2>${escape(state.agents.find((agent) => agent.id === version.agent_id)?.name || 'Agent')}</h2><p>Revision ${version.revision} · ${escape(new Date(version.published_at).toLocaleString())}</p></div><span class="status ready">Definition saved</span></article>`).join('')}</div>` : '<div class="large-empty"><span>◷</span><h2>Your first revision starts here.</h2><p>Give an agent its responsibilities, then publish its definition from the editor.</p></div>'}`;
}
function render() {
  const workspace = state.workspaces.find((item) => item.id === state.workspaceId);
  app.innerHTML = `<div class="workspace-shell"><aside class="sidebar"><a class="brand" href="/studio/">${logo}</a><p class="sidebar-label">WORKSPACE</p><label class="workspace-select"><span class="sr-only">Current workspace</span><select id="workspace-select">${state.workspaces.map((item) => `<option value="${item.id}" ${item.id === state.workspaceId ? 'selected' : ''}>${escape(item.name)}</option>`).join('') || '<option>No workspace yet</option>'}</select></label><button class="new-workspace" id="new-workspace">+ New workspace</button><nav><button data-view="builder" class="${state.view === 'builder' ? 'active' : ''}"><span>▦</span> Team builder</button><button data-view="versions" class="${state.view === 'versions' ? 'active' : ''}"><span>◷</span> Published definitions</button></nav><div class="jarvis-card"><span class="jarvis-icon">✦</span><strong>Jarvis</strong><span class="muted-pill">Setup in progress</span><p>Operations monitoring will appear here when the runtime is connected.</p></div><div class="profile"><span class="profile-avatar">${escape((state.user?.email || 'U').slice(0, 1).toUpperCase())}</span><span>${escape(state.user?.email || 'Signed in')}</span><button id="signout" aria-label="Sign out">↪</button></div></aside><main class="workspace-main"><header class="topbar"><span>Organization <span class="slash">/</span> ${escape(workspace?.name || 'Welcome')}</span><span class="private-label"><i></i> Private workspace</span></header><div class="page-content"><div class="page-heading"><div><p class="eyebrow">${state.view === 'builder' ? 'PEOPLE, AGENTS & PURPOSE' : 'VERSION HISTORY'}</p><h1>${state.view === 'builder' ? 'Your agent organization.' : 'Ready for the next step.'}</h1><p>${state.view === 'builder' ? 'Give every agent a role, a team, and a clear responsibility.' : 'A reliable record of what each agent was instructed to do.'}</p></div>${workspace && state.canManage ? '<button class="primary" id="create-agent">+ Create agent</button>' : ''}</div>${!workspace ? '<section class="large-empty"><span>▦</span><h2>Start with your organization.</h2><p>Create a workspace to organize agents across your departments.</p><button class="primary" id="first-workspace">Create workspace</button></section>' : `<div class="stats"><div><span>AGENTS</span><strong>${state.agents.length}</strong></div><div><span>DEPARTMENTS</span><strong>${state.departments.length}</strong></div><div><span>TEAMS</span><strong>${state.teams.length}</strong></div><div><span>PUBLISHED DEFINITIONS</span><strong>${state.versions.length}</strong></div></div>${state.canManage ? '<div class="organization-actions"><button class="text-button" id="add-department">+ Add department</button><button class="text-button" id="add-team">+ Add team</button></div>' : '<p class="read-only-note">You have view access. A workspace administrator can edit agents.</p>'}${state.view === 'builder' ? renderBoard() : renderVersions()}`}</div></main></div>`;
  app.querySelector('#signout').onclick = () => state.client.auth.signOut();
  app.querySelector('#new-workspace').onclick = createWorkspace;
  app.querySelector('#first-workspace')?.addEventListener('click', createWorkspace);
  app.querySelector('#create-agent')?.addEventListener('click', () => editAgent());
  app.querySelector('#add-department')?.addEventListener('click', () => addGroup('department'));
  app.querySelector('#add-team')?.addEventListener('click', () => addGroup('team'));
  app.querySelector('#workspace-select').onchange = async (event) => {
    state.workspaceId = event.target.value;
    try { await loadWorkspace(); render(); } catch (error) { showNotice(error.message, true); }
  };
  app.querySelectorAll('[data-view]').forEach((button) => { button.onclick = () => { state.view = button.dataset.view; render(); }; });
  app.querySelector('#search')?.addEventListener('input', (event) => {
    state.query = event.target.value;
    const caret = event.target.selectionStart;
    render();
    const search = app.querySelector('#search'); search.focus();
    try { search.setSelectionRange(caret, caret); } catch {}
  });
  app.querySelectorAll('[data-add]').forEach((button) => { button.onclick = () => editAgent(null, button.dataset.add); });
  app.querySelectorAll('[data-edit]').forEach((button) => { button.onclick = () => editAgent(state.agents.find((agent) => agent.id === button.dataset.edit)); });
  app.querySelectorAll('[data-move]').forEach((button) => { button.onclick = () => moveDialog(state.agents.find((agent) => agent.id === button.dataset.move)); });
  app.querySelectorAll('[data-agent]').forEach((card) => {
    card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', card.dataset.agent); event.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => { card.classList.remove('dragging'); app.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target')); });
  });
  app.querySelectorAll('[data-department]').forEach((column) => {
    column.addEventListener('dragover', (event) => { if (!state.canManage) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; column.classList.add('drop-target'); });
    column.addEventListener('dragleave', (event) => { if (!column.contains(event.relatedTarget)) column.classList.remove('drop-target'); });
    column.addEventListener('drop', async (event) => {
      event.preventDefault(); column.classList.remove('drop-target');
      const agent = state.agents.find((item) => item.id === event.dataTransfer.getData('text/plain'));
      if (!agent || !state.canManage) return;
      try { await moveAgent(agent, column.dataset.department); } catch (error) { showNotice(error.message, true); }
    });
  });
}
const departmentOptions = (selected) => state.departments.map((department) => `<option value="${department.id}" ${department.id === selected ? 'selected' : ''}>${escape(department.name)}</option>`).join('');
function createWorkspace() {
  modal('Create your workspace', 'Start with ten departments. Add your own teams and specialist roles whenever you need them.', '<form><label>Workspace name<input name="name" placeholder="Your organization" maxlength="100" required></label><div class="dialog-actions"><button type="submit" class="primary">Create workspace</button></div></form>');
  dialog.querySelector('form').onsubmit = (event) => submitForm(event, async (form) => {
    const result = await api('/workspaces', { method: 'POST', body: { name: form.get('name') } });
    state.workspaceId = result.id;
    await loadAccount();
    showNotice('Your workspace is ready. Add the first agent.');
  });
}
function addGroup(kind) {
  modal(`Add ${kind}`, 'Give this part of your organization a clear name.', `<form><label>Name<input name="name" maxlength="80" required></label>${kind === 'team' ? `<label>Department<select name="department_id">${departmentOptions()}</select></label>` : ''}<div class="dialog-actions"><button type="submit" class="primary">Add ${kind}</button></div></form>`);
  dialog.querySelector('form').onsubmit = (event) => submitForm(event, async (form) => {
    await api(`/workspaces/${state.workspaceId}/${kind === 'team' ? 'teams' : 'departments'}`, { method: 'POST', body: Object.fromEntries(form) });
    await loadWorkspace(); render(); showNotice(`${kind === 'team' ? 'Team' : 'Department'} added.`);
  });
}
function editAgent(agent, departmentId) {
  const selectedDepartment = departmentId || agent?.department_id || state.departments[0]?.id;
  modal(agent ? `Edit ${agent.name}` : 'Meet your next agent', 'Define the role and permissions. Publish a definition when its responsibilities are clear.', `<form id="agent-form"><div class="form-grid"><label>Agent name<input name="name" value="${escape(agent?.name || '')}" placeholder="Aria" maxlength="80" required></label><label>Role<input name="role" value="${escape(agent?.role || '')}" placeholder="Sales coordinator" maxlength="160" required></label><label>Department<select name="department_id">${departmentOptions(selectedDepartment)}</select></label><label>Team<select name="team_id" id="team-field"></select></label></div><label>Responsibilities <span class="label-hint">One per line</span><textarea name="responsibilities" rows="4" placeholder="Review incoming enquiries&#10;Prepare an evidence-based response&#10;Ask for approval before making commitments">${escape(agent?.responsibilities.join('\n') || '')}</textarea></label><label>Working instructions<textarea name="instructions" rows="3" maxlength="12000" placeholder="Style, boundaries, and the process this agent should follow">${escape(agent?.instructions || '')}</textarea></label><fieldset><legend>Tool permissions</legend><div class="tool-grid">${state.tools.map((tool) => `<label class="tool-option"><input type="checkbox" name="tool_ids" value="${tool.id}" ${(agent?.tool_ids || ['request_human']).includes(tool.id) ? 'checked' : ''}><span><strong>${escape(tool.name)}</strong><small>${escape(tool.description)}</small></span></label>`).join('')}</div></fieldset><div class="form-grid"><label>Model provider<select name="model_provider"><option value="gemini" ${agent?.model_provider === 'gemini' ? 'selected' : ''}>Gemini</option><option value="groq" ${agent?.model_provider === 'groq' ? 'selected' : ''}>Groq</option></select></label><label>Model ID <span class="label-hint">Optional; server default</span><input name="model_id" value="${escape(agent?.model_id || '')}" maxlength="160" placeholder="Use the configured default"></label></div><div class="dialog-actions">${agent ? '<button type="button" class="secondary" id="publish-agent">Publish saved definition</button>' : ''}<button type="submit" class="primary">Save agent</button></div>${agent ? '<p class="form-footnote">Publishing uses the last saved details. Save your edits first. Channel deployment follows separately.</p>' : ''}</form>`);
  const form = dialog.querySelector('form');
  function refreshTeams() {
    form.elements.team_id.innerHTML = '<option value="">No team assigned</option>' + state.teams.filter((team) => team.department_id === form.elements.department_id.value).map((team) => `<option value="${team.id}" ${agent?.team_id === team.id ? 'selected' : ''}>${escape(team.name)}</option>`).join('');
  }
  refreshTeams(); form.elements.department_id.onchange = refreshTeams;
  form.onsubmit = (event) => submitForm(event, async (data) => {
    const body = Object.fromEntries(data);
    body.responsibilities = String(data.get('responsibilities')).split('\n').map((line) => line.trim()).filter(Boolean);
    body.tool_ids = data.getAll('tool_ids'); body.team_id ||= null;
    if (agent) body.expected_version = agent.version;
    await api(`/workspaces/${state.workspaceId}/agents${agent ? `/${agent.id}` : ''}`, { method: agent ? 'PATCH' : 'POST', body });
    await loadWorkspace(); render(); showNotice('Agent saved to your workspace.');
  });
  dialog.querySelector('#publish-agent')?.addEventListener('click', async (event) => {
    event.target.disabled = true;
    try {
      const result = await api(`/workspaces/${state.workspaceId}/agents/${agent.id}/publish`, { method: 'POST', body: { expected_version: agent.version } });
      await loadWorkspace(); render(); dialog.close(); showNotice(result.message);
    } catch (error) { showNotice(error.message, true); event.target.disabled = false; }
  });
}
async function moveAgent(agent, departmentId) {
  if (state.busy || agent.department_id === departmentId) return;
  state.busy = true;
  try {
    const peers = state.agents.filter((item) => item.department_id === departmentId);
    const sortOrder = Math.max(0, ...peers.map((item) => item.sort_order)) + 1;
    await api(`/workspaces/${state.workspaceId}/agents/${agent.id}`, { method: 'PATCH', body: { expected_version: agent.version, department_id: departmentId, team_id: null, sort_order: sortOrder } });
    await loadWorkspace(); render(); showNotice(`${agent.name} moved to ${state.departments.find((item) => item.id === departmentId)?.name}.`);
  } finally { state.busy = false; }
}
function moveDialog(agent) {
  modal(`Move ${agent.name}`, 'Choose the new department. You can assign its team from the agent editor afterward.', `<form><label>Department<select name="department_id">${departmentOptions(agent.department_id)}</select></label><div class="dialog-actions"><button type="submit" class="primary">Move agent</button></div></form>`);
  dialog.querySelector('form').onsubmit = (event) => submitForm(event, (form) => moveAgent(agent, form.get('department_id')));
}
async function initialize() {
  try {
    const response = await fetch('/api/studio/config');
    if (!response.ok) throw new Error('The workspace server is unavailable.');
    const config = await response.json();
    if (!config.configured) return renderAuth(false);
    state.client = createClient(config.supabaseUrl, config.supabasePublishableKey);
    state.client.auth.onAuthStateChange((event, session) => {
      const previousId = state.session?.user?.id;
      state.session = session;
      if (!session) { authEpoch++; state.workspaceId = null; state.workspaces = []; state.agents = []; dialog.close(); renderAuth(); }
      else if (previousId !== session.user.id || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(loadAccount, 0);
    });
  } catch (error) { app.innerHTML = `<main class="blocked-state"><h1>Couldn’t open the workspace.</h1><p>${escape(error.message)}</p><button class="primary" id="reload">Reload</button></main>`; app.querySelector('#reload').onclick = () => location.reload(); }
}
initialize();
