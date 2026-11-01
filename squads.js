// Current squads (2026). Builds a new player table from the game's original one: each 2006 squad member's
// record becomes a 2026 player, and the team's squad list and captain are rewritten. Runs in the page (it is
// passed in as source text by names.js) and in Node for tests, so it uses no Node or browser APIs.
//
// Player table layout (same as the community Player Editor07's "PS2 roster"): 1200 records of 360 bytes from
// offset 4, then 67 team blocks of 2808 bytes from 432004. Abilities are 6-bit values packed into little-endian
// 32-bit words; the 0-100 numbers the game shows come from the UP table.
//
// A new player starts as a copy of the existing player whose style is closest (same role, bowling type and
// batting hand, similar level), so actions and shot habits fit. Then: name, commentary name, ratings, age,
// role, batting position, bowling type and batting hand are set; career stats are cleared; nationality and face stay with the
// record (licensed real faces are swapped for a generic one from the same country).
// With legends on, the 2006 squad players are left as they are (ten other teams become the Legends sides, copied
// from the 2006 squads) and the 2026 players take over the records of players found only in those ten teams.
function applySquads(orig, out, SQUADS, legends) {
  const REC = 360, BASE = 4, PLAYERS = 1200, TEAMS = 432004, TEAM = 2808;
  const UP = [0, 2, 4, 6, 7, 8, 10, 11, 12, 14, 16, 17, 19, 21, 23, 24, 25, 26, 28, 29, 31, 32, 34, 35, 37, 38, 40, 41, 43, 44, 46,
    47, 49, 50, 52, 54, 55, 57, 59, 60, 62, 64, 65, 67, 69, 70, 72, 74, 75, 77, 79, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 99, 100];
  const raw = (v) => { v = Math.max(20, Math.min(99, Math.round(v))); let b = 0; for (let i = 1; i < UP.length; i++) if (Math.abs(UP[i] - v) < Math.abs(UP[b] - v)) b = i; return b; };
  const u16 = (d, o) => d[o] | d[o + 1] << 8;
  const i16 = (d, o) => (u16(d, o) << 16) >> 16;
  const u32 = (d, o) => (d[o] | d[o + 1] << 8 | d[o + 2] << 16 | d[o + 3] << 24) >>> 0;
  const put16 = (d, o, v) => { d[o] = v & 255; d[o + 1] = v >> 8 & 255; };
  const put32 = (d, o, v) => { for (let k = 0; k < 4; k++) d[o + k] = v >>> (8 * k) & 255; };
  const six = (d, o, k) => Math.floor(u32(d, o) / 2 ** (6 * k)) % 64;
  const setSix = (d, o, k, v) => { const w = u32(d, o), m = 2 ** (6 * k); put32(d, o, w - six(d, o, k) * m + v * m); };
  const BAT = [[100, 0], [100, 1], [100, 2], [100, 3], [100, 4], [104, 0], [104, 1], [104, 2], [108, 1], [108, 3]];
  const BOWL = [[116, 1], [116, 2], [116, 3], [116, 4], [120, 0], [120, 1], [120, 2], [120, 3], [120, 4], [124, 0], [124, 1]];
  const TYPE = { BAT: 1, OB: 2, BWL: 3, SB: 4, ARS: 5, WK: 6, WKB: 7, OWK: 8, AR: 9, OBW: 10 };
  const BOWLT = { LS: 0, CH: 1, OS: 2, SLA: 3, LM: 4, RM: 5, LFM: 6, RFM: 7, LF: 8, RF: 9 };

  const at = (i) => BASE + i * REC;
  const byId = new Map();
  const info = [];
  for (let i = 0; i < PLAYERS; i++) {
    const s = at(i), id = i16(orig, s);
    if (!id || !orig[s + 4]) continue;
    if (!byId.has(id)) byId.set(id, i);
    info.push({ i, type: orig[s + 351] & 15, bowl: orig[s + 132] & 15, left: orig[s + 133] & 1,
      bat: UP[six(orig, s + 108, 1)], bowling: (UP[six(orig, s + 116, 1)] + UP[six(orig, s + 116, 2)]) / 2,
      nat: u32(orig, s + 216), face: u16(orig, s + 356) });
  }
  // generic faces used by a country's players, handed out in turn (so stand-ins don't all look the same)
  const faces = new Map();
  for (const p of info) if (p.face >= 40000) { const f = faces.get(p.nat) || []; if (!f.includes(p.face)) f.push(p.face); faces.set(p.nat, f); }
  let nextFace = 0;
  // Copy only from players in the 2006 international squads: their hidden values are tuned (a county keeper as
  // the model made new keepers open the batting)
  const intl = new Set();
  for (const t of SQUADS.teams) for (let k = 0; k < 20; k++) intl.add(byId.get(i16(orig, TEAMS + t.team * TEAM + 2 * k)));
  const pool = info.filter((p) => intl.has(p.i));
  const genericFace = (nat) => { const f = faces.get(nat) || [...faces.values()][0]; return f[nextFace++ % f.length]; };

  const squadOf = (t) => { const a = []; for (let k = 0; k < 20; k++) a.push(i16(orig, TEAMS + t * TEAM + 2 * k)); return a; };
  let donors = null;
  if (legends) {
    const L = SQUADS.legends, taken = new Set(L.teams.map((t) => t.block)), inTeams = new Map();
    for (let t = 0; t < 63; t++) for (const id of squadOf(t)) if (id > 0) inTeams.set(id, (inTeams.get(id) || new Set()).add(t));
    const national = new Set(SQUADS.teams.flatMap((t) => squadOf(t.team)));
    const free = (ok) => info.map((p) => i16(orig, at(p.i))).filter((id) => !national.has(id) && [...(inTeams.get(id) || [])].every(ok));
    donors = [...new Set([...free((t) => taken.has(t)), ...L.spare.flatMap((s) => free((t) => taken.has(t) || t === s))])];
    // the Legends teams: the 2006 squad, captain and shirt numbers, under the team's own id
    for (const t of L.teams) {
      const from = TEAMS + t.from * TEAM, to = TEAMS + t.block * TEAM, id = u16(orig, to + 40);
      out.set(orig.subarray(from, from + TEAM), to);
      put16(out, to + 40, id);
    }
  }

  for (const team of SQUADS.teams) {
    const b = TEAMS + team.team * TEAM;
    const old = squadOf(team.team);
    if (old.some((id) => !byId.has(id))) throw new Error(`team ${team.team}: unexpected squad`);
    // the country of the 2006 squad (most common nationality), for players moved into other records
    const nats = old.map((id) => u32(orig, at(byId.get(id)) + 216));
    const teamNat = nats.sort((x, y) => nats.filter((v) => v === y).length - nats.filter((v) => v === x).length)[0];
    const ids = [];
    team.players.forEach(([name, role, hand, bowlType, bat, bowl, dob, comm], k) => {
      const want = { type: TYPE[role], bowl: BOWLT[bowlType], left: hand === 'L' ? 1 : 0 };
      let best = null, score = -1e9;
      for (const p of pool) {
        const sc = (p.type === want.type) * 100 + (p.bowl === want.bowl) * 60 + (p.left === want.left) * 40
          - Math.abs(p.bat - bat) - Math.abs(p.bowling - bowl);
        if (sc > score) { score = sc; best = p; }
      }
      const id = ids[k] = donors ? donors.shift() : old[k];
      if (id === undefined) throw new Error('not enough free player records');
      const r = at(byId.get(id)), t = at(best.i);
      const nat = donors ? teamNat : u32(orig, r + 216), face = donors ? 0 : u16(orig, r + 356);
      out.set(orig.subarray(t, t + REC), r);
      put16(out, r, id);                                      // keep the record's id (squads point at it)
      put16(out, r + 2, comm ?? 0xffff);                      // commentary name (none unless the game has one)
      out.fill(0, r + 4, r + 20);
      for (let c = 0; c < name.length && c < 15; c++) out[r + 4 + c] = name.charCodeAt(c);
      out.fill(0, r + 20, r + 100);                           // career stats: start fresh
      const tBat = UP[six(orig, t + 108, 1)], tBowl = best.bowling;
      for (const [o, f] of BAT) setSix(out, r + o, f, raw(UP[six(orig, t + o, f)] + bat - tBat));
      // the game sends a keeper with an overall batting skill above 79 in to open (as Gilchrist did), so
      // keepers who don't open keep their shot ratings but have the overall skill held at 79
      if (role === 'WK' || role === 'WKB') setSix(out, r + 108, 1, Math.min(six(out, r + 108, 1), raw(79)));
      for (const [o, f] of BOWL) setSix(out, r + o, f, raw(UP[six(orig, t + o, f)] + bowl - tBowl));
      out[r + 351] = (out[r + 351] & 0xf0) | want.type;
      out[r + 132] = (out[r + 132] & 0xf0) | want.bowl;
      out[r + 133] = (out[r + 133] & 0xfe) | want.left;
      // batting position (the game orders the batting from it): opener, middle, lower order or tail
      const pos = role === 'OB' || role === 'OWK' ? 0 : ['OBW', 'BWL', 'SB'].includes(role) ? (bat >= 50 ? 2 : 3) : 1;
      out[r + 130] = (out[r + 130] & 0x7f) | (pos === 1 || pos === 2 ? 0x80 : 0);
      out[r + 131] = (out[r + 131] & 0xfe) | (pos >= 2 ? 1 : 0);
      put32(out, r + 216, nat);
      put16(out, r + 356, face >= 40000 ? face : genericFace(nat));
      if (dob) { const [y, m, d] = dob.split('-').map(Number); out[r + 348] = d; out[r + 349] = m - 1; out[r + 350] = y - 1900; }
    });
    ids.forEach((id, k) => put16(out, b + 2 * k, id));
    const cap = team.players.findIndex((p) => p[0] === team.captain);
    if (cap >= 0) put16(out, b + 46, ids[cap]);
  }
  return out;
}

