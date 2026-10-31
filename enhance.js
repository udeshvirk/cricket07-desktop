// Graphics enhancements, added on top of the port by the Mac app. Loaded before c07.js; it adjusts the
// game's WebGPU calls instead of changing the engine:
// - Sharper textures: 16x anisotropic filtering on the game's (linear) samplers, so the pitch and outfield
//   stay crisp at an angle. Applies when the game creates its samplers, so it needs a restart to change.
// - Smooth edges: the game draws each frame into one image and copies it to the screen. That copy is
//   replaced by a pass that applies FXAA anti-aliasing on the way. Can be switched on and off live.
// - Less shimmer: most of the game's textures have no mipmaps (smaller pre-shrunk copies), so distant crowds,
//   boards and buildings flicker as the camera moves. Each such texture gets an uncompressed copy with a full
//   set of mipmaps, which the game is given to draw with. Cut-out textures (crowd, trees) keep their shape in
//   the smaller copies instead of thinning out. Applies to textures loaded after it is on (restart to change).
// - HD textures: textures up to 512 pixels get their copy at twice the size (Catmull-Rom with an anti-ringing
//   clamp, on premultiplied colour), which makes menus, logos and kits crisper. Needs a restart.
// - Sharpen and Vivid Colours: contrast-adaptive sharpening and a gentle colour (saturation) boost that keeps brightness on the final
//   picture, after FXAA. Both can be switched live.
// - Widescreen: the game's frame image is made as wide as the screen and the 3D scene is drawn with a wider
//   view instead of being stretched; 2D (menus, scoreboard) fills the screen as before. Needs a restart.
// Settings come from the page URL (?aniso=0, ?fxaa=0, ?mips=0, ?sharpen=0, ?vivid=1, ?wide=1, ?stage=1: the engine draws widescreen itself) and window.c07Enhance (changed live by the app).
(() => {
  'use strict';
  if (!window.GPUDevice) return;
  const q = new URLSearchParams(location.search);
  const cfg = (window.c07Enhance = { fxaa: q.get('fxaa') !== '0', aniso: q.get('aniso') !== '0', mips: q.get('mips') !== '0',
    sharpen: q.get('sharpen') === '0' ? 0 : 0.5, vivid: q.get('vivid') === '1', wide: q.get('wide') === '1', stage: q.get('stage') === '1', msaa: q.get('msaa') === '1', upscale: q.get('upscale') === '1',
    auto: q.get('auto') !== '0', level: Math.max(0, Math.min(3, +q.get('level') || 0)), fps: q.get('fps') === '1', scale: 1, sharpenBoost: 0,
    tabKeys: q.get('keys') === '1' });

  // ---- Tab in menus (off unless switched on): the game's menus move with the arrow keys, so Tab / Shift+Tab are
  // passed on as Down / Up. The offline game doesn't use Tab (Enter it does: naming a save), so only Tab is changed.
  // It also applies in a match (the game doesn't say when a menu is showing), and can be switched live.
  const held = new Map();   // pressed Tab -> the key it was passed on as (so its release matches, even if Shift changed)
  const translate = (e) => {
    if (!e.isTrusted || e.code !== 'Tab') return;   // our own events (below), and every other key
    let to = held.get(e.code);
    if (!to) {
      // a release with no matching press (pressed before this page): swallow it too
      if (e.type === 'keyup') { if (cfg.tabKeys) { e.preventDefault(); e.stopImmediatePropagation(); } return; }
      if (!cfg.tabKeys || e.altKey || e.ctrlKey || e.metaKey) return;
      to = e.shiftKey ? 'ArrowUp' : 'ArrowDown';
      held.set(e.code, to);
    }
    if (e.type === 'keyup') held.delete(e.code);
    e.preventDefault();
    e.stopImmediatePropagation();
    window.dispatchEvent(new KeyboardEvent(e.type, { code: to, key: to, repeat: e.repeat, shiftKey: e.shiftKey, bubbles: true, cancelable: true }));
  };
  window.addEventListener('keydown', translate, true);
  window.addEventListener('keyup', translate, true);
  // a key let go while the window was in the background: let its stand-in go too
  window.addEventListener('blur', () => {
    for (const [, to] of held) window.dispatchEvent(new KeyboardEvent('keyup', { code: to, key: to, bubbles: true }));
    held.clear();
  });

  // ---- sharper textures
  const createSampler = GPUDevice.prototype.createSampler;
  GPUDevice.prototype.createSampler = function (d = {}) {
    if (cfg.aniso && d.minFilter === 'linear' && d.magFilter === 'linear' && d.mipmapFilter === 'linear' && !d.compare)
      d = { ...d, maxAnisotropy: 16 };
    return createSampler.call(this, d);
  };

  // ---- smooth edges
  const RENDER_ATTACHMENT = 16, TEXTURE_BINDING = 4;
  let device = null;
  const canvasTextures = new WeakSet();

  // widescreen: the screen's shape, and the 4:3 frame image -> wide frame image mapping
  // the shape is taken from the game's canvas when first needed (the window is full screen by then) and then kept
  let aspect = 0;
  const ASPECT = () => {
    if (!aspect) {
      const c = document.getElementById('canvas');
      aspect = Math.max(4 / 3, c && c.width && c.height ? c.width / c.height : screen.width / screen.height);
    }
    return aspect;
  };
  const wideScale = new WeakMap();   // widened texture -> width scale
  function wideSize(d) {
    const sz = d.size, w = sz.width ?? sz[0], h = sz.height ?? sz[1];
    if (!h || h < 300 || Math.abs(w / h - 4 / 3) > 0.01) return null;
    const w1 = Math.round(h * ASPECT());
    return w1 > w + 1 ? { w, h, w1 } : null;
  }

  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    device = this;
    // the frame image must be readable by the FXAA pass
    if ((d.usage & RENDER_ATTACHMENT) && d.format === 'bgra8unorm' && !(d.usage & TEXTURE_BINDING))
      d = { ...d, usage: d.usage | TEXTURE_BINDING };
    let ws = null;
    if (cfg.wide && (d.usage & RENDER_ATTACHMENT) && (ws = wideSize(d)))
      d = { ...d, size: { width: ws.w1, height: ws.h, depthOrArrayLayers: 1 } };
    const t = createTexture.call(this, d);
    if (ws) wideScale.set(t, ws.w1 / ws.w);
    if (cfg.mips || cfg.upscale) addMipCopy(t, d);
    return t;
  };
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    const t = getCurrentTexture.call(this);
    canvasTextures.add(t);
    return t;
  };

  const WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb; }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(src));
  let uv = in.uv;
  let m = tap(uv);
  let lNW = luma(tap(uv + vec2f(-1.0, -1.0) * px));
  let lNE = luma(tap(uv + vec2f(1.0, -1.0) * px));
  let lSW = luma(tap(uv + vec2f(-1.0, 1.0) * px));
  let lSE = luma(tap(uv + vec2f(1.0, 1.0) * px));
  let lM = luma(m);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.0312, lMax * 0.125)) { return vec4f(m, 1.0); }   // no edge here
  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  let rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcp, vec2f(-8.0), vec2f(8.0)) * px;
  let a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let b = a * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  let lB = luma(b);
  if (lB < lMin || lB > lMax) { return vec4f(a, 1.0); }
  return vec4f(b, 1.0);
}`;

  // The post-processing chain on the way to the screen: [FXAA] -> [sharpen + colour]
  const POST_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
struct P { sharp: f32, sat: f32, con: f32, pad: f32 };
@group(0) @binding(1) var<uniform> prm: P;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
fn ld(p: vec2i) -> vec3f { return textureLoad(src, clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1), 0).rgb; }
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  var c = ld(p);
  if (prm.sharp > 0.0) {
    // contrast-adaptive sharpening (after AMD's CAS): sharpens detail, holds back on edges that are already strong
    let n = ld(p + vec2i(0, -1)); let s = ld(p + vec2i(0, 1)); let e = ld(p + vec2i(1, 0)); let w = ld(p + vec2i(-1, 0));
    let mn = min(c, min(min(n, s), min(e, w)));
    let mx = max(c, max(max(n, s), max(e, w)));
    let amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3f(0.0001)), vec3f(0.0), vec3f(1.0)));
    let wgt = -amp * mix(0.125, 0.2, prm.sharp);
    c = clamp((c + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt), vec3f(0.0), vec3f(1.0));
  }
  let l = dot(c, vec3f(0.299, 0.587, 0.114));
  c = clamp(mix(vec3f(l), c, prm.sat), vec3f(0.0), vec3f(1.0));   // saturation (brightness stays the same)
  return vec4f(c, 1.0);
}`;

  // plain scaled copy (when the finished picture and the window differ in size, e.g. after leaving full screen)
  const STRETCH_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f { return vec4f(textureSampleLevel(src, smp, in.uv, 0.0).rgb, 1.0); }`;

  const speed = { frames: 0, scenes: 0 };   // counted for 'keep the game smooth' (below)
  let failed = false, linear = null, ubuf = null;
  const temps = [null, null];
  const tempTex = (i, w, h, format) => {
    const t = temps[i];
    if (t && t.width === w && t.height === h && t.format === format) return t;
    if (t) t.destroy();
    return (temps[i] = createTexture.call(device, { size: [w, h], format, usage: RENDER_ATTACHMENT | TEXTURE_BINDING, label: 'c07-post' }));
  };
  const pipes = {};
  const bindCache = new WeakMap();   // texture -> { fxaa, post }
  function pipe(kind, format) {
    const key = kind + ':' + format;
    if (!pipes[key]) {
      const module = device.createShaderModule({ code: kind === 'fxaa' ? WGSL : kind === 'stretch' ? STRETCH_WGSL : POST_WGSL });
      pipes[key] = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } });
    }
    return pipes[key];
  }
  function bindings(kind, p, tex) {
    let g = bindCache.get(tex);
    if (!g) bindCache.set(tex, (g = {}));
    if (!g[kind] || g[kind].p !== p) {
      const second = kind === 'post' ? { binding: 1, resource: { buffer: ubuf } } : { binding: 1, resource: linear };
      g[kind] = { p, bg: device.createBindGroup({ layout: p.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: tex.createView() }, second] }) };
    }
    return g[kind].bg;
  }
  function draw(enc, kind, srcTex, target, w, h) {
    const p = pipe(kind, target.format);
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear',
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(p);
    pass.setBindGroup(0, bindings(kind, p, srcTex));
    pass.draw(3);
    pass.end();
  }

  const copyTextureToTexture = GPUCommandEncoder.prototype.copyTextureToTexture;
  GPUCommandEncoder.prototype.copyTextureToTexture = function (source, destination, size) {
    const s = source.texture, d = destination.texture;
    if (canvasTextures.has(d)) speed.frames++;
    let w = size.width ?? size[0], h = size.height ?? size[1] ?? 1;
    // the whole frame image, copied to the top-left of the (same size or slightly larger) screen
    const atZero = (o) => !o || ((o.x ?? o[0] ?? 0) === 0 && (o.y ?? o[1] ?? 0) === 0 && (o.z ?? o[2] ?? 0) === 0);
    const wideSrc = wideScale.has(s);
    const whole = wideSrc || (atZero(source.origin) && atZero(destination.origin) && !source.mipLevel && !destination.mipLevel &&
      w === s.width && h === s.height && d.width >= w && d.height >= h);
    const post = cfg.sharpen > 0 || cfg.vivid || wideSrc;
    const fxaa = cfg.fxaa && !cfg.msaaActive;
    if (wideSrc) { w = Math.min(s.width, d.width); h = Math.min(s.height, d.height); }
    if ((fxaa || post) && !failed && device && canvasTextures.has(d) && whole && (s.usage & TEXTURE_BINDING)) {
      try {
        if (!linear) linear = createSampler.call(device, { minFilter: 'linear', magFilter: 'linear' });
        if (!ubuf) ubuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(ubuf, 0, new Float32Array([cfg.sharpen && Math.min(1, cfg.sharpen + cfg.sharpenBoost), cfg.vivid ? 1.2 : 1, 1, 0]));
        // the steps run at the picture's own size; if the window's size differs (it changed after the game
        // started), a last step scales the result to fill the window instead of leaving a black strip
        const steps = [];
        if (cfg.fxaa && !cfg.msaaActive) steps.push('fxaa');   // MSAA already smooths the edges: FXAA would only blur
        if (cfg.sharpen > 0 || cfg.vivid || (wideSrc && !steps.length)) steps.push('post');
        const stretch = wideSrc && (s.width !== d.width || s.height !== d.height);
        let src = s, sw = stretch ? s.width : w, sh = stretch ? s.height : h;
        steps.forEach((step, i) => {
          const last = i === steps.length - 1 && !stretch;
          const target = last ? d : tempTex(i % 2, sw, sh, d.format);
          draw(this, step, src, target, sw, sh);
          src = target;
        });
        if (stretch) draw(this, 'stretch', src, d, d.width, d.height);
        return;
      } catch (err) {
        failed = true;   // fall back to the plain copy for the rest of the session
        console.warn('[enhance] post-processing off:', err);
      }
    }
    return copyTextureToTexture.call(this, source, destination, size);
  };

  // ---- less shimmer: mipmapped copies of textures that have none
  const MIP_FORMATS = new Set(['rgba8unorm', 'bgra8unorm', 'bc1-rgba-unorm', 'bc2-rgba-unorm', 'bc3-rgba-unorm']);
  const copies = new WeakMap();   // game texture -> { tex, levels, w, h }
  const dirty = new Set();
  let mipFailed = false;
  const UPSCALE_MAX = 512;
  const stats = (window.__texStats = { copies: 0, upscaled: 0, bytes: 0 });

  function addMipCopy(t, d) {
    if (mipFailed || (d.usage & RENDER_ATTACHMENT) || (d.mipLevelCount || 1) !== 1 || !MIP_FORMATS.has(d.format)) return;
    if ((d.dimension && d.dimension !== '2d') || (d.sampleCount || 1) !== 1) return;
    const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, layers = s.depthOrArrayLayers ?? s[2] ?? 1;
    if (layers !== 1 || Math.max(w, h) < 64) return;
    // sharper textures: small and mid-size textures (up to 512) get a copy at twice the size
    const k = cfg.upscale && Math.max(w, h) <= UPSCALE_MAX ? 2 : 1;
    const W = w * k, H = h * k;
    const levels = cfg.mips ? Math.floor(Math.log2(Math.max(W, H))) + 1 : 1;
    try {
      const tex = createTexture.call(device, { size: [W, H], format: 'rgba8unorm', mipLevelCount: levels,
        usage: TEXTURE_BINDING | RENDER_ATTACHMENT, label: 'c07-mips' });
      copies.set(t, { tex, levels, w, h, k });
      stats.copies++; if (k > 1) stats.upscaled++;
      stats.bytes += W * H * 4 * (levels > 1 ? 4 / 3 : 1);
    } catch (err) { mipFailed = true; console.warn('[enhance] mipmaps off:', err); }
  }

  // the game draws with the copy (its views never pick a format or mip range, see below)
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (d) {
    const c = copies.get(this);
    if (c && !mipFailed && (!d || (!d.baseMipLevel && !d.baseArrayLayer && (!d.dimension || d.dimension === '2d'))))
      return createView.call(c.tex);
    return createView.call(this, d);
  };
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function (dst, ...rest) {
    const r = writeTexture.call(this, dst, ...rest);
    if (copies.has(dst.texture)) dirty.add(dst.texture);
    return r;
  };
  const destroy = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function () {
    const c = copies.get(this);
    if (c) { c.tex.destroy(); copies.delete(this); dirty.delete(this); }
    return destroy.call(this);
  };

  const MIP_WGSL = `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}
