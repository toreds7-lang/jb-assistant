import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

fs.mkdirSync(DATA_DIR, { recursive: true });

const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.jsonl');

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8').replace(/^﻿/, ''));
  } catch {
    return structuredClone(fallback);
  }
}

export function writeJson(name, value) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export const DEFAULT_SETTINGS = {
  keywords: ['Claude Code skills', 'agentic RAG', 'GraphRAG', 'AI language learning', 'paper reading assistant', 'TTS voice'],
  autoDaily: true,
  recModel: 'sonnet',
  recEffort: 'high',
  chatModel: '',
  chatEffort: '',
  permissionMode: 'auto',
  notify: true,
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson('settings.json', next);
  return next;
}

// App-activity log shown on the timeline. One JSON object per line.
export function logActivity(kind, title, extra = {}) {
  const event = { ts: new Date().toISOString(), kind, title, ...extra };
  fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(event) + '\n');
  return event;
}

export function readActivity(sinceMs) {
  let text;
  try {
    text = fs.readFileSync(ACTIVITY_FILE, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Date.parse(e.ts) >= sinceMs) out.push(e);
    } catch { /* skip a torn line */ }
  }
  return out;
}