// The Legends category's names, badges, kits and label. The game has four team categories, fixed in its code;
// Legends takes the place of Australian State (those teams move to Other). Works on one archive entry at a time:
// returns the changed bytes, or null for an entry it doesn't change. Text is handled as latin1, byte for byte.
function legendsPatch(name, data, SQUADS) {
  // (not playermanager.xml: its colour fields end in the team's own number, and copying them hid the teams)
  const F = { teams: 'be2970b0ada8e42cf891ce60ffe69575.xml', kits: '730eef3fd7726e43de955f21083ab000.xml',
    screens: ['17a9f0c56eaaeb65f3773e549620b95f.big', '986991c00c460e84461a2a84bbf0c52e.big', 'da73a7807e518c0d6ced209d547a0068.big'],
    strings: ['dc371d84ed78d4cf88a641a8d8abc38a.english', '1e970ae67ff9693610fa98ce27f928ab.english'] };
  if (name === 'entries') return [F.teams, F.kits, ...F.screens, ...F.strings];
  const L = SQUADS.legends;
  let s = ''; for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
  const fail = (what) => { throw new Error(`legends: ${what} not found in ${name}`); };
  const attr = (line, a) => (line.match(new RegExp(`\\s${a}="([^"]*)"`)) || fail(a))[1];
  const setAttr = (line, a, v) => (attr(line, a), line.replace(new RegExp(`(\\s${a}=)"[^"]*"`), `$1"${v}"`));
  const line = (re) => s.match(re) || fail(re.source);
  if (name === F.teams) {
    s = s.replace(/StandardOfCricket="1"/g, 'StandardOfCricket="3"');
    for (const t of L.teams) {
      const nat = line(new RegExp(`<team Index="${t.from}"\\s[^>]*>`))[0], mine = line(new RegExp(`<team Index="${t.block}"\\s[^>]*>`))[0];
      let l = setAttr(mine, 'TeamName', t.name); l = setAttr(l, 'TeamNameShort', t.short); l = setAttr(l, 'Abbreviation', t.abbr);
      l = setAttr(l, 'LogoAbbreviation', attr(nat, 'LogoAbbreviation')); l = setAttr(l, 'StandardOfCricket', '1');
      s = s.replace(mine, l);
    }
  } else if (name === F.kits) {
    // the Legends side wears its slot's own kit files (location), which kitFiles fills with the country's kit
    for (const t of L.teams) {
      const nat = line(new RegExp(`<team name="[^"]*"[^>]* id="${t.from}">([\\s\\S]*?)</team>`));
      const mine = line(new RegExp(`<team name="[^"]*"[^>]* id="${t.block}">[\\s\\S]*?</team>`))[0];
      let body = nat[1];
      if (t.kit.name) body = body.replace(/(<kit name="Coloured"[^>]*?\snamecolour=")[^"]*/, `$1${t.kit.name}`);
      if (t.kit.number) body = body.replace(/(<kit name="Coloured"[^>]*?\snumbercolour=")[^"]*/, `$1${t.kit.number}`);
      s = s.replace(mine, `<team name="${t.name}" location="${t.kit.slot}" id="${t.block}">${body}</team>`);
    }
  } else if (F.screens.includes(name) || F.strings.includes(name)) {
    // The category label, kept the same length as "Australian State" (some screens are binary and would break
    // otherwise). The game matches the label against the string table, so both get the same text.
    const w = 16, c = L.category, label = ' '.repeat((w - c.length) >> 1) + c + ' '.repeat(w - c.length - ((w - c.length) >> 1));
    const swaps = F.screens.includes(name) ? [['International|Australian State|', `International|${label}|`]]
      : [['International|Australian State|', `International|${label}|`], ['\x5e\x01Australian State\x00', `\x5e\x01${label}\x00`]];
    for (const [a, b] of swaps) { if (!s.includes(a)) fail('category label'); s = s.split(a).join(b); }
  } else return null;
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i);
  return o;
}