// level 0: the game's texture as it is (decompressed)
@fragment fn copy(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  return textureLoad(src, vec2i(pos.xy), 0);
}
// level 0 at twice the size: Catmull-Rom (sharp bicubic) on premultiplied colour, clamped to the nearest 2x2
// texels' range so edges don't get halos (anti-ringing)
fn ld(p: vec2i) -> vec4f {
  let q = clamp(p, vec2i(0), vec2i(textureDimensions(src)) - 1);
  let c = textureLoad(src, q, 0);
  return vec4f(c.rgb * c.a, c.a);
}
fn cr(t: f32) -> vec4f {
  let t2 = t * t; let t3 = t2 * t;
  return vec4f(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
@fragment fn up(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let s = pos.xy * 0.5 - 0.5;            // position in the original texture's texels
  let b = vec2i(floor(s));
  let f = s - floor(s);
  let wx = cr(f.x); let wy = cr(f.y);
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    var row = vec4f(0.0);
    for (var i = 0; i < 4; i++) { row += ld(b + vec2i(i - 1, j - 1)) * wx[i]; }
    acc += row * wy[j];
  }
  let n0 = ld(b); let n1 = ld(b + vec2i(1, 0)); let n2 = ld(b + vec2i(0, 1)); let n3 = ld(b + vec2i(1, 1));
  acc = clamp(acc, min(min(n0, n1), min(n2, n3)), max(max(n0, n1), max(n2, n3)));
  if (acc.a <= 0.0001) { return vec4f(0.0); }
  return vec4f(acc.rgb / acc.a, acc.a);
}
// smaller levels: average 2x2 texels; colours weighted by alpha so cut-out edges don't go dark, and alpha
// leaning towards the strongest texel so crowd and leaf cut-outs keep their shape at a distance
@fragment fn down(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let last = vec2i(textureDimensions(src)) - 1;
  let p = vec2i(pos.xy) * 2;
  let a = textureLoad(src, min(p, last), 0);
  let b = textureLoad(src, min(p + vec2i(1, 0), last), 0);
  let c = textureLoad(src, min(p + vec2i(0, 1), last), 0);
  let d = textureLoad(src, min(p + vec2i(1, 1), last), 0);
  let wsum = a.a + b.a + c.a + d.a;
  var rgb = (a.rgb + b.rgb + c.rgb + d.rgb) * 0.25;
  if (wsum > 0.001) { rgb = (a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) / wsum; }
  let avg = wsum * 0.25;
  let mx = max(max(a.a, b.a), max(c.a, d.a));
  let mn = min(min(a.a, b.a), min(c.a, d.a));
  // only cut-out edges (a sharp jump in alpha) lean towards the strongest texel; soft see-through areas (shadows,
  // glows) keep their true average, so they don't get heavier or darker at a distance
  return vec4f(rgb, select(avg, mix(avg, mx, 0.6), mx - mn > 0.5));
}`;
  let mipPipes = null;
  function buildMips(enc, game, c) {
    if (!mipPipes) {
      const module = device.createShaderModule({ code: MIP_WGSL });
      const mk = (entryPoint) => device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint, targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' } });
      mipPipes = { copy: mk('copy'), down: mk('down'), up: mk('up') };
    }
    const level = (i) => createView.call(c.tex, { baseMipLevel: i, mipLevelCount: 1 });
    const run = (pipe, srcView, i) => {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: level(i), loadOp: 'clear', storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: srcView }] }));
      pass.draw(3);
      pass.end();
    };
    const orig = createView.call(game);
    run(c.k > 1 ? mipPipes.up : mipPipes.copy, orig, 0);
    for (let i = 1; i < c.levels; i++) {
      // an upscaled copy's next level is the game's own texture, unchanged: drawn at its normal size, it looks exactly as before
      if (c.k > 1 && i === 1) run(mipPipes.copy, orig, 1);
      else run(mipPipes.down, level(i - 1), i);
    }
  }

  // the copies are refreshed just before the game's next drawing reaches the GPU
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    if (dirty.size && device && !mipFailed) {
      try {
        const enc = device.createCommandEncoder({ label: 'c07-mips' });
        for (const t of dirty) { const c = copies.get(t); if (c) buildMips(enc, t, c); }
        dirty.clear();
        return submit.call(this, [enc.finish(), ...buffers]);
      } catch (err) {
        mipFailed = true;
        console.warn('[enhance] mipmaps off:', err);
      }
    }
    return submit.call(this, buffers);
  };

  // ---- widescreen: render passes into the widened frame image get their viewport widened to match, and the
  // game's shader draws the 3D scene with a wider view (2D, which is placed by the viewport, stretches as before)
  if (cfg.wide) {
    const createShaderModule = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function (d) {
      const marker = 'p.x = p.x + p.w / u.vp.z;';
      if (d && typeof d.code === 'string' && d.code.includes(marker))
        // only perspective drawing (the stadium, players) gets the wider view; flat overlays drawn through the 3D
        // path (radar, inset frame) have no perspective and stretch with the rest of the 2D layer
        d = { ...d, code: d.code.replace(marker, `if (u.flags.x == 2u || u.mvp[0][3] != 0.0 || u.mvp[1][3] != 0.0 || u.mvp[2][3] != 0.0) { p.x = p.x * ${((4 / 3) / ASPECT()).toFixed(6)}; }\n    ${marker}`) };
      return createShaderModule.call(this, d);
    };
    const viewScale = new WeakMap(), wideWidth = new WeakMap(), passScale = new WeakMap();
    const createView2 = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (d) {
      const v = createView2.call(this, d);
      const sc = wideScale.get(this);
      if (sc) { viewScale.set(v, sc); wideWidth.set(v, this.width); }
      return v;
    };
    const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (d) {
      const pass = beginRenderPass.call(this, d);
      const v = d.colorAttachments?.[0]?.view || d.depthStencilAttachment?.view;
      const sc = v && viewScale.get(v);
      if (sc) passScale.set(pass, { sc, width: wideWidth.get(v) });
      return pass;
    };
    const setViewport = GPURenderPassEncoder.prototype.setViewport;
    GPURenderPassEncoder.prototype.setViewport = function (x, y, w, h, a, b) {
      const p = passScale.get(this);
      if (p) { x *= p.sc; w *= p.sc; }   // viewports stretch with the image; the shader keeps 3D in proportion
      return setViewport.call(this, x, y, w, h, a, b);
    };
  }

  // ---- true anti-aliasing (4x MSAA)
  // The game draws each frame into one image (plus a depth buffer) through render passes, and never reads that
  // image as a texture. Those passes are pointed at hidden 4x multisampled copies instead, which resolve into
  // the game's image at the end of each pass, and the game's pipelines get 4x twins (compiled in the background).
  // Anything unexpected switches MSAA off for the rest of the session and the game draws as before.
  if (cfg.msaa) {
    const SAMPLES = 4;
    let msaaOff = false;
    cfg.msaaActive = true;
    const off = (why) => { if (!msaaOff) { msaaOff = true; cfg.msaaActive = false; console.warn('[enhance] MSAA off:', why); } };
    // paused by 'keep the game smooth': passes and pipelines go back to the game's own (FXAA takes over)
    cfg.setMsaa = (on) => { cfg.msaaPaused = !on; cfg.msaaActive = on && !msaaOff; };
    cfg.msaaWorks = () => !msaaOff;
    const big = (d) => { const z = d.size, w = z.width ?? z[0], h = z.height ?? z[1]; return w >= 512 && h >= 384; };
    const msTex = new WeakMap();    // game render target -> its 4x copy
    const msView = new WeakMap();   // view of a game render target -> view of its 4x copy
    const viewOf = new WeakMap();   // view -> texture
    const pipeDesc = new WeakMap(), pipeTwin = new WeakMap();
    const msPasses = new WeakSet();

    const ctex = GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture = function (d) {
      const t = ctex.call(this, d);
      if (!msaaOff && (d.usage & RENDER_ATTACHMENT) && (d.sampleCount || 1) === 1 && (d.mipLevelCount || 1) === 1 && big(d) &&
          (d.format === 'bgra8unorm' || d.format === 'depth24plus-stencil8')) {
        try {
          const m = createTexture.call(this, { size: [t.width, t.height], format: d.format, sampleCount: SAMPLES,
            usage: RENDER_ATTACHMENT, label: 'c07-msaa' });
          msTex.set(t, m);
          if (wideScale.has(t)) wideScale.set(m, wideScale.get(t));   // widescreen viewports follow it too
        } catch (err) { off(err); }
      }
      return t;
    };
    const cview = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (d) {
      const v = cview.call(this, d);
      viewOf.set(v, this);
      return v;
    };
    const msViewFor = (v) => {
      if (!v) return null;
      let mv = msView.get(v);
      if (!mv) { const m = msTex.get(viewOf.get(v)); if (!m) return null; mv = m.createView(); msView.set(v, mv); }
      return mv;
    };

    const cpipe = GPUDevice.prototype.createRenderPipeline;
    GPUDevice.prototype.createRenderPipeline = function (d) {
      const p = cpipe.call(this, d);
      // the game's pipelines: explicit layout (so its bind groups fit the twin), drawing into its image + depth
      if (!msaaOff && d && d.layout && d.layout !== 'auto' && (d.multisample?.count || 1) === 1 &&
          d.depthStencil?.format === 'depth24plus-stencil8' && d.fragment?.targets?.length === 1) {
        const twin = { ...d, multisample: { count: SAMPLES, mask: 0xffffffff, alphaToCoverageEnabled: false } };
        pipeDesc.set(p, twin);
        this.createRenderPipelineAsync(twin).then((t) => pipeTwin.set(p, t)).catch((err) => off(err));
      }
      return p;
    };

    const bpass = GPUCommandEncoder.prototype.beginRenderPass;
    GPUCommandEncoder.prototype.beginRenderPass = function (d) {
      const c = d.colorAttachments?.length === 1 ? d.colorAttachments[0] : null, z = d.depthStencilAttachment;
      const mc = c && msViewFor(c.view), mz = z && msViewFor(z.view);
      if (cfg.msaaPaused) return bpass.call(this, d);   // live A/B comparison (tests only)
      if (msaaOff || !c || !mc || (z && !mz) || c.resolveTarget) {
        // a pass into the game's image that can't be multisampled would leave the 4x copy out of date
        if (!msaaOff && c && msTex.has(viewOf.get(c.view))) off('unexpected pass into the game image');
        return bpass.call(this, d);
      }
      const md = { ...d, colorAttachments: [{ ...c, view: mc, resolveTarget: c.view, storeOp: 'store' }] };
      if (z) md.depthStencilAttachment = { ...z, view: mz };
      const pass = bpass.call(this, md);
      msPasses.add(pass);
      return pass;
    };
    const spipe = GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline = function (p) {
      if (msPasses.has(this)) {
        let t = pipeTwin.get(p);
        if (!t) {
          const d = pipeDesc.get(p);
          if (!d) { off('pipeline without a 4x twin'); return spipe.call(this, p); }
          t = cpipe.call(device, d);   // not compiled yet: build it now (once)
          pipeTwin.set(p, t);
        }
        return spipe.call(this, t);
      }
      return spipe.call(this, p);
    };
    // any GPU error after this is switched on: switch it off (the game itself doesn't produce errors)
    const watch = new WeakSet();
    const reqDev = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...a) {
      const dev = await reqDev.apply(this, a);
      if (!watch.has(dev)) { watch.add(dev); dev.addEventListener('uncapturederror', (e) => off(e.error?.message || 'GPU error')); }
      return dev;
    };
  }

  // ---- keep the game smooth (automatic): only when a computer can't keep full speed in play
  // Frames are counted where the finished picture goes to the screen; only seconds with 3D drawing count (menus
  // and loading screens can be slow for other reasons). When play stays below full speed, the heaviest effect
  // eases off one step at a time, least visible first:
  //   1: Extra-smooth edges -> the light version (FXAA)
  //   2: draw at 85% of the screen's resolution, a little more sharpening; 3: 75%
  // A step that doesn't make it faster is undone (the computer is slow for another reason, e.g. its processor),
  // so no picture is given up for nothing. After a long stretch at full speed it tries one level up again. The
  // level that worked is reported to the app (console), which starts the game at it next time. Fast computers
  // never leave level 0.
  const SCALES = [1, 1, 0.85, 0.75];
  const FULL = 52, SOLID = 57;   // frames per second: below FULL is slow; SOLID is comfortably at full speed (60)
  const canvasEl = () => document.getElementById('canvas');
  function resize() {
    const c = canvasEl();
    if (!c || !window.c07?._c07_set_canvas_size) return;
    const r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const h = Math.max(480, Math.round(r.height * dpr * cfg.scale));
    const w = cfg.wide || cfg.stage ? Math.max(640, Math.round(r.width * dpr * cfg.scale)) : Math.max(640, Math.round(h * 4 / 3));
    if (c.width === w && c.height === h) return;
    c.width = w; c.height = h;
    window.c07._c07_set_canvas_size(w, h);
  }
  // a level is possible if it changes something here: no MSAA means no step 1; no smaller scale below 720 lines
  function possible(level) {
    if (level === 1) return !!(cfg.msaa && cfg.msaaWorks?.());
    const c = canvasEl();
    if (!c) return false;
    const lines = c.getBoundingClientRect().height * Math.min(window.devicePixelRatio || 1, 2);
    return lines * SCALES[level] >= 720;
  }
  function apply(level) {
    cfg.level = level;
    if (cfg.setMsaa) cfg.setMsaa(level < 1);
    cfg.scale = SCALES[level];
    cfg.sharpenBoost = level >= 2 ? 0.25 : 0;
    resize();
  }
  cfg.applyLevel = apply;
  let toastShown = false;
  function notice(text) {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9;padding:8px 18px;border-radius:99px;' +
      'background:rgba(0,0,0,.7);color:#fff;font:14px -apple-system,system-ui,sans-serif;pointer-events:none;opacity:0;transition:opacity .6s';
    document.body.appendChild(d);
    setTimeout(() => { d.style.opacity = '1'; }, 50);
    setTimeout(() => { d.style.opacity = '0'; }, 5000);
    setTimeout(() => d.remove(), 6000);
  }
  const report = () => console.log('[enhance] speed level ' + cfg.level);

  if (cfg.auto && cfg.level) {
    // start at the level that worked last time, once the game's canvas is there
    const wait = setInterval(() => { if (window.c07?._c07_set_canvas_size) { clearInterval(wait); apply(cfg.level); } }, 500);
  }
  cfg.setAuto = (on) => {
    cfg.auto = on;
    if (!on && cfg.level) { apply(0); report(); }
    plan = { state: 'watch', samples: [] };
  };

  // 3D drawing (passes with a depth buffer) marks the seconds that count
  const bpassSpeed = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function (d) {
    if (d && d.depthStencilAttachment) speed.scenes++;
    return bpassSpeed.call(this, d);
  };

  let plan = { state: 'watch', samples: [] }, stuck = false, meter = null, last = performance.now();
  let solidRun = 0;              // seconds of play in a row at full speed
  const probeFailed = new Set(); // levels this session couldn't go back up from
  const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
  const go = (level, state, extra) => { plan = { state, samples: [], from: cfg.level, ...extra }; apply(level); };
  setInterval(() => {
    const now = performance.now(), sec = (now - last) / 1000;
    last = now;
    const fps = speed.frames / sec, scene = speed.scenes > 0;
    speed.frames = 0; speed.scenes = 0;
    // frame-rate meter (Settings: Show frame rate)
    if (cfg.fps && !meter) {
      meter = document.createElement('div');
      meter.style.cssText = 'position:fixed;top:8px;right:10px;z-index:9;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.55);' +
        'color:#cfe9d6;font:12px ui-monospace,Menlo,monospace;pointer-events:none';
      document.body.appendChild(meter);
    }
    if (meter) {
      meter.style.display = cfg.fps ? '' : 'none';
      meter.textContent = `${Math.round(fps)} fps` + (cfg.level ? ` · smooth ${cfg.level}` : '');
    }
    if (!cfg.auto || document.hidden || !scene || sec > 3) { plan.samples = []; solidRun = 0; return; }
    plan.samples.push(fps);
    solidRun = fps >= SOLID ? solidRun + 1 : 0;
    // watching at a lower level: after a long stretch at full speed, try one level up (it may have been a
    // passing slowdown, or the computer is plugged in now)
    if (plan.state === 'watch' && cfg.level > 0 && solidRun >= 45 && !probeFailed.has(cfg.level)) {
      let up = cfg.level - 1;
      while (up > 0 && !possible(up)) up--;
      solidRun = 0;
      go(up, 'probe');
      console.warn(`[enhance] keep smooth: trying level ${up}`);
      return;
    }
    // seconds of play to judge by (the first second after a change is left out)
    const n = { watch: 8, verify: 5, probe: 8 }[plan.state];
    if (plan.samples.length < n + 1) return;
    const s = plan.samples.slice(1), med = median(s), slow = s.filter((f) => f < FULL).length;
    if (plan.state === 'watch') {
      plan.samples.shift();
      // steadily slow: most seconds below full speed (loading hiccups are a few slow seconds among fast ones)
      if (stuck || med >= FULL || slow < 6) return;
      let next = cfg.level + 1;
      while (next <= 3 && !possible(next)) next++;
      if (next > 3) return;
      go(next, 'verify', { before: med });
      console.warn(`[enhance] keep smooth: ${med.toFixed(1)} fps, level ${next}`);
    } else if (plan.state === 'verify') {
      // it must be clearly faster, or the step is undone and the picture stays as it was
      if (med < plan.before * 1.08 && med < SOLID) {
        console.warn(`[enhance] keep smooth: level ${cfg.level} didn't help (${med.toFixed(1)} fps), back to ${plan.from}`);
        go(plan.from, 'watch');
        stuck = true;
      } else {
        report();
        if (!toastShown) { toastShown = true; notice('Some picture effects eased off to keep the game smooth'); }
        plan = { state: 'watch', samples: [] };
      }
    } else {   // probe: one level up has to stay at full speed
      if (slow >= 3) {
        console.warn(`[enhance] keep smooth: level ${cfg.level} too slow (${med.toFixed(1)} fps), back to ${plan.from}`);
        probeFailed.add(plan.from);
        go(plan.from, 'watch');
      } else { report(); plan = { state: 'watch', samples: [] }; }
    }
  }, 1000);
})();
