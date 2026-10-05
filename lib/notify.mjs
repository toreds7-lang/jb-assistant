import crypto from 'node:crypto';
import { getSettings } from './store.mjs';

// Notifications for the tray icon: tray.ps1 polls /api/notifications and shows
// them as Windows toasts. Nothing is queued while the Todoro window is focused,
// since you are already looking at the result.

const BOOT = crypto.randomUUID().slice(0, 8);
const items = [];
let seq = 0;
let focusedUntil = 0;

// The page re-reports focus every minute, so a window that vanished without a
// blur event stops suppressing notifications after 90 seconds.
export function setPresence(focused) {
  focusedUntil = focused ? Date.now() + 90 * 1000 : 0;
  return { ok: true };
}

export function notify(title, text, level = 'info') {
  if (Date.now() < focusedUntil || getSettings().notify === false) return;
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  items.push({ seq: ++seq, ts: new Date().toISOString(), title: clean(title, 60), text: clean(text, 200) || ' ', level });
  if (items.length > 20) items.shift();
}

// `boot` identifies this server process; a tray that last saw another one
// (the server restarted) gets everything queued since this one started.
export function notificationsAfter(after, boot) {
  const from = boot === BOOT ? Number(after) || 0 : 0;
  return { boot: BOOT, seq, enabled: getSettings().notify !== false, items: items.filter((i) => i.seq > from) };
}