// The Legends kits: a country's kit textures (EA FSH: 32-bit BGRA or DXT) in a different shade. Colours whose hue is
// in tint.only (all if absent) get the hue shift and lightness/saturation factors; tint.greys scales dark greys.
function tintFsh(d, tint) {
  const o = new Uint8Array(d), u16 = (p) => o[p] | o[p + 1] << 8, u32 = (p) => (o[p] | o[p + 1] << 8 | o[p + 2] << 16 | o[p + 3] << 24) >>> 0;
  const cache = new Map();
  const rgb = (r, g, b) => {
    const k = r << 16 | g << 8 | b; if (cache.has(k)) return cache.get(k);
    let R = r / 255, G = g / 255, B = b / 255; const mx = Math.max(R, G, B), mn = Math.min(R, G, B), dd = mx - mn;
    let h = 0, sa = 0, l = (mx + mn) / 2, out = [r, g, b];
    if (dd) { sa = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn); h = 60 * (mx === R ? (G - B) / dd + (G < B ? 6 : 0) : mx === G ? (B - R) / dd + 2 : (R - G) / dd + 4); }
    const on = !tint.only || (tint.only[0] <= tint.only[1] ? h >= tint.only[0] && h <= tint.only[1] : h >= tint.only[0] || h <= tint.only[1]);
    let change = false;
    if (sa >= 0.2 && on) { h = (h + (tint.hue || 0) + 360) % 360; l = Math.min(1, l * (tint.light || 1)); sa = Math.min(1, sa * (tint.sat || 1)); change = true; }
    else if (sa < 0.2 && tint.greys && l < 0.6) { l = Math.min(1, l * tint.greys); change = true; }
    if (change) {
      const q = l < 0.5 ? l * (1 + sa) : l + sa - l * sa, p = 2 * l - q;
      const f = (t) => { t = ((t % 360) + 360) % 360 / 360; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
      out = [Math.round(f(h + 120) * 255), Math.round(f(h) * 255), Math.round(f(h - 120) * 255)];
    }
    cache.set(k, out); return out;
  };
  const to565 = ([r, g, b]) => (r * 31 / 255 + 0.5 | 0) << 11 | (g * 63 / 255 + 0.5 | 0) << 5 | (b * 31 / 255 + 0.5 | 0);
  const from565 = (v) => [((v >> 11) & 31) * 255 / 31 + 0.5 | 0, ((v >> 5) & 63) * 255 / 63 + 0.5 | 0, (v & 31) * 255 / 31 + 0.5 | 0];
  if (String.fromCharCode(o[0], o[1], o[2], o[3]) !== 'SHPI') throw new Error('kit: not an FSH texture');
  for (let i = 0, n = u32(8); i < n; i++) {
    const at = u32(20 + 8 * i), type = o[at], w = u16(at + 4), h = u16(at + 6), px = at + 16;
    if (type === 0x7d) {                                   // 32-bit BGRA
      for (let p = px, e = px + w * h * 4; p < e; p += 4) { const [r, g, b] = rgb(o[p + 2], o[p + 1], o[p]); o[p] = b; o[p + 1] = g; o[p + 2] = r; }
    } else if (type === 0x61 || type === 0x62) {           // DXT3/DXT5: 4-colour blocks, endpoint order doesn't matter
      for (let p = px, e = px + w * h; p < e; p += 16) for (const c of [p + 8, p + 10]) { const v = to565(rgb(...from565(u16(c)))); o[c] = v & 255; o[c + 1] = v >> 8; }
    } else throw new Error('kit: texture type ' + type);
  }
  return o;
}

