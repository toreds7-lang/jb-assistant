import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, TOOLS, childEnv, isSkippableDir } from './config.mjs';
import { killTree, lineReader, toolSummary } from './claude.mjs';
import { notify } from './notify.mjs';
import { httpError, listProjects } from './projects.mjs';
import { getSettings, logActivity, readJson, writeJson } from './store.mjs';

const DAY = 24 * 3600 * 1000;
const job = { running: false, runId: null, progress: [], startedAt: null, proc: null, auto: false };
let lastAutoAttempt = 0;

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on the overall picture for this developer this week.' },
    items: {
      type: 'array',
      minItems: 10,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          rank: { type: 'integer' },
          title: { type: 'string' },
          url: { type: 'string' },
          kind: { type: 'string', enum: ['repo', 'paper', 'tool', 'model', 'skill', 'article', 'dataset', 'idea'] },
          why: { type: 'string', description: 'Why this matters to this developer specifically.' },
          action: { type: 'string', description: 'One concrete first step.' },
          projects: { type: 'array', items: { type: 'string' }, description: 'Names of the projects it helps (may be empty).' },
          keywords: { type: 'array', items: { type: 'string' }, description: 'Enrolled keywords it matches (may be empty).' },
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          score: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['rank', 'title', 'url', 'kind', 'why', 'action', 'projects', 'effort', 'score'],
      },
    },
  },
  required: ['summary', 'items'],
};

function loadState() {
  return readJson('recommendations.json', { runs: [], feedback: {} });
}

function saveState(s) {
  s.runs = s.runs.slice(0, 30);
  writeJson('recommendations.json', s);
}

function readHead(file, n) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').slice(0, n);
  } catch {
    return '';
  }
}

function languageMix(root) {
  const counts = {};
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 5 || seen > 5000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !isSkippableDir(e.name, full) && e.name !== 'dist') walk(full, depth + 1);
      } else {
        const ext = path.extname(e.name).toLowerCase();
        if (['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.html', '.css', '.go', '.rs', '.java', '.kt', '.cs', '.cpp', '.ipynb', '.md'].includes(ext)) counts[ext] = (counts[ext] || 0) + 1;
      }
    }
  };
  walk(root, 0);
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`).join(' ');
}

// A compact, local "review" of each project so Claude doesn't have to spend
// turns reading files: purpose, stack, dependencies and recent work.
export function projectProfile(p) {
  const r = (f, n) => readHead(path.join(p.path, f), n);
  const readme = r('README.md', 1500) || r('readme.md', 1500) || r('CLAUDE.md', 1200);
  let deps = '';
  try {
    const pkg = JSON.parse(r('package.json', 20000));
    deps = 'npm: ' + Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 40).join(', ');
  } catch { /* none */ }
  const req = r('requirements.txt', 2000);
  if (req) deps += (deps ? '\n' : '') + 'pip: ' + req.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).slice(0, 40).join(', ');
  const top = fs.readdirSync(p.path).filter((n) => !n.startsWith('.') && n !== 'node_modules').slice(0, 50).join(', ');
  return [
    `### ${p.name}  (${p.path})`,
    `Languages: ${languageMix(p.path) || 'unknown'}`,
    deps && `Dependencies:\n${deps}`,
    `Top-level: ${top}`,
    readme && `README/CLAUDE.md excerpt:\n${readme.trim()}`,
  ].filter(Boolean).join('\n');
}

async function githubCandidates(keywords) {
  const since = new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10);
  const queries = [
    ...keywords.slice(0, 6).map((k) => `${k} pushed:>${since}`),
    `topic:llm created:>${since}`,
    `topic:ai-agents created:>${since}`,
  ];
  const headers = { 'User-Agent': 'Todoro-personal-assistant', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const seen = new Map();
  for (const q of queries) {
    try {
      const res = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      for (const r of (await res.json()).items || []) {
        if (!seen.has(r.html_url)) {
          seen.set(r.html_url, `- ${r.full_name} ★${r.stargazers_count} (pushed ${r.pushed_at?.slice(0, 10)}, ${r.language || 'n/a'}) ${r.html_url} — ${(r.description || '').slice(0, 160)}${r.topics?.length ? ' [' + r.topics.slice(0, 5).join(', ') + ']' : ''}`);
        }
      }
    } catch { /* offline or rate-limited: Claude still searches itself */ }
  }
  return [...seen.values()].slice(0, 50);
}

function buildPrompt({ profiles, keywords, candidates, avoid }) {
  return `You are Todoro, a personal research scout for one developer. Today is ${new Date().toISOString().slice(0, 10)}.

Goal: recommend the 10 best things this developer should look at right now — AI GitHub repositories, papers, tools, models, Claude Code skills/plugins/MCP servers, articles — that would concretely improve or inspire their current projects, or match the topics they follow.

## Their projects (local review)
${profiles.join('\n\n')}

## Topics they follow (enrolled keywords)
${keywords.map((k) => `- ${k}`).join('\n') || '- (none)'}

## GitHub candidates (live from the GitHub API; stars and dates are real)
${candidates.join('\n') || '- (GitHub API unavailable this run)'}

## Do not repeat these (already recommended or dismissed)
${avoid.map((u) => `- ${u}`).join('\n') || '- (nothing yet)'}

## How to work
1. Read the project profiles and note what each project does, its stack, and what it is missing.
2. Run several WebSearch queries covering both the projects and the enrolled keywords. Prefer items from the last 90 days. Use WebFetch only when you must confirm something.
3. Only return URLs that appeared in search results or in the candidate list. Never invent URLs.
4. Pick exactly 10, ranked by expected usefulness to THIS developer. Mix kinds. At least 4 must tie to a named project. No generic listicles, no duplicates.
5. "why" must name the specific project or keyword it helps and how. "action" must be a concrete first step (e.g. "try X's reranker in paper_read_project_pdf/hybrid_retrieval.py").
Return everything through the structured output.`;
}

