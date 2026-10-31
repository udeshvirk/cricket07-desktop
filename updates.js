// Update checks: this app (new releases on GitHub) and the game engine (Dhaiwat's port on cricket07.dhaiwat.com).
//
// The app only checks; downloading a new version is done from the release page. The engine can be updated in
// place: the new files go into a separate folder, are checked against the site's fingerprints, and replace the
// kept engine only when every file arrived. Game files that changed with it download when the game next starts.
const { app, net } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REPO = 'udeshvirk/cricket07-desktop';
const DAY = 24 * 60 * 60 * 1000;

const STATE = () => path.join(app.getPath('userData'), 'updates.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } };
const writeState = (s) => fs.writeFileSync(STATE(), JSON.stringify(s, null, 2));

// "1.10.0" > "1.9.2"
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}

async function checkApp() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${app.getName()}/${app.getVersion()}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const r = await res.json();
  const version = String(r.tag_name || '').replace(/^v/, '');
  return { version, url: r.html_url, available: newer(version, app.getVersion()) };
}

const md5 = (file) => { try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
// Cloudflare (the site's host) inserts an analytics tag into the page, different on each download, so the
// page is compared without it (and without the port's own analytics snippet)
const normalizePage = (text) => text
  .replace(/<script[^>]*static\.cloudflareinsights\.com[^>]*><\/script>\s*/g, '')
  .replace(/<!-- Cloudflare Web Analytics[\s\S]*?<\/script>\s*/g, '')
  .replace(/(<span id="visits">)[^<]*/g, '$1');   // the page's visit counter (Oct 2026) changes all the time
const tagOf = (res) => (res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');

// Files to compare: the scripts and engine, plus the list of game files (images rarely matter)
const ENGINE_COMPARE = ['index.html', 'c07.js', 'netplay.js', 'audio-worklet.js', 'build/cricket07.js', 'build/cricket07.wasm'];

// engine: { remote, dir, manifest } (the site, the kept engine folder, the kept game-file list)
async function checkEngine(engine) {
  if (!fs.existsSync(path.join(engine.dir, 'index.html'))) return { available: false };   // nothing kept yet
  const changed = [];
  for (const rel of [...ENGINE_COMPARE, 'game/manifest.json']) {
    const local = rel === 'game/manifest.json' ? engine.manifest : path.join(engine.dir, ...rel.split('/'));
    if (!fs.existsSync(local)) continue;
    if (rel === 'index.html') {
      const res = await net.fetch(engine.remote + rel, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
      if (normalizePage(await res.text()) !== normalizePage(fs.readFileSync(local, 'utf8'))) changed.push(rel);
      continue;
    }
    const res = await net.fetch(engine.remote + rel, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    const tag = tagOf(res);
    // a fingerprint we can compare (MD5 of the file); without one, fall back to the size
    const same = /^[0-9a-f]{32}$/.test(tag) ? tag === md5(local)
      : String(fs.statSync(local).size) === (res.headers.get('content-length') || '');
    if (!same) changed.push(rel);
  }
  return { available: changed.length > 0, changed };
}

// Runs both checks (unless offline) and remembers the result. Returns the saved state.
async function check(engine) {
  const s = readState();
  const out = { ...s, checkedAt: Date.now(), checkedWith: app.getVersion(), error: null };
  try { out.app = await checkApp(); } catch (err) { out.error = String(err.message || err); }
  try { out.engine = await checkEngine(engine); } catch (err) { out.error = out.error || String(err.message || err); }
  writeState(out);
  return out;
}

// once a day, and straight away after the app itself was updated (an older version's results may be stale)
const due = () => { const s = readState(); return Date.now() - (s.checkedAt || 0) > DAY || s.checkedWith !== app.getVersion(); };

// Which updates haven't been mentioned yet (so the in-game notice shows once per new version)
function unannounced() {
  const s = readState(), notes = [];
  if (s.app?.available && s.announcedApp !== s.app.version) notes.push('app');
  if (s.engine?.available && !s.announcedEngine) notes.push('engine');
  return notes;
}
function markAnnounced() {
  const s = readState();
  if (s.app?.available) s.announcedApp = s.app.version;
  if (s.engine?.available) s.announcedEngine = true;
  writeState(s);
}

// Downloads every engine file into a new folder, checks each against the site's fingerprint, then swaps it in.
async function updateEngine(engine, files, onProgress = () => {}) {
  const tmp = engine.dir + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  const trustedHost = new URL(engine.remote).hostname;
  const list = [...files, 'game/manifest.json'];
  let n = 0;
  for (const rel of list) {
    onProgress(`Downloading ${rel} (${++n} of ${list.length})`);
    const res = await net.fetch(engine.remote + rel, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    // A redirect to a different host/scheme would let whoever controls it supply both the file and its
    // fingerprint; only accept the response if it still came from the pinned, secure origin.
    const resUrl = new URL(res.url);
    if (resUrl.protocol !== 'https:' || resUrl.hostname !== trustedHost)
      throw new Error(`${rel}: download came from an unexpected origin`);
    const body = Buffer.from(await res.arrayBuffer());
    const tag = tagOf(res);
    if (/^[0-9a-f]{32}$/.test(tag) && crypto.createHash('md5').update(body).digest('hex') !== tag)
      throw new Error(`${rel} didn't download completely. Try again.`);
    const dest = rel === 'game/manifest.json' ? path.join(tmp, '.manifest.json') : path.join(tmp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  // swap: the previous engine is kept next to it (engine.previous) in case it is ever needed
  const prev = engine.dir + '.previous';
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(engine.dir)) fs.renameSync(engine.dir, prev);
  else fs.mkdirSync(prev, { recursive: true });
  if (fs.existsSync(engine.manifest)) fs.copyFileSync(engine.manifest, path.join(prev, '.manifest.json'));
  try {
    // on Windows a rename can fail while another program (an antivirus scan) has a file open
    fs.renameSync(tmp, engine.dir);
    fs.renameSync(path.join(engine.dir, '.manifest.json'), engine.manifest);
  } catch (err) {
    // put the previous engine and its game-file list back, so the game still matches what was kept
    fs.rmSync(engine.dir, { recursive: true, force: true });
    if (fs.existsSync(path.join(prev, 'index.html'))) fs.renameSync(prev, engine.dir);
    const oldManifest = path.join(engine.dir, '.manifest.json');
    if (fs.existsSync(oldManifest)) fs.renameSync(oldManifest, engine.manifest);
    throw new Error("the new files couldn't be put in place. Close other programs and try again.");
  }
  const s = readState();
  s.engine = { available: false, changed: [] };
  s.announcedEngine = false;
  s.engineUpdatedAt = Date.now();
  writeState(s);
}

module.exports = { normalizePage, check, due, readState, unannounced, markAnnounced, updateEngine, newer };
