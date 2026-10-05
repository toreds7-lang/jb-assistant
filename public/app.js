// Todoro front-end: projects, skills, Claude chat, Top 10, harness view, timeline.

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-todoro': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('todoro.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('todoro.' + k, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

const state = {
  projects: [],
  settings: {},
  agentRoot: '',
  skills: [],
  chat: { projectId: 'home', sessionId: null, runId: null, es: null, skill: null, running: false, live: null, received: 0 },
  tl: { events: [], sources: new Set(store.get('tlSources', ['app', 'claude', 'git', 'files'])), project: '' },
  rec: { status: null, viewing: null, pollTimer: null },
  harnessProject: 'home',
};

// ---------- formatting ----------
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDateTime = (ts) => `${fmtDate(ts)} ${fmtTime(ts)}`;
function fmtAgo(ts) {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
const PALETTE = ['#3f8f45', '#3d8fd6', '#ef9a2a', '#8a63d2', '#d8566b', '#1f9e9a', '#b0812f'];
function colorFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const projectName = (id) => (id === 'home' ? 'All projects' : state.projects.find((p) => p.id === id)?.name || 'project');
const projectIdByName = (name) => state.projects.find((p) => p.name === name)?.id;

// ---------- tiny, safe markdown ----------
function inline(s) {
  s = esc(s);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${c}</code>`);
    return `\u0001${codes.length - 1}\u0001`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[i]);
}

function md(src) {
  if ((src.match(/```/g) || []).length % 2) src += '\n```';
  const blocks = [];
  src = src.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const lines = src.split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) html += `<p>${inline(para.join('\n'))}</p>`;
    para = [];
  };
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.trim().match(/^\u0000(\d+)\u0000$/))) {
      flush(); closeList();
      html += blocks[+m[1]];
    } else if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
      flush(); closeList();
      const n = m[1].length + 2;
      html += `<h${n}>${inline(m[2])}</h${n}>`;
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush(); closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      i--;
      html += `<table><thead><tr>${cells(rows[0]).map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(2).map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)/))) {
      flush();
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flush();
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flush(); closeList();
      html += '<hr>';
    } else if ((m = line.match(/^>\s?(.*)/))) {
      flush(); closeList();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else if (!line.trim()) {
      flush(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush(); closeList();
  return html;
}

// ---------- app state ----------
async function loadState() {
  const s = await api('GET', '/api/state');
  state.projects = s.projects;
  state.settings = s.settings;
  state.agentRoot = s.agentRoot;
  renderTopStats(s.claude);
  renderProjects();
  renderProjectSelects();
}

function renderTopStats(claude) {
  const parts = [];
  if (claude?.version) parts.push(`<span class="stat">Claude Code <b>${esc(claude.version.split(' ')[0])}</b></span>`);
  const w = claude?.rateLimit?.unifiedWindows;
  const meter = (label, win) => {
    if (!win) return '';
    const pct = Math.round((win.utilization || 0) * 100);
    const cls = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '';
    return `<span class="stat" title="Plan usage in the ${label} window${win.resetsAt ? ', resets ' + fmtDateTime(win.resetsAt * 1000) : ''}">${label} <span class="meter ${cls}"><i style="width:${pct}%"></i></span> ${pct}%</span>`;
  };
  if (w) parts.push(meter('5h', w.five_hour), meter('7d', w.seven_day));
  else if (!claude?.path) parts.push('<span class="stat" style="color:var(--berry)">claude.exe not found</span>');
  $('#topstats').innerHTML = parts.join('');
}

async function refreshStats() {
  try {
    renderTopStats((await api('GET', '/api/state')).claude);
  } catch { /* ignore */ }
}

// ---------- projects ----------
const KIND_LABEL = { bat: 'BAT', exe: 'EXE', ps1: 'PS1', npm: 'npm', cmd: 'CMD' };

function renderProjects() {
  const el = $('#projectList');
  if (!state.projects.length) {
    el.innerHTML = '<p class="muted">No projects yet. Click <b>Browse</b> to pick folders from your disk.</p>';
    return;
  }
  el.innerHTML = state.projects.map((p) => `
    <article class="project ${p.exists ? '' : 'missing'} ${state.chat.projectId === p.id ? 'selected' : ''}" data-id="${p.id}">
      <div class="project-head">
        <span class="swatch" style="--c:${colorFor(p.name)}"></span>
        <div class="project-title" data-act="select" title="Click to chat about this project · double-click to rename">
          <strong>${esc(p.name)}</strong>
          <small title="${esc(p.path)}">${esc(p.path)}</small>
        </div>
        <button class="remove" data-act="remove" title="Remove from list (files are not touched)">✕</button>
      </div>
      <div class="run-row">
        <select data-act="pick" title="What to run">
          ${p.runnables.length ? '' : '<option value="">(nothing runnable found)</option>'}
          ${p.runnables.map((r) => `<option value="${esc(r.id)}" ${r.id === p.runnable ? 'selected' : ''}>${KIND_LABEL[r.kind] || ''} · ${esc(r.label)}</option>`).join('')}
          <option value="__custom">+ Custom command…</option>
        </select>
        <button class="run" data-act="run" title="Run in a new window">▶ Run</button>
      </div>
      <div class="actions">
        <button data-act="folder" title="Open in File Explorer">Folder</button>
        <button data-act="vscode" title="Open in VS Code">VS Code</button>
        <button data-act="terminal" title="Open an interactive Claude Code terminal here">Claude</button>
        <button data-act="chat" title="Chat about this project in Todoro">Chat</button>
      </div>
      <div class="tags">
        ${p.exists ? '' : '<span class="tag warn">folder missing</span>'}
        ${p.hasGit ? '<span class="tag plum">git</span>' : ''}
        ${p.hasClaudeMd ? '<span class="tag sky">CLAUDE.md</span>' : ''}
        ${p.custom?.length ? `<span class="tag sun">${p.custom.length} custom</span>` : ''}
      </div>
    </article>`).join('');
}

function renderProjectSelects() {
  const opts = [`<option value="home">All projects (${esc(state.agentRoot)})</option>`, ...state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)].join('');
  for (const id of ['#chatProject', '#harnessProject']) $(id).innerHTML = opts;
  $('#chatProject').value = state.projects.some((p) => p.id === state.chat.projectId) ? state.chat.projectId : 'home';
  $('#harnessProject').value = state.projects.some((p) => p.id === state.harnessProject) ? state.harnessProject : 'home';
  $('#tlProject').innerHTML = `<option value="">All projects</option>` + state.projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  $('#tlProject').value = state.tl.project;
}

async function projectAction(e) {
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('.project');
  if (!btn || !card || e.type === 'change') return;
  const p = state.projects.find((x) => x.id === card.dataset.id);
  const act = btn.dataset.act;
  try {
    if (act === 'remove') {
      if (!confirm(`Remove "${p.name}" from Todoro?\n\nOnly the list entry is removed. Files on disk are not touched.`)) return;
      await api('DELETE', `/api/projects/${p.id}`);
      if (state.chat.projectId === p.id) setChatProject('home');
      await loadState();
      toast(`Removed ${p.name}`);
      loadTimeline();
    } else if (act === 'run') {
      const runnable = $('select[data-act=pick]', card).value;
      if (!runnable || runnable === '__custom') return toast('Pick something to run first', true);
      const r = await api('POST', `/api/projects/${p.id}/run`, { runnable });
      toast(`Started ${r.label}`);
      loadTimeline();
    } else if (act === 'folder' || act === 'vscode' || act === 'terminal') {
      await api('POST', `/api/projects/${p.id}/open`, { target: act });
      toast(act === 'terminal' ? `Opening Claude Code in ${p.name}…` : `Opening ${p.name}…`);
    } else if (act === 'chat' || act === 'select') {
      setChatProject(p.id);
      switchTab('chat');
      $('#prompt').focus();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

async function projectPick(e) {
  const sel = e.target.closest('select[data-act=pick]');
  if (!sel) return;
  const p = state.projects.find((x) => x.id === sel.closest('.project').dataset.id);
  if (sel.value === '__custom') {
    sel.value = p.runnable || '';
    return openCustomCommand(p);
  }
  try {
    await api('PATCH', `/api/projects/${p.id}`, { runnable: sel.value });
    p.runnable = sel.value;
  } catch (err) {
    toast(err.message, true);
  }
}

function openCustomCommand(p) {
  showModal(`Custom command · ${p.name}`, `
    <form class="form-grid" id="customForm">
      <label>Label <input name="label" placeholder="Dev server" required></label>
      <label>Command (runs in ${esc(p.path)}) <input name="command" placeholder="python run.py --port 8000" required spellcheck="false"></label>
      ${p.custom?.length ? `<div><div class="muted" style="font-size:12px;margin-bottom:4px">Existing custom commands</div>${p.custom.map((c) => `<div class="hrow"><span class="grow"><div><b>${esc(c.label)}</b> <code>${esc(c.command)}</code></div></span><button type="button" class="small danger" data-remove-custom="${esc(c.id)}">Delete</button></div>`).join('')}</div>` : ''}
      <div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save &amp; select</button></div>
    </form>`, {
    async onSubmit(form) {
      const f = new FormData(form);
      await api('PATCH', `/api/projects/${p.id}`, { addCustom: { label: f.get('label'), command: f.get('command') } });
      hideModal();
      await loadState();
      toast('Custom command added');
    },
    async onClick(e) {
      const id = e.target.dataset.removeCustom;
      if (!id) return;
      await api('PATCH', `/api/projects/${p.id}`, { removeCustom: id });
      hideModal();
      await loadState();
    },
  });
}

function openRename(p) {
  showModal('Rename project', `
    <form class="form-grid">
      <label>Display name <input name="name" value="${esc(p.name)}" required></label>
      <div class="form-actions"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div>
    </form>`, {
    async onSubmit(form) {
      await api('PATCH', `/api/projects/${p.id}`, { name: new FormData(form).get('name') });
      hideModal();
      await loadState();
    },
  });
  setTimeout(() => $('#modalBody input')?.select(), 30);
}

async function addProjectPath(path) {
  try {
    const p = await api('POST', '/api/projects', { path });
    toast(`Added ${p.name}`);
    await loadState();
    loadTimeline();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function openBrowse(dir) {
  let data;
  try {
    data = await api('GET', '/api/browse?path=' + encodeURIComponent(dir || ''));
  } catch (err) {
    return toast(err.message, true);
  }
  showModal('Add projects from disk', `
    <div class="browse-path">
      <button type="button" data-up="${esc(data.parent || '')}" ${data.parent ? '' : 'disabled'}>↑ Up</button>
      <input id="browseInput" value="${esc(data.path)}" spellcheck="false">
      <button type="button" data-go>Go</button>
      <button type="button" class="primary" data-add="${esc(data.path)}">Add this folder</button>
    </div>
    <div class="browse-list">
      ${data.dirs.map((d) => `
        <div class="browse-row">
          <span class="name ${d.looksLikeProject ? 'proj' : ''}" data-open="${esc(d.path)}" title="Open folder">${esc(d.name)}</span>
          ${d.registered ? '<span class="tag leaf">added</span>' : `<button type="button" class="small" data-add="${esc(d.path)}">Add</button>`}
        </div>`).join('') || '<p class="muted">No sub-folders here.</p>'}
    </div>
    <p class="muted" style="font-size:12px;margin-top:10px">● marks folders that look like projects (.git, package.json, README, run.bat…). Click a name to look inside.</p>`, {
    async onClick(e) {
      const t = e.target;
      if (t.dataset.up) openBrowse(t.dataset.up);
      else if (t.dataset.open) openBrowse(t.dataset.open);
      else if (t.hasAttribute('data-go')) openBrowse($('#browseInput').value);
      else if (t.dataset.add && (await addProjectPath(t.dataset.add))) openBrowse(data.path);
    },
  });
  $('#browseInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openBrowse(e.target.value);
  });
}

// ---------- modal ----------
let modalHandlers = {};
function showModal(title, html, handlers = {}) {
  modalHandlers = handlers;
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modalBody input:not([type=hidden])')?.focus();
}
function hideModal() {
  $('#modal').classList.add('hidden');
  modalHandlers = {};
}

// ---------- skills ----------
async function loadSkills() {
  try {
    state.skills = await api('GET', '/api/skills?projectId=' + state.chat.projectId);
  } catch {
    state.skills = [];
  }
  renderSkills();
}

const SCOPE_TAG = { global: 'leaf', project: 'sun', plugin: 'plum', synced: 'sky' };
const SCOPE_LABEL = { global: 'global', project: 'project', plugin: 'plugin', synced: 'anthropic' };

function renderSkills() {
  const q = $('#skillFilter').value.trim().toLowerCase();
  const scope = $('#skillScope').value;
  const list = state.skills.filter((s) => (!scope || s.scope === scope) && (!q || s.invoke.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
  $('#skillCount').textContent = `${list.length}/${state.skills.length}`;
  $('#skillList').innerHTML = list.map((s) => `
    <div class="skill ${state.chat.skill === s.invoke ? 'active' : ''}" data-invoke="${esc(s.invoke)}">
      <div class="skill-top">
        <b title="/${esc(s.invoke)}">/${esc(s.invoke)}</b>
        <span class="tag ${SCOPE_TAG[s.scope]}">${SCOPE_LABEL[s.scope]}</span>
        <button class="small" data-use>Use</button>
      </div>
      <p>${esc(s.description || 'No description')}</p>
    </div>`).join('') || '<p class="muted">No skills match.</p>';
}

function selectSkill(invoke) {
  const s = state.skills.find((x) => x.invoke === invoke);
  state.chat.skill = invoke;
  $('#skillChip').innerHTML = `/${esc(invoke)} <button type="button" title="Remove skill">✕</button>`;
  $('#skillChip').classList.remove('hidden');
  $('#prompt').placeholder = s?.argumentHint ? `Arguments: ${s.argumentHint}` : `What should /${invoke} do? (optional — Enter to run)`;
  renderSkills();
  switchTab('chat');
  $('#prompt').focus();
}

function clearSkill() {
  state.chat.skill = null;
  $('#skillChip').classList.add('hidden');
  $('#prompt').placeholder = 'Ask Claude about this project…';
  renderSkills();
}

// ---------- chat ----------
const QUICK_PROJECT = [
  'What did I work on here recently? Use git log and recently changed files.',
  'Review this project and list the 5 most valuable improvements.',
  'Find likely bugs in the most recently changed files.',
  'How do I run this project, and what does each .bat/.exe do?',
];
const QUICK_HOME = [
  'Which of my projects changed the most this week, and what changed?',
  'Suggest what I should focus on today across my projects.',
  'List my projects that have no README or CLAUDE.md yet.',
];

function renderWelcome() {
  const home = state.chat.projectId === 'home';
  $('#messages').innerHTML = `
    <div class="welcome">
      <img src="/totoro.jpg" alt="">
      <h2>Hi! What shall we do today?</h2>
      <p>You're chatting in <b>${esc(projectName(state.chat.projectId))}</b>. Every message runs a real Claude Code session in that folder, so your tools, skills, CLAUDE.md and memory all apply.</p>
      <div class="quick">${(home ? QUICK_HOME : QUICK_PROJECT).map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    </div>`;
}

function setChatProject(id) {
  if (state.chat.running) {
    toast('Wait for the current reply, or stop it first', true);
    $('#chatProject').value = state.chat.projectId;
    return false;
  }
  const changed = state.chat.projectId !== id;
  state.chat.projectId = id;
  $('#chatProject').value = id;
  if (changed) {
    state.chat.sessionId = null;
    updateSessionBadge();
    renderWelcome();
    loadSkills();
  }
  renderProjects();
  return true;
}

function updateSessionBadge() {
  const b = $('#sessionBadge');
  if (state.chat.sessionId) {
    b.textContent = 'session ' + state.chat.sessionId.slice(0, 8);
    b.title = `Claude Code session ${state.chat.sessionId}. Your next message continues it.`;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

const messagesEl = () => $('#messages');
function nearBottom() {
  const m = messagesEl();
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}
function append(el) {
  const m = messagesEl();
  const stick = nearBottom();
  $('.welcome', m)?.remove();
  const thinking = $('.thinking', m);
  m.insertBefore(el, thinking || null);
  if (stick) m.scrollTop = m.scrollHeight;
  return el;
}
function node(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function addUser(text, skill) {
  append(node(`<div class="msg user">${skill ? `<span class="skill-tag">/${esc(skill)}</span>` : ''}${esc(text)}</div>`));
}
function addAssistant(text) {
  const el = append(node('<div class="msg assistant"></div>'));
  el.innerHTML = md(text);
  return el;
}
function addNote(text, kind = '') {
  append(node(`<div class="note ${kind}">${esc(text)}</div>`));
}
function addTool(b, nested) {
  append(node(`
    <details class="tool ${nested ? 'nested' : ''}" data-id="${esc(b.id || '')}">
      <summary><span class="tool-name">${esc(b.name)}</span><span class="tool-sum">${esc(b.summary || '')}</span><span class="tool-status">${b.id ? '…' : ''}</span></summary>
      ${b.input ? `<pre>${esc(b.input)}</pre>` : ''}
    </details>`));
}
function attachResult(r) {
  const el = $$('.tool', messagesEl()).find((t) => t.dataset.id === r.tool_use_id);
  if (!el) return;
  el.classList.add(r.is_error ? 'err' : 'ok');
  $('.tool-status', el).textContent = r.is_error ? '✗' : '✓';
  if (r.text) el.insertAdjacentHTML('beforeend', `<pre>${esc(r.text)}</pre>`);
}

let liveFrame = 0;
function renderLive() {
  liveFrame = 0;
  const live = state.chat.live;
  if (!live) return;
  const stick = nearBottom();
  live.el.innerHTML = md(live.text);
  if (stick) messagesEl().scrollTop = messagesEl().scrollHeight;
}

function onEvent(ev) {
  state.chat.received++;
  const c = state.chat;
  switch (ev.type) {
    case 'init':
      c.sessionId = ev.session_id;
      updateSessionBadge();
      break;
    case 'delta':
      if (!c.live) c.live = { el: append(node('<div class="msg assistant live"></div>')), text: '' };
      c.live.text += ev.text;
      if (!liveFrame) liveFrame = requestAnimationFrame(renderLive);
      break;
    case 'assistant':
      for (const b of ev.content) {
        if (b.type === 'text') {
          if (ev.parent) continue;
          if (c.live) {
            c.live.el.classList.remove('live');
            c.live.el.innerHTML = md(b.text);
            c.live = null;
          } else {
            addAssistant(b.text);
          }
        } else if (b.type === 'tool_use') {
          addTool(b, !!ev.parent);
        }
      }
      break;
    case 'tool_results':
      ev.items.forEach(attachResult);
      break;
    case 'result': {
      const bits = [];
      if (ev.duration_ms) bits.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
      if (ev.num_turns) bits.push(`${ev.num_turns} turn${ev.num_turns === 1 ? '' : 's'}`);
      if (ev.total_cost_usd != null) bits.push(`$${ev.total_cost_usd.toFixed(3)}`);
      append(node(`<div class="result-line ${ev.is_error ? 'err' : ''}">${ev.is_error ? '✗ ' + esc(ev.result || ev.subtype) : '✓ Done'} · ${bits.join(' · ')}</div>`));
      if (ev.permission_denials?.length) {
        addNote(`Blocked by the permission mode: ${[...new Set(ev.permission_denials)].join(', ')}. Switch Permissions (e.g. Accept edits) or use "Open in terminal" to approve step by step.`, 'error');
      }
      break;
    }
    case 'note':
      addNote(ev.text);
      break;
    case 'stderr':
      if (ev.text.trim()) addNote(ev.text, 'error');
      break;
    case 'rate':
      refreshStats();
      break;
    case 'exit':
      if (ev.code && !$$('.result-line', messagesEl()).length) addNote(`Claude exited with code ${ev.code}`, 'error');
      finishRun();
      break;
  }
}

function setRunning(on) {
  state.chat.running = on;
  const btn = $('#btnSend');
  btn.textContent = on ? 'Stop' : 'Send';
  btn.classList.toggle('stop', on);
  btn.classList.toggle('primary', !on);
  $('#chatProject').disabled = on;
  $('.thinking', messagesEl())?.remove();
  if (on) {
    messagesEl().appendChild(node('<div class="thinking"><span class="spinner"></span> Claude is working…</div>'));
    messagesEl().scrollTop = messagesEl().scrollHeight;
  }
}

function connect(runId) {
  const es = new EventSource(`/api/runs/${runId}/events?from=${state.chat.received}`);
  state.chat.es = es;
  es.onmessage = (m) => onEvent(JSON.parse(m.data));
  es.onerror = () => {
    es.close();
    // Dropped mid-run: reconnect and pick up where we left off.
    if (state.chat.running && state.chat.runId === runId) setTimeout(() => state.chat.running && connect(runId), 1000);
  };
}

function finishRun() {
  state.chat.es?.close();
  state.chat.es = null;
  if (state.chat.live) {
    state.chat.live.el.classList.remove('live');
    state.chat.live = null;
  }
  setRunning(false);
  setTimeout(loadTimeline, 800);
}

async function send(e) {
  e?.preventDefault();
  if (state.chat.running) {
    try {
      await api('POST', `/api/runs/${state.chat.runId}/stop`);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  const text = $('#prompt').value.trim();
  const skill = state.chat.skill;
  if (!text && !skill) return;
  addUser(text, skill);
  $('#prompt').value = '';
  if (skill) clearSkill();
  setRunning(true);
  try {
    const { runId } = await api('POST', '/api/chat', {
      projectId: state.chat.projectId,
      prompt: text,
      skill,
      model: $('#chatModel').value,
      effort: $('#chatEffort').value,
      permissionMode: $('#chatPerm').value,
      sessionId: state.chat.sessionId,
    });
    state.chat.runId = runId;
    state.chat.received = 0;
    connect(runId);
  } catch (err) {
    addNote(err.message, 'error');
    setRunning(false);
  }
}

async function openSession(projectId, sessionId) {
  if (!projectId) return toast('That session belongs to a folder that is not in your list', true);
  if (state.chat.running) return toast('Wait for the current reply, or stop it first', true);
  switchTab('chat');
  if (!setChatProject(projectId)) return;
  messagesEl().innerHTML = '';
  try {
    const data = await api('GET', `/api/sessions/${projectId}/${sessionId}`);
    addNote(`Loaded ${data.messages.length}${data.total > data.messages.length ? ` of ${data.total}` : ''} messages from a Claude Code session`);
    for (const m of data.messages) {
      if (m.role === 'user') addUser(m.text);
      else if (m.role === 'assistant') addAssistant(m.text);
      else addTool({ name: m.name, summary: m.summary });
    }
    state.chat.sessionId = sessionId;
    updateSessionBadge();
    addNote('Type below to continue this session with its full context.');
    messagesEl().scrollTop = messagesEl().scrollHeight;
  } catch (err) {
    addNote(err.message, 'error');
  }
}

// ---------- tabs ----------
function switchTab(name) {
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  for (const b of $$('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of $$('.tab-body')) t.classList.toggle('hidden', t.id !== 'tab-' + name);
  if (name === 'harness') loadHarness();
  if (name === 'top10') {
    const latest = state.rec.status?.latest;
    if (latest) store.set('recSeen', latest.startedAt);
    $('#recDot').classList.add('hidden');
  }
}

// ---------- timeline ----------
const SOURCES = [
  ['app', 'Todoro'],
  ['claude', 'Claude'],
  ['git', 'Git'],
  ['files', 'Files'],
];

async function loadTimeline() {
  try {
    const data = await api('GET', '/api/timeline?days=' + $('#tlDays').value);
    state.tl.events = data.events;
    renderTimeline();
  } catch (err) {
    $('#timeline').innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function renderTimeline() {
  const byProject = state.tl.events.filter((e) => !state.tl.project || e.project === state.tl.project);
  $('#tlFilters').innerHTML = SOURCES.map(([k, label]) => `<button class="filter src-${k} ${state.tl.sources.has(k) ? '' : 'off'}" data-src="${k}"><span class="sw"></span>${label} <b>${byProject.filter((e) => e.source === k).length}</b></button>`).join('');
  const events = byProject.filter((e) => state.tl.sources.has(e.source));
  if (!events.length) {
    $('#timeline').innerHTML = '<div class="empty-state"><p>Nothing happened in this range yet.</p></div>';
    return;
  }
  let html = '';
  let day = '';
  events.forEach((e, i) => {
    const d = dayLabel(e.ts);
    if (d !== day) {
      html += `<div class="tl-day">${d}</div>`;
      day = d;
    }
    const pid = e.projectId || (e.project ? projectIdByName(e.project) : null) || (e.project === 'All projects' ? 'home' : null);
    const clickable = e.ref?.sessionId && pid;
    const started = e.startTs && (new Date(e.startTs).toDateString() === new Date(e.ts).toDateString() ? fmtTime(e.startTs) : fmtDateTime(e.startTs));
    const meta = [e.project ? `<span class="tag">${esc(e.project)}</span>` : '', esc(e.detail || ''), started ? `· started ${esc(started)}` : ''].join(' ');
    html += `
      <div class="tl-item src-${e.source} ${clickable ? 'clickable' : ''} ${e.status === 'error' ? 'err' : ''}" data-i="${i}" ${clickable ? `data-pid="${pid}" data-sid="${esc(e.ref.sessionId)}" title="Open this Claude session"` : ''}>
        <div class="tl-time">${fmtTime(e.ts)}</div>
        <div class="tl-dot"></div>
        <div class="tl-body"><div class="tl-title">${esc(e.title)}</div><div class="tl-meta">${meta}</div></div>
      </div>`;
  });
  $('#timeline').innerHTML = html;
}

// ---------- top 10 ----------
async function loadRec(quiet = false) {
  try {
    state.rec.status = await api('GET', '/api/recommend');
  } catch (err) {
    if (!quiet) toast(err.message, true);
    return;
  }
  renderRec();
  clearTimeout(state.rec.pollTimer);
  if (state.rec.status.running) state.rec.pollTimer = setTimeout(() => loadRec(true), 2500);
}

function renderRec() {
  const s = state.rec.status;
  if (!s) return;
  const settings = s.settings;
  if (document.activeElement?.id !== 'recModel') $('#recModel').value = settings.recModel;
  if (document.activeElement?.id !== 'recEffort') $('#recEffort').value = settings.recEffort;
  $('#recAuto').checked = !!settings.autoDaily;

  $('#kwList').innerHTML = settings.keywords.map((k) => `<span class="chip">${esc(k)}<button type="button" data-kw="${esc(k)}" title="Remove">✕</button></span>`).join('') || '<span class="muted">No keywords yet. Add a few topics you care about.</span>';

  const btn = $('#btnRec');
  btn.textContent = s.running ? 'Stop' : 'Refresh now';
  btn.classList.toggle('stop', s.running);
  btn.classList.toggle('primary', !s.running);

  const prog = $('#recProgress');
  prog.classList.toggle('hidden', !s.running);
  if (s.running) {
    prog.innerHTML = `<div><span class="spinner"></span><b>${s.auto ? 'Daily auto-run in progress' : 'Researching'}… started ${fmtTime(s.startedAt)}</b></div>` + s.progress.map((p) => `<div><time>${fmtTime(p.ts)}</time><span>${esc(p.text)}</span></div>`).join('');
    prog.scrollTop = prog.scrollHeight;
  }

  const err = $('#recError');
  const failed = !s.running && s.lastRun?.status === 'error';
  err.classList.toggle('hidden', !failed);
  if (failed) err.innerHTML = `<b>Last run failed</b> (${esc(fmtDateTime(s.lastRun.startedAt))}): ${esc(s.lastRun.error || 'unknown error')}`;

  const hist = $('#recHistory');
  const okRuns = s.history.filter((h) => h.status === 'ok');
  hist.innerHTML = okRuns.length ? okRuns.map((h, i) => `<option value="${h.id}">${i === 0 ? 'Latest · ' : ''}${esc(fmtDateTime(h.startedAt))} · ${esc(h.model || '')}</option>`).join('') : '<option value="">No runs yet</option>';
  const run = state.rec.viewing || s.latest;
  if (run) hist.value = run.id;

  $('#recMeta').textContent = s.latest
    ? `Last refreshed ${fmtAgo(s.latest.startedAt)} (${fmtDateTime(s.latest.startedAt)}) · ${s.latest.model}${s.latest.auto ? ' · auto' : ''}${s.latest.cost ? ` · $${s.latest.cost.toFixed(2)}` : ''}`
    : 'Never run yet. Click Refresh now, or wait for the daily auto-run.';

  const seen = store.get('recSeen', '');
  $('#recDot').classList.toggle('hidden', !s.latest || s.latest.startedAt <= seen || !$('#tab-top10').classList.contains('hidden'));

  renderRecItems(run, s.feedback);
}

function renderRecItems(run, feedback) {
  const sum = $('#recSummary');
  sum.classList.toggle('hidden', !run?.summary);
  sum.textContent = run?.summary || '';
  if (!run?.items?.length) {
    $('#recGrid').innerHTML = `<div class="empty-state" style="grid-column:1/-1"><img src="/totoro.jpg" alt=""><p>Todoro reviews your projects and keywords, searches the web and GitHub,<br>and picks the 10 best things for you to look at.</p></div>`;
    return;
  }
  $('#recGrid').innerHTML = run.items.map((it, i) => {
    const fb = feedback[it.url] || '';
    let host = '';
    try {
      host = new URL(it.url).host + new URL(it.url).pathname.replace(/\/$/, '');
    } catch { host = it.url; }
    return `
      <article class="rec ${fb ? 'fb-' + fb : ''}" data-i="${i}">
        <div class="rec-rank">${it.rank || i + 1}</div>
        <div class="rec-body">
          <div class="rec-top"><span class="tag ${{ repo: 'plum', paper: 'sky', tool: 'leaf', model: 'sun', skill: 'sky' }[it.kind] || ''}">${esc(it.kind)}</span><span class="score" title="Relevance ${it.score}/100"><i style="width:${Math.max(0, Math.min(100, it.score))}%"></i></span><span>${esc(it.effort)} effort</span></div>
          <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
          <div class="url">${esc(host)}</div>
          <p class="why">${esc(it.why)}</p>
          <p class="action"><b>Try:</b> ${esc(it.action)}</p>
          <div class="tags">${(it.projects || []).map((p) => `<span class="tag leaf">${esc(p)}</span>`).join('')}${(it.keywords || []).map((k) => `<span class="tag sun">${esc(k)}</span>`).join('')}</div>
          <div class="rec-actions">
            <button data-fb="saved" class="${fb === 'saved' ? 'on' : ''}">★ Save</button>
            <button data-fb="done" class="${fb === 'done' ? 'on' : ''}">✓ Done</button>
            <button data-fb="dismissed" class="${fb === 'dismissed' ? 'on' : ''}">✕ Not for me</button>
            <button data-ask>Ask Claude</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

async function saveKeywords(keywords) {
  state.rec.status.settings = await api('PUT', '/api/settings', { keywords });
  renderRec();
}

// ---------- harness ----------
async function loadHarness() {
  const el = $('#harness');
  el.innerHTML = '<p class="muted"><span class="spinner"></span> Reading your Claude Code setup…</p>';
  let h;
  try {
    h = await api('GET', '/api/harness?projectId=' + state.harnessProject);
  } catch (err) {
    el.innerHTML = `<div class="warn-box">${esc(err.message)}</div>`;
    return;
  }
  const w = h.claude.rateLimit?.unifiedWindows;
  const pct = (x) => Math.round((x?.utilization || 0) * 100);
  const list = (items, row, empty) => (items.length ? `<div class="hlist">${items.map(row).join('')}</div>` : `<p class="muted">${empty}</p>`);
  const p = h.project;
  el.innerHTML = `
    <div class="hcard">
      <h3>Claude Code</h3>
      <dl class="kv">
        <dt>Version</dt><dd>${esc(h.claude.version || 'unknown')}</dd>
        <dt>Binary</dt><dd>${esc(h.claude.path || 'not found')}</dd>
        <dt>Default model</dt><dd>${esc(h.settings.model)}</dd>
        <dt>Effort</dt><dd>${esc(h.settings.effortLevel)}</dd>
        <dt>Env vars</dt><dd>${esc(h.settings.envKeys.join(', ') || 'none')}</dd>
        <dt>Plan usage</dt><dd>${w ? `5h ${pct(w.five_hour)}% · 7d ${pct(w.seven_day)}%` : 'shown after the first run'}</dd>
        <dt>~/.claude/CLAUDE.md</dt><dd>${h.userClaudeMd ? 'yes' : 'no'}</dd>
      </dl>
      ${h.settings.pathWarning ? `<div class="warn-box" style="margin:10px 0 0">${esc(h.settings.pathWarning)}</div>` : ''}
    </div>
    <div class="hcard">
      <h3>${esc(p.name)} <span class="count">${esc(p.path)}</span></h3>
      <dl class="kv">
        <dt>Memory files</dt><dd>${esc(p.claudeMd.join(', ') || 'none — run /init in a terminal to create CLAUDE.md')}</dd>
        <dt>Allow rules</dt><dd>${p.allow.length ? esc(p.allow.slice(0, 8).join(', ')) + (p.allow.length > 8 ? ` +${p.allow.length - 8}` : '') : 'none'}</dd>
      </dl>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="small" data-h-terminal>New terminal session</button>
      </div>
    </div>
    <div class="hcard wide">
      <h3>Sessions <span class="count">${p.sessions.length}</span></h3>
      ${list(p.sessions, (s) => `
        <div class="hrow session-row">
          <span class="grow"><div class="title">${esc(s.title || s.firstPrompt)}</div><div class="sub">${esc(fmtDateTime(s.startTs))} → ${esc(fmtAgo(s.endTs))} · ${s.prompts} prompts · ${s.sizeKb} KB · ${esc(s.id.slice(0, 8))}</div></span>
          <button class="small" data-open-session="${esc(s.id)}">Continue here</button>
          <button class="small" data-resume-terminal="${esc(s.id)}">Terminal</button>
        </div>`, 'No Claude Code sessions in this folder yet.')}
    </div>
    <div class="hcard">
      <h3>Hooks <span class="count">${h.hooks.length}</span></h3>
      ${list(h.hooks, (k) => `<div class="hrow"><span class="tag plum">${esc(k.event)}</span><span class="grow"><div><code>${esc(k.command)}</code></div><div class="muted" style="font-size:11px">${esc(k.scope)} · matcher ${esc(k.matcher)}</div></span></div>`, 'No hooks configured.')}
    </div>
    <div class="hcard">
      <h3>MCP servers <span class="count">${h.mcp.length}</span></h3>
      ${list(h.mcp, (m) => `<div class="hrow"><span class="tag sky">${esc(m.scope)}</span><span class="grow"><div><b>${esc(m.name)}</b> · ${esc(m.type)}</div><div><code>${esc(m.target)}</code></div></span></div>`, 'No local MCP servers. claude.ai connectors (Gmail, Calendar, Drive…) are managed in claude.ai settings.')}
    </div>
    <div class="hcard">
      <h3>Plugins <span class="count">${h.plugins.length}</span></h3>
      ${list(h.plugins, (pl) => `<div class="hrow"><span class="tag ${pl.enabled ? 'leaf' : ''}">${pl.enabled ? 'on' : 'off'}</span><span class="grow"><div><b>${esc(pl.name)}</b> ${esc(pl.version || '')}</div><div class="muted" style="font-size:11px">${esc(pl.marketplace)} · ${esc(pl.scope || '')}</div></span></div>`, 'No plugins installed.')}
    </div>
    <div class="hcard">
      <h3>Agents <span class="count">${h.agents.length}</span></h3>
      ${list(h.agents, (a) => `<div class="hrow"><span class="tag sun">${esc(a.scope)}</span><span class="grow"><div><b>${esc(a.name)}</b>${a.model ? ` · ${esc(a.model)}` : ''}</div><div class="muted" style="font-size:11px">${esc(a.description)}</div></span></div>`, 'No custom subagents (~/.claude/agents or .claude/agents).')}
    </div>`;
}

// ---------- wiring ----------
function bind() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.dataset.tab);
  });

  // projects
  $('#projectList').addEventListener('click', projectAction);
  $('#projectList').addEventListener('change', projectPick);
  $('#projectList').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.project-title') && e.target.closest('.project');
    if (card) openRename(state.projects.find((p) => p.id === card.dataset.id));
  });
  $('#btnAdd').addEventListener('click', () => {
    $('#addForm').classList.toggle('hidden');
    $('#addPath').focus();
  });
  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (await addProjectPath($('#addPath').value)) {
      $('#addPath').value = '';
      $('#addForm').classList.add('hidden');
    }
  });
  $('#btnBrowse').addEventListener('click', () => openBrowse(state.agentRoot));

  // modal
  $('#modalClose').addEventListener('click', hideModal);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal' || e.target.hasAttribute('data-close')) return hideModal();
    modalHandlers.onClick?.(e)?.catch?.((err) => toast(err.message, true));
  });
  $('#modal').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await modalHandlers.onSubmit?.(e.target);
    } catch (err) {
      toast(err.message, true);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').classList.contains('hidden')) hideModal();
  });

  // skills
  $('#skillFilter').addEventListener('input', renderSkills);
  $('#skillScope').addEventListener('change', renderSkills);
  $('#skillList').addEventListener('click', (e) => {
    const el = e.target.closest('.skill');
    if (!el) return;
    if (e.target.hasAttribute('data-use')) selectSkill(el.dataset.invoke);
    else el.classList.toggle('open');
  });
  $('#skillChip').addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') clearSkill();
  });

  // chat
  $('#composer').addEventListener('submit', send);
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $('#messages').addEventListener('click', (e) => {
    const q = e.target.dataset.q;
    if (q) {
      $('#prompt').value = q;
      $('#prompt').focus();
    }
  });
  $('#chatProject').addEventListener('change', (e) => setChatProject(e.target.value));
  for (const [id, key] of [['#chatModel', 'chatModel'], ['#chatEffort', 'chatEffort'], ['#chatPerm', 'permissionMode']]) {
    $(id).value = state.settings[key] ?? $(id).value;
    $(id).addEventListener('change', (e) => api('PUT', '/api/settings', { [key]: e.target.value }).catch(() => {}));
  }
  $('#chatPerm').addEventListener('change', (e) => {
    if (e.target.value === 'bypassPermissions') toast('Bypass lets Claude run any command without asking. Use with care.', true);
  });
  $('#btnNewChat').addEventListener('click', () => {
    if (state.chat.running) return toast('Stop the current reply first', true);
    state.chat.sessionId = null;
    updateSessionBadge();
    renderWelcome();
  });
  $('#btnTerminal').addEventListener('click', async () => {
    try {
      await api('POST', `/api/projects/${state.chat.projectId}/open`, { target: 'terminal', sessionId: state.chat.sessionId || undefined });
      toast(state.chat.sessionId ? 'Resuming this session in a Claude Code terminal…' : 'Opening a Claude Code terminal…');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // timeline
  $('#tlDays').addEventListener('change', loadTimeline);
  $('#tlRefresh').addEventListener('click', loadTimeline);
  $('#tlProject').addEventListener('change', (e) => {
    state.tl.project = e.target.value;
    renderTimeline();
  });
  $('#tlFilters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-src]');
    if (!b) return;
    const s = state.tl.sources;
    s.has(b.dataset.src) ? s.delete(b.dataset.src) : s.add(b.dataset.src);
    store.set('tlSources', [...s]);
    renderTimeline();
  });
  $('#timeline').addEventListener('click', (e) => {
    const item = e.target.closest('.tl-item.clickable');
    if (item) openSession(item.dataset.pid, item.dataset.sid);
  });

  // top 10
  $('#btnRec').addEventListener('click', async () => {
    try {
      if (state.rec.status?.running) {
        await api('POST', '/api/recommend/stop');
        toast('Stopping…');
      } else {
        state.rec.viewing = null;
        await api('POST', '/api/recommend/run', { model: $('#recModel').value, effort: $('#recEffort').value });
        toast('Researching your Top 10 — this takes a few minutes');
      }
      setTimeout(() => loadRec(), 400);
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#recModel').addEventListener('change', (e) => api('PUT', '/api/settings', { recModel: e.target.value }).then((s) => (state.rec.status.settings = s)));
  $('#recEffort').addEventListener('change', (e) => api('PUT', '/api/settings', { recEffort: e.target.value }).then((s) => (state.rec.status.settings = s)));
  $('#recAuto').addEventListener('change', (e) => api('PUT', '/api/settings', { autoDaily: e.target.checked }).then((s) => {
    state.rec.status.settings = s;
    toast(s.autoDaily ? 'Auto daily on: Todoro refreshes once a day while it is running' : 'Auto daily off');
  }));
  $('#recHistory').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    try {
      state.rec.viewing = e.target.value === state.rec.status.latest?.id ? null : await api('GET', `/api/recommend/runs/${e.target.value}`);
      renderRec();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#kwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#kwInput').value.trim();
    if (!v) return;
    await saveKeywords([...state.rec.status.settings.keywords, v]);
    $('#kwInput').value = '';
  });
  $('#kwList').addEventListener('click', (e) => {
    const k = e.target.dataset.kw;
    if (k) saveKeywords(state.rec.status.settings.keywords.filter((x) => x !== k));
  });
  $('#recGrid').addEventListener('click', async (e) => {
    const card = e.target.closest('.rec');
    if (!card) return;
    const run = state.rec.viewing || state.rec.status.latest;
    const it = run.items[+card.dataset.i];
    if (e.target.dataset.fb) {
      const next = state.rec.status.feedback[it.url] === e.target.dataset.fb ? 'none' : e.target.dataset.fb;
      state.rec.status.feedback = await api('POST', '/api/recommend/feedback', { url: it.url, state: next });
      renderRecItems(run, state.rec.status.feedback);
    } else if (e.target.hasAttribute('data-ask')) {
      const pid = (it.projects || []).map(projectIdByName).find(Boolean) || 'home';
      if (!setChatProject(pid)) return;
      switchTab('chat');
      $('#prompt').value = `Look at "${it.title}" (${it.url}). How could I apply it to ${pid === 'home' ? 'my projects' : 'this project'}? Read the relevant code first, then give me a concrete step-by-step plan.`;
      $('#prompt').focus();
    }
  });

  // harness
  $('#harnessProject').addEventListener('change', (e) => {
    state.harnessProject = e.target.value;
    loadHarness();
  });
  $('#btnHarnessRefresh').addEventListener('click', loadHarness);
  $('#harness').addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.dataset.openSession) openSession(state.harnessProject, t.dataset.openSession);
      else if (t.dataset.resumeTerminal) {
        await api('POST', `/api/projects/${state.harnessProject}/open`, { target: 'terminal', sessionId: t.dataset.resumeTerminal });
        toast('Resuming in a Claude Code terminal…');
      } else if (t.hasAttribute('data-h-terminal')) {
        await api('POST', `/api/projects/${state.harnessProject}/open`, { target: 'terminal' });
        toast('Opening a Claude Code terminal…');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#btnQuit').addEventListener('click', async () => {
    if (!confirm('Quit Todoro? This stops the server and removes the tray icon. Running Claude replies will be cut off.')) return;
    await api('POST', '/api/quit').catch(() => {});
    document.body.innerHTML = '<div class="empty-state" style="margin-top:20vh"><img src="/totoro.jpg" alt=""><h2>Todoro is sleeping.</h2><p>Start it again from the Start menu or Todoro.bat. You can close this window.</p></div>';
  });
}