export function recommendStatus() {
  const s = loadState();
  return {
    running: job.running,
    auto: job.auto,
    startedAt: job.startedAt,
    progress: job.progress.slice(-30),
    latest: s.runs.find((r) => r.status === 'ok') || null,
    lastRun: s.runs[0] ? { ...s.runs[0], items: undefined } : null,
    history: s.runs.map((r) => ({ id: r.id, startedAt: r.startedAt, status: r.status, count: r.items?.length || 0, model: r.model })),
    feedback: s.feedback,
    settings: getSettings(),
  };
}

export function getRun(id) {
  const r = loadState().runs.find((x) => x.id === id);
  if (!r) throw httpError(404, 'Run not found');
  return r;
}

export function setFeedback(url, state) {
  const s = loadState();
  if (!state || state === 'none') delete s.feedback[url];
  else s.feedback[url] = state;
  saveState(s);
  return s.feedback;
}

export async function runRecommendations({ model, effort, auto = false } = {}) {
  if (job.running) throw httpError(409, 'A recommendation run is already in progress.');
  if (!TOOLS.claude) throw httpError(500, 'claude.exe not found');
  const settings = getSettings();
  model ||= settings.recModel;
  effort ||= settings.recEffort;

  Object.assign(job, { running: true, auto, runId: crypto.randomUUID().slice(0, 8), startedAt: new Date().toISOString(), progress: [], proc: null });
  const note = (t) => job.progress.push({ ts: new Date().toISOString(), text: t });
  const record = { id: job.runId, startedAt: job.startedAt, model, effort, keywords: settings.keywords, auto, status: 'running', items: [], summary: '' };

  try {
    note('Reviewing your projects locally…');
    const projects = listProjects().filter((p) => p.exists);
    const profiles = projects.map(projectProfile);
    note(`Profiled ${projects.length} projects. Asking GitHub for fresh AI repos…`);
    const candidates = await githubCandidates(settings.keywords);
    note(`Got ${candidates.length} GitHub candidates. Claude is searching the web…`);

    const state = loadState();
    const avoid = new Set(Object.entries(state.feedback).filter(([, v]) => v === 'dismissed' || v === 'done').map(([u]) => u));
    for (const r of state.runs.slice(0, 3)) for (const i of r.items || []) avoid.add(i.url);

    const prompt = buildPrompt({ profiles, keywords: settings.keywords, candidates, avoid: [...avoid].slice(0, 60) });
    const result = await runClaude(prompt, model, effort, note);
    const out = result.structured_output || tryParse(result.result);
    if (!out?.items?.length) throw new Error(result.is_error ? result.result || 'Claude returned an error' : 'Claude returned no items');
    record.items = out.items.sort((a, b) => a.rank - b.rank).slice(0, 10);
    record.summary = out.summary || '';
    record.cost = result.total_cost_usd;
    record.status = 'ok';
    note(`Done: ${record.items.length} recommendations.`);
    logActivity('recommend', `Top 10 refreshed (${record.items.length} picks${record.cost ? ` · $${record.cost.toFixed(2)}` : ''})`, { status: 'ok' });
    notify('Top 10 refreshed', `#1 ${record.items[0].title}. ${record.summary}`);
  } catch (err) {
    record.status = 'error';
    record.error = err.message;
    note('Failed: ' + err.message);
    logActivity('recommend', `Top 10 run failed: ${err.message.slice(0, 120)}`, { status: 'error' });
    notify('Top 10 run failed', err.message, 'error');
  } finally {
    record.finishedAt = new Date().toISOString();
    record.progress = job.progress.slice(-40);
    const s = loadState();
    s.runs.unshift(record);
    saveState(s);
    job.running = false;
    job.proc = null;
  }
  return record;
}

function tryParse(text) {
  try {
    return JSON.parse(String(text).replace(/^```(json)?|```$/g, '').trim());
  } catch {
    return null;
  }
}

function runClaude(prompt, model, effort, note) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config',
      '--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch', 'WebFetch', '--permission-mode', 'dontAsk',
      '--json-schema', JSON.stringify(SCHEMA)];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    const proc = spawn(TOOLS.claude, args, { cwd: APP_DIR, env: childEnv(), windowsHide: true });
    job.proc = proc;
    let result = null;
    const stderr = [];
    const timer = setTimeout(() => {
      note('Timed out after 20 minutes — stopping.');
      killTree(proc);
    }, 20 * 60 * 1000);
    proc.stdin.on('error', () => {});
    proc.stdin.end(prompt);
    lineReader(proc.stdout, (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use' && b.name !== 'StructuredOutput') note(`${b.name}: ${toolSummary(b.name, b.input)}`);
        }
      }
      if (ev.type === 'result') result = ev;
    });
    lineReader(proc.stderr, (l) => stderr.push(l));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(new Error(stderr.slice(-3).join(' ') || `claude exited with code ${code}`));
    });
  });
}

export function stopRecommendations() {
  if (job.proc) killTree(job.proc);
  return { ok: true };
}

// Auto daily: once the last successful run is older than 24h. A failed
// attempt waits 6h before retrying so it never hammers the plan.
export function maybeAutoRun() {
  const settings = getSettings();
  if (!settings.autoDaily || job.running) return;
  if (Date.now() - lastAutoAttempt < 6 * 3600 * 1000) return;
  const lastOk = loadState().runs.find((r) => r.status === 'ok');
  if (lastOk && Date.now() - Date.parse(lastOk.startedAt) < DAY) return;
  lastAutoAttempt = Date.now();
  runRecommendations({ auto: true }).catch(() => {});
}
