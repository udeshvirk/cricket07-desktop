// A log of each launch (log.txt in the app's data folder, the previous launch in log-previous.txt) for problem
// reports, and "safe graphics": if the game's picture never appears (a graphics driver that crashes or hangs leaves
// a white window), the app says so and restarts with safer graphics settings, one step at a time:
//   0 normal: graphics on even for drivers Chromium blocks (needed for WebGPU on many PCs)
//   1 Chromium's own driver blocklist is respected
//   2 the window is drawn without the graphics card (the game itself may still use it)
//   3 graphics card off: no game, but the window can say what's wrong
// A new graphics driver brings back normal graphics; so does "Try Normal Graphics" in Settings.
const { app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LEVEL = 3;
const dir = () => app.getPath('userData');
const LOG = () => path.join(dir(), 'log.txt');
const STATE = () => path.join(dir(), 'graphics.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } };
const writeState = (s) => { try { fs.writeFileSync(STATE(), JSON.stringify(s, null, 2)); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), sleep(ms).then(() => fallback)]);

// ---------------------------------------------------------------- log

let logSize = 0;
const LOG_MAX = 2e6;
function log(...parts) {
  if (logSize > LOG_MAX) return;
  const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
  logSize += line.length;
  try { fs.appendFileSync(LOG(), line); } catch {}
  if (logSize > LOG_MAX) try { fs.appendFileSync(LOG(), '(log full: nothing more is written this launch)\n'); } catch {}
}

// the page's messages: warnings and errors, with repeats collapsed (the engine can repeat one line thousands of times)
let lastConsole = '', repeats = 0, consoleLines = 0;
function logConsole(level, message) {
  if (message === lastConsole) { repeats++; return; }
  if (repeats) log(`page: (previous line repeated ${repeats} more times)`);
  lastConsole = message; repeats = 0;
  if (++consoleLines > 2000) return;
  log(`page ${level}:`, message.slice(0, 1000));
}

// ---------------------------------------------------------------- safe graphics

let state = {};
let level = 0;
let pictureOk = false;
let restarting = false;

// Before the app is ready: start the log and pick the graphics switches.
function init() {
  try { fs.mkdirSync(dir(), { recursive: true }); } catch {}
  try { fs.renameSync(LOG(), path.join(dir(), 'log-previous.txt')); } catch {}
  state = readState();
  // the last launch's graphics process crashed and the picture never appeared (Chromium can give up and quit)
  if (state.pending && state.pending.gpuCrashes > 0 && (state.level || 0) < MAX_LEVEL) {
    state.level = (state.level || 0) + 1;
    state.reason = `graphics crashed ${state.pending.gpuCrashes}× on the last launch`;
    state.notice = true;
  }
  level = state.level || 0;
  state.pending = { gpuCrashes: 0 };
  writeState(state);

  log(`${app.getName()} ${app.getVersion()} on ${process.platform} ${os.release()} ${process.arch}`,
    `| Electron ${process.versions.electron}, Chrome ${process.versions.chrome}`,
    `| ${os.cpus()[0]?.model || '?'} ×${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM`);
  log(`graphics level ${level}${level ? ` (safe graphics: ${state.reason || ''})` : ''}`);

  if (level === 0) app.commandLine.appendSwitch('ignore-gpu-blocklist');
  if (level >= 2) app.commandLine.appendSwitch('disable-gpu-compositing');
  if (level >= 3) app.commandLine.appendSwitch('disable-gpu');

  app.on('child-process-gone', (_e, d) => {
    log('process gone:', d.type, d.reason, `exit code ${d.exitCode}`, d.name || '');
    if (d.type !== 'GPU' || pictureOk || !state.pending || restarting) return;
    state.pending.gpuCrashes++;
    writeState(state);
    // Chromium gives up (and quits without a word) after a few more: restart with safer graphics first
    if (state.pending.gpuCrashes >= 3 && level < MAX_LEVEL) {
      log(`graphics crashed ${state.pending.gpuCrashes}×: restarting with safer graphics`);
      writeState({ ...state, level: level + 1, reason: `graphics crashed ${state.pending.gpuCrashes}× at startup`, notice: true, pending: null });
      restarting = true;
      app.relaunch(); app.exit(0);
    }
  });
  process.on('uncaughtException', (err) => log('app error:', err.stack || String(err)));
  for (const k of ['error', 'warn']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { log(`app ${k}:`, a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); orig(...a); };
  }
}

// once the app is ready: the graphics card, its driver and what Chromium makes of them
const driverOf = (info) => (info?.gpuDevice || []).filter((g) => g.active || info.gpuDevice.length === 1)
  .map((g) => `${g.vendorId}:${g.deviceId} ${g.driverVendor || ''} ${g.driverVersion || ''}`.trim()).join(', ') || null;
async function ready() {
  const info = await withTimeout(app.getGPUInfo('basic'), 8000, null);
  const driver = driverOf(info);
  log('graphics card:', driver || 'unknown', (info?.gpuDevice || []).map((g) => g.deviceString).filter(Boolean).join(', '));
  // a new driver may fix it: try normal graphics again
  if (level > 0 && driver && state.driver && driver !== state.driver) {
    log('graphics driver changed since safe graphics was switched on: trying normal graphics');
    writeState({ ...state, level: 0, driver, notice: false, reason: '' });
    app.relaunch(); app.exit(0);
    return false;
  }
  if (driver) state.driver = driver;
  writeState(state);
  return true;
}

// The page's files as the app hands them over (each logged once). The page is stuck if it got its files but
// never finished loading: that happens when the graphics process hangs.
let lastServed = 0, fetching = 0;
const servedOnce = new Set();
// wraps the app's work on one page file (a first launch downloads it, which can be slow)
async function serving(rel, work) {
  fetching++;
  try { return await work(); } finally {
    fetching--;
    lastServed = Date.now();
    if (!servedOnce.has(rel)) { servedOnce.add(rel); log('page file:', rel); }
  }
}

// Watches the game window until it shows its first frames: two animation frames that never come mean the picture
// isn't being drawn, and a page that got its files but never finished loading means the same.
function watch(win) {
  let started = false;
  const stuck = setInterval(() => {
    if (started || pictureOk || win.isDestroyed()) return clearInterval(stuck);
    if (lastServed && !fetching && Date.now() - lastServed > 30000 && win.isVisible() && !win.isMinimized()) {
      clearInterval(stuck);
      started = true;
      failed(win, 'the page got its files but never finished loading (30 s)');
    }
  }, 2000);
  const check = async () => {
    if (pictureOk || win.isDestroyed()) return;
    if (win.isMinimized() || !win.isVisible()) { setTimeout(check, 2000); return; }
    const r = await withTimeout(win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))'), 20000, 0);
    if (pictureOk || win.isDestroyed()) return;
    if (r === 1) {
      pictureOk = true;
      log('picture: ok');
      try { log('graphics features:', app.getGPUFeatureStatus()); } catch {}
      state.pending = null;
      writeState(state);
      if (state.notice) { state.notice = false; writeState(state); notice(win, false); }
      return;
    }
    if (win.isMinimized() || !win.isVisible()) { setTimeout(check, 2000); return; }
    failed(win, 'no frames 20 s after the page loaded');
  };
  win.webContents.on('dom-ready', () => { if (!started) { started = true; setTimeout(check, 1000); } });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('page failed to load:', code, desc, url));
  win.webContents.on('unresponsive', () => log('page not responding'));
  win.webContents.on('responsive', () => log('page responding again'));
  win.webContents.on('render-process-gone', (_e, d) => log('page process gone:', d.reason, `exit code ${d.exitCode}`));
  win.webContents.on('console-message', (e) => { if (e.level === 'warning' || e.level === 'error') logConsole(e.level, e.message || ''); });
}

