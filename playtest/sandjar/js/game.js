// 画面、拖放、提示、结果页、试玩记录。规则都在 sim.js 里，这里只负责看和摸。
// 一份代码三个出口（docs/02 开头）：手指和鼠标都用 pointer 事件；震动、广告这些壳里的东西没有就不出现。
(() => {
  'use strict';
  const S = window.SandSim;
  const { CELL, COLS, ROWS, HEAD, W, H, RIM } = S;

  // 6 种沙色（2026-11-25 跟着 A「日落海边」换得更鲜艳，docs/07）：朱红、海蓝、金黄、翡翠绿、洋红紫、奶白沙。
  // 过了红/绿/蓝色弱模拟：任意两色在三种色弱下的色差都不低于 15.9（最近的一对是蓝和绿，在少见的蓝色弱下）
  const COLORS = [null, '#E5452F', '#2F8DE4', '#F6C433', '#23A86B', '#C94FB0', '#F4EEE2'];
  const WORDS = ['Nice!', 'Great!', 'Excellent!', 'Amazing!', 'Unbelievable!'];
  // 字：iPhone 自带的圆体（SF Pro Rounded），胖、圆，配奶白填色和可可棕描边（A 图的样子）
  const FONT = 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", system-ui, sans-serif';
  const font = (w, px) => w + ' ' + px + 'px ' + FONT;
  const CREAM = '#FFF4E2', COCOA = '#4A2C1C';
  // 颜色加深/变浅：k>1 往白混，k<1 往黑混
  const shadeHex = (hex, k) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const f = v => Math.round(k >= 1 ? v + (255 - v) * (k - 1) : v * k);
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  };

  // 第 2 批美术素材（docs/07 第六节）。没加载到就用代码画的替身，游戏照样能玩
  const IMG = {};
  for (const n of ['bg_sky', 'sill', 'cork', 'shell', 'starfish', 'tray_base', 'btn_sound_on', 'btn_sound_off']) {
    const im = new Image();
    im.onload = () => { IMG[n] = im; grainsDirty = true; };
    im.src = 'img/' + n + (n === 'bg_sky' || n === 'sill' ? '.jpg' : '.png');   // 背景和窗台不透明，用 jpg 省流量
  }

  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const pack = (r, g, b) => (255 << 24) | (Math.max(0, Math.min(255, b | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, r | 0));
  const BASE = COLORS.map(h => h ? pack(...rgb(h)) : 0);

  // 沙粒质感（docs/04：5px 的平色块不像沙）。模拟还是每格 8×8 粒；画的时候每粒再分成 K×K 个小点。
  // 每粒沙带着 16 种花纹里的一种（sim 里的 shade，跟着沙粒走），沙子流动时纹理跟着走，不会像隔着一层纱窗。
  // 明暗：每种花纹整体差 ±9%，小点之间再差 ±5%，少数花纹带一个亮点或暗点；色相也轻轻偏暖偏冷。
  // 颜色之间靠色相区分，明暗变化再大，薄薄一条接没接通也看得出来（截图看过）。
  const K = 3, VAR = 16, KK = K * K;
  const TILE = new Uint32Array(7 * VAR * KK), TILE_HI = new Uint32Array(7 * VAR * KK);
  // 沙面的光影（docs/07）：迎光的表面一层最亮，往下越深越暗，沙山看起来是立体的
  const DEPTH_K = [1.16, 1.07, 1.0, 0.94, 0.88];
  const TILE_L = DEPTH_K.map(() => new Uint32Array(7 * VAR * KK));
  {
    let a = 20261122;
    const r01 = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let v = 0; v < VAR; v++) {
      const base = (v / (VAR - 1) - 0.5) * 0.18, warm = (r01() - 0.5) * 0.06;
      const dots = [];
      for (let j = 0; j < KK; j++) dots.push(base + (r01() - 0.5) * 0.10);
      if (v % 6 === 1) dots[(r01() * KK) | 0] += 0.20;   // 亮点：沙子里反光的石英
      if (v % 5 === 3) dots[(r01() * KK) | 0] -= 0.16;   // 暗点
      for (let c = 1; c <= 6; c++) {
        const [r, g, b] = rgb(COLORS[c]);
        for (let j = 0; j < KK; j++) {
          const k = 1 + dots[j], o = (c * VAR + v) * KK + j;
          const R = r * k * (1 + warm), G = g * k, B = b * k * (1 - warm);
          TILE[o] = pack(R, G, B);
          for (let lv = 0; lv < DEPTH_K.length; lv++) {
            const q = DEPTH_K[lv], up = q > 1;
            TILE_L[lv][o] = up ? pack(R + (255 - R) * (q - 1), G + (255 - G) * (q - 1), B + (255 - B) * (q - 1)) : pack(R * q, G * q, B * q);
          }
          // 提示时亮一点：只往白色混 35%，混太多会被看成另一种颜色
          TILE_HI[o] = pack(R * 0.65 + 89, G * 0.65 + 89, B * 0.65 + 89);
        }
      }
    }
  }

  // 网址参数：?rec 是录短视频用的模式（tools/rec/，虚拟时钟、不弹结果页、不显示声音按钮）；?seed=N 固定种子
  const Q = new URLSearchParams(location.search);
  const REC = Q.has('rec'), SEED = Q.has('seed') ? (+Q.get('seed') >>> 0) : null;

  const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  const KW = W * K;
  const off = document.createElement('canvas'); off.width = KW; off.height = H * K;
  const octx = off.getContext('2d');
  const img = octx.createImageData(KW, H * K), px = new Uint32Array(img.data.buffer);
  const hiMask = new Uint8Array(W * H), depthCol = new Int16Array(W);
  let grainsDirty = true, lastHintOn = false;   // 沙子没动、提示没换的时候不重算沙子图

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 隐私模式下存不了也能玩 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* 同上 */ } },
  };
  function haptic(kind) {
    try {
      if (window.hybHaptic) window.hybHaptic(kind);
      else if (navigator.vibrate) navigator.vibrate(kind === 'heavy' ? 30 : kind === 'medium' ? 14 : 8);
    } catch (e) { /* 没有震动就算了 */ }
  }

  // ---------- 布局 ----------
  let L = {};
  function layout() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const vw = window.innerWidth, vh = window.innerHeight;
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gameW = Math.min(vw, vh * 0.62);                  // 电脑上也是竖屏，居中
    // 刘海/灵动岛和底部横条让开（进了全屏壳才不是 0）
    const cssv = k => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(k)) || 0;
    const sat = cssv('--sat'), sab = cssv('--sab');
    const hud = Math.max(84, vh * 0.1) + sat, tray = Math.max(120, vh * 0.2) + sab;
    const cs = Math.floor(Math.min((gameW - 36) / COLS, (vh - hud - tray - 10) / (ROWS + HEAD)));
    const jw = cs * COLS, jh = cs * (ROWS + HEAD);
    const jx = Math.round((vw - jw) / 2), jy = Math.round(hud);
    const trayY = jy + jh + 14, trayH = vh - trayY - 10 - sab;
    const sw = Math.min(gameW - 12, jw + 40) / 3, sx = (vw - sw * 3) / 2;
    L = { vw, vh, top: sat, cs, gp: cs / CELL, jx, jy, jw, jh, rimY: jy + HEAD * cs, trayY, trayH,
      slots: [0, 1, 2].map(i => ({ x: sx + sw * i, y: trayY, w: sw, h: trayH })),
      snd: { x: (vw + gameW) / 2 - 46, y: 14 + sat, w: 36, h: 36 } };
  }

  // ---------- 一局 ----------
  let st, drag = null, popups = [], flashes = [], overAt = 0, lastColors = 3, tutFirstX = -1;
  // 消除反馈（docs/06：学 Sand Blast 把反馈做大）：整屏闪成被消的颜色、震一下、沙粒迸散、连击大字
  let bgFlash = null, shake = null, sparks = [], comboBanner = null;
  // 分数：放大以后加一条「下一个里程碑」进度条；分数数字滚动着往上涨
  const MILESTONES = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
  let mileIdx = 0, shownScore = 0, lastHudNow = 0;
  let run = null;   // 试玩记录里的这一局
  let best = +store.get('sand1-best', 0) || 0;

  function start() {
    const tutorial = REC ? Q.has('tut') : store.get('sand1-tut', '0') !== '1';
    st = S.create(SEED != null ? SEED : (Date.now() ^ (Math.random() * 1e9)) >>> 0, { tutorial });
    grainsDirty = true;
    st.events.length = 0;
    drag = null; popups = []; flashes = []; overAt = 0; lastColors = S.CFG.start; tutFirstX = -1;
    bgFlash = null; shake = null; sparks = []; comboBanner = null; mileIdx = 0; shownScore = 0;
    run = { at: new Date().toISOString(), t0: performance.now(), firstClear: null, tutorial };
    document.getElementById('over').classList.add('hide');
  }

  const recEvents = [];   // 录制模式下记下每次消除、加色、结束的时间，给剪视频的人找高光
  function onEvent(e, now) {
    grainsDirty = true;
    if (REC && e.type !== 'land') recEvents.push({ t: +now.toFixed(2), type: e.type, combo: e.combo, pts: e.pts, colors: e.colors });
    if (e.type === 'land') {
      Snd.land(S.SHAPES[e.s].cells.length); haptic('light');
      if (st.tutorial && tutFirstX < 0) tutFirstX = e.x;
      addPopup({ text: '+' + e.pts, sub: '', x: L.jx + (e.x + S.shapeW(e.s) * CELL / 2) * L.gp, y: L.jy + e.y * L.gp, t0: now, c: CREAM, small: true });
    } else if (e.type === 'clear') {
      const cells = [], cols = [];
      for (const p of e.parts) for (const i of p.cells) { cells.push(i); cols.push(p.c); }
      flashes.push({ cells, cols, t0: now });
      const col = COLORS[e.parts[0].c];
      bgFlash = { c: col, t0: now, k: Math.min(1, 0.45 + 0.15 * e.combo) };
      shake = { t0: now, amp: 2 + 2 * e.combo };
      spawnSparks(cells, cols, now);
      if (e.combo >= 2) comboBanner = { n: e.combo, t0: now };
      let sx = 0, sy = 0;
      for (let k = 0; k < cells.length; k += 7) { sx += cells[k] % W; sy += (cells[k] / W) | 0; }
      const m = Math.ceil(cells.length / 7);
      addPopup({ text: WORDS[e.combo - 1], sub: '+' + e.pts, x: L.jx + sx / m * L.gp, y: L.jy + sy / m * L.gp, t0: now, c: COLORS[e.parts[0].c] });
      Snd.clear(e.combo); haptic(e.combo > 1 ? 'heavy' : 'medium');
      if (run.firstClear == null) run.firstClear = +((performance.now() - run.t0) / 1000).toFixed(1);
      if (st.tutorial) store.set('sand1-tut', '1');
    } else if (e.type === 'deal') {
      if (e.colors && e.colors > lastColors) {
        lastColors = e.colors;
        addPopup({ text: 'New color!', sub: '', x: L.vw / 2, y: L.trayY - 10, t0: now, c: COLORS[e.colors] });
      }
    } else if (e.type === 'over') {
      overAt = now; Snd.over(); haptic('heavy');
      finishRun();
      if (!REC) setTimeout(showOver, 700);
    }
  }

  function tick(now) {
    S.step(st);
    if (st.moving || st.falling.length) grainsDirty = true;
    for (const e of st.events) onEvent(e, now);
    st.events.length = 0;
  }

  // ---------- 结果页和试玩记录 ----------
  function showOver() {
    const isBest = st.score > best;
    if (isBest) { best = st.score; store.set('sand1-best', String(best)); }
    document.getElementById('ovScore').textContent = st.score.toLocaleString('en-US');
    document.getElementById('ovBest').innerHTML = isBest && st.score > 0 ? '<span class="new">NEW BEST!</span>' : 'Best ' + best.toLocaleString('en-US');
    document.getElementById('over').classList.remove('hide');
    run.overShown = performance.now();
  }
  function readLog() { try { return JSON.parse(store.get('sand1-log', '[]')) || []; } catch (e) { return []; } }
  function finishRun() {
    run.sec = +((performance.now() - run.t0) / 1000).toFixed(1);
    run.pieces = st.placed; run.score = st.score; run.clears = st.clears; run.colors = S.colorsAt(st.placed);
  }
  function record(retry) {
    const r = { at: run.at, tutorial: run.tutorial, sec: run.sec, firstClear: run.firstClear, pieces: run.pieces, score: run.score, clears: run.clears, colors: run.colors, retrySec: retry };
    if (!st.over) r.quit = true;   // 没玩完就走了
    return r;
  }
  function pushLog(r) {
    const log = readLog();
    log.push(r);
    store.set('sand1-log', JSON.stringify(log.slice(-100)));
  }
  document.getElementById('again').addEventListener('click', () => {
    Snd.unlock();
    store.del('sand1-cur');
    pushLog(record(+((performance.now() - run.overShown) / 1000).toFixed(1)));
    start();
  });
  // 切走或关掉页面时，先把这一局记在 sand1-cur；回来接着玩就删掉，没回来的话下次打开时并进记录。
  // 这样玩到一半关掉的（quit）、结束了没点再来一局的（retrySec 为 null）都不会漏，iPhone 上直接划掉 Safari 也算。
  function parkRun() {
    if (!st || !run || (!st.over && st.placed === 0)) return;
    if (st.over) { if (run.sec == null) return; } else finishRun();
    store.set('sand1-cur', JSON.stringify(record(null)));
  }
  window.addEventListener('pagehide', parkRun);
  document.addEventListener('visibilitychange', () => { if (document.hidden) parkRun(); else store.del('sand1-cur'); });
  try { const cur = JSON.parse(store.get('sand1-cur', 'null')); if (cur) pushLog(cur); } catch (e) { /* 坏了就算了 */ }
  store.del('sand1-cur');

  // 网址带 ?log 时显示试玩记录（docs/02 第八节：多久第一次消、第一局多长、有没有自己再来一局）
  if (/[?&]log\b/.test(location.search)) {
    const log = readLog();
    const firsts = log.filter(r => r.tutorial);
    const retried = log.filter(r => r.retrySec != null).length;
    const quits = log.filter(r => r.quit).length;
    document.getElementById('logSum').textContent =
      `${log.length} runs · first-run length ${firsts.map(r => r.sec + 's').join(', ') || '-'} · first clear ${firsts.map(r => r.firstClear == null ? 'none' : r.firstClear + 's').join(', ') || '-'} · played again ${retried}/${log.length} · quit mid-run ${quits}`;
    document.getElementById('logTxt').value = JSON.stringify(log, null, 1);
    document.getElementById('log').classList.remove('hide');
    document.getElementById('logCopy').addEventListener('click', () => {
      const t = document.getElementById('logTxt'), b = document.getElementById('logCopy');
      const done = () => { b.textContent = 'Copied'; };
      const old = () => { t.focus(); t.select(); t.setSelectionRange(0, t.value.length); try { document.execCommand('copy'); done(); } catch (e) { /* 手动长按复制 */ } };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.value).then(done, old); else old();
    });
  }

  // ---------- 拖放 ----------
  function pieceSize(s) { const sh = S.SHAPES[s]; return { w: sh.w, h: sh.h }; }
  function pointOf(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

  function updateDrag() {
    const p = st.tray[drag.slot];
    if (!p) { drag = null; return; }
    const { w, h } = pieceSize(p.s);
    drag.left = drag.x - w * L.cs / 2;
    drag.top = drag.y - L.cs * 1.5 - h * L.cs;            // 块浮在手指上方 1.5 格，不被手指挡住
    drag.valid = drag.y < L.trayY - 6;                      // 拖回底盘就是取消
    const col = S.clampCol(p.s, Math.round((drag.left - L.jx) / L.cs));
    drag.col = col;   // 预览在 drawGhost 里按需重算
  }

  // 落点预览：在副本上把这一块放下去跑到停稳，画出它的沙子最后会在哪（docs/04：影子要说真话）。
  // 换了列、沙子停稳/开始流的时候重算；沙子还在流就每 12 步重算一次
  const goff = document.createElement('canvas'); goff.width = W; goff.height = H;
  const gctx = goff.getContext('2d'), gimg = gctx.createImageData(W, H), gpx = new Uint32Array(gimg.data.buffer);
  function refreshPreview() {
    const set = S.settled(st);
    const pv = drag.pv;
    if (pv && pv.col === drag.col && pv.set === set && (set || st.tick - pv.tick < 12)) return;
    const r = S.preview(st, drag.slot, drag.col, 240);
    drag.pv = { col: drag.col, set, tick: st.tick, r };
    drag.glow = !!(r && r.clear);
    if (r) {
      const c = BASE[st.tray[drag.slot].c];
      for (let i = 0; i < W * H; i++) gpx[i] = r.mask[i] ? c : 0;
      gctx.putImageData(gimg, 0, 0);
    }
  }

  cv.addEventListener('pointerdown', e => {
    Snd.unlock();
    if (!st || st.over) return;
    const p = pointOf(e);
    if (inRect(p, L.snd)) { Snd.toggle(); return; }
    for (let i = 0; i < 3; i++) {
      if (st.tray[i] && inRect(p, L.slots[i])) {
        drag = { slot: i, x: p.x, y: p.y, col: null, glow: false };
        updateDrag();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器 */ }
        Snd.pick(); haptic('light');
        return;
      }
    }
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = pointOf(e); drag.x = p.x; drag.y = p.y;
    updateDrag();
  });
  function release() {
    if (!drag) return;
    if (drag.valid && !st.over) {
      const y0 = Math.round((drag.top - L.jy) / L.gp);
      S.drop(st, drag.slot, drag.col, y0);
    }
    drag = null;
  }
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', () => { drag = null; });

  // ---------- 画 ----------
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  // 方块的颜色：亮面、本色、暗面、描边（按颜色缓存）
  const PIECE_COL = COLORS.map(h => h && { hi: shadeHex(h, 1.38), mid: h, lo: shadeHex(h, 0.72), edge: shadeHex(h, 0.45) });
  function drawPiece(s, c, x, y, size, alpha) {
    const sh = S.SHAPES[s], P = PIECE_COL[c], r = size * 0.2, gap = Math.max(1, size * 0.05);
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    for (const [cx, cy] of sh.cells) {
      const px0 = x + cx * size + gap / 2, py0 = y + cy * size + gap / 2, sz = size - gap;
      // 底色：上亮下暗的渐变，像一块糖
      const g = ctx.createLinearGradient(0, py0, 0, py0 + sz);
      g.addColorStop(0, P.hi); g.addColorStop(0.45, P.mid); g.addColorStop(1, P.lo);
      ctx.fillStyle = g; roundRect(px0, py0, sz, sz, r); ctx.fill();
      ctx.lineWidth = Math.max(1, size * 0.06); ctx.strokeStyle = P.edge; ctx.stroke();
      // 左上一道高光
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      roundRect(px0 + sz * 0.16, py0 + sz * 0.12, sz * 0.5, sz * 0.14, sz * 0.07); ctx.fill();
    }
    ctx.restore();
  }

  function drawGrains(now) {
    // 快接通的那片沙一闪一闪地发亮（docs/02 第一节：规则自己会说话）
    const hintOn = !st.over && st.hints.length > 0 && (Math.sin(now * 6) + 1) / 2 > 0.35;
    flashes = flashes.filter(f => now - f.t0 < FLASH_T);
    if (grainsDirty || hintOn !== lastHintOn || flashes.length) {
      grainsDirty = false; lastHintOn = hintOn;
      const g = st.grid, sd = st.shade;
      if (hintOn) { hiMask.fill(0); for (const h of st.hints) for (const i of h.cells) hiMask[i] = 1; }
      depthCol.fill(0);
      for (let y = 0, i = 0; y < H; y++) {
        for (let x = 0; x < W; x++, i++) {
          let o = y * K * KW + x * K;
          const c = g[i];
          if (!c) { depthCol[x] = 0; for (let a = 0; a < K; a++, o += KW) for (let b = 0; b < K; b++) px[o + b] = 0; continue; }
          const d = y > 0 && g[i - W] ? ++depthCol[x] : (depthCol[x] = 0);
          const T = hintOn && hiMask[i] ? TILE_HI : TILE_L[d === 0 ? 0 : d <= 2 ? 1 : d <= 10 ? 2 : d <= 22 ? 3 : 4];
          let t = (c * VAR + sd[i]) * KK;
          for (let a = 0; a < K; a++, o += KW) for (let b = 0; b < K; b++) px[o + b] = T[t++];
        }
      }
      // 刚消掉的沙：先亮成浅色，再在 0.35 秒里淡掉（同时沙粒迸散，见 spawnSparks）
      for (const f of flashes) {
        const alpha = Math.max(0, 1 - (now - f.t0) / FLASH_T);
        const a8 = (alpha * alpha * 255) << 24;
        for (let n = 0; n < f.cells.length; n++) {
          const i = f.cells[n];
          if (g[i]) continue;
          let o = ((i / W) | 0) * K * KW + (i % W) * K, t = (f.cols[n] * VAR + (i & 15)) * KK;
          for (let a = 0; a < K; a++, o += KW) for (let b = 0; b < K; b++) px[o + b] = ((TILE_HI[t++] & 0x00FFFFFF) | a8) >>> 0;
        }
      }
      octx.putImageData(img, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, L.jx, L.jy, L.jw, L.jh);
  }

  const FLASH_T = 0.35;

  // 消除时从消掉的沙里迸出一把亮沙粒，往上飞再落下。位置只跟时间有关（不用 Math.random），录视频时一帧不差
  function spawnSparks(cells, cols, now) {
    let r = (st.tick * 7919 + st.clears * 104729) >>> 0;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    const n = Math.min(120, 30 + (cells.length >> 4));
    for (let k = 0; k < n; k++) {
      const j = (rnd() * cells.length) | 0, i = cells[j];
      sparks.push({ x: L.jx + (i % W + 0.5) * L.gp, y: L.jy + (((i / W) | 0) + 0.5) * L.gp,
        vx: (rnd() - 0.5) * 220, vy: -60 - rnd() * 280, life: 0.55 + rnd() * 0.4, t0: now, c: cols[j] });
    }
  }
  function drawSparks(now) {
    sparks = sparks.filter(p => now - p.t0 < p.life);
    for (const p of sparks) {
      const t = now - p.t0, a = 1 - t / p.life, sz = L.gp * (0.7 + 0.9 * a);
      ctx.globalAlpha = a;
      ctx.fillStyle = COLORS[p.c];
      ctx.fillRect(p.x + p.vx * t - sz / 2, p.y + p.vy * t + 520 * t * t - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  // 连击 2 次以上：瓶子上方一行彩虹色大字，先放大再落回
  function drawComboBanner(now) {
    if (!comboBanner || st.over) return;
    const t = (now - comboBanner.t0) / 1.0;
    if (t >= 1) { comboBanner = null; return; }
    const sc = t < 0.15 ? 1.5 - (t / 0.15) * 0.5 : 1, a = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
    const text = 'COMBO ×' + comboBanner.n, x = L.vw / 2, y = L.jy + L.cs * 2.2;
    ctx.save();
    ctx.globalAlpha = a; ctx.translate(x, y); ctx.scale(sc, sc);
    ctx.font = font(900, Math.round(Math.min(50, L.jw / 6.5)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = parseFloat(ctx.font), grad = ctx.createLinearGradient(0, -fs / 2, 0, fs / 2);
    grad.addColorStop(0, '#FFFBF0'); grad.addColorStop(0.55, CREAM); grad.addColorStop(1, '#FFD27A');
    ctx.shadowColor = 'rgba(255,170,60,0.9)'; ctx.shadowBlur = 18;
    ctx.lineWidth = 10; ctx.strokeStyle = COCOA; ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
    ctx.shadowBlur = 0;
    ctx.fillStyle = grad; ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // 第一局：瓶口里一行字把规则说出来（docs/06：三款竞品都用字讲，我们原来只有一只手）
  function drawRuleLine(now) {
    if (!st.tutorial || st.clears || st.over) return;
    const text = 'Connect one color wall to wall';
    ctx.save();
    let fs = 19;
    ctx.font = font(900, fs);
    const w = ctx.measureText(text).width, room = L.jw - 70;
    if (w > room) { fs = Math.floor(fs * room / w); ctx.font = font(900, fs); }
    const y = L.rimY + L.cs * 1.7, a = 0.75 + 0.25 * Math.sin(now * 4);   // 瓶子里、瓶口线下面（教学手拖的块在瓶口上面，不会压住字）
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = a; outlined(text, L.vw / 2, y, fs, 900, CREAM, COCOA, 4.5);
    ctx.fillStyle = CREAM; ctx.strokeStyle = COCOA; ctx.lineWidth = 2;
    // 两头的箭头指着两边墙
    const ax = L.cs * 0.45;
    ctx.beginPath();
    ctx.moveTo(L.jx + 8, y); ctx.lineTo(L.jx + 8 + ax, y - ax * 0.7); ctx.lineTo(L.jx + 8 + ax, y + ax * 0.7); ctx.closePath();
    ctx.moveTo(L.jx + L.jw - 8, y); ctx.lineTo(L.jx + L.jw - 8 - ax, y - ax * 0.7); ctx.lineTo(L.jx + L.jw - 8 - ax, y + ax * 0.7); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  // 背景：日落天空（bg_sky 铺满，没加载到就用渐变替身）
  function drawBackdrop() {
    const { vw, vh } = L, im = IMG.bg_sky;
    if (im) {
      const k = Math.max(vw / im.width, vh / im.height), w = im.width * k, h = im.height * k;
      ctx.drawImage(im, (vw - w) / 2, (vh - h) / 2, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, vh);
      g.addColorStop(0, '#F7A98F'); g.addColorStop(0.45, '#D98AA6'); g.addColorStop(0.75, '#8E6AA8'); g.addColorStop(1, '#5E4A86');
      ctx.fillStyle = g; ctx.fillRect(0, 0, vw, vh);
    }
  }
  // 窗台：瓶子和三个底座都放在上面。台面那条线对齐瓶底，不管屏幕多高
  function sillTop() { return L.jy + L.jh + L.cs * 0.32; }
  function drawSill() {
    const { vw, vh } = L, top = sillTop(), im = IMG.sill;
    if (im) {
      // 宽度至少铺满屏幕；屏幕下面剩得多就按高度放大，左右裁掉一点，不露出平涂的底色
      const face = im.height * 0.075;   // 台面中线在图里的位置（相对图高）
      let k = vw / im.width;
      const need = vh - top + face * k + 2;
      if (im.height * k < need) k = need / im.height;
      const w = im.width * k, h = im.height * k;
      ctx.drawImage(im, (vw - w) / 2, top - face * k, w, h);
    } else {
      ctx.fillStyle = '#C98B57'; ctx.fillRect(0, top - L.cs * 0.25, vw, L.cs * 0.5);
      const g = ctx.createLinearGradient(0, top + L.cs * 0.25, 0, vh);
      g.addColorStop(0, '#9A5E36'); g.addColorStop(1, '#6A3D22');
      ctx.fillStyle = g; ctx.fillRect(0, top + L.cs * 0.25, vw, vh);
    }
    // 软木塞和小贝壳：一个在瓶子右后方，一个在左边，一半藏在瓶子后面
    const deco = (im, w, x) => { if (!im) return; const h = im.height * (w / im.width); ctx.drawImage(im, x, top - h * 0.72, w, h); };
    deco(IMG.cork, L.cs * 1.9, L.jx + L.jw - L.cs * 0.6);
    deco(IMG.shell, L.cs * 1.15, L.jx - L.cs * 0.75);
  }

  function jarClip() {
    const { jx, jw, jy, jh, cs } = L, bottom = jy + jh, r = cs * 0.7;
    ctx.beginPath(); ctx.moveTo(jx, 0); ctx.lineTo(jx, bottom - r); ctx.quadraticCurveTo(jx, bottom, jx + r, bottom);
    ctx.lineTo(jx + jw - r, bottom); ctx.quadraticCurveTo(jx + jw, bottom, jx + jw, bottom - r); ctx.lineTo(jx + jw, 0); ctx.closePath();
  }

  // 瓶子的外形：直壁、圆底角的宽口瓶，d 是往外扩多少（画玻璃厚度用）
  function jarPath(d, topY) {
    const { jx, jw, jy, jh, cs } = L, bottom = jy + jh + d, r = cs * 0.7 + d, x0 = jx - d, x1 = jx + jw + d;
    ctx.beginPath(); ctx.moveTo(x0, topY); ctx.lineTo(x0, bottom - r); ctx.quadraticCurveTo(x0, bottom, x0 + r, bottom);
    ctx.lineTo(x1 - r, bottom); ctx.quadraticCurveTo(x1, bottom, x1, bottom - r); ctx.lineTo(x1, topY); ctx.closePath();
  }
  function drawJar(now, front) {
    const { jx, jw, rimY, jy, jh, cs } = L, bottom = jy + jh, t = Math.max(4, cs * 0.26);
    if (!front) {
      // 瓶底在窗台上的投影
      ctx.fillStyle = 'rgba(40,20,10,0.35)';
      ctx.beginPath(); ctx.ellipse(jx + jw / 2, sillTop() + t * 0.3, jw / 2 + t * 2.2, t * 1.6, 0, 0, Math.PI * 2); ctx.fill();
      // 玻璃本身：外壁一圈
      jarPath(t, rimY);
      const gw = ctx.createLinearGradient(jx - t, 0, jx + jw + t, 0);
      gw.addColorStop(0, 'rgba(255,236,214,0.55)'); gw.addColorStop(0.5, 'rgba(255,236,214,0.18)'); gw.addColorStop(1, 'rgba(255,200,150,0.5)');
      ctx.fillStyle = gw; ctx.fill();
      // 瓶里：把背景压暗一点，沙子的颜色才跳得出来（docs/07：日落的粉紫会跟紫沙、红沙抢眼）
      jarPath(0, rimY);
      const gi = ctx.createLinearGradient(0, rimY, 0, bottom);
      gi.addColorStop(0, 'rgba(70,36,52,0.16)'); gi.addColorStop(1, 'rgba(50,24,30,0.32)');
      ctx.fillStyle = gi; ctx.fill();
      return;
    }
    ctx.save();
    // 玻璃厚壁：外沿一道暖色描边，里沿一道亮线
    jarPath(t, rimY); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(110,60,30,0.55)'; ctx.stroke();
    jarPath(1, rimY); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,245,230,0.55)'; ctx.stroke();
    // 高光：左边一长条、右边一短条，像晚霞照在玻璃上
    const hl = (x, y0, y1, w, a) => {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,250,240,' + a + ')'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; roundRect(x, y0, w, y1 - y0, w / 2); ctx.fill();
    };
    hl(jx + cs * 0.18, rimY + cs * 0.5, bottom - cs * 1.6, cs * 0.34, 0.42);
    hl(jx + cs * 0.62, rimY + cs * 0.8, rimY + cs * 3.2, cs * 0.14, 0.3);
    hl(jx + jw - cs * 0.5, rimY + cs * 1.2, rimY + cs * 4.5, cs * 0.2, 0.32);
    // 底部厚玻璃：一道亮弧
    ctx.strokeStyle = 'rgba(255,240,220,0.5)'; ctx.lineWidth = t * 0.5;
    ctx.beginPath(); ctx.moveTo(jx + cs * 0.9, bottom + t * 0.45); ctx.lineTo(jx + jw - cs * 0.9, bottom + t * 0.45); ctx.stroke();
    // 瓶口：一圈加厚的玻璃唇，比瓶身宽一点；沙子快到瓶口时变红闪
    const danger = S.danger(st) && !st.over;
    const red = danger ? 0.45 + 0.55 * ((Math.sin(now * 10) + 1) / 2) : 0;
    const lipH = t * 1.5, lx = jx - t * 1.7, lw = jw + t * 3.4, ly = rimY - lipH;
    const gl = ctx.createLinearGradient(0, ly, 0, ly + lipH);
    gl.addColorStop(0, 'rgba(255,250,240,0.85)'); gl.addColorStop(0.5, 'rgba(255,225,190,0.45)'); gl.addColorStop(1, 'rgba(200,140,100,0.55)');
    ctx.fillStyle = gl; roundRect(lx, ly, lw, lipH, lipH / 2); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = danger ? 'rgba(230,60,40,' + red + ')' : 'rgba(110,60,30,0.6)'; ctx.stroke();
    if (danger) { ctx.shadowColor = 'rgba(255,60,40,0.9)'; ctx.shadowBlur = 14 * red; ctx.stroke(); ctx.shadowBlur = 0; }
    // 瓶口线：一条细虚线，越过就输
    ctx.strokeStyle = danger ? 'rgba(230,60,40,' + red + ')' : 'rgba(255,240,225,0.45)';
    ctx.lineWidth = danger ? 2.5 : 1.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(jx + 6, rimY + 2); ctx.lineTo(jx + jw - 6, rimY + 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawHints(now) {
    if (st.over) return;
    // 另一边墙上对应的位置亮成这片沙的颜色：告诉玩家「接到这边就消」
    const a = 0.45 + 0.55 * ((Math.sin(now * 6) + 1) / 2);
    for (const h of st.hints) {
      const y = L.jy + h.row * L.gp, x = h.side === 'R' ? L.jx + L.jw - 7 : L.jx + 1;
      ctx.globalAlpha = a; ctx.fillStyle = COLORS[h.c];
      ctx.shadowColor = COLORS[h.c]; ctx.shadowBlur = 12;
      roundRect(x, y - L.cs * 0.7, 6, L.cs * 1.4, 3); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
  }

  function drawFalling() {
    for (const f of st.falling) drawPiece(f.s, f.c, L.jx + f.x * L.gp, L.jy + f.y * L.gp, L.cs);
  }

  function drawGhost(now) {
    if (!drag || !drag.valid) return;
    const p = st.tray[drag.slot]; if (!p) return;
    refreshPreview();
    if (!drag.pv.r) return;
    ctx.save(); jarClip(); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    if (drag.glow) {
      // 能消：沙形一亮一亮，带白色光晕
      ctx.globalAlpha = 0.55 + 0.4 * ((Math.sin(now * 9) + 1) / 2);
      ctx.shadowColor = '#fff'; ctx.shadowBlur = 14;
    } else {
      ctx.globalAlpha = 0.42;
    }
    ctx.drawImage(goff, L.jx, L.jy, L.jw, L.jh);
    ctx.restore();
  }

  function drawTrayBase(sl) {
    const im = IMG.tray_base, w = Math.min(sl.w - 8, L.cs * 3.3), cx = sl.x + sl.w / 2;
    if (im) {
      const h = im.height * (w / im.width);
      ctx.drawImage(im, cx - w / 2, sl.y + sl.h * 0.52 - h * 0.5, w, h);
    } else {
      const h = w * 0.62, y = sl.y + sl.h * 0.52 - h / 2;
      ctx.fillStyle = 'rgba(40,20,10,0.35)'; roundRect(cx - w / 2 + 2, y + 6, w, h, 14); ctx.fill();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#D9A070'); g.addColorStop(1, '#9C5E34');
      ctx.fillStyle = g; roundRect(cx - w / 2, y, w, h, 14); ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = COCOA; ctx.stroke();
    }
  }
  function drawTray() {
    if (st.over) return;   // 结束了底盘让给结果卡片
    for (let i = 0; i < 3; i++) drawTrayBase(L.slots[i]);
    for (let i = 0; i < 3; i++) {
      const sl = L.slots[i], p = st.tray[i];
      if (!p) continue;
      const { w, h } = pieceSize(p.s);
      const size = Math.min(L.cs * 0.6, (sl.w - 24) / 4, (sl.h - 24) / 4);
      const x = sl.x + (sl.w - w * size) / 2, y = sl.y + sl.h * 0.47 - h * size / 2;
      drawPiece(p.s, p.c, x, y, size, drag && drag.slot === i ? 0.25 : 1);
    }
  }

  function drawDrag() {
    if (!drag) return;
    const p = st.tray[drag.slot]; if (!p) return;
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 4;
    drawPiece(p.s, p.c, drag.left, drag.top, L.cs, drag.valid ? 1 : 0.6);
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  }

  // 奶白填色 + 可可棕描边的字（A 图的样子）
  function outlined(text, x, y, px, w, fill, stroke, lw) {
    ctx.font = font(w, px); ctx.lineJoin = 'round';
    ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.strokeText(text, x, y);
    ctx.fillStyle = fill; ctx.fillText(text, x, y);
  }
  const kfmt = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1000 ? (v / 1000) + 'K' : String(v);
  function drawHud(now) {
    // 分数滚着往上涨，不是一下跳过去
    const dt = Math.min(0.1, Math.max(0, now - lastHudNow)); lastHudNow = now;
    shownScore += (st.score - shownScore) * Math.min(1, dt * 10);
    if (Math.abs(st.score - shownScore) < 1) shownScore = st.score;
    // 过了里程碑：金色大字、整屏闪金色
    while (mileIdx < MILESTONES.length && st.score >= MILESTONES[mileIdx]) {
      addPopup({ text: kfmt(MILESTONES[mileIdx]) + '!', sub: 'Milestone', x: L.vw / 2, y: L.rimY + L.cs * 2.8, t0: now, c: '#D9A21B' });   // 瓶子上半截，跟瓶口上方的 COMBO 大字错开
      bgFlash = { c: '#F2C230', t0: now, k: 0.8 };
      mileIdx++;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.save(); ctx.shadowColor = 'rgba(60,20,10,0.35)'; ctx.shadowOffsetY = 2; ctx.shadowBlur = 4;
    outlined(Math.round(shownScore).toLocaleString('en-US'), L.vw / 2, L.top + 42, 36, 900, CREAM, COCOA, 7);
    ctx.restore();
    outlined('BEST ' + Math.max(best, st.score).toLocaleString('en-US'), L.vw / 2, L.top + 58, 12, 800, CREAM, COCOA, 3.5);
    // 下一个里程碑：一条细进度条，右边写着目标
    if (mileIdx < MILESTONES.length) {
      const prev = mileIdx ? MILESTONES[mileIdx - 1] : 0, next = MILESTONES[mileIdx];
      const f = Math.max(0, Math.min(1, (shownScore - prev) / (next - prev)));
      const bw = Math.min(150, L.jw * 0.44), bh = 9, bx = L.vw / 2 - bw / 2, by = L.top + 65;
      ctx.fillStyle = 'rgba(60,30,20,0.55)'; roundRect(bx, by, bw, bh, bh / 2); ctx.fill();
      if (f > 0) {
        const g = ctx.createLinearGradient(0, by, 0, by + bh);
        g.addColorStop(0, '#FFE08A'); g.addColorStop(1, '#E39B1E');
        ctx.fillStyle = g; roundRect(bx, by, Math.max(bh, bw * f), bh, bh / 2); ctx.fill();
      }
      ctx.lineWidth = 2; ctx.strokeStyle = COCOA; roundRect(bx, by, bw, bh, bh / 2); ctx.stroke();
      ctx.textAlign = 'left';
      outlined(kfmt(next), bx + bw + 7, by + bh, 12, 900, CREAM, COCOA, 3.5);
      ctx.textAlign = 'center';
    }
    // 现在有几种颜色
    const n = S.colorsAt(st.placed), d = 11;
    for (let c = 1; c <= n; c++) {
      ctx.fillStyle = COLORS[c]; ctx.strokeStyle = COCOA; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(L.jx + 8 + (c - 1) * (d + 5), L.top + 36, d / 2, 0, 7); ctx.fill(); ctx.stroke();
    }
    // 声音开关（录视频时不画）
    if (REC) return;
    const s = L.snd, im = Snd.on ? IMG.btn_sound_on : IMG.btn_sound_off;
    if (im) ctx.drawImage(im, s.x - 2, s.y - 2, s.w + 4, s.h + 4);
    else {
      ctx.fillStyle = '#B9774A'; ctx.strokeStyle = COCOA; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, 0, 7); ctx.fill(); ctx.stroke();
      ctx.textBaseline = 'middle'; outlined(Snd.on ? '♪' : '♪̸', s.x + s.w / 2, s.y + s.h / 2 + 1, 20, 900, CREAM, COCOA, 3); ctx.textBaseline = 'alphabetic';
      if (!Snd.on) { ctx.strokeStyle = CREAM; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(s.x + 9, s.y + 9); ctx.lineTo(s.x + s.w - 9, s.y + s.h - 9); ctx.stroke(); }
    }
  }

  // 同时冒出来的字不叠在一起：跟还没飘走的字挨得太近，就往上挪一行（两次消除同一瞬间、消除又赶上加色时会这样）
  function addPopup(p) {
    for (let moved = true, n = 0; moved && n < 6; n++) {
      moved = false;
      for (const q of popups) {
        if (!q.small !== !p.small) continue;
        const qy = q.y - 40 * Math.min(1, (p.t0 - q.t0) / 1.1);   // q 此刻已经飘到的高度
        if (p.t0 - q.t0 < 0.9 && Math.abs(p.x - q.x) < 170 && Math.abs(p.y - qy) < 48) { p.y = qy - 50; moved = true; }
      }
    }
    popups.push(p);
  }

  function drawPopups(now) {
    popups = popups.filter(p => now - p.t0 < 1.1);
    ctx.textAlign = 'center';
    for (const p of popups) {
      const t = (now - p.t0) / 1.1, y = p.y - 40 * t;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      if (p.small) {   // 放一块的飘分：小、奶白、不抢眼
        outlined(p.text, p.x, y, 16, 900, CREAM, 'rgba(74,44,28,0.85)', 4);
        ctx.globalAlpha = 1;
        continue;
      }
      outlined(p.text, p.x, y, 32, 900, p.c, COCOA, 7);
      if (p.sub) outlined(p.sub, p.x, y + 24, 18, 900, CREAM, COCOA, 5);
      ctx.globalAlpha = 1;
    }
  }

  // 第一局只有一只手示范拖放，没有说明文字（docs/02 第一节）
  function drawHand(now) {
    if (!st.tutorial || st.placed >= 2 || drag || st.over || st.clears) return;
    const slot = st.tray[0] ? 0 : 1;
    if (!st.tray[slot]) return;
    const col = st.placed === 0 ? 0 : (tutFirstX >= 0 && tutFirstX < W / 2 ? 4 : 0);
    const sl = L.slots[slot];
    const t = (now % 1.8) / 1.8, k = Math.min(1, Math.max(0, (t - 0.15) / 0.55)), e = k * k * (3 - 2 * k);
    const x0 = sl.x + sl.w / 2, y0 = sl.y + sl.h / 2;
    const x1 = L.jx + (col + 2) * L.cs, y1 = L.rimY - L.cs * 0.5;
    const x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e;
    ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
    if (k > 0) drawPiece('I4h', 1, x - 2 * L.cs, y - L.cs * 2.5, L.cs, 0.5);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.strokeStyle = '#3B2F25'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x, y, 15, 0, 7); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function draw(now) {
    drawBackdrop();
    if (bgFlash) {   // 整屏闪成被消的颜色，0.7 秒淡回去
      const t = (now - bgFlash.t0) / 0.7;
      if (t >= 1) bgFlash = null;
      else { ctx.globalAlpha = bgFlash.k * 0.6 * (1 - t) * (1 - t); ctx.fillStyle = bgFlash.c; ctx.fillRect(0, 0, L.vw, L.vh); ctx.globalAlpha = 1; }
    }
    ctx.save();
    if (shake) {     // 震一下：幅度随连击变大，0.3 秒停下
      const t = (now - shake.t0) / 0.3;
      if (t >= 1) shake = null;
      else { const a = shake.amp * (1 - t); ctx.translate(Math.sin(now * 91.7) * a, Math.cos(now * 77.3) * a); }
    }
    drawSill();
    drawJar(now, false);
    // 沙子只画在瓶身里：瓶底两个角是圆的，不裁会露到玻璃外面
    ctx.save(); jarClip(); ctx.clip();
    drawGrains(now);
    drawFalling();
    ctx.restore();
    drawJar(now, true);
    drawHints(now);
    drawGhost(now);
    drawSparks(now);
    ctx.restore();
    drawTray();
    drawDrag();
    drawHud(now);
    drawRuleLine(now);
    drawComboBanner(now);
    drawPopups(now);
    drawHand(now);
    if (REC) drawFinger();
  }

  // 录视频时没有真手指：拖的时候画一个半透明的圆点
  function drawFinger() {
    if (!drag) return;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.strokeStyle = 'rgba(90,70,50,0.35)'; ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(drag.x, drag.y, L.cs * 0.55, 0, 7); ctx.fill(); ctx.shadowBlur = 0; ctx.stroke();
    ctx.restore();
  }

  // ---------- 主循环：固定步长 1/60 秒，跟帧率无关 ----------
  let last = performance.now(), acc = 0;
  function advance(dt, now) {
    if (dt > 0.1) dt = 0.1;
    acc += dt;
    let n = 0;
    while (acc >= 1 / 60 && n < 6) { tick(now); acc -= 1 / 60; n++; }
    draw(now);
  }
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = (t - last) / 1000; last = t;
    advance(dt, t / 1000);
  }

  window.addEventListener('resize', layout);
  layout();
  start();
  // 录制模式不跟屏幕刷新走：录像脚本每帧调用 SAND.advance(1/30)，时间是假的，录出来一帧不差
  let vnow = 0;
  if (!REC) requestAnimationFrame(frame);

  // 调试用：面板藏起来时动画帧不走，用 SAND.tick(n) 推进
  window.SAND = {
    sim: S,
    get st() { return st; },
    tick(n) { const now = performance.now() / 1000; for (let i = 0; i < (n || 1); i++) tick(now); draw(now); },
    drop(slot, col) { return S.drop(st, slot, col); },
    restart: start,
    get L() { return L; },
    advance(dt) { vnow += dt; advance(dt, vnow); },
    recEvents,
  };
})();
