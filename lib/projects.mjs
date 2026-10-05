import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_ROOT, TOOLS, childEnv, isSkippableDir, samePath } from './config.mjs';
import { logActivity, readJson, writeJson } from './store.mjs';

const SEED_PATHS = [
  'D:\\2026_Agent\\1_Understanding_fast\\paper_read_project_pdf',
  'D:\\2026_Agent\\language_platform',
  'D:\\2026_Agent\\language_reactor',
];

const RUN_KINDS = { '.bat': 'bat', '.cmd': 'bat', '.exe': 'exe', '.ps1': 'ps1' };

function load() {
  const data = readJson('projects.json', null);
  if (data) return data;
  const seeded = { projects: [] };
  for (const p of SEED_PATHS) {
    if (fs.existsSync(p)) seeded.projects.push(newProject(p));
  }
  writeJson('projects.json', seeded);
  return seeded;
}

function save(data) {
  writeJson('projects.json', data);
}

function newProject(dir, name) {
  const runnables = detectRunnables(dir);
  return {
    id: crypto.randomUUID().slice(0, 8),
    name: name || path.basename(dir),
    path: dir,
    runnable: pickDefaultRunnable(runnables)?.id || null,
    custom: [],
    addedAt: new Date().toISOString(),
  };
}

// Finds launchable things: .bat/.cmd/.exe/.ps1 up to two folders deep, plus
// package.json scripts. Virtualenvs, node_modules and build output are skipped.
export function detectRunnables(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !e.name.startsWith('.') && !isSkippableDir(e.name, full)) walk(full, depth + 1);
      } else {
        const kind = RUN_KINDS[path.extname(e.name).toLowerCase()];
        if (kind) {
          const rel = path.relative(root, full);
          found.push({ id: 'file:' + rel.replace(/\\/g, '/'), label: rel, kind });
        }
      }
    }
  };
  walk(root, 0);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const s of Object.keys(pkg.scripts || {})) found.push({ id: 'npm:' + s, label: 'npm run ' + s, kind: 'npm' });
  } catch { /* no package.json */ }
  return found.slice(0, 60);
}

