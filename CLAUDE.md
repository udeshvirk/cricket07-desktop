# Notes for working on this app

Electron wrapper around Dhaiwat's Cricket 07 browser port (https://cricket07.dhaiwat.com,
https://github.com/Dhaiwat10/cricket07-browser). Players are mostly non-technical: keep the README and
in-app text simple.

## Hard rules
- **No EA game files in this repo** (no `.wasm`, `data.gob`, `.cdf`, videos). They download from Dhaiwat's site on first launch.
- **Never modify the engine.** All changes go through `main.js` (page adjustments) and `enhance.js` (WebGPU hooks).
- **Every enhancement must have a Settings toggle and fall back safely** (switch itself off on any GPU error).
- **Don't change `name`/`productName` in package.json**: they set the `userData` folder, so players would lose their game files and settings. (The repo was renamed cricket07-mac → cricket07-desktop; GitHub redirects the old name, so never create a new repo with the old name.)
- **Test on a scratch `userData` folder, never a player's real data.** Two copies sharing storage once wiped the game files (OPFS).
  The single-instance lock doesn't protect a test script with a different entry point.

## How it fits together
| File | What it does |
|---|---|
| `main.js` | `c07://` scheme (COOP/COEP headers for threads), `adapt()` edits the fetched page (removes analytics, injects CSS + `enhance.js`, widescreen `sizeCanvas`), `startGame()` (backup, names, skip intro, click Play), shortcuts in `before-input-event` (the game swallows keys), Settings window, update toasts, single-instance lock. `DEFAULTS` = setting defaults. |
| `enhance.js` | Graphics, by wrapping WebGPU calls. Options come from the page URL (`gfxQuery`): `fxaa aniso mips sharpen vivid wide msaa upscale auto level fps keys`. Tab in menus (`tabKeys`, off by default, `keys=1` on): a capture-phase listener passes Tab / Shift+Tab on as Down / Up; Enter is left alone (the game uses it to name a save). Post chain on the final frame copy (FXAA/sharpen/vivid/stretch); 4× MSAA via multisampled twins of render targets and pipelines; 2× Catmull-Rom upscale of textures ≤ 512 px; widescreen via viewport scaling + a shader patch. "Keep the game smooth" (`auto`): counts presented frames in 3D seconds; steadily below 52 fps → steps down (1: MSAA paused → FXAA, 2: 85% resolution, 3: 75%), undoes a step that doesn't help (CPU-bound), tries one level up after 45 s at full speed; reports `[enhance] speed level N`, saved as `autoLevel`. |
| `names.js` | Patches the player table `113964e05e69ab31d264fb8f15c58e5c.cdf` inside `Data/data.gob` (EA BIGF + RefPack) in OPFS: real names (`real-names.json`) and/or current squads (`squads.js`). Always builds from the original list, appends the result and repoints the index; `.names-original.json` marks the original and what is applied (`applied: {names, squads}`, squads = a fingerprint of the squad data, so changed squads are rebuilt), so 'original' restores it byte-for-byte. `extra` records the original index entries of the other files it changes (Legends teams). |
| `squads.js`, `squads-2026.json` | Current squads (2026), setting `squads2026`. Player table = Player Editor07's "PS2 roster" layout: 1200 records × 360 bytes from offset 4, then 67 team blocks × 2808 from 432004 (20 int16 player ids, captain id at +46). Each 2006 squad member's record becomes a 2026 player, copied from the closest 2006 international player (role, bowling type, hand, level), then name, ratings (6-bit fields, shifted from the model's), role, batting position, bowling type, hand, DOB set and career stats cleared. Ratings in the JSON are our own. Legends teams (`legends2006`, needs squads): the game has 4 team categories, fixed in its code, so "Australian State" is renamed Legends (states move to Other) and 10 A/XI teams become the 2006 squads (`legendsPatch`: team list XML, kits XML, kit textures: each slot's kit files (`teams/<location>/colouredkit1` etc., FSH) get the country's kit in another shade (`tintFsh`, per-team `kit.tint`; Australia uses its real yellow kit `auo`), so a team and its Legends side look apart. Archive names are MD5 of the path without extension (`xml/config/teaminfo` → `be2970b0….xml`), the category label in 3 menu packages and both string tables). The 2026 players then use records found only in those teams (`spare` teams after). |
| `updates.js` | App updates (GitHub releases API) and engine updates (HEAD ETag = MD5; `index.html` compared with Cloudflare's per-download tag stripped). Engine update downloads to `engine.new`, verifies, keeps `engine.previous`. Restore original names before restarting after an engine update, or the game re-downloads 341 MB. |
| `diagnostics.js` | `log.txt` per launch (previous in `log-previous.txt`): versions, GPU + driver, WebGPU adapter, page files, startup steps, page warnings/errors (repeats collapsed), crashes. Help menu / Settings → Show Log File. Safe graphics (`graphics.json`): no picture (page got its files but never loaded, or no animation frames) → dialog + restart one level safer (0 normal + `ignore-gpu-blocklist`, 1 blocklist respected, 2 `disable-gpu-compositing`, 3 `disable-gpu` = SwiftShader); 3 GPU crashes before the first frame → restart a level safer without asking (Chromium quits silently after ~8). A changed driver, or Settings → Try Normal Graphics, goes back to 0. |
| `saves.js`, `screenshot.js` | Save backups (Documents/`<app> Saves`), screenshots (Pictures/`<app> Screenshots`). |
| `settings.html`, `settings-preload.js` | Settings window (⌘, / Ctrl+,). |
| `test/smoke.js`, `.github/workflows/windows-test.yml` | Windows end-to-end test on GitHub (software WebGPU via SwiftShader), ending with Quit from the game's menu. Runs on every published release, or manually (`gh workflow run windows-test.yml --ref <branch>`). |
| `test/drive.js` | Local manual driver: `UD=<scratch userData copy> OUT=<dir> npx electron test/drive.js`, then append commands (`key S`, `shot name`, `js …`, `crash`, `exit`) to `$OUT/cmd`. |

Storage under `userData`: `engine/` (page + engine), `manifest.json` (game-file list), `settings.json`, `updates.json`, `log.txt`, `graphics.json`; game files in OPFS (`c07game`).
Skip intro = rename OPFS `Data/eaep.vp6` → `eaep.vp6.skip` before the game starts.

## Lessons
- Mip levels: an upscaled texture's level 1 must be the game's texture unchanged (it's what's drawn at normal
  size); distant levels raise alpha only at cut-out edges. Otherwise see-through shading gets heavier (1.4.1 fix).
- Measure picture changes, don't eyeball them: menus and match conditions are random between runs, so compare
  inside one session (live toggles, or read textures back from the GPU) or on a paused frame.
- Post effects must not shift brightness (most of this game's picture is below mid-grey, so a contrast boost darkens it).
- The engine's sound can loop and crash (`DSound buffer index not advancing, restoring` ×900 → `guest heap exhausted`
  → `Aborted()`) when its timer is starved: on slow machines, often right after Quit in the game menu (Windows), and
  always on the SwiftShader CI machine. Engine bug (Dhaiwat's); the app shows "The game has stopped" (Quit / Start again).
- The game picks each team's XI and batting order itself, from roles and ratings. A keeper with overall batting
  skill above 79 is sent in to open (as Gilchrist did), so non-opening keepers have that one field held at 79.
  Models must be 2006 international players: a county keeper as the model also made keepers open.
- The category label must match the string table text exactly, or the game shows Other's teams under it; binary
  menu screens (.rfe) break if a string changes length (Selections crashed), so labels are padded to the same length.
  Don't copy playermanager.xml colour fields between teams: they hid the teams.
- Engines from 26 Oct 2026 have their own widescreen (on unless `?4x3`); it draws the bar under the batting
  mini-screen past its frame, and stacked with ours squeezes the HUD. The app passes `4x3` and keeps its own (`engineWide()` in main.js).
- White window on Windows = Chromium's graphics process hung or crashed (the app itself paints black). Test it on a Mac
  with `test/drive.js --gpu-launcher=<script>`: a script that sleeps = hang (the page never finishes loading), one that exits = crash.
  `capturePage` hangs with `disable-gpu`; use `screencapture`.
- A fast Mac never shows slowness: test "Keep the game smooth" by injecting a busy-wait per frame (`test/drive.js`).

## Releasing
1. Bump `version` in `package.json`, commit, push.
2. `npm run dist` (Mac zips) and `npm run dist:win` (Windows installer); both build on a Mac.
3. Rename for the README's fixed "latest" links: `Cricket07-Mac-arm64.zip` → `Cricket07-Mac-Apple-Chip.zip`,
   `Cricket07-Mac-x64.zip` → `Cricket07-Mac-Intel.zip`; Windows is `Cricket07-Windows-Setup.exe`.
4. `gh release create vX.Y.Z <files> --notes "…"` (plain-language notes). Publishing triggers the Windows test;
   check it with `gh run list --workflow windows-test.yml`.
5. Build scripts use `--publish never` (CI has no publish token).

## Known limits
- Online multiplayer doesn't work in the app.
- The licence screen at startup is a still image in the game, not skippable like the intro movie.
- Dhaiwat hasn't replied to https://github.com/Dhaiwat10/cricket07-browser/issues/1 (credit/permission note).
