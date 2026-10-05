import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AGENT_ROOT, APP_DIR, PORT, PUBLIC_DIR, TOOLS } from './lib/config.mjs';
import { listSessions, sessionTranscript, startChat, stopChat, subscribe, usage } from './lib/claude.mjs';
import { harnessInfo } from './lib/harness.mjs';
import { notificationsAfter, setPresence } from './lib/notify.mjs';
import { addProject, browse, getProject, httpError, listProjects, openProject, removeProject, runProject, updateProject } from './lib/projects.mjs';
import { getRun, maybeAutoRun, recommendStatus, runRecommendations, setFeedback, stopRecommendations } from './lib/recommend.mjs';
import { listSkills } from './lib/skills.mjs';
import { getSettings, logActivity, saveSettings } from './lib/store.mjs';
import { buildTimeline, invalidateTimeline } from './lib/timeline.mjs';

const HOME_PROJECT = { id: 'home', name: 'All projects', path: AGENT_ROOT };

function workspace(id) {
  if (!id || id === 'home') return HOME_PROJECT;
  const p = getProject(id);
  if (!p) throw httpError(404, 'Project not found');
  return p;
}

const routes = [];
// `quiet` writes change nothing the timeline shows, so they keep its cache.
const route = (method, pattern, handler, { quiet = false } = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, quiet });

route('GET', '/api/state', () => ({
  projects: listProjects(),
  settings: getSettings(),
  agentRoot: AGENT_ROOT,
  claude: { path: TOOLS.claude, version: usage.version, rateLimit: usage.rateLimit },
  tools: { vscode: !!TOOLS.code, git: !!TOOLS.git },
}));

route('POST', '/api/projects', ({ body }) => addProject(body.path, body.name));
route('PATCH', '/api/projects/:id', ({ params, body }) => updateProject(params.id, body));
route('DELETE', '/api/projects/:id', ({ params }) => (removeProject(params.id), { ok: true }));
route('POST', '/api/projects/:id/run', ({ params, body }) => runProject(params.id, body.runnable));
route('POST', '/api/projects/:id/open', ({ params, body }) => openProject(workspace(params.id), body.target, body.sessionId));
route('GET', '/api/browse', ({ query }) => browse(query.get('path')));

route('GET', '/api/skills', ({ query }) => listSkills(query.get('projectId') && query.get('projectId') !== 'home' ? workspace(query.get('projectId')).path : null));

route('POST', '/api/chat', ({ body }) => {
  const ws = workspace(body.projectId);
  if (!fs.existsSync(ws.path)) throw httpError(404, `Folder is missing: ${ws.path}`);
  return startChat({ ...body, cwd: ws.path, projectName: ws.name });
});
route('GET', '/api/runs/:id/events', ({ params, query, req, res }) => subscribe(params.id, req, res, query.get('from')));
route('POST', '/api/runs/:id/stop', ({ params }) => stopChat(params.id));

route('GET', '/api/sessions', ({ query }) => listSessions(workspace(query.get('projectId')).path));
route('GET', '/api/sessions/:projectId/:sessionId', ({ params }) => sessionTranscript(workspace(params.projectId).path, params.sessionId));

route('GET', '/api/timeline', ({ query }) => buildTimeline(query.get('days')));
route('GET', '/api/harness', ({ query }) => harnessInfo(workspace(query.get('projectId'))));

route('GET', '/api/recommend', () => recommendStatus());
route('GET', '/api/recommend/runs/:id', ({ params }) => getRun(params.id));
route('POST', '/api/recommend/run', ({ body }) => {
  runRecommendations({ model: body.model, effort: body.effort }).catch(() => {});
  return { ok: true };
});
route('POST', '/api/recommend/stop', () => stopRecommendations());
route('POST', '/api/recommend/feedback', ({ body }) => setFeedback(String(body.url || ''), body.state));

route('PUT', '/api/settings', ({ body }) => {
  const allowed = ['keywords', 'autoDaily', 'recModel', 'recEffort', 'chatModel', 'chatEffort', 'permissionMode', 'notify'];
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
  if (patch.keywords) patch.keywords = [...new Set(patch.keywords.map((k) => String(k).trim()).filter(Boolean))].slice(0, 30);
  return saveSettings(patch);
});

// Used by the tray icon (tray.ps1).
route('GET', '/api/notifications', ({ query }) => notificationsAfter(query.get('after'), query.get('boot')));
route('POST', '/api/presence', ({ body }) => setPresence(!!body.focused), { quiet: true });
route('POST', '/api/window', () => (openWindow(), { ok: true }), { quiet: true });

route('POST', '/api/quit', ({ res }) => {
  sendJson(res, 200, { ok: true });
  setTimeout(() => process.exit(0), 200);
});

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) reject(httpError(413, 'Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(pathname, res) {
  let file;
  if (pathname === '/') file = path.join(PUBLIC_DIR, 'index.html');
  else if (pathname === '/totoro.jpg') file = path.join(APP_DIR, 'totoro.jpg');
  else file = path.join(PUBLIC_DIR, path.normalize(decodeURIComponent(pathname)).replace(/^([\\/]|\.\.)+/, ''));
  if (!file.startsWith(PUBLIC_DIR) && file !== path.join(APP_DIR, 'totoro.jpg')) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this machine, and require a custom
    // header on writes so no web page can drive Todoro cross-site.
    const host = (req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
      res.writeHead(403);
      return res.end('Forbidden host');
    }
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    if (req.method !== 'GET' && req.headers['x-todoro'] !== '1') throw httpError(403, 'Missing x-todoro header');

    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler({ req, res, params, query: url.searchParams, body });
      if (req.method !== 'GET' && !r.quiet) invalidateTimeline();
      if (out !== undefined && !res.headersSent) sendJson(res, 200, out);
      return;
    }
    throw httpError(404, 'No such endpoint');
  } catch (err) {
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    if (!err.status) console.error(err);
  }
});

const APP_URL = `http://127.0.0.1:${PORT}`;

// Edge "app mode" gives Todoro its own window without bundling Electron.
function openWindow() {
  if (TOOLS.edge && process.env.TODORO_BROWSER !== 'default') {
    spawn(TOOLS.edge, [`--app=${APP_URL}`, '--window-size=1560,980'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } else {
    spawn(TOOLS.cmd, ['/c', 'start', '', APP_URL], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Todoro is already running at ${APP_URL}`);
    if (process.argv.includes('--open')) openWindow();
    setTimeout(() => process.exit(0), 500);
  } else {
    throw err;
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Todoro running at ${APP_URL}  (close this window or use the Quit button to stop)`);
  logActivity('app', 'Todoro started');
  if (process.argv.includes('--open')) openWindow();
  setTimeout(maybeAutoRun, 30 * 1000);
  setInterval(maybeAutoRun, 30 * 60 * 1000);
});
