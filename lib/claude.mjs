import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { CLAUDE_DIR, TOOLS, childEnv } from './config.mjs';
import { notify } from './notify.mjs';
import { httpError } from './projects.mjs';
import { logActivity } from './store.mjs';

const runs = new Map();
export const usage = { rateLimit: null, version: null };

if (TOOLS.claude) {
  execFile(TOOLS.claude, ['--version'], { env: childEnv(), windowsHide: true, timeout: 20000 }, (err, out) => {
    if (!err) usage.version = String(out).trim();
  });
}

export function lineReader(stream, onLine) {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += decoder.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => {
    buf += decoder.end();
    if (buf.trim()) onLine(buf);
  });
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s || '');

export function toolSummary(name, input = {}) {
  const pick = input.command || input.file_path || input.notebook_path || input.pattern || input.query || input.url || input.skill || input.description || input.prompt;
  const s = typeof pick === 'string' ? pick : Object.values(input).find((v) => typeof v === 'string') || '';
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return '';
}

// Stream-json events from `claude -p` are reduced to the compact shapes the UI renders.
function compact(ev) {
  switch (ev.type) {
    case 'stream_event': {
      const e = ev.event || {};
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && !ev.parent_tool_use_id) return { type: 'delta', text: e.delta.text };
      return null;
    }
    case 'system':
      if (ev.subtype === 'init') return { type: 'init', session_id: ev.session_id, model: ev.model, cwd: ev.cwd, permissionMode: ev.permissionMode };
      if (ev.subtype === 'compact_boundary') return { type: 'note', text: 'Context was compacted' };
      if (ev.subtype === 'api_retry') return { type: 'note', text: `API retry (attempt ${ev.attempt ?? '?'})` };
      return null;
    case 'assistant': {
      const content = [];
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, summary: toolSummary(b.name, b.input), input: clip(JSON.stringify(b.input, null, 2), 4000) });
      }
      return content.length ? { type: 'assistant', parent: ev.parent_tool_use_id || null, content } : null;
    }
    case 'user': {
      const results = (Array.isArray(ev.message?.content) ? ev.message.content : []).filter((b) => b.type === 'tool_result');
      if (!results.length) return null;
      return { type: 'tool_results', items: results.map((r) => ({ tool_use_id: r.tool_use_id, is_error: !!r.is_error, text: clip(toolResultText(r.content), 4000) })) };
    }
    case 'result':
      return { type: 'result', subtype: ev.subtype, is_error: !!ev.is_error, result: ev.result || '', duration_ms: ev.duration_ms, num_turns: ev.num_turns, total_cost_usd: ev.total_cost_usd, session_id: ev.session_id, permission_denials: (ev.permission_denials || []).map((d) => d.tool_name) };
    case 'rate_limit_event':
      usage.rateLimit = { ...ev.rate_limit_info, at: Date.now() };
      return { type: 'rate', info: ev.rate_limit_info };
    default:
      return null;
  }
}

function push(run, ev) {
  if (!ev) return;
  run.events.push(ev);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.clients) res.write(data);
}

function finish(run, code) {
  if (run.done) return;
  run.done = true;
  push(run, { type: 'exit', code });
  for (const res of run.clients) res.end();
  run.clients.clear();
  const r = run.result;
  const failed = !!(r?.is_error || code);
  const cost = r?.total_cost_usd != null ? ` · $${r.total_cost_usd.toFixed(3)}` : '';
  logActivity('chat', `${run.skill ? '/' + run.skill + ' ' : ''}${run.prompt.slice(0, 80)}${cost}`, {
    project: run.projectName,
    sessionId: run.sessionId,
    status: failed ? 'error' : 'ok',
  });
  notify(`${failed ? 'Claude run failed' : 'Claude finished'} · ${run.projectName}`, r?.result || run.prompt, failed ? 'error' : 'info');
  setTimeout(() => runs.delete(run.id), 60 * 60 * 1000);
}

