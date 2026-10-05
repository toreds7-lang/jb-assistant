import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(APP_DIR, 'data');
export const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PORT = Number(process.env.TODORO_PORT) || 7878;
export const AGENT_ROOT = process.env.TODORO_AGENT_ROOT || 'D:\\2026_Agent';

const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

function firstExisting(candidates) {
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

function onPath(names) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const n of names) {
      const p = path.join(dir, n);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return null;
}

const SYSROOT = process.env.SystemRoot || 'C:\\Windows';

export const TOOLS = {
  // Absolute system paths: PATH can be stripped (e.g. by a settings.json env.PATH).
  cmd: process.env.ComSpec || path.join(SYSROOT, 'System32', 'cmd.exe'),
  explorer: path.join(SYSROOT, 'explorer.exe'),
  taskkill: path.join(SYSROOT, 'System32', 'taskkill.exe'),
  claude: firstExisting([process.env.CLAUDE_PATH, path.join(HOME, '.local', 'bin', 'claude.exe')]) || onPath(['claude.exe', 'claude.cmd']),
  git: onPath(['git.exe']) || firstExisting([path.join(PF, 'Git', 'cmd', 'git.exe')]),
  code: firstExisting([path.join(LOCAL, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(PF, 'Microsoft VS Code', 'Code.exe')]),
  edge: firstExisting([path.join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
  wt: onPath(['wt.exe']) || firstExisting([path.join(LOCAL, 'Microsoft', 'WindowsApps', 'wt.exe')]),
};

// Environment for child processes. Strips variables that would make a spawned
// claude.exe think it is nested inside another Claude Code session, or make
// Code.exe run as plain Node when Todoro was started from a VS Code terminal.
export function childEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  return env;
}

// Directories never worth walking when scanning a project.
export const SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', '.git', '__pycache__', 'site-packages', '.output', '.wxt', '.next',
  '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.idea', '.vs', 'build', 'tiktoken_cache',
  '.understanding', '.gradle', 'Pods', 'target', 'coverage', '.turbo', '.parcel-cache',
]);

export function isSkippableDir(name, fullPath) {
  if (SKIP_DIRS.has(name)) return true;
  // Any Python virtualenv, whatever it is called.
  return fs.existsSync(path.join(fullPath, 'pyvenv.cfg'));
}

export function samePath(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