// The game's list of extra-fast bowlers (Data/data.gob) gives each one a top speed (MaxFake mph for the overlay,
// MaxReal m/s for the ball), naming them by player record. The current squads put each 2026 player into a 2006
// player's record, so that player inherited the speed: a batter or spinner bowling at Shoaib Akhtar's 100 mph or
// Brett Lee's 99. This returns the list (bytes in, bytes out) without the entries whose record now holds a 2026
// player, plus today's fastest bowlers at their own top speed (SQUADS.pace, mph), or null if it isn't laid out as
// expected. Legends sides keep theirs: those players keep their records.
const FAST_BOWLERS = '6db25817c37163921676c2d9be05214e.xml';
function fastBowlersPatch(bytes, out, SQUADS) {
  const TEAMS = 432004, TEAM = 2808;
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const taken = new Set();   // records that now hold the 2026 squads
  for (const t of SQUADS.teams) for (let k = 0; k < 20; k++) {
    const o = TEAMS + t.team * TEAM + 2 * k;
    taken.add(((out[o] | out[o + 1] << 8) << 16) >> 16);
  }
  const lines = text.split('\n');
  if (!lines.some((l) => /<Bowler\s+ID\s*=/.test(l))) return null;
  const kept = lines.filter((l) => { const m = /<Bowler\s+ID\s*="(\d+)"/.exec(l); return !m || !taken.has(+m[1]); });
  // today's fastest bowlers, at their own top speed (mph shown, m/s bowled), in the record that now holds them
  const end = kept.findIndex((l) => /<\/Root>/.test(l));
  if (end < 0) return null;
  const add = [], cr = /\r$/.test(lines[0]) ? '\r' : '';   // the file's own line ends
  for (const t of SQUADS.teams) t.players.forEach(([name], k) => {
    const mph = SQUADS.pace && SQUADS.pace[name];
    if (!mph) return;
    const o = TEAMS + t.team * TEAM + 2 * k, id = ((out[o] | out[o + 1] << 8) << 16) >> 16;
    add.push(`\t<Bowler ID ="${id}" MaxFake = "${mph}" MaxReal = "${(mph * 0.44704).toFixed(2)}"/>\t<!-- ${name.replace(/-/g, ' ')} -->${cr}`, cr);
  });
  kept.splice(end, 0, ...add);
  const res = kept.join('\n');
  const bytesOut = new Uint8Array(res.length);
  for (let i = 0; i < res.length; i++) bytesOut[i] = res.charCodeAt(i) & 255;
  return bytesOut;
}

if (typeof module !== 'undefined') module.exports = { applySquads, legendsPatch, tintFsh, FAST_BOWLERS, fastBowlersPatch };
