// Gameplay tuning, applied by names.js to the app's copy of Data/data.gob (settings realEdges, "Realistic edges",
// realOuts, "Realistic dismissals", realPitches, "Livelier pitches", moreSixes, "More sixes in short games", and
// cpuSixes, "Fewer CPU slogs").
//
// The edge table (an XML file in the archive, written by HB Studios) scales each shot's chance of an edge, by
// batter (Human, CPU), match length, difficulty and timing zone (Start, Early, Ideal, Late, End; Start and End
// are the worst-timed): 0 leaves the shot's own chance, -1 means no edges, 0.4 means 40% more. The original
// barely uses timing outside Tests, gives you far fewer edges in short games, and gives the CPU fewer edges the
// harder the difficulty. This table uses the same values for every match length; timing always counts (a
// mistimed shot edges more, a well-timed one less), and difficulty mainly sets how forgiving it is to you.
//
// The misses and bat-pad tables have the same layout, for the chance that a shot misses the ball (bowled, LBW) and
// that an inside edge pops up off the pad to a close fielder. The originals are all 0 (every timing zone the same).
// Realistic dismissals: a mistimed shot is beaten more often, a well-timed one less; the CPU is easier to get out on
// easy difficulties, you are on hard ones. (Raising the CPU's misses to 20 made it lose 9 wickets for 6 runs.)
//
// Runs in the page (passed in as source text by names.js), so it uses no Node or browser APIs.
const EDGES_ENTRY = 'd660f1d880cacf893fe0b4b72421b50a.xml';

// [Start, Early, Ideal, Late, End] per difficulty
const EDGE_TUNING = {
  Human: {
    Very_Easy: [-0.4, -0.7, -0.9, -0.7, -0.4],
    Easy: [-0.2, -0.5, -0.8, -0.5, -0.2],
    Medium: [0.15, -0.15, -0.5, -0.15, 0.15],
    Hard: [0.3, 0, -0.35, 0, 0.3],
    Very_Hard: [0.4, 0.1, -0.2, 0.1, 0.4],
  },
  CPU: {
    Very_Easy: [0.4, 0.2, 0.05, 0.2, 0.4],
    Easy: [0.3, 0.15, 0, 0.15, 0.3],
    Medium: [0.25, 0.1, -0.05, 0.1, 0.25],
    Hard: [0.2, 0.05, -0.1, 0.05, 0.2],
    Very_Hard: [0.15, 0, -0.15, 0, 0.15],
  },
};

const MISSES_ENTRY = '4bb869e6ec78be4f6cdfd521487abba2.xml';
const MISS_TUNING = {
  Human: {
    Very_Easy: [0, 0, -0.5, 0, 0],
    Easy: [0.2, 0, -0.5, 0, 0.2],
    Medium: [0.5, 0.2, -0.5, 0.2, 0.5],
    Hard: [0.8, 0.4, -0.4, 0.4, 0.8],
    Very_Hard: [1, 0.5, -0.3, 0.5, 1],
  },
  CPU: {
    Very_Easy: [2.5, 1.5, 0.3, 1.5, 2.5],
    Easy: [2.2, 1.3, 0.2, 1.3, 2.2],
    Medium: [2, 1.1, 0.1, 1.1, 2],
    Hard: [1.8, 1, 0, 1, 1.8],
    Very_Hard: [1.5, 0.8, 0, 0.8, 1.5],
  },
};
const BATPAD_ENTRY = 'd011861aa745e6e118a85d8fd954506c.xml';
const BATPAD_TUNING = {
  Human: {
    Very_Easy: [0, 0, -0.5, 0, 0],
    Easy: [0.1, 0, -0.4, 0, 0.1],
    Medium: [0.3, 0.1, -0.3, 0.1, 0.3],
    Hard: [0.4, 0.2, -0.2, 0.2, 0.4],
    Very_Hard: [0.5, 0.25, -0.1, 0.25, 0.5],
  },
  CPU: {
    Very_Easy: [0.5, 0.25, 0, 0.25, 0.5],
    Easy: [0.4, 0.2, 0, 0.2, 0.4],
    Medium: [0.3, 0.15, -0.1, 0.15, 0.3],
    Hard: [0.25, 0.1, -0.15, 0.1, 0.25],
    Very_Hard: [0.2, 0.05, -0.2, 0.05, 0.2],
  },
};

// One of these tables (edges, misses, bat-pads) with TUNING's values (bytes in, bytes out), or null if the file isn't laid out as expected
// (then the original stays).
function edgesPatch(bytes, TUNING) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const ZONES = ['Start', 'Early', 'Ideal', 'Late', 'End'];
  let who = null, rows = 0;
  const out = text.split('\n').map((line) => {
    if (/<Human>/.test(line)) who = 'Human';
    else if (/<CPU>/.test(line)) who = 'CPU';
    const m = /^(\s*)<(Very_Easy|Easy|Medium|Hard|Very_Hard)\s[^>]*\/>(\r?)$/.exec(line);
    if (!m || !who) return line;
    rows++;
    const v = TUNING[who][m[2]];
    return `${m[1]}<${m[2]} ${ZONES.map((z, k) => `${z} = "${v[k]}"`).join(' ')} />${m[3]}`;
  }).join('\n');
  if (rows !== 70) return null;   // 7 match lengths x 5 difficulties, for Human and CPU
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out.charCodeAt(i) & 255;
  return res;
}

