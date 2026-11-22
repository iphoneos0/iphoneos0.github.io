// 画面、拖放、提示、结果页、试玩记录。规则都在 sim.js 里，这里只负责看和摸。
// 一份代码三个出口（docs/02 开头）：手指和鼠标都用 pointer 事件；震动、广告这些壳里的东西没有就不出现。
(() => {
  'use strict';
  const S = window.SandSim;
  const { CELL, COLS, ROWS, HEAD, W, H, RIM } = S;

  // 6 种沙色：从 Okabe-Ito 色盲友好色板挑的，按上场顺序。第 2 周正式定色前还要过色弱模拟（docs/02 第三节）
  const COLORS = [null, '#E4572E', '#4BA3E3', '#F2C230', '#21A07A', '#C66FB0', '#2E5AA8'];
  const SHADE = [0.94, 0.98, 1.02, 1.06];   // 每粒沙的明暗只差 ±5%，不然薄薄一条看不出接没接通
  const WORDS = ['Nice!', 'Great!', 'Excellent!', 'Amazing!', 'Unbelievable!'];
  const BG = '#EFE4D2';

  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const PAL = new Uint32Array(7 * 4), PAL_HI = new Uint32Array(7 * 4);
  const pack = (r, g, b) => (255 << 24) | (Math.min(255, b) << 16) | (Math.min(255, g) << 8) | Math.min(255, r);
  for (let c = 1; c <= 6; c++) {
    const [r, g, b] = rgb(COLORS[c]);
    for (let s = 0; s < 4; s++) {
      const k = SHADE[s];
      PAL[c * 4 + s] = pack(r * k | 0, g * k | 0, b * k | 0);
      // 提示时亮一点：只往白色混 35%，混太多会被看成另一种颜色
      PAL_HI[c * 4 + s] = pack(r * k * 0.65 + 89 | 0, g * k * 0.65 + 89 | 0, b * k * 0.65 + 89 | 0);
    }
  }

  const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const octx = off.getContext('2d');
  const img = octx.createImageData(W, H), px = new Uint32Array(img.data.buffer);

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
    const hud = Math.max(70, vh * 0.1) + sat, tray = Math.max(120, vh * 0.2) + sab;
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
  let run = null;   // 试玩记录里的这一局
  let best = +store.get('sand1-best', 0) || 0;

  function start() {
    const tutorial = store.get('sand1-tut', '0') !== '1';
    st = S.create((Date.now() ^ (Math.random() * 1e9)) >>> 0, { tutorial });
    st.events.length = 0;
    drag = null; popups = []; flashes = []; overAt = 0; lastColors = S.CFG.start; tutFirstX = -1;
    run = { at: new Date().toISOString(), t0: performance.now(), firstClear: null, tutorial };
    document.getElementById('over').classList.add('hide');
  }

  function onEvent(e, now) {
    if (e.type === 'land') {
      Snd.land(S.SHAPES[e.s].cells.length); haptic('light');
      if (st.tutorial && tutFirstX < 0) tutFirstX = e.x;
    } else if (e.type === 'clear') {
      const cells = [];
      for (const p of e.parts) for (const i of p.cells) cells.push(i);
      flashes.push({ cells, t0: now });
      let sx = 0, sy = 0;
      for (let k = 0; k < cells.length; k += 7) { sx += cells[k] % W; sy += (cells[k] / W) | 0; }
      const m = Math.ceil(cells.length / 7);
      popups.push({ text: WORDS[e.combo - 1], sub: '+' + e.pts, x: L.jx + sx / m * L.gp, y: L.jy + sy / m * L.gp, t0: now, c: COLORS[e.parts[0].c] });
      Snd.clear(e.combo); haptic(e.combo > 1 ? 'heavy' : 'medium');
      if (run.firstClear == null) run.firstClear = +((performance.now() - run.t0) / 1000).toFixed(1);
      if (st.tutorial) store.set('sand1-tut', '1');
    } else if (e.type === 'deal') {
      if (e.colors && e.colors > lastColors) {
        lastColors = e.colors;
        popups.push({ text: 'New color!', sub: '', x: L.vw / 2, y: L.trayY - 10, t0: now, c: COLORS[e.colors] });
      }
    } else if (e.type === 'over') {
      overAt = now; Snd.over(); haptic('heavy');
      finishRun();
      setTimeout(showOver, 700);
    }
  }

  function tick(now) {
    S.step(st);
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
      const c = PAL[st.tray[drag.slot].c * 4 + 1];
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
    const g = st.grid, sd = st.shade;
    for (let i = 0; i < W * H; i++) px[i] = g[i] ? PAL[g[i] * 4 + sd[i]] : 0;
    // 快接通的那片沙一闪一闪地发亮（docs/02 第一节：规则自己会说话）
    const pulse = (Math.sin(now * 6) + 1) / 2;
    if (pulse > 0.35 && !st.over) for (const h of st.hints) for (const i of h.cells) if (g[i]) px[i] = PAL_HI[g[i] * 4 + sd[i]];
    // 刚消掉的位置白光一闪
    flashes = flashes.filter(f => now - f.t0 < 0.25);
    for (const f of flashes) {
      const a = 1 - (now - f.t0) / 0.25;
      const wv = pack(255, 255, 255) & 0x00FFFFFF | ((a * 255) << 24);
      for (const i of f.cells) if (!g[i]) px[i] = wv;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, L.jx, L.jy, L.jw, L.jh);
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

  function drawHud() {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#3B2F25'; ctx.font = '800 34px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(st.score.toLocaleString('en-US'), L.vw / 2, L.top + 44);
    ctx.fillStyle = '#9A8670'; ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('BEST ' + Math.max(best, st.score).toLocaleString('en-US'), L.vw / 2, L.top + 62);
    // 现在有几种颜色
    const n = S.colorsAt(st.placed), d = 9;
    for (let c = 1; c <= n; c++) {
      ctx.fillStyle = COLORS[c];
      ctx.beginPath(); ctx.arc(L.jx + 6 + (c - 1) * (d + 5), L.top + 40, d / 2, 0, 7); ctx.fill();
    }
    // 声音开关
    const s = L.snd;
    ctx.fillStyle = Snd.on ? '#7A6550' : '#C2B39E';
    ctx.font = '22px -apple-system, sans-serif';
    ctx.fillText(Snd.on ? '♪' : '♪̸', s.x + s.w / 2, s.y + 26);
    if (!Snd.on) { ctx.strokeStyle = '#C2B39E'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(s.x + 8, s.y + 8); ctx.lineTo(s.x + s.w - 8, s.y + s.h - 8); ctx.stroke(); }
  }

  function drawPopups(now) {
    popups = popups.filter(p => now - p.t0 < 1.1);
    ctx.textAlign = 'center';
    for (const p of popups) {
      const t = (now - p.t0) / 1.1, y = p.y - 40 * t;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
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
    drawJar(now, false);
    // 沙子只画在瓶身里：瓶底两个角是圆的，不裁会露到玻璃外面
    ctx.save(); jarClip(); ctx.clip();
    drawGrains(now);
    drawFalling();
    ctx.restore();
    drawJar(now, true);
    drawHints(now);
    drawGhost(now);
    drawTray();
    drawDrag();
    drawHud();
    drawPopups(now);
    drawHand(now);
  }

  // ---------- 主循环：固定步长 1/60 秒，跟帧率无关 ----------
  let last = performance.now(), acc = 0;
  function frame(t) {
    requestAnimationFrame(frame);
    let dt = (t - last) / 1000; last = t;
    if (dt > 0.1) dt = 0.1;
    acc += dt;
    const now = t / 1000;
    let n = 0;
    while (acc >= 1 / 60 && n < 6) { tick(now); acc -= 1 / 60; n++; }
    draw(now);
  }

  window.addEventListener('resize', layout);
  layout();
  start();
  requestAnimationFrame(frame);

  // 调试用：面板藏起来时动画帧不走，用 SAND.tick(n) 推进
  window.SAND = {
    sim: S,
    get st() { return st; },
    tick(n) { const now = performance.now() / 1000; for (let i = 0; i < (n || 1); i++) tick(now); draw(now); },
    drop(slot, col) { return S.drop(st, slot, col); },
    restart: start,
  };
})();