// Tells the server whether this window is in front, so the tray icon only
// notifies about finished runs while you are looking at something else.
function reportPresence(focused = document.visibilityState === 'visible' && document.hasFocus()) {
  fetch('/api/presence', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'x-todoro': '1' },
    body: JSON.stringify({ focused }),
  }).catch(() => {});
}

function trackPresence() {
  for (const ev of ['focus', 'blur']) window.addEventListener(ev, () => reportPresence());
  document.addEventListener('visibilitychange', () => reportPresence());
  window.addEventListener('pagehide', () => reportPresence(false));
  setInterval(() => document.hasFocus() && reportPresence(), 60 * 1000);
  reportPresence();
}

async function init() {
  try {
    await loadState();
  } catch (err) {
    document.body.innerHTML = `<div class="empty-state" style="margin-top:20vh"><h2>Cannot reach the Todoro server</h2><p>${esc(err.message)}</p></div>`;
    return;
  }
  bind();
  trackPresence();
  renderWelcome();
  const tab = location.hash.slice(1);
  if (['chat', 'top10', 'harness'].includes(tab)) switchTab(tab);
  loadSkills();
  loadTimeline();
  loadRec(true);
  setInterval(loadTimeline, 60 * 1000);
  setInterval(() => !state.rec.status?.running && loadRec(true), 60 * 1000);
}

init();