function pickDefaultRunnable(list) {
  const score = (r) => {
    const n = r.label.toLowerCase();
    if (n === 'run.bat') return 100;
    if (r.kind === 'bat' && !n.includes('\\') && !/setup|install|build|test/.test(n)) return 80;
    if (r.kind === 'exe' && n.startsWith('dist')) return 70;
    if (r.id === 'npm:dev') return 60;
    if (r.id === 'npm:start') return 55;
    if (r.kind === 'bat') return 40;
    return 10;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

function withRunnables(p) {
  const exists = fs.existsSync(p.path);
  const runnables = exists ? detectRunnables(p.path) : [];
  for (const c of p.custom || []) runnables.push({ id: c.id, label: c.label, kind: 'cmd', command: c.command });
  return {
    ...p,
    exists,
    runnables,
    hasGit: exists && fs.existsSync(path.join(p.path, '.git')),
    hasClaudeMd: exists && (fs.existsSync(path.join(p.path, 'CLAUDE.md')) || fs.existsSync(path.join(p.path, '.claude', 'CLAUDE.md'))),
  };
}

export function listProjects() {
  return load().projects.map(withRunnables);
}

export function getProject(id) {
  return load().projects.find((p) => p.id === id) || null;
}

export function addProject(dir, name) {
  dir = path.resolve(String(dir || '').trim().replace(/^"|"$/g, ''));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `Folder not found: ${dir}`);
  const data = load();
  if (data.projects.some((p) => samePath(p.path, dir))) throw httpError(409, 'That folder is already in the list.');
  const project = newProject(dir, name?.trim());
  data.projects.push(project);
  save(data);
  logActivity('project', `Added project ${project.name}`, { project: project.name });
  return withRunnables(project);
}

export function updateProject(id, patch) {
  const data = load();
  const p = data.projects.find((x) => x.id === id);
  if (!p) throw httpError(404, 'Project not found');
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (typeof patch.runnable === 'string') p.runnable = patch.runnable;
  if (patch.addCustom?.command) {
    const c = { id: 'cmd:' + crypto.randomUUID().slice(0, 8), label: (patch.addCustom.label || patch.addCustom.command).trim(), command: patch.addCustom.command.trim() };
    p.custom = [...(p.custom || []), c];
    p.runnable = c.id;
  }
  if (patch.removeCustom) {
    p.custom = (p.custom || []).filter((c) => c.id !== patch.removeCustom);
    if (p.runnable === patch.removeCustom) p.runnable = null;
  }
  if (Array.isArray(patch.order)) {
    const rank = new Map(patch.order.map((pid, i) => [pid, i]));
    data.projects.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  }
  save(data);
  return withRunnables(p);
}

export function removeProject(id) {
  const data = load();
  const p = data.projects.find((x) => x.id === id);
  if (!p) throw httpError(404, 'Project not found');
  data.projects = data.projects.filter((x) => x.id !== id);
  save(data);
  logActivity('project', `Removed project ${p.name} from the list`, { project: p.name });
}

// ---------- launching ----------

const cmdSafe = (s) => String(s).replace(/["&|<>^%]/g, ' ');

// Spawns a detached process and resolves once it has actually started, so a
// missing executable surfaces as an error instead of a silent no-op.
function launch(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', env: childEnv(), ...options });
    child.once('error', (err) => reject(httpError(500, `Could not start ${path.basename(file)}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

// Runs `inner` through cmd.exe so `start` opens it in its own console window.
function startDetached(inner) {
  return launch(TOOLS.cmd, ['/d', '/s', '/c', `"${inner}"`], { windowsVerbatimArguments: true, windowsHide: true });
}

export async function runProject(id, runnableId) {
  const p = withRunnables(requireProject(id));
  const r = p.runnables.find((x) => x.id === (runnableId || p.runnable));
  if (!r) throw httpError(400, 'Pick something to run first (a .bat, .exe or command).');
  const title = cmdSafe(`${p.name} - ${r.label}`);
  const shell = `"${TOOLS.cmd}"`;
  if (r.kind === 'npm') {
    const script = r.id.slice(4);
    if (!/^[\w:.-]+$/.test(script)) throw httpError(400, 'Unusual npm script name');
    await startDetached(`start "${title}" /D "${p.path}" ${shell} /k npm run ${script}`);
  } else if (r.kind === 'cmd') {
    // Quoted so &, >, | belong to the new window's shell, not the launcher's.
    await startDetached(`start "${title}" /D "${p.path}" ${shell} /k "${r.command}"`);
  } else {
    const full = path.join(p.path, r.id.slice(5));
    const dir = path.dirname(full);
    if (!fs.existsSync(full)) throw httpError(404, `File is gone: ${full}`);
    if (r.kind === 'exe') await startDetached(`start "${title}" /D "${dir}" "${full}"`);
    else if (r.kind === 'ps1') await startDetached(`start "${title}" /D "${dir}" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${full}"`);
    else await startDetached(`start "${title}" /D "${dir}" ${shell} /k "${full}"`);
  }
  if (runnableId && runnableId !== p.runnable) updateProject(id, { runnable: runnableId });
  logActivity('run', `Ran ${r.label}`, { project: p.name });
  return { ok: true, label: r.label };
}

// `p` is a project or the "All projects" workspace ({ name, path }).
export async function openProject(p, target, sessionId) {
  if (!fs.existsSync(p.path)) throw httpError(404, `Folder is missing: ${p.path}`);
  if (target === 'folder') {
    await launch(TOOLS.explorer, [p.path]);
  } else if (target === 'vscode') {
    if (TOOLS.code) await launch(TOOLS.code, [p.path]);
    else await startDetached(`code "${p.path}"`);
    logActivity('open', `Opened ${p.name} in VS Code`, { project: p.name });
  } else if (target === 'terminal') {
    if (!TOOLS.claude) throw httpError(500, 'claude.exe not found');
    if (sessionId && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw httpError(400, 'Bad session id');
    const extra = sessionId ? ` --resume ${sessionId}` : '';
    await startDetached(`start "${cmdSafe('Claude - ' + p.name)}" /D "${p.path}" "${TOOLS.cmd}" /k ""${TOOLS.claude}"${extra}"`);
    logActivity('terminal', sessionId ? `Resumed Claude session in terminal` : `Opened Claude Code terminal`, { project: p.name, sessionId });
  } else {
    throw httpError(400, 'Unknown open target');
  }
  return { ok: true };
}

export function browse(dir) {
  dir = path.resolve(dir || AGENT_ROOT);
  if (!fs.existsSync(dir)) throw httpError(404, `Not found: ${dir}`);
  const registered = load().projects;
  const dirs = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$')) continue;
    const full = path.join(dir, e.name);
    if (isSkippableDir(e.name, full)) continue;
    const has = (f) => fs.existsSync(path.join(full, f));
    dirs.push({
      name: e.name,
      path: full,
      looksLikeProject: ['.git', '.vscode', '.claude', 'package.json', 'requirements.txt', 'pyproject.toml', 'README.md', 'run.bat'].some(has),
      registered: registered.some((p) => samePath(p.path, full)),
    });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : null, dirs };
}

function requireProject(id) {
  const p = getProject(id);
  if (!p) throw httpError(404, 'Project not found');
  return p;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