async function failed(win, why) {
  log('PICTURE FAILED:', why, `(graphics level ${level})`);
  const next = Math.min(level + 1, MAX_LEVEL);
  state = { ...state, level: next, reason: why, notice: next !== level, pending: null };
  writeState(state);
  // the window shows nothing: get it out of the way so the message is seen
  try { win.setFullScreen(false); win.hide(); } catch {}
  if (next === level) return notice(win, true);
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'warning', title: 'Cricket 07', buttons: ['Restart', 'Show Log File', 'Quit'], defaultId: 0, cancelId: 2,
      message: "The game's picture didn't appear",
      detail: 'This is usually a graphics driver problem. The app will now restart with safer graphics settings.\n\n' +
        'If it keeps happening, update your graphics driver from Intel, AMD or NVIDIA\'s website.',
    });
    if (response === 1) { shell.showItemInFolder(LOG()); continue; }
    if (response === 0) app.relaunch();
    app.exit(0);
    return;
  }
}

// After a step down: say what happened. lastStep = the safest settings didn't help either.
async function notice(win, lastStep) {
  if (!lastStep) {
    // after the intro logos, like the app's other hints (the loading screen covers anything shown before)
    await sleep(12000);
    const text = level < MAX_LEVEL ? "Safe graphics is on (the picture didn't appear before)"
      : 'Safe graphics: the game runs without the graphics card, so it will be slow. Updating the graphics driver may fix this';
    if (!win.isDestroyed()) win.webContents.executeJavaScript(TOAST(`${text} · ${process.platform === 'darwin' ? '⌘,' : 'Ctrl+,'} for details`)).catch(() => {});
    return;
  }
  for (;;) {
    const { response } = await dialog.showMessageBox({
      type: 'error', title: 'Cricket 07', buttons: ['Show Log File', 'Report the Problem', 'Close'], defaultId: 0, cancelId: 2,
      message: "The game can't use this computer's graphics",
      detail: 'Update your graphics driver from Intel, AMD or NVIDIA\'s website (Windows Update often has an older one), then open the app again.\n\n' +
        'If that doesn\'t help, report the problem on GitHub and attach the log file (log.txt).',
    });
    if (response === 0) { shell.showItemInFolder(LOG()); continue; }
    if (response === 1) { shell.openExternal('https://github.com/udeshvirk/cricket07-desktop/issues/new/choose'); continue; }
    if (!win.isVisible()) app.exit(0);
    return;
  }
}

