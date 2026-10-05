import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_DIR, TOOLS, samePath } from './config.mjs';
import { listSessions, usage } from './claude.mjs';
import { listPlugins, parseFrontmatter } from './skills.mjs';

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function hooksFrom(settings, scope) {
  const out = [];
  for (const [event, groups] of Object.entries(settings?.hooks || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) out.push({ scope, event, matcher: g.matcher || '*', type: h.type, command: h.command || h.prompt || h.url || '' });
    }
  }
  return out;
}

function mcpFrom(servers, scope) {
  return Object.entries(servers || {}).map(([name, s]) => ({ scope, name, type: s.type || (s.url ? 'http' : 'stdio'), target: s.url || [s.command, ...(s.args || [])].filter(Boolean).join(' ') }));
}

function agentsIn(dir, scope) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { scope, name: fm.name || f.slice(0, -3), description: (fm.description || '').slice(0, 300), model: fm.model || '' };
    });
  } catch {
    return [];
  }
}

export function harnessInfo(project) {
  const userSettings = readJsonFile(path.join(CLAUDE_DIR, 'settings.json')) || {};
  const claudeJson = readJsonFile(path.join(os.homedir(), '.claude.json')) || {};
  const hooks = hooksFrom(userSettings, 'user');
  const mcp = mcpFrom(claudeJson.mcpServers, 'user');
  const agents = agentsIn(path.join(CLAUDE_DIR, 'agents'), 'user');
  let projectInfo = null;

  for (const p of listPlugins()) {
    if (!p.enabled || !p.installPath) continue;
    const pluginHooks = readJsonFile(path.join(p.installPath, 'hooks', 'hooks.json'));
    hooks.push(...hooksFrom(pluginHooks, `plugin:${p.name}`));
  }

  if (project) {
    const ps = readJsonFile(path.join(project.path, '.claude', 'settings.json'));
    const pl = readJsonFile(path.join(project.path, '.claude', 'settings.local.json'));
    hooks.push(...hooksFrom(ps, 'project'), ...hooksFrom(pl, 'local'));
    mcp.push(...mcpFrom(readJsonFile(path.join(project.path, '.mcp.json'))?.mcpServers, 'project'));
    const entry = Object.entries(claudeJson.projects || {}).find(([k]) => samePath(k, project.path));
    if (entry) mcp.push(...mcpFrom(entry[1].mcpServers, 'local'));
    agents.push(...agentsIn(path.join(project.path, '.claude', 'agents'), 'project'));
    const claudeMd = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].filter((f) => fs.existsSync(path.join(project.path, f)));
    projectInfo = {
      id: project.id,
      name: project.name,
      path: project.path,
      claudeMd,
      allow: [...(ps?.permissions?.allow || []), ...(pl?.permissions?.allow || [])].slice(0, 40),
      sessions: listSessions(project.path).slice(0, 40),
    };
  }

  // A settings.json `env.PATH` replaces the whole Windows PATH for Claude's own tools.
  const envPath = userSettings.env?.PATH || '';
  const pathWarning = envPath && !/nodejs|\\git\\|python/i.test(envPath)
    ? 'Your ~/.claude/settings.json sets env.PATH without Node, Git or Python folders, so Bash/PowerShell tools inside Claude sessions cannot find node, npm, git or python. Consider removing env.PATH or appending C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd.'
    : '';

  return {
    claude: { path: TOOLS.claude, version: usage.version, rateLimit: usage.rateLimit },
    settings: {
      model: userSettings.model || 'default',
      effortLevel: userSettings.effortLevel || 'default',
      theme: userSettings.theme || '',
      autoUpdatesChannel: userSettings.autoUpdatesChannel || '',
      envKeys: Object.keys(userSettings.env || {}),
      allowCount: userSettings.permissions?.allow?.length || 0,
      pathWarning,
    },
    userClaudeMd: fs.existsSync(path.join(CLAUDE_DIR, 'CLAUDE.md')),
    hooks,
    mcp,
    plugins: listPlugins().map(({ installPath, ...p }) => p),
    agents,
    project: projectInfo,
  };
}