// Livelier pitches (realPitches): the delivery table (xml/config/deliveries) gives each delivery type, per pitch
// (Damp, Wet, Green, Normal, Hard, Dusty), a bounce ("hardness") and a sideways movement range (SideSpin: turn for
// spinners, seam for the quicks; swing deliveries are the same on every pitch, so they're left alone). The original
// makes pitches alike: a dusty pitch bounces more for the quicks than a green one. Here a dusty pitch turns more and
// keeps low for the quicks, and green and damp pitches seam more (green ones bounce a little more).
const PITCH_ENTRY = 'cc7e3c04d4e7cb0f30d6d6e99904efb9.xml';
const PITCH_TUNING = {
  spinTurn: { Dusty: 1.3 },                            // spinners' SideSpin range, times
  seam: { Green: 1.3, Damp: 1.15 },                     // quicks' seam deliveries (normal, cutters), times
  paceBounce: { Dusty: -0.06, Green: 0.03 },            // quicks' bounce, added
};
function pitchPatch(bytes, TUNING) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const lines = text.split('\n');
  let rows = 0, scale = 1;
  for (let i = 0; i < lines.length; i++) {
    const d = /<Delivery type="([A-Z_]+)"[^>]*pitchtype="(\w+)"/.exec(lines[i]);
    if (d) {
      rows++;
      const [, type, pitch] = d, spin = /SPIN_/.test(type), pace = /^(FAST|MFAST|MEDIUM)_/.test(type);
      scale = spin ? TUNING.spinTurn[pitch] || 1 : pace && /_(NORMAL|OFFCUTTER|LEGCUTTER)$/.test(type) ? TUNING.seam[pitch] || 1 : 1;
      const bounce = pace ? TUNING.paceBounce[pitch] || 0 : 0;
      if (bounce) lines[i] = lines[i].replace(/hardness="([\d.]+)"/, (m, h) => `hardness="${(+h + bounce).toFixed(6)}"`);
      continue;
    }
    if (scale !== 1 && /<SideSpin\s/.test(lines[i]))
      lines[i] = lines[i].replace(/(min|max|default)="(-?\d+)"/g, (m, k, v) => `${k}="${Math.round(v * scale)}"`);
  }
  if (rows !== 210) return null;   // 35 delivery types x 6 pitches
  const out = lines.join('\n'), res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out.charCodeAt(i) & 255;
  return res;
}

// More sixes in short games (moreSixes): the six-hitting table (xml/shots/adjustments) makes the timing window for a
// six smaller by a share per difficulty (0.25 = 25% smaller), for limited-overs and unlimited (Test) matches. Today's
// limited-overs batters hit far more sixes than in 2006, so the limited-overs window shrinks less; Tests stay as they were.
const SIXES_ENTRY = '25fc60848f89da6d94ccb6995fd808ba.xml';
const SIXES_TUNING = { Limited: { Very_Easy: 0.05, Easy: 0.08, Medium: 0.15, Hard: 0.2, Very_Hard: 0.28 } };
function sixesPatch(bytes, TUNING) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  let part = null, rows = 0;
  const out = text.split('\n').map((line) => {
    const p = /<(Limited|Unlimited)>/.exec(line);
    if (p) part = p[1];
    const m = /<(Very_Easy|Easy|Medium|Hard|Very_Hard)\s+Mod\s*=\s*"[^"]*"/.exec(line);
    if (!m || !part) return line;
    rows++;
    const v = TUNING[part] && TUNING[part][m[1]];
    return v === undefined ? line : line.replace(/Mod\s*=\s*"[^"]*"/, `Mod = "${v.toFixed(2)}"`);
  }).join('\n');
  if (rows !== 10) return null;
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out.charCodeAt(i) & 255;
  return res;
}

// Fewer CPU slogs (cpuSixes): the CPU doesn't time its shots, so the six table doesn't touch its sixes. Each of the
// game's shots (830 XML files, listed in shot-attributes.json) has AI values for an attempt to hit it for six:
// EdgeModifier6 (the chance of an edge or miscue; the original is the same as the ordinary shot's, so a slog risks
// nothing extra) and Reward6 (how much the CPU values the attempt). Here a six attempt edges 50% more often, and the
// CPU values it a quarter less. Your own shots are unchanged.
const CPU_SIXES = { edge6: 1.5, reward6: 0.75 };
// One shot file with those changes (bytes in, bytes out), or null if it has no AI line laid out as expected.
function shotPatch(bytes, SHOTS) {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  const line = /<AI\s[^>]*\/>/.exec(text);
  if (!line) return null;
  const num = (name) => { const m = new RegExp('\\s' + name + '="(-?[0-9.]+)"').exec(line[0]); return m ? +m[1] : null; };
  const edge = num('EdgeModifier'), reward6 = num('Reward6');
  if (edge === null || num('EdgeModifier6') === null || reward6 === null) return null;
  const ai = line[0]
    .replace(/(\sEdgeModifier6=")-?[0-9.]+"/, (_m, a) => `${a}${Math.round(edge * SHOTS.edge6)}"`)
    .replace(/(\sReward6=")-?[0-9.]+"/, (_m, a) => `${a}${(reward6 * SHOTS.reward6).toFixed(6)}"`);
  const out = text.slice(0, line.index) + ai + text.slice(line.index + line[0].length);
  const res = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) res[i] = out.charCodeAt(i) & 255;
  return res;
}

if (typeof module !== 'undefined') module.exports = { CPU_SIXES, shotPatch, EDGES_ENTRY, EDGE_TUNING, MISSES_ENTRY, MISS_TUNING, BATPAD_ENTRY, BATPAD_TUNING, edgesPatch,
  PITCH_ENTRY, PITCH_TUNING, pitchPatch, SIXES_ENTRY, SIXES_TUNING, sixesPatch };
