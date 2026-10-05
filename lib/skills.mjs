import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR } from './config.mjs';

// Minimal YAML front-matter reader: `key: value` plus `key: |` / `key: >` blocks.
export function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (/^[|>][-+]?$/.test(val)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      val = block.join(val.startsWith('|') ? '\n' : ' ').trim();
    } else {
      val = val.replace(/^(["'])(.*)\1$/, '$2');
    }
    out[key] = val;
  }
  return out;
}

function readSkill(file, invokePrefix, scope, fallbackName) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    const name = fm.name || fallbackName;
    if (fm['user-invocable'] === 'false') return null;
    return {
      name,
      invoke: invokePrefix ? `${invokePrefix}:${name}` : name,
      scope,
      description: (fm.description || '').replace(/\s+/g, ' ').trim(),
      argumentHint: fm['argument-hint'] || '',
      path: file,
    };
  } catch {
    return null;
  }
}

function skillsIn(dir, prefix, scope) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'synced') continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(file)) {
      const s = readSkill(file, prefix, scope, e.name);
      if (s) out.push(s);
    }
  }
  return out;
}

function commandsIn(dir, prefix, scope) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.md')) {
      const s = readSkill(path.join(dir, e.name), prefix, scope, e.name.slice(0, -3));
      if (s) out.push(s);
    }
  }
  return out;
}

function enabledPlugins() {
  let enabled = {};
  try {
    enabled = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8')).enabledPlugins || {};
  } catch { /* no settings */ }
  let installed = {};
  try {
    installed = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
  } catch { /* no plugins */ }
  return Object.entries(installed).map(([key, installs]) => {
    const latest = installs[installs.length - 1] || {};
    return { key, name: key.split('@')[0], marketplace: key.split('@')[1] || '', enabled: enabled[key] === true, version: latest.version, installPath: latest.installPath, scope: latest.scope };
  });
}

export { enabledPlugins as listPlugins };

export function listSkills(projectPath) {
  const skills = [...skillsIn(path.join(CLAUDE_DIR, 'skills'), '', 'global'), ...commandsIn(path.join(CLAUDE_DIR, 'commands'), '', 'global')];

  const syncedRoot = path.join(CLAUDE_DIR, 'skills', 'synced');
  try {
    for (const bucket of fs.readdirSync(syncedRoot, { withFileTypes: true })) {
      if (bucket.isDirectory()) skills.push(...skillsIn(path.join(syncedRoot, bucket.name), 'anthropic-skills', 'synced'));
    }
  } catch { /* no synced skills */ }

  for (const p of enabledPlugins()) {
    if (!p.enabled || !p.installPath) continue;
    skills.push(...skillsIn(path.join(p.installPath, 'skills'), p.name, 'plugin'), ...commandsIn(path.join(p.installPath, 'commands'), p.name, 'plugin'));
  }

  if (projectPath) {
    skills.push(...skillsIn(path.join(projectPath, '.claude', 'skills'), '', 'project'), ...commandsIn(path.join(projectPath, '.claude', 'commands'), '', 'project'));
  }

  const order = { project: 0, global: 1, plugin: 2, synced: 3 };
  return skills.sort((a, b) => order[a.scope] - order[b.scope] || a.name.localeCompare(b.name));
}
