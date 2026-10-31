// Real player names, and current squads (2026, see squads.js). Cricket 07 shows made-up names for unlicensed players (S.Tendehar for Tendulkar).
// Its data also holds a real-name copy of the player list; real-names.json maps each fake-named record
// to its real name (matched by comparing the two copies' stats). This code runs in the page, before the
// game starts, and edits the app's own copy of Data/data.gob.
//
// The new player list is appended to the archive and its index entry pointed at it, so the original list
// stays in the file and switching back to the original only restores the index entry.
const fs = require('fs');
const path = require('path');

const NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'real-names.json'), 'utf8'));
const SQUADS = JSON.parse(fs.readFileSync(path.join(__dirname, 'squads-2026.json'), 'utf8'));
const { applySquads, legendsPatch, tintFsh, FAST_BOWLERS, fastBowlersPatch } = require('./squads');
const md5 = (t) => require('crypto').createHash('md5').update(t).digest('hex');
// Legends kits: each Legends side's slot kit files (archive names are the MD5 of the path without its extension)
// get the country's kit, recoloured (tint) or as it is
const KIT_FILES = ['kit1', 'kit2', 'kit3', 'accessories'].flatMap((k) => ['coloured', 'white', 'sweater'].map((v) => v + k)).concat('helm');
const KITS = SQUADS.legends.teams.flatMap((t) => KIT_FILES.map((k) => ({ entry: md5(`teams/${t.kit.slot}/${k}`) + '.fsh',
  from: md5(`teams/${t.kit.from}/${k}`) + '.fsh', tint: t.kit.tint && (k.startsWith('coloured') || k === 'helm') ? t.kit.tint : null })));
// Fingerprint of the squad data and code: a game patched with older squads is rebuilt when it changes
const SQ_VER = require('crypto').createHash('md5').update(JSON.stringify(SQUADS) + applySquads.toString() + legendsPatch.toString() + tintFsh.toString() + fastBowlersPatch.toString()).digest('hex').slice(0, 8);

