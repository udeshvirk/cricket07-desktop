// Manual driver for local testing: runs the app on a given userData folder and takes commands from a file.
// Run: UD=<scratch userData copy> OUT=<folder> npx electron test/drive.js
// Commands (one per line, appended to $OUT/cmd): key <KeyCode> [mod,...] | shot <name> | js <code> | exit
// | shotsettings <name> | jssettings <code> (in the Settings window)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.resolve(process.env.OUT || 'drive-out');
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => fs.appendFileSync(path.join(OUT, 'log.txt'), `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(' ')}\n`);
if (!process.env.UD) throw new Error('UD (a scratch userData folder) is required');

const pkg = require('../package.json');
app.setName(pkg.productName);
app.getVersion = () => pkg.version;
app.setPath('userData', path.resolve(process.env.UD));
const realExit = app.exit.bind(app);
app.exit = (code) => { log('APP.EXIT called', code); setTimeout(() => realExit(code), 500); };
require('../main.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.on('browser-window-created', (_e, win) => {
  if (win.getParentWindow()) return;
  win.webContents.on('console-message', (e) => fs.appendFileSync(path.join(OUT, 'console.txt'),
    `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${e.level} ${e.message}\n`));
  win.webContents.on('render-process-gone', (_e, d) => log('RENDERER GONE', d.reason));
  const cmdFile = path.join(OUT, 'cmd');
  fs.writeFileSync(cmdFile, '');
  let done = 0;
  (async () => {
    for (;;) {
      await sleep(300);
      const lines = fs.readFileSync(cmdFile, 'utf8').split('\n').filter(Boolean);
      while (done < lines.length) {
        const [cmd, ...rest] = lines[done++].split(' ');
        try {
          if (cmd === 'key') {
            const [keyCode, mods] = rest;
            const modifiers = mods ? mods.split(',') : [];
            win.webContents.focus();
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
            await sleep(120);
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
            await sleep(400);
          } else if (cmd === 'shot') {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.join(OUT, `${rest[0]}.png`), img.resize({ width: 960 }).toPNG());
          } else if (cmd === 'js') {
            log('js', JSON.stringify(await win.webContents.executeJavaScript(rest.join(' '))));
          } else if (cmd === 'shotsettings') {
            const sw = BrowserWindow.getAllWindows().find((w) => w.getParentWindow());
            if (sw) fs.writeFileSync(path.join(OUT, `${rest[0]}.png`), (await sw.webContents.capturePage()).toPNG());
          } else if (cmd === 'jssettings') {
            const sw = BrowserWindow.getAllWindows().find((w) => w.getParentWindow());
            if (sw) log('jssettings', JSON.stringify(await sw.webContents.executeJavaScript(rest.join(' '))));
          } else if (cmd === 'crash') win.webContents.forcefullyCrashRenderer();
          else if (cmd === 'exit') realExit(0);
          log('done', lines[done - 1]);
        } catch (err) { log('cmd failed', lines[done - 1], err.message); }
      }
    }
  })();
});
