import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, isSkippableDir } from './config.mjs';
import { listSessions } from './claude.mjs';
import { listProjects } from './projects.mjs';
import { readActivity } from './store.mjs';

const HOUR = 3600 * 1000;
const cache = new Map();

function gitLog(dir, sinceMs) {
  return new Promise((resolve) => {
    if (!TOOLS.git || !fs.existsSync(path.join(dir, '.git'))) return resolve([]);
    const args = ['-c', 'core.quotepath=off', '-c', 'i18n.logOutputEncoding=utf-8', '-C', dir, 'log', '--all', `--since=${new Date(sinceMs).toISOString()}`, '-n', '80', '--date=iso-strict', '--pretty=format:%h%x1f%aI%x1f%an%x1f%s'];
    execFile(TOOLS.git, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split('\n').filter(Boolean).map((l) => {
        const [hash, ts, author, subject] = l.split('\x1f');
        return { hash, ts, author, subject };
      }));
    });
  });
}

// Recently modified files, skipping dependency/build folders. Bounded so a huge
// project can't stall the timeline.
function recentFiles(root, sinceMs) {
  const out = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || visited > 20000) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !isSkippableDir(e.name, full) && e.name !== 'dist') walk(full, depth + 1);
      } else if (e.isFile() && !/\.(pyc|log|tmp|lock)$/i.test(e.name)) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m >= sinceMs) out.push({ rel: path.relative(root, full), mtimeMs: m });
        } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out;
}

export async function buildTimeline(days = 7) {
  days = Math.min(Math.max(Number(days) || 7, 1), 90);
  const key = String(days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20000) return hit.value;

  const since = Date.now() - days * 24 * HOUR;
  const projects = listProjects().filter((p) => p.exists);
  const events = [];

  for (const a of readActivity(since)) {
    events.push({ ts: a.ts, source: 'app', project: a.project || null, title: a.title, detail: a.kind, ref: a.sessionId ? { sessionId: a.sessionId } : null, status: a.status });
  }

  await Promise.all(projects.map(async (p) => {
    for (const s of listSessions(p.path)) {
      if (Date.parse(s.endTs) < since) continue;
      events.push({
        ts: s.endTs,
        source: 'claude',
        project: p.name,
        projectId: p.id,
        title: s.title || s.firstPrompt || 'Claude session',
        detail: `${s.prompts} prompt${s.prompts === 1 ? '' : 's'}`,
        startTs: s.startTs,
        ref: { sessionId: s.id },
      });
    }

    for (const c of await gitLog(p.path, since)) {
      events.push({ ts: c.ts, source: 'git', project: p.name, projectId: p.id, title: c.subject, detail: `${c.hash} · ${c.author}` });
    }

    // One event per project per hour of edits, so a big save doesn't flood the list.
    const buckets = new Map();
    for (const f of recentFiles(p.path, since)) {
      const b = Math.floor(f.mtimeMs / HOUR);
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(f);
    }
    for (const files of buckets.values()) {
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      events.push({
        ts: new Date(files[0].mtimeMs).toISOString(),
        source: 'files',
        project: p.name,
        projectId: p.id,
        title: `${files.length} file${files.length === 1 ? '' : 's'} changed`,
        detail: files.slice(0, 6).map((f) => f.rel).join(', ') + (files.length > 6 ? ` +${files.length - 6} more` : ''),
      });
    }
  }));

  events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  const value = { days, generatedAt: new Date().toISOString(), events: events.slice(0, 600) };
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function invalidateTimeline() {
  cache.clear();
}