const PAGE_JS = `async (NAMES, SQUADS, LIB, KITS, want) => {
  const { applySquads, legendsPatch, tintFsh, FAST_BOWLERS, fastBowlersPatch } = LIB;
  const ENTRY = '113964e05e69ab31d264fb8f15c58e5c.cdf', REC = 360, MARK = '.names-original.json';
  // team list, kits, menu screens, kit textures (Legends); the fast-bowler list (current squads)
  const EXTRA = legendsPatch('entries').concat(KITS.map((k) => k.entry), FAST_BOWLERS);
  const root = await navigator.storage.getDirectory();
  let dir, fh;
  try { dir = await root.getDirectoryHandle('c07game'); fh = await (await dir.getDirectoryHandle('Data')).getFileHandle('data.gob'); }
  catch { return 'no-game'; }
  const file = await fh.getFile();
  const bytes = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  const head = new DataView((await bytes(0, 16)).buffer);
  if (head.getUint32(0) !== 0x42494746) return 'unknown';   // "BIGF"
  const count = head.getUint32(8), idx = await bytes(16, 16 + head.getUint32(12));
  const iv = new DataView(idx.buffer);
  const where = {};
  for (let p = 0, k = 0; k < count; k++) {
    const o = iv.getUint32(p), s = iv.getUint32(p + 4); let e = p + 8;
    while (idx[e]) e++;
    where[new TextDecoder('latin1').decode(idx.subarray(p + 8, e))] = { pos: 16 + p, off: o, size: s };   // all entries: the marker may name ones an older version changed
    p = e + 1;
  }
  if (!where[ENTRY]) return 'unknown';
  const { pos, off, size } = where[ENTRY];

  // RefPack (EA's compression)
  const unpack = (s) => {
    const f = s[0]; let p = 2, n;
    if (f & 0x80) { n = (s[p] << 24 | s[p + 1] << 16 | s[p + 2] << 8 | s[p + 3]) >>> 0; p += 4; } else { n = s[p] << 16 | s[p + 1] << 8 | s[p + 2]; p += 3; }
    if (f & 1) p += f & 0x80 ? 4 : 3;
    const o = new Uint8Array(n); let q = 0;
    const lit = (k) => { o.set(s.subarray(p, p + k), q); p += k; q += k; };
    while (p < s.length) {
      const c = s[p]; let len, dist;
      if (c < 0x80) { const c1 = s[p + 1]; p += 2; lit(c & 3); len = ((c & 0x1c) >> 2) + 3; dist = ((c & 0x60) << 3) + c1 + 1; }
      else if (c < 0xc0) { const c1 = s[p + 1], c2 = s[p + 2]; p += 3; lit(c1 >> 6); len = (c & 0x3f) + 4; dist = ((c1 & 0x3f) << 8) + c2 + 1; }
      else if (c < 0xe0) { const c1 = s[p + 1], c2 = s[p + 2], c3 = s[p + 3]; p += 4; lit(c & 3); len = ((c & 0x0c) << 6) + c3 + 5; dist = ((c & 0x10) << 12) + (c1 << 8) + c2 + 1; }
      else if (c < 0xfc) { p += 1; lit(((c & 0x1f) << 2) + 4); continue; }
      else { p += 1; lit(c & 3); break; }
      for (let i = 0; i < len; i++, q++) o[q] = o[q - dist];
    }
    return o;
  };
  // a valid RefPack stream made of literal blocks only (bigger, but simple)
  const pack = (d) => {
    const n = d.length, o = new Uint8Array(5 + n + Math.ceil(n / 112) + 1); let q = 0, p = 0;
    o.set([0x10, 0xfb, n >> 16 & 255, n >> 8 & 255, n & 255]); q = 5;
    while (n - p >= 4) { const k = Math.min(112, ((n - p) >> 2) << 2); o[q++] = 0xe0 + ((k - 4) >> 2); o.set(d.subarray(p, p + k), q); q += k; p += k; }
    o[q++] = 0xfc + (n - p); o.set(d.subarray(p), q); q += n - p;
    return o.subarray(0, q);
  };

  const raw = await bytes(off, off + size);
  const cdf = raw[1] === 0xfb ? unpack(raw) : raw;
  const dec = new TextDecoder('latin1');
  const nameAt = (c, i) => { const b = c.subarray(i * REC + 8, i * REC + 24); const z = b.indexOf(0); return dec.decode(z < 0 ? b : b.subarray(0, z)); };
  const key = (a) => a.pending ? 'partial' : [a.names && 'names', a.squads && (a.squads === true ? 'squads' : 'squads@' + a.squads),
    a.legends && 'legends'].filter(Boolean).join('+') || 'original';

  // What is applied now: the marker says (written with each change); an older app version's marker didn't
  // record it, so then the names themselves tell.
  let m = null;
  try { m = JSON.parse(await (await (await dir.getFileHandle(MARK)).getFile()).text()); } catch {}
  let state;
  if (m && m.off === off) state = 'original';
  else if (m && m.applied) state = key(m.applied);
  else if (NAMES.every(([i, , r]) => nameAt(cdf, i) === r)) state = 'names';
  else if (NAMES.every(([i, f]) => nameAt(cdf, i) === f)) state = 'original';
  else state = 'unknown';
  if (want === 'status' || state === 'unknown') return state;
  const target = want === 'original' ? 'original' : key(want);
  if (state === target) return state;

  const setEntry = async (w, at, o, s) => {
    const b = new DataView(new ArrayBuffer(8)); b.setUint32(0, o); b.setUint32(4, s);
    await w.write({ type: 'write', position: at, data: b.buffer });
  };
  const saveMark = async () => { const mw = await (await dir.getFileHandle(MARK, { create: true })).createWritable(); await mw.write(JSON.stringify(m)); await mw.close(); };
  if (target === 'original') {
    if (!m) return 'no-original';
    const w = await fh.createWritable({ keepExistingData: true });
    await setEntry(w, pos, m.off, m.size);
    for (const [n, [o, s]] of Object.entries(m.extra || {})) if (where[n]) await setEntry(w, where[n].pos, o, s);
    // also drop the appended list and restore the archive's length, so the file is byte for byte the
    // original again (the port's launcher checks file sizes when its game-file list changes)
    if (m.fileSize && m.fileSize < file.size && m.off + m.size <= m.fileSize) {
      const t = new DataView(new ArrayBuffer(4)); t.setUint32(0, m.fileSize, true);
      await w.write({ type: 'write', position: 4, data: t.buffer });
      await w.truncate(m.fileSize);
    }
    await w.close();
    return 'original';
  }
  // Always build from the original list. The marker remembers it and the archive's original length; the new
  // list always goes right after that length, replacing any list written before, so the file doesn't grow.
  if (!m || !m.fileSize) {
    if (state !== 'original') return 'no-original';   // first time: the current list is the original
    m = { off, size, fileSize: file.size };
  }
  // the other entries' originals, recorded before they are first changed
  m.extra = m.extra || {};
  for (const n of EXTRA) if (where[n] && !(n in m.extra)) {
    if (where[n].off + where[n].size > m.fileSize) return 'unknown';
    m.extra[n] = [where[n].off, where[n].size];
  }
  const original = async (o, s) => { const r = await bytes(o, o + s); return r[1] === 0xfb ? unpack(r) : r; };
  let base = cdf;
  if (state !== 'original') base = await original(m.off, m.size);
  const out = new Uint8Array(base);
  if (want.names) for (const [i, , r] of NAMES) {
    const b = new Uint8Array(16);
    for (let k = 0; k < r.length; k++) b[k] = r.charCodeAt(k);
    out.set(b, i * REC + 8);
  }
  if (want.squads) applySquads(base, out, SQUADS, !!want.legends);
  // everything is built before the archive is touched, so an error leaves it as it was
  const files = [[pos, pack(out)]], resets = [];
  for (const n of Object.keys(m.extra)) {
    if (!where[n]) continue;
    const kit = want.legends && KITS.find((k) => k.entry === n), src = kit && where[kit.from];
    if (src) {   // a Legends kit texture: the country's, recoloured (appended) or pointed at as it is
      if (kit.tint) files.push([where[n].pos, pack(tintFsh(await original(src.off, src.size), kit.tint))]);
      else resets.push([where[n].pos, src.off, src.size]);
      continue;
    }
    const changed = n === FAST_BOWLERS ? want.squads && fastBowlersPatch(await original(...m.extra[n]), out, SQUADS)
      : want.legends && legendsPatch(n, await original(...m.extra[n]), SQUADS);
    if (changed) files.push([where[n].pos, pack(changed)]);
    else resets.push([where[n].pos, ...m.extra[n]]);
  }
  m.applied = { pending: true };   // until the archive is written
  await saveMark();
  const align = (x) => x + ((16 - x % 16) % 16);
  const w = await fh.createWritable({ keepExistingData: true });
  let end = align(m.fileSize), last = end;
  await w.truncate(end);
  for (const [at, data] of files) {
    await w.write({ type: 'write', position: end, data });
    await setEntry(w, at, end, data.length);
    last = end + data.length; end = align(last);
  }
  for (const [at, o, s] of resets) await setEntry(w, at, o, s);
  const t = new DataView(new ArrayBuffer(4)); t.setUint32(0, last, true);   // the archive's length
  await w.write({ type: 'write', position: 4, data: t.buffer });
  await w.close();
  m.applied = { names: !!want.names, squads: want.squads || false, legends: !!want.legends };
  await saveMark();
  return target;
}`;

// want: 'status' | 'original' | { names, squads, legends }. Returns the state afterwards: 'original', 'names',
// 'squads@<version>', 'names+squads@<version>+legends' and so on, 'unknown' or 'no-game' (compare with stateFor).
// Legends teams need the current squads.
function names(win, want) {
  if (typeof want === 'object') want = { names: !!want.names, squads: want.squads ? SQ_VER : false, legends: !!(want.squads && want.legends) };
  const lib = `({ applySquads: ${applySquads.toString()}, legendsPatch: ${legendsPatch.toString()}, tintFsh: ${tintFsh.toString()},
    FAST_BOWLERS: ${JSON.stringify(FAST_BOWLERS)}, fastBowlersPatch: ${fastBowlersPatch.toString()} })`;
  return win.webContents.executeJavaScript(
    `(${PAGE_JS})(${JSON.stringify(NAMES)}, ${JSON.stringify(SQUADS)}, ${lib}, ${JSON.stringify(KITS)}, ${JSON.stringify(want)})`);
}
const stateFor = (want) => [want.names && 'names', want.squads && 'squads@' + SQ_VER, want.squads && want.legends && 'legends']
  .filter(Boolean).join('+') || 'original';

module.exports = { names, stateFor, COUNT: NAMES.length };
