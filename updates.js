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
// A saved "new version available" is compared with the running version again: after the app is updated, the
// last check (made by the older version) would otherwise offer the version that is now running, or an older one.
const readState = () => {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; }
  if (s.app?.version) s.app.available = newer(s.app.version, app.getVersion());
  return s;
};
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
const md5Of = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// The game file's name, as c07.js loads it: build/cricket07.wasm, or build/cricket07.<hash>.wasm (engines from Nov 2026)
const wasmName = (c07) => (String(c07).match(/build\/cricket07(?:\.[0-9a-f]{6,64})?\.wasm/) || ['build/cricket07.wasm'])[0];

// Files compared by content (all small; the page without its changing parts). The host's ETags were the files'
// MD5 until Nov 2026; now most aren't, so they can't tell whether a file changed.
const ENGINE_COMPARE = ['index.html', 'c07.js', 'netplay.js', 'audio-worklet.js', 'build/cricket07.js', 'game/manifest.json'];

async function fetchOk(url, opts) {
  const res = await net.fetch(url, { cache: 'no-store', ...opts });
  if (!res.ok) throw new Error(`${url.split('/').slice(3).join('/')}: HTTP ${res.status}`);
  return res;
}

// engine: { remote, dir, manifest } (the site, the kept engine folder, the kept game-file list)
async function checkEngine(engine) {
  if (!fs.existsSync(path.join(engine.dir, 'index.html'))) return { available: false };   // nothing kept yet
  const changed = [];
  let remoteC07 = null;
  for (const rel of ENGINE_COMPARE) {
    const local = rel === 'game/manifest.json' ? engine.manifest : path.join(engine.dir, ...rel.split('/'));
    if (!fs.existsSync(local)) continue;
    const body = Buffer.from(await (await fetchOk(engine.remote + rel)).arrayBuffer());
    if (rel === 'c07.js') remoteC07 = body;
    const same = rel === 'index.html'
      ? normalizePage(body.toString('utf8')) === normalizePage(fs.readFileSync(local, 'utf8'))
      : md5Of(body) === md5(local);
    if (!same) changed.push(rel);
  }
  // the game file (30 MB) isn't downloaded to compare: its name, then the host's fingerprint or its size
  const c07 = path.join(engine.dir, 'c07.js');
  if (remoteC07 && fs.existsSync(c07)) {
    const name = wasmName(remoteC07), local = path.join(engine.dir, ...wasmName(fs.readFileSync(c07)).split('/'));
    if (fs.existsSync(local)) {
      const res = await fetchOk(engine.remote + name, { method: 'HEAD' });
      const tag = tagOf(res), len = res.headers.get('content-length');
      const same = tag === md5(local) || (len ? Number(len) === fs.statSync(local).size : !/^[0-9a-f]{32}$/.test(tag));
      if (!same) changed.push(name);
    }
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

// Is a download whole? The host's ETag, when it is the file's MD5 (the game file's still is), or its size when
// sent uncompressed. A cut-off transfer also fails in the network layer itself.
function whole(res, body, rel) {
  if (rel.endsWith('.wasm') && body.readUInt32LE(0) !== 0x6d736100) return false;   // "\0asm"
  const tag = tagOf(res);
  if (/^[0-9a-f]{32}$/.test(tag) && md5Of(body) === tag) return true;
  const len = res.headers.get('content-length');
  if (len && !res.headers.get('content-encoding')) return Number(len) === body.length;
  return body.length > 0;
}

// Downloads every engine file (files: the list from main.js; the game file's name comes from the new c07.js)
// into a new folder, checks each, then swaps it in. Files missing from the site (an older engine) are optional
// only for download-worker.js.
const OPTIONAL = new Set(['download-worker.js']);
async function updateEngine(engine, files, onProgress = () => {}) {
  const tmp = engine.dir + '.new';
  fs.rmSync(tmp, { recursive: true, force: true });
  const c07 = await fetchOk(engine.remote + 'c07.js');
  const c07Body = Buffer.from(await c07.arrayBuffer());
  if (!whole(c07, c07Body, 'c07.js')) throw new Error("c07.js didn't download completely. Try again.");
  const list = [...new Set(['c07.js', ...files, wasmName(c07Body), 'game/manifest.json'])];
  let n = 0;
  for (const rel of list) {
    onProgress(`Downloading ${rel} (${++n} of ${list.length})`);
    let body;
    if (rel === 'c07.js') body = c07Body;
    else {
      const res = await net.fetch(engine.remote + rel, { cache: 'no-store' });
      if (res.status === 404 && OPTIONAL.has(rel)) continue;
      if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
      body = Buffer.from(await res.arrayBuffer());
      if (!whole(res, body, rel)) throw new Error(`${rel} didn't download completely. Try again.`);
    }
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