const TOAST = (text) => `(() => {
  const d = document.createElement('div');
  d.textContent = ${JSON.stringify(text)};
  d.style.cssText = 'position:fixed;left:50%;top:28px;transform:translateX(-50%);z-index:9;padding:9px 20px;border-radius:99px;' +
    'background:rgba(90,60,10,.92);color:#fff;font:14px -apple-system,system-ui,sans-serif;pointer-events:none;transition:opacity .6s';
  document.body.appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; }, 10000);
  setTimeout(() => d.remove(), 11000);
})()`;

// The engine's own "no WebGPU" text is written for web browsers; this one says what to do in the app.
const NO_GPU_TEXT = () => level > 0
  ? "This computer's graphics driver can't run the game. Update it from Intel, AMD or NVIDIA's website, then open the app again. " +
    `(Safe graphics is on: ${process.platform === 'darwin' ? '⌘,' : 'Ctrl+,'} for details.)`
  : "This computer's graphics driver can't run the game. Update it from Intel, AMD or NVIDIA's website, then open the app again.";

function tryNormal() {
  log('Try Normal Graphics chosen');
  writeState({ ...state, level: 0, notice: false, reason: '', pending: null });
  app.relaunch(); app.exit(0);
}

module.exports = {
  init, ready, watch, serving, log, tryNormal, NO_GPU_TEXT,
  logFile: LOG,
  showLog: () => shell.showItemInFolder(LOG()),
  level: () => level,
};
