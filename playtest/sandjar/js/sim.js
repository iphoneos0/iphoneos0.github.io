// 沙子方块的规则和沙子模拟（docs/02 第一节）。
// 纯逻辑，不碰画面：浏览器里的游戏和 node 里的机器人用的是同一份。
// 结果是确定的：同一个种子、同样的操作，每一步都一模一样。随机数全走 st 里的两条随机数流，不用 Math.random。
(function (root) {
  'use strict';

  const CELL = 8;              // 每格 8×8 粒沙
  const COLS = 8, ROWS = 10;   // 瓶身：宽 8 格、高 10 格（瓶口线以下）
  const HEAD = 4;              // 瓶口线以上留 4 格，块从这里落下（最高的块正好 4 格）
  const W = COLS * CELL, H = (ROWS + HEAD) * CELL;
  const RIM = HEAD * CELL;     // 瓶口线所在的行：沙子停稳以后还有一粒在这行以上就输

  // 可调的数字。机器人用环境变量 CFG='{"slideDepth":2}' 覆盖。
  const CFG = {
    substeps: 2,         // 每个 tick（1/60 秒）沙子走几步
    fallRows: 5,         // 落下中的块每 tick 下降几行（约 0.3 秒落到底）
    slideDepth: 1,       // 斜滑的条件：斜下方空几格才滑。1 = 45° 的坡，2 = 更陡、摊得更窄
    slideBudget: 24,     // 每粒沙最多斜滑几次（0 = 不限）。限了以后一块沙只在落点附近摊开，不会一路流到两边墙。
                         // 机器人（2026-11-22）：不限或 ≥32 时「一直放正中间」永远不死；28 离那道坎太近；24 留了余量
    start: 3,            // 每局开始几种颜色
    add: [15, 45, 120],  // 这局放到第几块时，加第 4、5、6 种颜色
    drought: 8,          // 一种颜色连续这么多块没发，下一块就一定是它
    comboWindow: 2,      // 消完以后，接下来几块之内再消算连击
    comboMax: 5,
    ptsPerCell: 10,      // 一格的沙量（64 粒）10 分
    settleTicks: 6,      // 停了这么多 tick 才算「停稳」，这时判输
    hintSpan: 0.6,       // 碰到一边墙、横跨超过瓶宽这么多的一片同色沙，给提示
  };

  // 块的形状（格为单位）。不能旋转，所以横竖各算一种。
  const SHAPE_DEF = {
    I2h: [[0, 0], [1, 0]], I2v: [[0, 0], [0, 1]],
    I3h: [[0, 0], [1, 0], [2, 0]], I3v: [[0, 0], [0, 1], [0, 2]],
    I4h: [[0, 0], [1, 0], [2, 0], [3, 0]], I4v: [[0, 0], [0, 1], [0, 2], [0, 3]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]], Tu: [[1, 0], [0, 1], [1, 1], [2, 1]],
    L: [[0, 0], [0, 1], [0, 2], [1, 2]], J: [[1, 0], [1, 1], [1, 2], [0, 2]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]], Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  };
  const SHAPE_WEIGHT = { I2h: .8, I2v: .5, I3h: 1, I3v: .6, I4h: 1, I4v: .5, O: 1, T: 1, Tu: 1, L: 1, J: 1, S: .8, Z: .8 };
  const SHAPES = {};
  for (const k in SHAPE_DEF) {
    const cells = SHAPE_DEF[k];
    const w = 1 + Math.max(...cells.map(c => c[0])), h = 1 + Math.max(...cells.map(c => c[1]));
    // 每一列沙粒，块最底下那一格的下一行（相对块顶）：落下时只看这一行有没有东西
    const bottom = new Int16Array(w * CELL);
    for (const [cx, cy] of cells) for (let j = 0; j < CELL; j++) bottom[cx * CELL + j] = Math.max(bottom[cx * CELL + j], (cy + 1) * CELL);
    SHAPES[k] = { cells, w, h, bottom };
  }
  const SHAPE_KEYS = Object.keys(SHAPES);
  const WEIGHT_SUM = SHAPE_KEYS.reduce((a, k) => a + SHAPE_WEIGHT[k], 0);

  // 两条随机数流（mulberry32）：rs 给沙子（斜滑方向、颗粒明暗），rd 给发块。状态就是一个整数，复制局面时一起复制
  function rnd(st, k) {
    let t = (st[k] = (st[k] + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function colorsAt(placed) {
    let n = CFG.start;
    for (const a of CFG.add) if (placed >= a) n++;
    return Math.min(6, n);
  }

  function create(seed, opt) {
    opt = opt || {};
    seed = seed >>> 0;
    const st = {
      seed, rs: (seed ^ 0x9E3779B9) | 0, rd: (seed ^ 0x85EBCA6B) | 0,
      grid: new Uint8Array(W * H),     // 每粒沙的颜色，0 = 空
      shade: new Uint8Array(W * H),    // 每粒沙的明暗（0–3），只给画面用
      slid: new Uint8Array(W * H),     // 每粒沙已经斜滑了几次（slideBudget 用）
      tray: [null, null, null], falling: [],
      placed: 0, dealt: 0, lastSeen: [0, 0, 0, 0, 0, 0, 0],
      score: 0, combo: 0, sinceClear: 99, clears: 0,
      tick: 0, moving: false, still: 0, over: false, top: H,
      events: [], hints: [], reach: 0,
      tutorial: !!opt.tutorial,
    };
    for (let c = CFG.start + 1; c <= 6; c++) st.lastSeen[c] = -1;   // -1 = 还没上场，一上场就先发它
    deal(st);
    return st;
  }

  function pickShape(st) {
    let r = rnd(st, 'rd') * WEIGHT_SUM;
    for (const k of SHAPE_KEYS) { r -= SHAPE_WEIGHT[k]; if (r <= 0) return k; }
    return SHAPE_KEYS[SHAPE_KEYS.length - 1];
  }

  // 发一盘 3 块（docs/02 第二节「颜色发得公平」）：随机抽颜色，哪种连续 drought 块没出现就一定发它
  function deal(st) {
    if (st.tutorial && st.dealt === 0) {
      // 第一局的第一盘：两条同色长条，左右各放一条就能接通两壁，20 秒内一定消一次
      st.tray = [{ s: 'I4h', c: 1 }, { s: 'I4h', c: 1 }, { s: 'O', c: 2 }];
      st.dealt = 3; st.lastSeen[1] = 2; st.lastSeen[2] = 3;
      st.events.push({ type: 'deal' });
      return;
    }
    const n = colorsAt(st.placed);
    for (let i = 0; i < 3; i++) {
      st.dealt++;
      let c = 0, worst = 0;
      for (let k = 1; k <= n; k++) {
        const gap = st.lastSeen[k] < 0 ? 999 : st.dealt - st.lastSeen[k];
        if (gap > CFG.drought && gap > worst) { worst = gap; c = k; }
      }
      if (!c) c = 1 + Math.floor(rnd(st, 'rd') * n);
      st.lastSeen[c] = st.dealt;
      st.tray[i] = { s: pickShape(st), c };
    }
    st.events.push({ type: 'deal', colors: n });
  }

  function clampCol(s, col) { return Math.max(0, Math.min(COLS - SHAPES[s].w, col | 0)); }

  // 把底盘第 slot 块放到第 col 列（块最左一格所在的列），从第 y0 行（沙粒行，默认瓶顶）直直落下。
  // 游戏里 y0 是松手时块在画面上的位置，免得块先跳回顶上再落；落点以下的位置一律按落点算
  function drop(st, slot, col, y0) {
    const p = st.tray[slot];
    if (!p || st.over) return false;
    col = clampCol(p.s, col);
    st.tray[slot] = null;
    st.placed++; st.sinceClear++;
    const y = y0 > 0 ? Math.min(y0 | 0, landingY(st, p.s, col)) : 0;
    st.falling.push({ s: p.s, c: p.c, x: col * CELL, y });
    st.still = 0;
    if (!st.tray[0] && !st.tray[1] && !st.tray[2]) deal(st);
    return true;
  }

  function blockedBelow(st, f) {
    const sh = SHAPES[f.s], g = st.grid;
    for (let j = 0; j < sh.bottom.length; j++) {
      if (!sh.bottom[j]) continue;
      const by = f.y + sh.bottom[j];
      if (by >= H || g[by * W + f.x + j]) return true;
    }
    return false;
  }

  // 刚性落下时会停在哪一行（只看已经在瓶里的沙，画落点影子用）
  function landingY(st, s, col) {
    const f = { s, x: clampCol(s, col) * CELL, y: 0 };
    while (!blockedBelow(st, f)) f.y++;
    return f.y;
  }

  function toGrains(st, f) {
    const sh = SHAPES[f.s], g = st.grid, sd = st.shade;
    for (const [cx, cy] of sh.cells) {
      for (let dy = 0; dy < CELL; dy++) {
        const y = f.y + cy * CELL + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = 0; dx < CELL; dx++) {
          const i = y * W + f.x + cx * CELL + dx;
          if (g[i]) continue;
          g[i] = f.c; sd[i] = (rnd(st, 'rs') * 4) | 0; st.slid[i] = 0;
        }
      }
    }
    if (f.y < st.top) st.top = f.y;
  }

  // 沙子走一步：从下往上扫，每粒先往下；下面堵住了，就随机先试左下或右下。每行扫的方向轮换，免得偏向一边
  function pass(st) {
    const g = st.grid, sd = st.shade, sl = st.slid, deep = CFG.slideDepth > 1, budget = CFG.slideBudget;
    let moves = 0;
    for (let y = H - 2; y >= st.top - 1 && y >= 0; y--) {
      const ltr = ((y + st.tick) & 1) === 0, row = y * W;
      for (let k = 0; k < W; k++) {
        const x = ltr ? k : W - 1 - k, i = row + x, c = g[i];
        if (!c) continue;
        const b = i + W;
        if (!g[b]) { g[b] = c; sd[b] = sd[i]; sl[b] = sl[i]; g[i] = 0; moves++; continue; }
        if (budget && sl[i] >= budget) continue;
        const first = rnd(st, 'rs') < 0.5 ? -1 : 1;
        for (let t = 0; t < 2; t++) {
          const d = t ? -first : first, nx = x + d;
          if (nx < 0 || nx >= W) continue;
          const di = b + d;
          if (g[di]) continue;
          if (deep && (y + 2 >= H || g[di + W])) continue;
          g[di] = c; sd[di] = sd[i]; sl[di] = sl[i] + 1; g[i] = 0; moves++;
          break;
        }
      }
    }
    return moves;
  }

  function findTop(st) {
    const g = st.grid;
    for (let i = 0; i < W * H; i++) if (g[i]) { st.top = (i / W) | 0; return; }
    st.top = H;
  }

  // 找同色连通的片（只算上下左右，斜对角不算），从两边墙出发：
  // 同时碰到两壁的消掉；碰到一边、横跨过一大半的记成提示（画面让它发亮，另一边墙对应的位置也亮）
  const LAB = new Int32Array(W * H), STACK = new Int32Array(W * H);
  let stamp = 0;
  function flood(g, start) {
    const c = g[start], cells = [];
    let sp = 0, minX = W, maxX = -1, rowAtMax = 0, rowAtMin = 0;
    STACK[sp++] = start; LAB[start] = stamp;
    while (sp) {
      const i = STACK[--sp], x = i % W;
      cells.push(i);
      if (x > maxX) { maxX = x; rowAtMax = (i / W) | 0; }
      if (x < minX) { minX = x; rowAtMin = (i / W) | 0; }
      if (x > 0 && g[i - 1] === c && LAB[i - 1] !== stamp) { LAB[i - 1] = stamp; STACK[sp++] = i - 1; }
      if (x < W - 1 && g[i + 1] === c && LAB[i + 1] !== stamp) { LAB[i + 1] = stamp; STACK[sp++] = i + 1; }
      if (i >= W && g[i - W] === c && LAB[i - W] !== stamp) { LAB[i - W] = stamp; STACK[sp++] = i - W; }
      if (i + W < W * H && g[i + W] === c && LAB[i + W] !== stamp) { LAB[i + W] = stamp; STACK[sp++] = i + W; }
    }
    return { c, cells, minX, maxX, rowAtMax, rowAtMin };
  }

  function detect(st) {
    stamp++;
    const g = st.grid, clear = [], hints = [];
    let reach = 0;
    for (let y = Math.max(0, st.top); y < H; y++) {
      const i = y * W;
      if (!g[i] || LAB[i] === stamp) continue;
      const k = flood(g, i);
      if (k.maxX === W - 1) clear.push(k);
      else {
        reach = Math.max(reach, (k.maxX + 1) / W);
        if ((k.maxX + 1) / W >= CFG.hintSpan) hints.push({ c: k.c, cells: k.cells, side: 'R', row: k.rowAtMax, span: (k.maxX + 1) / W });
      }
    }
    for (let y = Math.max(0, st.top); y < H; y++) {
      const i = y * W + W - 1;
      if (!g[i] || LAB[i] === stamp) continue;
      const k = flood(g, i);
      reach = Math.max(reach, (W - k.minX) / W);
      if ((W - k.minX) / W >= CFG.hintSpan) hints.push({ c: k.c, cells: k.cells, side: 'L', row: k.rowAtMin, span: (W - k.minX) / W });
    }
    st.hints = hints; st.reach = reach;
    if (!clear.length) return;

    let n = 0;
    for (const k of clear) { for (const i of k.cells) g[i] = 0; n += k.cells.length; }
    if (st.clears > 0 && st.sinceClear <= CFG.comboWindow) st.combo = Math.min(CFG.comboMax, st.combo + 1);
    else st.combo = 1;
    const pts = Math.round(n / (CELL * CELL) * CFG.ptsPerCell) * st.combo;
    st.score += pts; st.clears++; st.sinceClear = 0;
    st.moving = true;
    st.events.push({ type: 'clear', n, pts, combo: st.combo, parts: clear.map(k => ({ c: k.c, cells: k.cells })) });
    findTop(st);
  }

  // 走一个 tick（1/60 秒）
  function step(st) {
    if (st.over) return;
    st.tick++;
    let changed = false;
    for (let i = st.falling.length - 1; i >= 0; i--) {
      const f = st.falling[i];
      for (let k = 0; k < CFG.fallRows; k++) {
        if (blockedBelow(st, f)) {
          toGrains(st, f);
          st.falling.splice(i, 1);
          st.events.push({ type: 'land', s: f.s, c: f.c, x: f.x, y: f.y });
          changed = true; st.moving = true;
          break;
        }
        f.y++;
      }
    }
    if (st.moving) {
      let moves = 0;
      for (let s = 0; s < CFG.substeps; s++) moves += pass(st);
      st.moving = moves > 0;
      if (moves) { changed = true; findTop(st); }
    }
    if (changed) detect(st);

    if (!st.falling.length && !st.moving) st.still++; else st.still = 0;
    if (st.still === CFG.settleTicks && st.top < RIM) {
      st.over = true;
      st.events.push({ type: 'over' });
    }
  }

  function settled(st) { return !st.falling.length && !st.moving; }
  function danger(st) { return st.top < RIM + CELL; }

  function clone(st) {
    const c = Object.assign({}, st);
    c.grid = st.grid.slice(); c.shade = st.shade.slice(); c.slid = st.slid.slice();
    c.tray = st.tray.map(p => p && Object.assign({}, p));
    c.falling = st.falling.map(f => Object.assign({}, f));
    c.lastSeen = st.lastSeen.slice();
    c.events = []; c.hints = [];
    return c;
  }

  // 这一块放在这一列，会不会马上消掉一片（拖块时落点影子发光用）。在副本上跑到停稳，不影响真局面
  function predictClear(st, slot, col, maxTicks) {
    const c = clone(st);
    const before = c.clears;
    if (!drop(c, slot, col)) return false;
    for (let t = 0; t < (maxTicks || 300) && !settled(c); t++) step(c);
    return c.clears > before;
  }

  const api = {
    CELL, COLS, ROWS, HEAD, W, H, RIM, CFG, SHAPES,
    create, step, drop, clone, colorsAt, landingY, clampCol, predictClear, settled, danger,
    shapeW: s => SHAPES[s].w, shapeH: s => SHAPES[s].h,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SandSim = api;
})(this);
