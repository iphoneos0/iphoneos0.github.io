// 画面、拖放、提示、结果页、试玩记录。规则都在 sim.js 里，这里只负责看和摸。
// 一份代码三个出口（docs/02 开头）：手指和鼠标都用 pointer 事件；震动、广告这些壳里的东西没有就不出现。
(() => {
  'use strict';
  const S = window.SandSim;
  const { CELL, COLS, ROWS, HEAD, W, H, RIM } = S;

  // 6 种沙色：从 Okabe-Ito 色盲友好色板挑的，按上场顺序。第 2 周正式定色前还要过色弱模拟（docs/02 第三节）
  const COLORS = [null, '#E4572E', '#4BA3E3', '#F2C230', '#21A07A', '#C66FB0', '#2E5AA8'];
  const WORDS = ['Nice!', 'Great!', 'Excellent!', 'Amazing!', 'Unbelievable!'];
  const BG = '#EFE4D2';

  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const pack = (r, g, b) => (255 << 24) | (Math.max(0, Math.min(255, b | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, r | 0));
  const BASE = COLORS.map(h => h ? pack(...rgb(h)) : 0);

  // 沙粒质感（docs/04：5px 的平色块不像沙）。模拟还是每格 8×8 粒；画的时候每粒再分成 K×K 个小点。
  // 每粒沙带着 16 种花纹里的一种（sim 里的 shade，跟着沙粒走），沙子流动时纹理跟着走，不会像隔着一层纱窗。
  // 明暗：每种花纹整体差 ±9%，小点之间再差 ±5%，少数花纹带一个亮点或暗点；色相也轻轻偏暖偏冷。
  // 颜色之间靠色相区分，明暗变化再大，薄薄一条接没接通也看得出来（截图看过）。
  const K = 3, VAR = 16, KK = K * K;
  const TILE = new Uint32Array(7 * VAR * KK), TILE_HI = new Uint32Array(7 * VAR * KK);
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
  const hiMask = new Uint8Array(W * H);
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
      addPopup({ text: '+' + e.pts, sub: '', x: L.jx + (e.x + S.shapeW(e.s) * CELL / 2) * L.gp, y: L.jy + e.y * L.gp, t0: now, c: '#8A7660', small: true });
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

  function drawPiece(s, c, x, y, size, alpha) {
    const sh = S.SHAPES[s];
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    for (const [cx, cy] of sh.cells) {
      ctx.fillStyle = COLORS[c];
      ctx.fillRect(x + cx * size, y + cy * size, size, size);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x + cx * size, y + cy * size, size, size * 0.18);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x + cx * size, y + cy * size + size * 0.82, size, size * 0.18);
    }
    ctx.globalAlpha = 1;
  }

  function drawGrains(now) {
    // 快接通的那片沙一闪一闪地发亮（docs/02 第一节：规则自己会说话）
    const hintOn = !st.over && st.hints.length > 0 && (Math.sin(now * 6) + 1) / 2 > 0.35;
    flashes = flashes.filter(f => now - f.t0 < FLASH_T);
    if (grainsDirty || hintOn !== lastHintOn || flashes.length) {
      grainsDirty = false; lastHintOn = hintOn;
      const g = st.grid, sd = st.shade;
      if (hintOn) { hiMask.fill(0); for (const h of st.hints) for (const i of h.cells) hiMask[i] = 1; }
      for (let y = 0, i = 0; y < H; y++) {
        for (let x = 0; x < W; x++, i++) {
          let o = y * K * KW + x * K;
          const c = g[i];
          if (!c) { for (let a = 0; a < K; a++, o += KW) for (let b = 0; b < K; b++) px[o + b] = 0; continue; }
          const T = hintOn && hiMask[i] ? TILE_HI : TILE;
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
    ctx.font = '900 ' + Math.round(Math.min(46, L.jw / 7)) + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width, grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    for (let c = 1; c <= 6; c++) grad.addColorStop((c - 1) / 5, COLORS[c]);
    ctx.lineWidth = 8; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.strokeText(text, 0, 0);
    ctx.fillStyle = grad; ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // 第一局：瓶口里一行字把规则说出来（docs/06：三款竞品都用字讲，我们原来只有一只手）
  function drawRuleLine(now) {
    if (!st.tutorial || st.clears || st.over) return;
    const text = 'Connect one color wall to wall';
    ctx.save();
    let fs = 18;
    ctx.font = '800 ' + fs + 'px -apple-system, BlinkMacSystemFont, sans-serif';
    const w = ctx.measureText(text).width, room = L.jw - 70;
    if (w > room) { fs = Math.floor(fs * room / w); ctx.font = '800 ' + fs + 'px -apple-system, BlinkMacSystemFont, sans-serif'; }
    const y = L.rimY + L.cs * 1.7, a = 0.75 + 0.25 * Math.sin(now * 4);   // 瓶子里、瓶口线下面（教学手拖的块在瓶口上面，不会压住字）
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#6B5845'; ctx.globalAlpha = a; ctx.fillText(text, L.vw / 2, y);
    // 两头的箭头指着两边墙
    const ax = L.cs * 0.45;
    ctx.beginPath();
    ctx.moveTo(L.jx + 8, y); ctx.lineTo(L.jx + 8 + ax, y - ax * 0.7); ctx.lineTo(L.jx + 8 + ax, y + ax * 0.7); ctx.closePath();
    ctx.moveTo(L.jx + L.jw - 8, y); ctx.lineTo(L.jx + L.jw - 8 - ax, y - ax * 0.7); ctx.lineTo(L.jx + L.jw - 8 - ax, y + ax * 0.7); ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function jarClip() {
    const { jx, jw, jy, jh, cs } = L, bottom = jy + jh, r = cs * 0.7;
    ctx.beginPath(); ctx.moveTo(jx, 0); ctx.lineTo(jx, bottom - r); ctx.quadraticCurveTo(jx, bottom, jx + r, bottom);
    ctx.lineTo(jx + jw - r, bottom); ctx.quadraticCurveTo(jx + jw, bottom, jx + jw, bottom - r); ctx.lineTo(jx + jw, 0); ctx.closePath();
  }

  function drawJar(now, front) {
    const { jx, jw, rimY, jy, jh, cs } = L, bottom = jy + jh, r = cs * 0.7;
    if (!front) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.beginPath(); ctx.moveTo(jx, rimY); ctx.lineTo(jx, bottom - r); ctx.quadraticCurveTo(jx, bottom, jx + r, bottom);
      ctx.lineTo(jx + jw - r, bottom); ctx.quadraticCurveTo(jx + jw, bottom, jx + jw, bottom - r); ctx.lineTo(jx + jw, rimY); ctx.closePath(); ctx.fill();
      return;
    }
    // 玻璃
    ctx.strokeStyle = 'rgba(95,120,130,0.55)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(jx - 1.5, rimY); ctx.lineTo(jx - 1.5, bottom - r); ctx.quadraticCurveTo(jx - 1.5, bottom + 1.5, jx + r, bottom + 1.5);
    ctx.lineTo(jx + jw - r, bottom + 1.5); ctx.quadraticCurveTo(jx + jw + 1.5, bottom + 1.5, jx + jw + 1.5, bottom - r); ctx.lineTo(jx + jw + 1.5, rimY); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(jx + 5, rimY + cs * 0.6); ctx.lineTo(jx + 5, rimY + cs * 3); ctx.stroke();
    // 瓶口：两边的唇，中间一条虚线；沙子离瓶口不到 1 格时变红闪
    const danger = S.danger(st) && !st.over;
    const red = danger ? 0.45 + 0.55 * ((Math.sin(now * 10) + 1) / 2) : 0;
    ctx.fillStyle = danger ? `rgba(220,60,40,${red})` : 'rgba(95,120,130,0.7)';
    roundRect(jx - 8, rimY - 4, 14, 8, 4); ctx.fill();
    roundRect(jx + jw - 6, rimY - 4, 14, 8, 4); ctx.fill();
    ctx.strokeStyle = danger ? `rgba(220,60,40,${red})` : 'rgba(95,120,130,0.35)';
    ctx.lineWidth = danger ? 2.5 : 1.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(jx + 6, rimY); ctx.lineTo(jx + jw - 6, rimY); ctx.stroke();
    ctx.setLineDash([]);
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

  function drawTray() {
    if (st.over) return;   // 结束了底盘让给结果卡片
    for (let i = 0; i < 3; i++) {
      const sl = L.slots[i], p = st.tray[i];
      if (!p) continue;
      const { w, h } = pieceSize(p.s);
      const size = Math.min(L.cs * 0.62, (sl.w - 16) / 4, (sl.h - 16) / 4);
      const x = sl.x + (sl.w - w * size) / 2, y = sl.y + (sl.h - h * size) / 2;
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

  const kfmt = v => v >= 1e6 ? (v / 1e6) + 'M' : v >= 1000 ? (v / 1000) + 'K' : String(v);
  function drawHud(now) {
    // 分数滚着往上涨，不是一下跳过去
    const dt = Math.min(0.1, Math.max(0, now - lastHudNow)); lastHudNow = now;
    shownScore += (st.score - shownScore) * Math.min(1, dt * 10);
    if (Math.abs(st.score - shownScore) < 1) shownScore = st.score;
    // 过了里程碑：金色大字、整屏闪金色
    while (mileIdx < MILESTONES.length && st.score >= MILESTONES[mileIdx]) {
      addPopup({ text: kfmt(MILESTONES[mileIdx]) + '!', sub: 'Milestone', x: L.vw / 2, y: L.jy + L.cs * 3.4, t0: now, c: '#D9A21B' });
      bgFlash = { c: '#F2C230', t0: now, k: 0.8 };
      mileIdx++;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#3B2F25'; ctx.font = '800 34px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(Math.round(shownScore).toLocaleString('en-US'), L.vw / 2, L.top + 42);
    ctx.fillStyle = '#9A8670'; ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('BEST ' + Math.max(best, st.score).toLocaleString('en-US'), L.vw / 2, L.top + 58);
    // 下一个里程碑：一条细进度条，右边写着目标
    if (mileIdx < MILESTONES.length) {
      const prev = mileIdx ? MILESTONES[mileIdx - 1] : 0, next = MILESTONES[mileIdx];
      const f = Math.max(0, Math.min(1, (shownScore - prev) / (next - prev)));
      const bw = Math.min(140, L.jw * 0.42), bh = 7, bx = L.vw / 2 - bw / 2, by = L.top + 66;
      ctx.fillStyle = 'rgba(122,101,80,0.18)'; roundRect(bx, by, bw, bh, 3.5); ctx.fill();
      if (f > 0) { ctx.fillStyle = '#E2A72A'; roundRect(bx, by, Math.max(bh, bw * f), bh, 3.5); ctx.fill(); }
      ctx.textAlign = 'left'; ctx.fillStyle = '#9A8670'; ctx.font = '800 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(kfmt(next), bx + bw + 6, by + bh);
      ctx.textAlign = 'center';
    }
    // 现在有几种颜色
    const n = S.colorsAt(st.placed), d = 9;
    for (let c = 1; c <= n; c++) {
      ctx.fillStyle = COLORS[c];
      ctx.beginPath(); ctx.arc(L.jx + 6 + (c - 1) * (d + 5), L.top + 40, d / 2, 0, 7); ctx.fill();
    }
    // 声音开关（录视频时不画）
    if (REC) return;
    const s = L.snd;
    ctx.fillStyle = Snd.on ? '#7A6550' : '#C2B39E';
    ctx.font = '22px -apple-system, sans-serif';
    ctx.fillText(Snd.on ? '♪' : '♪̸', s.x + s.w / 2, s.y + 26);
    if (!Snd.on) { ctx.strokeStyle = '#C2B39E'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x + 8, s.y + 8); ctx.lineTo(s.x + s.w - 8, s.y + s.h - 8); ctx.stroke(); }
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
      if (p.small) {   // 放一块的飘分：小、灰、不抢眼
        ctx.font = '800 16px -apple-system, BlinkMacSystemFont, sans-serif';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.strokeText(p.text, p.x, y);
        ctx.fillStyle = p.c; ctx.fillText(p.text, p.x, y);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.font = '900 30px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.strokeText(p.text, p.x, y);
      ctx.fillStyle = p.c; ctx.fillText(p.text, p.x, y);
      if (p.sub) {
        ctx.font = '800 18px -apple-system, sans-serif';
        ctx.strokeText(p.sub, p.x, y + 24); ctx.fillStyle = '#3B2F25'; ctx.fillText(p.sub, p.x, y + 24);
      }
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
    ctx.fillStyle = BG; ctx.fillRect(0, 0, L.vw, L.vh);
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
