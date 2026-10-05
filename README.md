# Todoro

A personal AI assistant that uses your installed **Claude Code** (`claude.exe`) as its harness.
It is a local web app: a small Node server with no npm dependencies, plus a bright single-page UI opened in an Edge app window.

## Start

Open **Todoro** from the Start menu, or double-click **`Todoro.bat`**. Todoro lives in the system tray (the Totoro icon by the clock): the server runs with no console window and the app window opens at http://127.0.0.1:7878.
Closing the window leaves Todoro running in the tray. Launching it again just brings the window forward. Use **Quit** (top right, or in the tray menu) to stop it.

**Tray icon:** click to open Todoro. Right-click for **Open folder**, **Notifications** (on/off), **Start with Windows** (on/off), **Restart server** and **Quit Todoro**.
When a Claude reply or the Top 10 finishes while the Todoro window is not in front, a Windows notification pops up. Click it to open Todoro.
If the server crashes, the tray shows "Todoro stopped". Click it to start the server again.

**Shortcuts:** `powershell -ExecutionPolicy Bypass -File tray.ps1 -Install` adds a Start menu entry (pin it to the taskbar from there) and starts Todoro in the tray when you log in. Run it again if you move the folder. `-Uninstall` removes both shortcuts.

## What's where

| Area | What it does |
|---|---|
| **Projects** (left) | Your project list. Pick a `.bat` / `.exe` / `.ps1` / `npm` script (or add a custom command) and press **Run**. Open the folder, open it in VS Code, or open an interactive Claude Code terminal there. **Browse** or **+ Add** adds projects, **✕** removes one from the list (files are never touched). Double-click a name to rename it. |
| **Skills** (left) | Every skill Claude Code can see: global (`~/.claude/skills`), project (`.claude/skills`), plugin, and Anthropic-synced. **Use** puts `/skill` into the composer. |
| **Assistant** | Each message runs `claude -p` in the selected project folder, so tools, skills, CLAUDE.md and memory all apply. You pick the model, effort and permission mode. Follow-ups resume the same session. **Open in terminal** continues the session interactively. |
| **Top 10** | Reviews your projects locally, pulls fresh AI repos from the GitHub API, then has Claude web-search against your keywords and pick the 10 best things for you. Runs once a day automatically (while Todoro is running) or on **Refresh now**. Save / Done / Not-for-me feed into the next run. |
| **Harness** | Claude Code version, settings, plan usage, sessions per project (continue in the app or a terminal), hooks, MCP servers, plugins, agents, CLAUDE.md files. |
| **Timeline** (right) | One chronological stream of Todoro activity, Claude Code sessions, git commits and file changes. Click a Claude session to reopen it. |

## Files

- `server.mjs`: HTTP server and routes (binds to 127.0.0.1 only). `node server.mjs --open` still runs it in a console without the tray.
- `tray.ps1`: tray icon host (built-in Windows PowerShell + WinForms, no extra dependencies). It starts the server, polls `/api/notifications` and owns the shortcuts. `totoro.ico` is generated from `totoro.jpg`.
- `lib/`: projects, skills, Claude runner and sessions, timeline, harness view, Top 10 engine, tray notifications
- `public/`: UI (`index.html`, `app.css`, `app.js`)
- `data/`: your state (`projects.json`, `settings.json`, `recommendations.json`, `activity.jsonl`), plus `server.log` (console output of the last tray-started server) and `tray.log` (tray errors, if any)

## Options

- `TODORO_PORT`: port (default 7878)
- `TODORO_BROWSER=default`: use your default browser instead of an Edge app window
- `GITHUB_TOKEN`: raises the GitHub search rate limit for Top 10
- `CLAUDE_PATH`: path to `claude.exe` if it is not in `%USERPROFILE%\.local\bin`
