// Gameplay tuning, applied by names.js to the app's copy of Data/data.gob (setting realEdges, "Realistic edges").
//
// The edge table (an XML file in the archive, written by HB Studios) scales each shot's chance of an edge, by
// batter (Human, CPU), match length, difficulty and timing zone (Start, Early, Ideal, Late, End; Start and End
// are the worst-timed): 0 leaves the shot's own chance, -1 means no edges, 0.4 means 40% more. The original
// barely uses timing outside Tests, gives you far fewer edges in short games, and gives the CPU fewer edges the
// harder the difficulty. This table uses the same values for every match length; timing always counts (a
// mistimed shot edges more, a well-timed one less), and difficulty mainly sets how forgiving it is to you.
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

// The edge table with EDGE_TUNING's values (bytes in, bytes out), or null if the file isn't laid out as expected
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

if (typeof module !== 'undefined') module.exports = { EDGES_ENTRY, EDGE_TUNING, edgesPatch };