export function startChat({ cwd, prompt, skill, model, effort, permissionMode, sessionId, projectName }) {
  if (!TOOLS.claude) throw httpError(500, 'claude.exe was not found. Install Claude Code first.');
  if (!prompt?.trim() && !skill) throw httpError(400, 'Type a message first.');
  if (sessionId && !/^[0-9a-f-]{36}$/i.test(sessionId)) throw httpError(400, 'Bad session id');

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (permissionMode) args.push('--permission-mode', permissionMode, '--permission-prompts', 'none');
  if (sessionId) args.push('--resume', sessionId);

  const text = skill ? `/${skill} ${prompt || ''}`.trim() : prompt;
  const run = { id: crypto.randomUUID(), events: [], clients: new Set(), done: false, sessionId, prompt: (prompt || '').trim(), skill, projectName, result: null };
  const proc = spawn(TOOLS.claude, args, { cwd, env: childEnv(), windowsHide: true });
  run.proc = proc;
  runs.set(run.id, run);

  proc.stdin.on('error', () => {});
  proc.stdin.end(text);
  lineReader(proc.stdout, (line) => {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      push(run, { type: 'stderr', text: line });
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'init') run.sessionId = ev.session_id;
    if (ev.type === 'result') run.result = ev;
    push(run, compact(ev));
  });
  lineReader(proc.stderr, (line) => push(run, { type: 'stderr', text: line }));
  proc.on('error', (err) => {
    push(run, { type: 'stderr', text: err.message });
    finish(run, -1);
  });
  proc.on('close', (code) => finish(run, code));
  return { runId: run.id };
}

// `from` lets a reconnecting client skip events it already rendered.
export function subscribe(runId, req, res, from = 0) {
  const run = runs.get(runId);
  if (!run) throw httpError(404, 'Run not found (it may have expired)');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const ev of run.events.slice(Math.max(0, Number(from) || 0))) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (run.done) return res.end();
  run.clients.add(res);
  req.on('close', () => run.clients.delete(res));
}

export function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  execFile(TOOLS.taskkill, ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

export function stopChat(runId) {
  const run = runs.get(runId);
  if (!run) throw httpError(404, 'Run not found');
  killTree(run.proc);
  push(run, { type: 'note', text: 'Stopped by you' });
  return { ok: true };
}

// ---------- Claude Code session files (~/.claude/projects/<encoded-cwd>/*.jsonl) ----------

const sessionCache = new Map();

export function sessionDirsFor(projectPath) {
  const enc = path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const root = path.join(CLAUDE_DIR, 'projects');
  try {
    return fs.readdirSync(root).filter((d) => d.toLowerCase() === enc).map((d) => path.join(root, d));
  } catch {
    return [];
  }
}

function promptText(msg) {
  const c = msg?.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b.type === 'tool_result') ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  text = text.trim();
  if (!text) return '';
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${cmd[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  if (text.startsWith('<')) return '';
  return text;
}

function parseSessionFile(file) {
  const st = fs.statSync(file);
  const cached = sessionCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.info;

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const info = { id: path.basename(file, '.jsonl'), file, title: '', firstPrompt: '', prompts: 0, startTs: null, endTs: new Date(st.mtimeMs).toISOString(), sizeKb: Math.round(st.size / 1024) };
  for (const line of lines) {
    if (!line) continue;
    const isUser = line.includes('"type":"user"');
    const isTitle = line.includes('"type":"ai-title"') || line.includes('"type":"custom-title"');
    if (!isUser && !isTitle && info.startTs) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!info.startTs && ev.timestamp) info.startTs = ev.timestamp;
    if (ev.type === 'ai-title' && ev.aiTitle && !info.customTitle) info.title = ev.aiTitle;
    if (ev.type === 'custom-title' && ev.customTitle) info.title = info.customTitle = ev.customTitle;
    if (ev.type === 'user' && !ev.isMeta && !ev.isSidechain) {
      const t = promptText(ev.message);
      if (t) {
        info.prompts++;
        if (!info.firstPrompt) info.firstPrompt = t.slice(0, 200);
      }
    }
  }
  delete info.customTitle;
  info.startTs ||= info.endTs;
  sessionCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
  return info;
}

export function listSessions(projectPath) {
  const out = [];
  for (const dir of sessionDirsFor(projectPath)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const info = parseSessionFile(path.join(dir, f));
        if (info.prompts > 0) out.push(info);
      } catch { /* unreadable file */ }
    }
  }
  return out.sort((a, b) => b.endTs.localeCompare(a.endTs)).map(({ file, ...rest }) => rest);
}

export function sessionTranscript(projectPath, sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw httpError(400, 'Bad session id');
  const file = sessionDirsFor(projectPath).map((d) => path.join(d, sessionId + '.jsonl')).find((f) => fs.existsSync(f));
  if (!file) throw httpError(404, 'Session file not found');
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.isSidechain || ev.isMeta) continue;
    if (ev.type === 'user') {
      const t = promptText(ev.message);
      if (t) messages.push({ role: 'user', text: t, ts: ev.timestamp });
    } else if (ev.type === 'assistant') {
      for (const b of ev.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) messages.push({ role: 'assistant', text: b.text, ts: ev.timestamp });
        else if (b.type === 'tool_use') messages.push({ role: 'tool', name: b.name, summary: toolSummary(b.name, b.input), ts: ev.timestamp });
      }
    }
  }
  return { sessionId, total: messages.length, messages: messages.slice(-250) };
}
