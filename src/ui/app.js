'use strict';
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ============================================================
   M5.6 · 自绘浮层提示（主人 2 号）：原生 title 的黑框永远贴在光标正下方，
   鼠标一过就把内容挡住了。改成自己画一层：默认落在目标的「右上方」，
   贴到右/上边就自动翻转，pointer-events:none 不吃鼠标。
   热力图格子、概览柱、详情柱共用一套（都靠 data-tip）。
   ============================================================ */
const tipEl = () => document.getElementById('tip');

/* —— M7（主人 4 号）「hover 不够丝滑、要果冻手感」的根因与修法 ——
   旧实现挂在 pointerover / pointerout 上：鼠标在一根柱子里扫过 .pst → .s-use → .px
   三个子元素，就会触发三次 showTip，而每次都要 innerHTML 重写 + offsetWidth/offsetHeight
   + getBoundingClientRect，一共三次强制同步布局 → 手感发涩、掉帧。
   新实现三条：
     ①同一段文案只写一次 DOM，尺寸只量一次（量完缓存在 TIP.w/h）；
     ②位置只改 transform（合成层），全程不触发重排；
     ③位置用弹簧追着光标走（欠阻尼 → 会过冲再回弹），这就是「q 弹」的来源。 */
const TIP = { el: null, key: '', w: 0, h: 0, x: 0, y: 0, tx: 0, ty: 0, vx: 0, vy: 0, raf: 0, show: false };

function tipSpring() {
  TIP.raf = 0;
  const t = TIP.el;
  if (!t || !TIP.show) return;
  const K = 0.30, D = 0.72;                 // 刚度 / 阻尼：明显回弹但不晃
  TIP.vx = (TIP.vx + (TIP.tx - TIP.x) * K) * D;
  TIP.vy = (TIP.vy + (TIP.ty - TIP.y) * K) * D;
  TIP.x += TIP.vx; TIP.y += TIP.vy;
  t.style.transform = 'translate3d(' + TIP.x.toFixed(2) + 'px,' + TIP.y.toFixed(2) + 'px,0)';
  if (Math.abs(TIP.tx - TIP.x) > .2 || Math.abs(TIP.ty - TIP.y) > .2 ||
      Math.abs(TIP.vx) > .2 || Math.abs(TIP.vy) > .2) TIP.raf = requestAnimationFrame(tipSpring);
}
const tipKick = () => { if (!TIP.raf) TIP.raf = requestAnimationFrame(tipSpring); };

function hideTip() {
  const t = TIP.el || tipEl();
  if (t && TIP.show) { t.hidden = true; t.classList.remove('on'); }
  TIP.show = false; TIP.key = '';
  if (TIP.raf) { cancelAnimationFrame(TIP.raf); TIP.raf = 0; }
}
/** cx/cy = 光标位置；落点固定「右上方」（鼠标不会压住文字），只有右边/上面真的放不下才翻转。
    M8（主人 1 号）修掉一个藏了很久的定位 bug：旧版在元素还 hidden 的时候 getBoundingClientRect()
    —— 隐藏元素量出来恒为 0×0，于是第一次弹出的浮层按「高 0」算位置，实际画到了光标右下，
    左下角热力图的提示正好盖住下面几行格子。改成「先显示、再量尺寸」。 */
function showTip(text, cx, cy) {
  const t = tipEl();
  if (!t || !text) return;
  TIP.el = t;
  const first = !TIP.show;
  if (first) { TIP.show = true; t.hidden = false; }     // 必须先可见再量，否则量到 0×0
  const changed = TIP.key !== text;
  if (changed || !TIP.w || !TIP.h) {
    if (changed) {
      const lines = String(text).split('\n');
      t.innerHTML = lines.map((s, i) => '<span class="' + (i === 0 ? 'tip-t' : '') + '">' + esc(s) + '</span>').join('');
      TIP.key = text;
    }
    const r = t.getBoundingClientRect();               // 量一次就缓存（同一段文案不再量，不触发重排）
    TIP.w = r.width; TIP.h = r.height;
  }
  const vw = window.innerWidth, vh = window.innerHeight, GAP = 12;
  let tx = cx + GAP, ty = cy - TIP.h - GAP;
  if (tx + TIP.w > vw - 6) tx = cx - GAP - TIP.w;      // 右边放不下 → 翻到左边
  if (ty < 6) ty = cy + GAP;                           // 上面放不下 → 翻到下面
  TIP.tx = clamp(tx, 6, Math.max(6, vw - TIP.w - 6));
  TIP.ty = clamp(ty, 6, Math.max(6, vh - TIP.h - 6));
  if (first) {                                         // 首次出现直接落位，不从错误的地方飞过来
    TIP.x = TIP.tx; TIP.y = TIP.ty; TIP.vx = 0; TIP.vy = 0;
    t.style.transform = 'translate3d(' + TIP.x.toFixed(2) + 'px,' + TIP.y.toFixed(2) + 'px,0)';
    t.classList.add('on');
  }
  tipKick();
}
/* 事件委托挂一次就够：任何带 data-tip 的元素都能出提示。
   pointermove 只写两个数字（不碰 DOM），真正的绘制交给 rAF 里的弹簧 → 天生节流。 */
function bindTips() {
  document.addEventListener('pointermove', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!el) { if (TIP.show) hideTip(); return; }
    showTip(el.dataset.tip, e.clientX, e.clientY);
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', hideTip);   // 光标离开窗口
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('pointercancel', hideTip, true);
  window.addEventListener('blur', hideTip);
}

const state = {
  kind: 'day', anchor: dayKey(), theme: 'light', resolved: 'light', glass: .55, icon: 48,
  iconLevel: 1, winW: 0, iconPx: 48,   // M5.5：图标像素 = 窗口宽 × 倍率（拖窗口就跟着缩放）
  info: null, range: null,
  view: 'app',      // app = 应用视图 / cat = 分类视图（F4）
  cat: 'all',       // 左栏选中的分类；'all' = 全部应用
  lastRows: [], lastCatRows: []
};

/* 时间到底去哪了（M1 细分）：空闲 / 锁屏 / 休眠分开显示，表格里仍是一整行（主人 4 号决定） */
const KIND_LABEL = { idle: '无操作', lock: '锁屏', sleep: '休眠' };
const MODE_TEXT = { idle: '已空闲', lock: '已锁屏', sleep: '休眠中', paused: '已暂停记录' };

function fmtDur(sec) {
  if (!sec) return '0 分钟';
  if (sec < 60) return '< 1 分钟';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
  return `${m}分钟`;
}
function fmtDate(d) { const x = new Date(d + 'T00:00:00'); return `${x.getMonth() + 1}月${x.getDate()}日`; }
function dateLabel(d) {
  const today = dayKey();
  if (d.kind === 'month') { const x = new Date(d.from + 'T00:00:00'); return `${x.getFullYear()}年${x.getMonth() + 1}月`; }
  if (d.kind === 'week') return `${fmtDate(d.from)}–${fmtDate(d.to)}`;
  if (d.kind === 'all') return `${fmtDate(d.from)} 至今`;
  return fmtDate(d.anchor) + (d.anchor === today ? ' 今天' : '');
}
/* M8（主人 4/5 号）：概览卡与热力图要能前后翻页，需要一个纯日期的加减 */
function shiftDay(d, n) { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return dayKey(x); }
/** 紧凑月日：09/14 —— 窄栏（热力图标题）放得下的写法 */
function shortMd(d) { return d.slice(5).replace('-', '/'); }
/** 这一天所在那一周（周一为始）的周日 */
function weekEnd(d) {
  const dow = (new Date(d + 'T00:00:00').getDay() + 6) % 7;
  return shiftDay(d, 6 - dow);
}

/* ============================================================
   分段控件：完美对称的椭圆玻璃滑块（可拖拽 + 弹性滑动）
   ============================================================ */
function initSegmented(root, onPick, opts) {
  const thumb = root.querySelector('.seg-thumb');
  const btns = Array.from(root.querySelectorAll('button'));
  // 静止：与分段条同形状的胶囊，四周留白匀匀（左右 --thumb-edge，上下 --thumb-inset）。
  // 按住/拖动：整体轻微放大（INFLATE）=> 「只有按住才变大一丁点」。
  const INFLATE_X = 1.05, INFLATE_Y = 1.05;   // 按住 = 整体轻微放大（不再纵向鼓出）
  const geom = { w: 0, h: 0, rr: null, edge: 2 };

  // hot=true => 膨胀态。按「当前这一颗按钮」的宽度量，所以标签宽窄不同也能贴合。
  function measure(b, hot) {
    geom.rr = root.getBoundingClientRect();
    const btn = b || root.querySelector('button.active') || btns[0];
    const cs = getComputedStyle(thumb);
    const edge = parseFloat(cs.getPropertyValue('--thumb-edge')) || 2;
    const inset = parseFloat(cs.getPropertyValue('--thumb-inset')) || 2;
    const kx = hot ? INFLATE_X : 1, ky = hot ? INFLATE_Y : 1;
    geom.edge = edge;
    // 宽度 = 按钮宽 − 左右各一点留白 → 滑块与按钮同心，且永远不贴条边
    geom.w = Math.max(30, btn.getBoundingClientRect().width - edge * 2) * kx;
    geom.h = Math.max(18, geom.rr.height - inset) * ky;
    thumb.style.setProperty('--tw', geom.w.toFixed(2) + 'px');
    thumb.style.setProperty('--th', geom.h.toFixed(2) + 'px');
  }
  function centerOf(b) {
    const rb = b.getBoundingClientRect();
    return rb.left - root.getBoundingClientRect().left + rb.width / 2;
  }
  function place(cx) {
    // 左右同样留 edge：第一/最后一颗不再贴条边 → 消除两端的月牙空隙
    const lo = geom.edge, hi = Math.max(lo, geom.rr.width - geom.w - geom.edge);
    const tx = clamp(cx - geom.w / 2, lo, hi);
    thumb.style.setProperty('--tx', tx.toFixed(1) + 'px');
  }
  function snapToActive() {
    const b = root.querySelector('button.active') || btns[0];
    if (!b) return;
    if (opts && opts.position === false) {   // 详情页在浮层里，隐藏时量不出宽度
      thumb.style.setProperty('--tx', '');
      thumb.style.setProperty('--tw', '');
      thumb.style.setProperty('--th', '');
      return;
    }
    measure(b, false);
    place(centerOf(b));
  }
  function active(kind) {
    btns.forEach((x) => x.classList.toggle('active', x.dataset.kind === kind || x.dataset.theme === kind || x.dataset.view === kind));
  }
  function kindAt(clientX) {
    const rr = root.getBoundingClientRect();
    let best = btns[0], d = Infinity;
    for (const b of btns) {
      const rb = b.getBoundingClientRect();
      const dd = Math.abs(clientX - (rb.left + rb.width / 2));
      if (dd < d) { d = dd; best = b; }
    }
    return best;
  }
  function keyOf(b) { return b.dataset.kind || b.dataset.theme || b.dataset.view; }

  let drag = null;
  root.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.preventDefault();
    try { root.setPointerCapture(e.pointerId); } catch {}
    root.classList.add('dragging');
    drag = { id: e.pointerId, key: keyOf(b), x0: e.clientX, moved: false };
    measure(b, true);
    active(drag.key);
    place(centerOf(b));
  });
  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
    const b = kindAt(e.clientX);
    if (keyOf(b) !== drag.key) { drag.key = keyOf(b); active(drag.key); measure(b, true); }
    const rr = root.getBoundingClientRect();
    place(clamp(e.clientX - rr.left, 0, rr.width));
  });
  const finish = (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    const key = drag.key;
    drag = null;
    root.classList.remove('dragging');
    try { root.releasePointerCapture(e.pointerId); } catch {}
    active(key);
    snapToActive();
    if (onPick) onPick(key, { dragged: wasDrag });
  };
  root.addEventListener('pointerup', finish);
  root.addEventListener('pointercancel', (e) => { if (drag) { drag = null; root.classList.remove('dragging'); snapToActive(); } });
  // 键盘：左右方向键切换
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = btns.findIndex((b) => b.classList.contains('active'));
    const n = clamp(i + (e.key === 'ArrowRight' ? 1 : -1), 0, btns.length - 1);
    if (n === i) return;
    e.preventDefault();
    active(keyOf(btns[n]));
    snapToActive();
    if (onPick) onPick(keyOf(btns[n]), { key: true });
  });
  return { sync: (key) => { active(key); snapToActive(); }, refresh: snapToActive };
}

const segKind = initSegmented($('#seg'), (kind) => {
  if (kind === state.kind) return;
  state.kind = kind;
  refresh();
});
const segTheme = initSegmented($('#themeSeg'), (t) => applyTheme(t, true));

/* ============================================================
   窗口缩放：自绘的 8 个边缘手柄
   窗口是 frame:false + thickFrame:false：Windows 不保留非客户区（所以不会有那圈
   「裸亚克力」边框），代价是没有原生缩放边框。这里自己实现：
   pointerdown 记下起始窗口矩形 → pointermove 算新矩形 → setBounds（主进程再夹一次下限）。
   ============================================================ */
function initResize(info) {
  const MINW = (info && info.minSize && info.minSize.w) || 900;
  const MINH = (info && info.minSize && info.minSize.h) || 620;
  const handles = Array.from(document.querySelectorAll('.rz i'));
  if (!handles.length) return;
  let job = null;

  handles.forEach((el) => {
    const edge = el.className.replace('rz-', '');
    el.addEventListener('pointerdown', async (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const b0 = await window.nami.getBounds();
      if (!b0) return;
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      job = { id: e.pointerId, edge: edge, b0: b0, x0: e.screenX, y0: e.screenY, el: el };
      document.documentElement.classList.add('resizing');
    });
  });

  window.addEventListener('pointermove', (e) => {
    if (!job || e.pointerId !== job.id) return;
    const dx = e.screenX - job.x0, dy = e.screenY - job.y0;
    const b = { x: job.b0.x, y: job.b0.y, width: job.b0.width, height: job.b0.height };
    if (job.edge.indexOf('e') >= 0) b.width = Math.max(MINW, Math.round(job.b0.width + dx));
    if (job.edge.indexOf('s') >= 0) b.height = Math.max(MINH, Math.round(job.b0.height + dy));
    if (job.edge.indexOf('w') >= 0) {
      const w = Math.max(MINW, Math.round(job.b0.width - dx));
      b.width = w; b.x = job.b0.x + job.b0.width - w;
    }
    if (job.edge.indexOf('n') >= 0) {
      const h = Math.max(MINH, Math.round(job.b0.height - dy));
      b.height = h; b.y = job.b0.y + job.b0.height - h;
    }
    window.nami.setBounds(b).catch(() => {});
    const now = Date.now();
    if (now - (job.lastIcon || 0) > 70) { job.lastIcon = now; resizeView(); }
  });

  const finish = (e) => {
    if (!job || e.pointerId !== job.id) return;
    try { job.el.releasePointerCapture(e.pointerId); } catch (_) {}
    job = null;
    document.documentElement.classList.remove('resizing');
    segKind.refresh();
    segTheme.refresh();
  };
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

/* ============================================================
   数据
   ============================================================ */
/* ============================================================
   共用柱图（M5.5）：概览卡两张图与详情页「时段分布」都用这一支。
   纯 DOM，不新增 GPU 层（M4 纪律）。布局 = grid(柱区 1fr + 纵轴 38px)。
   ============================================================ */
function renderPlotArea(el, opts) {
  const bars = opts.bars || [], max = Math.max(1, opts.max || 0);
  const xLabels = opts.xLabels || [];
  const avg = opts.avg && max > 0 ? Math.max(0, Math.min(1, opts.avg / max)) : 0;
  el.style.setProperty('--avg', avg.toFixed(4));   // 纵轴的「平均」标签也要读到它（M5.6）
  const parts = [];
  if (avg) parts.push('<div class="plot-avg" style="--avg:' + avg.toFixed(4) + '"></div>');
  parts.push('<div class="plot-bars">');
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i] || {};
    const segs = b.parts || [];
    const title = (b.tip || '') + (b.sub ? '\n' + b.sub : '');
    const pct = (v) => (v / max * 100).toFixed(2) + '%';
    let stack = '<div class="pst">';
    for (const p of segs) {
      const st = p.raw ? p.raw : 'height:' + pct(Math.max(0, p.sec || 0));
      stack += '<i class="' + (p.cls || 's-use') + '" style="' + st + '"></i>';
    }
    stack += '</div>';
    const xo = xLabels[i];
    /* M5.6（主人 1/2 号）：提示改用 data-tip + 自绘浮层；带 day 的柱子再挂 data-day，点一下跳那天 */
    const tipAttr = title ? ' data-tip="' + esc(title) + '"' : '';
    const dayAttr = b.day ? ' data-day="' + b.day + '"' : '';
    parts.push('<div class="pbar' + (b.cls ? ' ' + b.cls : '') + (b.day ? ' clickable' : '') + '"' + dayAttr + tipAttr + '>' + stack +
      (xo ? '<span class="px' + (xo.hide ? ' hide' : '') + (xo.cls ? ' ' + xo.cls : '') + '">' + esc(xo.label) + '</span>' : '<span class="px hide"></span>') +
      '</div>');
  }
  parts.push('</div>');
  let y = '<div class="plot-y"><span class="y1">' + esc(opts.y1Label || '') + '</span>';
  if (avg) y += '<span class="ya">平均</span>';
  y += '<span class="y0">' + esc(opts.y0Label || '0') + '</span></div>';
  el.innerHTML = parts.join('') + y;
}

/* 概览卡 / 热力图：按「显示指纹」节流，20 秒轮询时数据没变就一次 DOM 写都不做 */
let ovSig = '', heatSig = '';
/* M8（主人 5 号）：概览卡的 7 天窗口自成一份状态 —— 默认「最近 7 天」，
   点 ‹ › 按周前后翻，不再跟着 state.anchor 走（不然点一根柱子那天就变成窗口最后一天，回不去）。
   null = 收口到「到今天为止」，不为空时它就是窗口的最后一天。 */
let ovEnd = null;
/* M8（主人 4 号）：热力图的窗口同理 —— null = 本周（最近 4 周），否则存窗口最后一天（周日）。 */
let heatEnd = null;
const OV_DAYS = 7;

/* 苹果「屏幕时间」主页风：上 = 逐日堆叠柱 + 平均虚线，下 = 24 小时按分类堆叠，底 = 图例。
   除「其他」外每根柱子按分类分色，与图例同一套颜色。 */
async function renderOverview() {
  const today = dayKey();
  const end = ovEnd || today;
  const o = await window.nami.overview({ anchor: end, days: OV_DAYS });
  if (!o || o.ok === false) return;
  const sig = o.from + '|' + o.to + '|' + o.total + '|' + o.avg + '|' +
    o.days.map((x) => x.sec + ':' + x.idle + ':' + x.lock + ':' + x.sleep).join(',') + '|' +
    o.hours.map((h) => h.map((s) => s.k + s.s).join('.')).join(',') + '|' +
    o.legend.map((l) => l.id + ':' + l.name + ':' + l.sec + ':' + (l.color || '')).join(',');
  if (sig === ovSig) return;
  ovSig = sig;
  const maxDay = Math.max(1, o.maxDay);
  const WD = ['日', '一', '二', '三', '四', '五', '六'];
  const bars = o.days.map((x) => {
    const d = new Date(x.day + 'T00:00:00');
    const tip = fmtDate(x.day) + (x.day === dayKey() ? ' 今天' : '') +
      '\n' + WD[d.getDay()] + '\n合计 ' + fmtDur(x.sec) +
      (x.idle ? '\n空闲 ' + fmtDur(x.idle) : '') + (x.lock ? '\n锁屏 ' + fmtDur(x.lock) : '') + (x.sleep ? '\n休眠 ' + fmtDur(x.sleep) : '');
    return {
      tip, cls: x.day === o.today ? 'today' : '', day: x.day,
      parts: [
        { cls: 's-sleep', sec: x.sleep }, { cls: 's-lock', sec: x.lock },
        { cls: 's-idle', sec: x.idle }, { cls: 's-use', sec: x.sec }
      ]
    };
  });
  const stepD = Math.max(1, Math.ceil(bars.length / 7));
  const xD = bars.map((x, i) => ({
    label: o.days[i].day.slice(5).replace('-', '/'), hide: !(i === 0 || i === bars.length - 1 || i % stepD === 0),
    cls: o.days[i].day === o.today ? 'today' : ''
  }));
  renderPlotArea($('#ovDayPlot'), { bars, max: maxDay, avg: o.avg, xLabels: xD, y1Label: fmtShort(maxDay) || '0', y0Label: '0' });
  const cName = new Map((o.legend || []).map((l) => ['c' + l.id, l]));
  /* M9（主人 2026-10-16）：和详情页「时段分布」同一口径 —— 柱子画「平均一天里的这个小时」。
     以前画的是整个窗口的合计，7 天窗口里一根柱子能顶到 5 小时，读起来像「这个小时用了 5 小时」。
     分母是活跃天数（和 #ovSub 的日均同一个），24 根加起来正好 = 日均；只有 1 个活跃天时与合计等价。
     柱子高度的比例没动（仍按窗口内的 hourMax 换算），变的只是纵轴刻度与文案。 */
  const hMax = Math.max(1, o.hourMax);
  const hDays = Math.max(1, o.hoursDays || 1);
  const hAct = Math.max(1, o.activeN || hDays);
  const hourBars = (o.hours || []).map((segs, h) => {
    const list = segs.slice().sort((p, q) => (p.k === 'o' ? 1 : q.k === 'o' ? -1 : q.s - p.s));
    const sum = segs.reduce((s, x) => s + x.s, 0);
    const lab = String(h).padStart(2, '0');
    const tip = lab + ':00 – ' + lab + ':59\n日均 ' + fmtDur(Math.round(sum / hAct)) +
      (hAct > 1 ? '（' + hAct + ' 个活跃天合计 ' + fmtDur(Math.round(sum)) + '）' : '');
    const parts = [];
    for (const s of list) {
      const item = cName.get(s.k);
      const col = s.k === 'o' ? 'rgb(140 140 150 / .55)' : (item ? item.color : 'rgb(140 140 150 / .55)');
      parts.push({ raw: 'height:' + (s.s / hMax * 100).toFixed(2) + '%;background:' + col });
    }
    if (!parts.length) parts.push({ raw: 'height:0' });
    return { tip, parts };
  });
  renderPlotArea($('#ovHourPlot'), {
    bars: hourBars, max: hMax, xLabels: hourXLabels(),
    y1Label: fmtShort(hMax / hAct) || '0', y0Label: '0'
  });
  /* M8（主人 5 号）：窗口收口到今天 == 「最近 N 天」；翻到过去就报出这一段的日期区间 */
  $('#ovTitle').textContent = end >= today ? '最近 ' + o.days.length + ' 天' : shortMd(o.from) + ' – ' + shortMd(o.to);
  $('#ovSub').textContent = '合计 ' + fmtDur(o.total) + ' · 日均 ' + fmtDur(o.avg);
  $('#ovPrev').disabled = false;
  $('#ovNext').disabled = end >= today;
  $('#ovHourCap').textContent = hDays > 1 ? '平均一天 · 按分类（活跃 ' + hAct + ' 天）' : '按分类';
  $('#ovLegend').innerHTML = (o.legend || []).map((l) => '<span><i style="background:' + esc(l.color || 'rgb(140 140 150 / .55)') + '"></i>' + esc(l.name) + ' <b>' + esc(fmtShort(l.sec) || '0分') + '</b></span>').join('');
}

/* 横轴标签：0 / 6 / 12 / 18 / 24 时（24 根柱子时才用） */
function hourXLabels() {
  return Array.from({ length: 24 }, (_, h) => (h % 6 === 0 ? { label: h === 24 ? '24' : String(h), hide: false } : { label: '', hide: true }));
}

/* 左栏热力图（M5.5）：GitHub contributions 风 —— 最近 4 周 × 7 列，点一下跳到那天。
   既补了左栏原来的空白，又给了「哪天用得多、一眼找到」的真预览（比纯装饰有用）。 */
async function renderHeat() {
  const today = dayKey();
  const curSun = weekEnd(today);                                  // 本周日 = 默认窗口的最后一天
  const dEnd = new Date(heatEnd || curSun);                       // M8：窗口最后一天（周日）
  const to = dayKey(dEnd);                                        // = heatEnd，或本周日
  const d0 = new Date(dEnd); d0.setDate(d0.getDate() - 34);
  const from = dayKey(d0);                                        // 5 列 × 7 = 35 天（4 周历史 + 本周）
  const r = await window.nami.days({ from, to });
  if (!r || !r.days) return;
  const sig = from + '|' + to + '|' + r.days.map((x) => x.day + ':' + x.seconds).join(',') + '|' +
    (r.idle || []).map((x) => x.day + ':' + x.kind + ':' + x.seconds).join(',');
  if (sig === heatSig) return;
  heatSig = sig;
  const secMap = new Map(r.days.map((x) => [x.day, x.seconds || 0]));
  const away = new Map();
  for (const x of (r.idle || [])) {
    const cur = away.get(x.day) || { idle: 0, lock: 0, sleep: 0 };
    cur[x.kind] = (cur[x.kind] || 0) + x.seconds;
    away.set(x.day, cur);
  }
  let max = 1, sum = 0;
  for (const [, s] of secMap) { if (s > max) max = s; sum += s; }
  const WD = ['一', '二', '三', '四', '五', '六', '日'];
  $('#heatWd').innerHTML = WD.map((w) => '<span>' + w + '</span>').join('');
  const pad = (new Date(from + 'T00:00:00').getDay() + 6) % 7;   // 从周一起排
  const cells = [];
  for (let i = 0; i < pad; i++) cells.push('<span class="heat-cell future" aria-hidden="true"></span>');
  for (let d = from; d <= to; ) {
    if (d > today) {
      cells.push('<span class="heat-cell future" aria-hidden="true"></span>');
      const nf = new Date(d + 'T00:00:00'); nf.setDate(nf.getDate() + 1); d = dayKey(nf);
      continue;
    }
    const s = secMap.get(d) || 0;
    /* M5.6 主人 1 号：旧版是「中灰底 + 0~1 透明度叠加」→ 35 个方块看起来就是一堵灰墙。
       改成：没有记录 = 只剩一圈细描边；有记录 = 按活跃度上色（0.30~1.00，差的档位也看得出深浅） */
    const a = s > 0 ? (0.30 + 0.70 * Math.min(1, s / max)).toFixed(3) : '0';
    const av = away.get(d) || {};
    const tip = fmtDate(d) + (d === today ? ' 今天' : '') + '\n使用 ' + fmtDur(s) +
      (av.idle ? '\n空闲 ' + fmtDur(av.idle) : '') + (av.lock ? '\n锁屏 ' + fmtDur(av.lock) : '') + (av.sleep ? '\n休眠 ' + fmtDur(av.sleep) : '') +
      '\n点一下跳到这天';
    cells.push('<button class="heat-cell' + (s > 0 ? ' has' : '') + (d === state.anchor ? ' sel' : '') +
      '" data-day="' + d + '" data-tip="' + esc(tip) + '" style="--a:' + a + '"' +
      ' aria-label="' + esc(fmtDate(d) + ' ' + fmtDur(s)) + '"></button>');
    const nx = new Date(d + 'T00:00:00'); nx.setDate(nx.getDate() + 1); d = dayKey(nx);
  }
  $('#heatGrid').innerHTML = cells.join('');
  /* M8（主人 4 号）：翻到过去就把标题换成这一段的具体日期 */
  $('#heatTitle').textContent = to >= curSun ? '最近 4 周' : shortMd(from) + '–' + shortMd(to);
  $('#heatSum').textContent = fmtShort(sum) || '0分';   // M8：左栏只有 170px，去掉「合计 」才不挤
  $('#heatPrev').disabled = false;
  $('#heatNext').disabled = to >= curSun;
}

let lastSig = '';
async function refresh(force) {
  /* M5.6 性能（主人 5 号）：详情页是整窗浮层，底下的列表 / 概览 / 热力图全被它盖住。
     这时候还照 20 秒一遍地重画那些 DOM = 白烧一次全窗合成（进出详情页的那一帧就是这么被拖慢的）。
     直接跳过；关掉详情页时 closeDetail() 会补一次 refresh(true)。 */
  if (detailApp !== null) return;
  const d = await window.nami.range({ kind: state.kind, anchor: state.anchor });
  /* 资源纪律：先算「显示指纹」。指纹没变就一次 DOM 写、一次重绘都不做。
     软件合成下一次全窗重绘要几百毫秒，轮询必须便宜到这个程度。 */
  const sig = state.kind + '|' + d.from + '|' + d.to + '|' + dateLabel(d) + '|' +
    fmtDur(d.total) + '|' + d.rows.length + '|' + fmtDur(d.idle) + '|' +
    (d.idleParts || []).map((p) => p.kind + ':' + p.seconds).join(',') + '|' +
    d.rows.map((r) => r.id + ':' + fmtDur(r.seconds) + ':' + (r.icon || '') + ':' + (r.cats || []).join('.')).join(',') + '|' +
    state.view + '|' + state.cat + '|' + catOpenId + '|' +
    catState.list.map((c) => c.id + c.name + (c.color || '')).join(',') + '|' +
    (d.catRows || []).map((c) => c.id + ':' + c.seconds).join(',');
  if (!force && sig === lastSig) return;
  lastSig = sig;
  state.range = { from: d.from, to: d.to };   // 日历要用它标出「当前这一段」的范围
  state.lastRows = d.rows;                    // 归类弹层要用它拿「这一行的分类」
  /* 详情页范围自成一个（M5.5）：点应用进来默认「最近 7 天」，页内切范围不会动主列表。
     M5.6：详情页打开时 refresh 在最上面就返回了，所以这里不用再「顺手刷一遍详情」。 */

  $('#dateLabel').textContent = dateLabel(d);
  $('#nextDay').disabled = state.kind === 'all';
  $('#foot').textContent = `${d.from} → ${d.to} · 记录保存在本机`;
  renderRail(d.catRows || []);
  renderOverview();
  renderHeat();

  const list = $('#list');
  const cmap = new Map((d.catRows || []).map((c) => [c.id, c]));
  const sel = state.cat !== 'all' ? catById(state.cat) : null;
  const isCatView = state.view === 'cat';
  const appRows = state.cat === 'all' ? d.rows : d.rows.filter((r) => (r.cats || []).includes(state.cat));
  const catList = catState.list.map((c) => ({
    id: c.id, name: c.name, color: c.color,
    seconds: (cmap.get(c.id) || {}).seconds || 0,
    apps: (cmap.get(c.id) || {}).apps || []
  })).sort((a, b) => b.seconds - a.seconds || a.id - b.id);

  $('#listTitle').textContent = isCatView ? '分类合计' : (sel ? sel.name : '最常用');
  $('#rangeHint').textContent = isCatView
    ? `${fmtDur(catList.reduce((s, c) => s + c.seconds, 0))} · ${catList.length} 个分类`
    : `${fmtDur(appRows.reduce((s, r) => s + r.seconds, 0))} · ${appRows.length} 个应用`;

  if (isCatView) {
    if (!catList.length) {
      list.innerHTML = '<div class="empty">还没有分类喵~<br>左栏点「＋ 新建分类」，或一键启用游戏模板</div>';
      return;
    }
    const cmax = Math.max(1, catList[0].seconds);
    list.innerHTML = catList.map((c) => catRowHtml(c, cmax) +
      (catOpenId === c.id ? c.apps.map((a) => memberRowHtml(a, Math.max(1, c.seconds))).join('') : '')).join('');
    return;
  }

  if (!appRows.length && !(state.cat === 'all' && d.idle)) {
    list.innerHTML = state.cat === 'all'
      ? '<div class="empty">这个范围还没有记录<br>让它跑一会儿，再回来看喵~</div>'
      : '<div class="empty">这个分类下暂时还没有应用<br>点应用行末尾的 ⋯ 可以手动归类</div>';
    return;
  }
  const rows = appRows.map((r) => appRowHtml(r, d.max));
  if (state.cat === 'all' && d.idle > 0) {
    const parts = (d.idleParts || []).filter((p) => p.seconds > 0);
    const away = parts.filter((p) => p.kind !== 'idle');          // 有锁屏/休眠才写明细
    const sub = away.length
      ? '明细 ' + parts.map((p) => `${KIND_LABEL[p.kind] || p.kind} ${fmtDur(p.seconds)}`).join(' · ')
      : '这段时间没有键鼠操作';
    rows.push(`<div class="row idle"><div class="ico">☾</div><div class="col">` +
      `<div class="top"><span class="name">空闲</span><span class="dur">${fmtDur(d.idle)}</span></div>` +
      `<div class="sub">${sub}</div></div></div>`);
  }
  list.innerHTML = rows.join('');
}

function shift(dir) {
  if (state.kind === 'all') return;
  const d = new Date(state.anchor + 'T00:00:00');
  if (state.kind === 'day') d.setDate(d.getDate() + dir);
  else if (state.kind === 'week') d.setDate(d.getDate() + 7 * dir);
  else d.setMonth(d.getMonth() + dir, 1);
  state.anchor = dayKey(d);
  refresh();
}

/* ============================================================
   大日历选择器（M2 尾巴）：点日期标题弹出，一屏看整月
   · 有记录的日子带一个小圆点 —— 这就是「快速跳到以前的记录」的入口
   · 未来 / 最早记录之前的日期置灰；点标题切「整年 12 个月」
   ============================================================ */
const cal = { month: null, view: 'day', token: 0, cache: { key: '', map: new Map(), first: null, today: dayKey() } };
const ymKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** 逐日汇总（带缓存：同一个区间不重复问主进程） */
async function calLoad(from, to) {
  const key = from + '~' + to;
  if (cal.cache.key === key) return cal.cache;
  let r = null;
  try { r = await window.nami.days({ from, to }); } catch (e) { r = null; }
  const map = new Map();
  for (const x of ((r && r.days) || [])) map.set(x.day, x.seconds);
  cal.cache = { key, map, first: r ? r.firstDay : null, today: (r && r.today) || dayKey() };
  return cal.cache;
}

/** 42 格（6 周）月视图，周日开头（和苹果日历一致） */
function calCells(y, m) {
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

async function renderCal() {
  const grid = $('#calGrid');
  const today = dayKey();
  const month = cal.month || (state.anchor || today).slice(0, 7);
  const y = +month.slice(0, 4), m = +month.slice(5, 7);
  const token = ++cal.token;

  if (cal.view === 'month') {
    $('#calTitle').textContent = `${y}年`;
    $('#calWeek').style.display = 'none';
    grid.classList.add('months');
    const c = await calLoad(`${y}-01-01`, `${y}-12-31`);
    if (token !== cal.token) return;
    const firstYm = c.first ? c.first.slice(0, 7) : null;
    const curYm = today.slice(0, 7);
    const selYm = (state.anchor || today).slice(0, 7);
    const months = new Set([...c.map.keys()].map((k) => k.slice(0, 7)));
    grid.innerHTML = Array.from({ length: 12 }, (_, i) => {
      const key = `${y}-${pad(i + 1)}`;
      const off = (firstYm && key < firstYm) || key > curYm;
      const cls = ['cal-cell', key === curYm ? 'today' : '', key === selYm ? 'sel' : '', off ? 'off' : ''].filter(Boolean).join(' ');
      return `<button class="${cls}" data-ym="${key}"><span class="d">${i + 1}月${months.has(key) ? '<i class="dot"></i>' : ''}</span></button>`;
    }).join('');
    return;
  }

  $('#calTitle').textContent = `${y}年${m}月`;
  $('#calWeek').style.display = '';
  grid.classList.remove('months');
  const cells = calCells(y, m);
  const c = await calLoad(dayKey(cells[0]), dayKey(cells[41]));
  if (token !== cal.token) return;
  const r = state.range || { from: state.anchor, to: state.anchor };
  grid.innerHTML = cells.map((d) => {
    const key = dayKey(d);
    const cls = ['cal-cell',
      d.getMonth() + 1 !== m ? 'out' : '',
      key === today ? 'today' : '',
      key === state.anchor ? 'sel' : '',
      (state.kind !== 'day' && key >= r.from && key <= r.to) ? 'inrange' : '',
      (key > today || (c.first && key < c.first)) ? 'off' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-day="${key}"><span class="d">${d.getDate()}${c.map.has(key) ? '<i class="dot"></i>' : ''}</span></button>`;
  }).join('');
}

function calOpen(on) {
  const el = $('#calpop');
  if (on) { cal.month = (state.anchor || dayKey()).slice(0, 7); el.hidden = false; renderCal(); }
  else el.hidden = true;
  const label = $('#dateLabel');
  if (label) label.classList.toggle('on', on);
}

/** ‹ › ：日视图翻月，年视图翻年 */
function calStep(dir) {
  const mk = cal.month || (state.anchor || dayKey()).slice(0, 7);
  const d = new Date(+mk.slice(0, 4), +mk.slice(5, 7) - 1 + (cal.view === 'month' ? 12 * dir : dir), 1);
  cal.month = ymKey(d);
  renderCal();
}

function pickDay(key) {
  if (state.kind === 'all') { state.kind = 'day'; segKind.sync('day'); }  // 「全部」没有锚点，选日期就切回单日
  state.anchor = key;
  calOpen(false);
  refresh(true);
}

/* ============================================================
   分类（M3 · S3.1~S3.5）
   · 左栏筛选 + 「＋ 新建分类」
   · 应用视图 ⇄ 分类视图（分类视图：每个分类一行合计，点开看成员各自时长）
   · 手动归类：应用行末尾的 ⋯ → 归类到…（手动优先，规则让位）
   · 规则编辑：exe 名 / 路径 / 标题正则；预置「游戏」模板一键启用
   ============================================================ */
const catState = { list: [], rules: [], rulesOn: true, pairs: [], palette: [], hasGame: false, template: null, kindLabel: {} };
let catOpenId = null;      // 分类视图里正在展开的那个分类
/* ============================================================
   M5 · 应用详情页（F5）
   点应用行进来：逐日柱图（本应用 / 空闲 / 锁屏 堆叠）+ 首末次使用 + 日均 + 分类。
   柱图是纯 DOM，没上 SVG / Canvas —— 一天一根柱子、几十根的量级不值得起图层。
   ============================================================ */
let detailApp = null;        // 正在看详情的应用 id；null = 详情页没开
let detailKey = '';          // 详情数据指纹（范围 + 锚点），没变就不重取
let dtKind = 'd7';           // M5.5：详情页自己的范围，默认最近 7 天
let dtAnchor = '';           // 详情页锚点；空 = 跟主列表当前锚点
let detailSeg = null;        // 详情页范围分段控件；openDetailAt 要 refresh 它，所以必须在这一层

const MAX_DETAIL_DAYS = 120;
const fmtClock = (ts) => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

/* M9（主人 1 号）：多了一个可选的第 4 参 tip —— 卡片面积小，副标题只能写一句短的，
   完整定义（比如「空闲」到底怎么算）走 data-tip 自绘浮层，悬停就能看全。 */
function dtStat(label, value, sub, tip) {
  return '<div class="dt-stat"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '>' +
    '<span class="dt-s-l">' + esc(label) + '</span>' +
    '<span class="dt-s-v">' + esc(value) + '</span>' +
    (sub ? '<span class="dt-s-s">' + esc(sub) + '</span>' : '') + '</div>';
}

/* ============================================================
   M5.6 · 详情页逐日柱：30 天窗口 + 拖动平移（主人 3 号）
   「全部」会载入几百天，一次全画出来又慢又卡（进入那一刻的主要开销之一）。
   改成一次只画 30 根柱子，按住柱子左右拖动看更早的（DOM 数量恒定，滑动不掉帧）；
   点柱子还能跳到那天的记录。平均虚线也按 30 天窗口算，和柱子同一个刻度。
   ============================================================ */
const DT_WIN = 30;
const dtWin = { key: '', off: 0 };     // off = 窗口起点在 days 里的下标
let detailData = null;                 // 最近一次 appDetail 的原始数据（拖动重画要用）
let dtPan = null, dtPanned = false;

function paintDayChart() {
  const d = detailData;
  const chart = $('#dtChart');
  if (!d) return;
  hideTip();
  const days = d.days || [];
  const n = days.length;
  const win = Math.min(DT_WIN, Math.max(1, n));
  dtWin.off = clamp(dtWin.off, 0, Math.max(0, n - win));
  const view = days.slice(dtWin.off, dtWin.off + win);
  const pannable = n > win;
  chart.classList.toggle('pannable', pannable);
  const peak = view.reduce((m, x) => Math.max(m, x.sec + x.idle + x.lock + x.sleep), 0);
  if (!view.length || !peak) {
    chart.innerHTML = '<div class="empty">这段时间还没有记录喵~</div>';
    $('#dtChartNote').textContent = '';
    return;
  }
  const N = view.length;
  const step = Math.max(1, Math.ceil(N / 8));      // 横轴最多标 8 个日期，多了会糊成一团
  const bars = view.map((x) => ({
    day: x.day,
    tip: fmtDate(x.day) + (x.day === d.today ? ' 今天' : ''),
    sub: ['本应用 ' + fmtDur(x.sec), x.idle ? '空闲 ' + fmtDur(x.idle) : '',
      x.lock ? '锁屏 ' + fmtDur(x.lock) : '', x.sleep ? '休眠 ' + fmtDur(x.sleep) : ''].filter(Boolean).join('\n'),
    cls: (x.sec + x.idle + x.lock + x.sleep) ? '' : 'zero',
    parts: [
      { cls: 's-sleep', sec: x.sleep }, { cls: 's-lock', sec: x.lock },
      { cls: 's-idle', sec: x.idle }, { cls: 's-use', sec: x.sec }
    ]
  }));
  const xL = view.map((x, i) => ({
    label: x.day.slice(8).replace(/^0/, '') + '日',
    hide: !(i === 0 || i === N - 1 || (i % step === 0 && i <= N - 1 - step)),
    cls: x.day === d.today ? 'today' : ''
  }));
  /* 平均虚线：柱子画的是「本应用 + 空闲 + 锁屏/休眠」，虚线就得同一个刻度；
     数字口径的「日均」写在 hero 里，按本应用活跃天算（和概览卡一致）。 */
  const withAll = view.filter((x) => (x.sec + x.idle + x.lock + x.sleep) > 0);
  const avgAll = withAll.length
    ? Math.round(withAll.reduce((s, x) => s + x.sec + x.idle + x.lock + x.sleep, 0) / withAll.length) : 0;
  renderPlotArea(chart, { bars, max: peak, avg: avgAll, xLabels: xL, y1Label: fmtShort(peak) || '0', y0Label: '0' });
  const note = [];
  if (pannable) {
    note.push('这一段显示 ' + fmtDate(view[0].day) + ' – ' + fmtDate(view[N - 1].day) + '（共 ' + n +
      ' 天）· 按住柱子左右拖动看更早的；点柱子跳到那天的记录。');
  } else if (d.clipped) note.push('范围太长，只画最近 ' + n + ' 天。');
  note.push('柱高 = 当天「本应用 + 空闲 + 锁屏 / 休眠」合计，虚线 = 平均一天的合计高度；空闲与锁屏是全系统合计，不属于该应用本身。');
  $('#dtChartNote').textContent = note.join(' ');
}

/* 拖动平移 + 点柱子跳那天：只有「长度超过 30 天」时才能拖，短范围行为跟以前一样 */
function bindDetailChart() {
  const el = $('#dtChart');
  el.addEventListener('pointerdown', (e) => {
    if (!el.classList.contains('pannable')) return;
    dtPan = { x: e.clientX, off: dtWin.off, w: el.getBoundingClientRect().width };
    dtPanned = false;
    el.classList.add('panning');
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  });
  el.addEventListener('pointermove', (e) => {
    if (!dtPan) return;
    const per = Math.max(10, dtPan.w / DT_WIN);          // 一根柱子大概多少像素
    const dx = dtPan.x - e.clientX;
    if (Math.abs(dx) > 4) dtPanned = true;
    const days = (detailData && detailData.days) || [];
    const want = clamp(dtPan.off + Math.round(dx / per), 0, Math.max(0, days.length - DT_WIN));
    if (want === dtWin.off) return;
    dtWin.off = want;
    paintDayChart();
  });
  const end = () => { if (dtPan) { dtPan = null; el.classList.remove('panning'); } };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('click', (e) => {
    if (dtPanned) { dtPanned = false; return; }          // 刚才是拖，不是点
    const b = e.target.closest ? e.target.closest('[data-day]') : null;
    if (!b || detailApp === null) return;
    hideTip();
    closeDetail();
    pickDay(b.dataset.day);
  });
}

function renderDetail(d) {
  const a = d.app || {};
  const days = d.days || [];
  const parts = {};
  for (const p of (d.idleParts || [])) parts[p.kind] = p.seconds;

  $('#dtRange').textContent = dateLabel({ kind: d.kind, anchor: d.anchor, from: d.from, to: d.to });
  $('#dtIco').innerHTML = d.icon
    ? '<img src="nami-icon://' + esc(d.icon) + '" alt="">'
    : '<span class="letter">' + esc((a.name || '?').trim().charAt(0).toUpperCase()) + '</span>';
  $('#dtName').textContent = a.name || '—';
  const pathEl = $('#dtPath');
  pathEl.textContent = a.path || a.exeName || '';
  pathEl.title = a.path || '';
  const tags = (d.cats || []).map((id) => {
    const c = catById(id);
    return c ? '<span class="cat-tag"><i style="background:' + esc(c.color || '#8E8E93') + '"></i>' + esc(c.name) + '</span>' : '';
  }).join('');
  $('#dtTags').innerHTML = tags || '<span class="dt-nocat">还没有归类（回到列表，行尾 ⋯ 可以手动归类）</span>';
  /* M7 主人第 6 条：详情页也能换图标（列表里那个 ⋯ 菜单里也有一份） */
  $('#dtIconRow').innerHTML =
    '<button class="dt-iconbtn" id="dtIconPick">' + (d.customIcon ? '换一张自定义图标…' : '自定义图标…') + '</button>' +
    (d.customIcon ? '<button class="dt-iconbtn" id="dtIconClear">恢复自动图标</button>' : '') +
    /* M8 主人第 9 条：详情页也能改名（列表右键的 ⋯ 菜单里也有一份） */
    '<button class="dt-iconbtn" id="dtRename">' + (d.app.customName ? '换个名字…' : '自定义名称…') + '</button>' +
    (d.app.customName ? '<button class="dt-iconbtn" id="dtRenameClear">恢复自动名称</button>' : '');
  $('#dtTotal').textContent = fmtDur(d.total);

  const active = days.filter((x) => x.sec > 0);
  const idleDays = days.length - active.length;
  const avg = active.length ? Math.round(d.total / active.length) : 0;
  const lockAll = parts.lock || 0, sleepAll = parts.sleep || 0;
  /* M9（主人 1 号）：主人问「空闲时间要有个定义」—— 卡片刻度只能写一句短的，
     完整口径走 data-tip 浮层（每行都短，浮层是 nowrap 的）。口径来自采集器：
     连续 2 分钟没有键鼠操作就从停手那一刻起算（collector.js:197-201），
     没有前台窗口时也算（collector.js:205-207），锁屏 / 休眠另有单独口径。 */
  const IDLE_DEF = '空闲 = 连续 2 分钟没有键鼠操作\n从你停手那一刻开始算\n桌面 / UAC 这类没有前台窗口也算\n空闲不属于任何应用\n锁屏与休眠单独统计，不算空闲';
  const LOCK_DEF = '锁屏 = 系统锁屏期间\n休眠 = 睡眠 / 休眠期间\n两者单独统计，不算空闲\n也不属于任何应用';
  $('#dtStats').innerHTML = [
    dtStat('活跃天数', active.length + ' / ' + days.length + ' 天', idleDays > 0 ? idleDays + ' 天空着' : (days.length ? '每天都用过' : '')),
    dtStat('日均（按活跃天）', fmtDur(avg), '把这 ' + active.length + ' 天平摊成一天'),
    dtStat('首次使用', d.firstTs ? fmtDate(dayKey(new Date(d.firstTs))) : '—', d.firstTs ? fmtClock(d.firstTs) : ''),
    dtStat('最后使用', d.lastTs ? fmtDate(dayKey(new Date(d.lastTs))) : '—', d.lastTs ? fmtClock(d.lastTs) : ''),
    dtStat('空闲合计', fmtDur(parts.idle || 0), '连续 2 分无键鼠', IDLE_DEF),
    dtStat('锁屏 / 休眠', fmtDur(lockAll + sleepAll), sleepAll ? '休眠 ' + fmtDur(sleepAll) : '', LOCK_DEF)
  ].join('');

  $('#dtLegend').innerHTML =
    '<span class="lg-use">本应用</span>' +
    '<span class="lg-idle" data-tip="' + esc(IDLE_DEF) + '">空闲</span>' +
    '<span class="lg-lock" data-tip="' + esc(LOCK_DEF) + '">锁屏 / 休眠</span>';

  /* 逐日柱（M5.6 主人 3 号）：默认 7 天，一次最多画 30 根，「全部」载入很多天时开窗口 + 拖动平移 */
  detailData = d;
  const wkey = d.kind + '|' + d.from + '|' + d.to;
  if (dtWin.key !== wkey) { dtWin.key = wkey; dtWin.off = Math.max(0, days.length - DT_WIN); }
  /* 主人在意的是「这个应用本范围日均用了多久」，所以数字用本应用口径（和概览卡 #ovSub 一致） */
  $('#dtTotalL').textContent = '本范围合计 · 日均 ' + (fmtShort(avg) || '0分');
  paintDayChart();

  /* 时段分布：24 小时 = 「平均一天」的样子（M9 · 主人 2026-10-16）。
     历史：M7 那版柱子画「本范围真实合计」，因为更早的版本除以**日历天数**会把
     「7 天里只用过 1 天」压成 1/7（今天用了 1 小时，图里最高才 5 分）。
     但合计口径在长范围里读不通：30 天窗口里 20:00–20:59 显示「3 小时 4 分钟」，
     像在说「这个小时用了 3 小时」。现在柱子 = 该小时 ÷ **活跃天数**（和 hero「日均（按活跃天）」
     同一个分母），纵轴是「一天里这个小时平均用多久」，24 根加起来正好 = 日均；
     只有 1 个活跃天时与「合计」完全等价，T 字型两难的「1/7 压扁」也不会回来。
     悬停仍然给合计。 */
  const hrs = d.hours || [];
  const hdiv = Math.max(1, d.hoursDays || 1);
  const hAct = Math.max(1, active.length);          // 活跃天 = 有用量的天（hero 同一口径）
  const hsum = hrs.reduce((s, x) => s + x, 0);
  const hmax = Math.max(1, hrs.length ? Math.max(...hrs) / hAct : 0);
  $('#dtHoursLegend').innerHTML = '<span class="lg-use">本应用</span><span class="dt-hu">' +
    (hdiv > 1 ? '平均一天 · 活跃 ' + hAct + ' 天' : '当天') + '</span>';
  if (!d.hoursSegs) {
    $('#dtHours').innerHTML = '<div class="empty">这段时间还没有逐秒片段喵~<br>（早于采集器的记录只有按天汇总）</div>';
    $('#dtHoursNote').textContent = '时段分布需要原始片段；更早的历史只有按天汇总。';
  } else {
    const hbars = hrs.map((s, h) => {
      const lab = String(h).padStart(2, '0');
      return {
        tip: lab + ':00 – ' + lab + ':59',
        sub: '日均 ' + fmtDur(Math.round(s / hAct)) +
          (hAct > 1 ? '（' + hAct + ' 个活跃天合计 ' + fmtDur(Math.round(s)) + '）' : ''),
        cls: s ? '' : 'zero', parts: [{ cls: 's-use', sec: s / hAct }]
      };
    });
    renderPlotArea($('#dtHours'), { bars: hbars, max: hmax, xLabels: hourXLabels(), y1Label: fmtShort(hmax) || '0', y0Label: '0' });
    const hn = ['柱子 = 一天里「第几小时」平均用了多久' +
      (hsum > 0 ? '（日均共 ' + fmtDur(Math.round(hsum / hAct)) + '）' : '') + '。'];
    if (hdiv > 1) hn.push('把 ' + hdiv + ' 天里本应用活跃的 ' + hAct + ' 天平摊成一天；悬停柱子看合计。');
    if (d.kind === 'all') hn.push('「全部」只取最近 ' + MAX_DETAIL_DAYS + ' 天来画。');
    $('#dtHoursNote').textContent = hn.join(' ');
  }
}

function openDetail(appId, opts) {
  const id = Number(appId);
  const k = dtKind, a = dtAnchor || state.anchor;
  return openDetailAt(id, k, a, !!(opts && opts.force));
}
async function openDetailAt(id, k, a, force) {
  const key = k + '|' + a;
  if (!force && detailApp === id && detailKey === key) return;
  const d = await window.nami.appDetail({ appId: id, kind: k, anchor: a });
  const el = $('#detail');
  detailApp = id;
  detailKey = key;
  if (!d || d.ok === false) {
    $('#dtRange').textContent = dateLabel({ kind: k, anchor: a, from: a, to: a });
    $('#dtName').textContent = '—';
    $('#dtChart').innerHTML = '<div class="empty">' + esc((d && d.error) || '打不开详情喵') + '</div>';
    $('#dtChartNote').textContent = '';
    el.hidden = false;
    document.body.classList.add('dt-open');
    return;
  }
  renderDetail(d);
  el.hidden = false;
  document.body.classList.add('dt-open');
  el.scrollTop = 0;
  if (detailSeg) requestAnimationFrame(() => detailSeg.refresh());
}
function closeDetail() {
  if (detailApp === null) return;
  detailApp = null;
  $('#detail').hidden = true;
  document.body.classList.remove('dt-open');
  hideTip();
  /* 详情页期间主列表是不刷新的（上面 refresh 直接 return），出来补一次 */
  refresh(true);
}

let editId = null;         // 编辑器正在改的分类（null = 新建）
let editColor = null;
let assignApp = null;      // 归类弹层正在处理的应用
let assignSel = new Set();

/** 左栏用的紧凑时长：3时37分（完整版太长了塞不下） */
function fmtShort(sec) {
  if (!sec) return '';
  if (sec < 60) return '<1分';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}时${m}分` : `${h}时`;
  return `${m}分`;
}
const catById = (id) => catState.list.find((c) => c.id === Number(id)) || null;
const manualOf = (appId) => catState.pairs.filter((p) => p.app_id === Number(appId)).map((p) => p.category_id);
const autoCatsOf = (appId) => {
  const row = state.lastRows.find((r) => r.id === Number(appId));
  return (row && row.cats) || [];
};

function applyCatState(s) {
  if (!s || s.ok === false) return s;
  catState.list = s.categories || [];
  catState.rules = s.rules || [];
  catState.rulesOn = !!s.rulesOn;
  catState.pairs = s.pairs || [];
  catState.hasGame = !!s.hasGame;
  if (s.palette) catState.palette = s.palette;
  if (s.kindLabel) catState.kindLabel = s.kindLabel;
  if (s.template) catState.template = s.template;
  return s;
}
async function loadCats() { return applyCatState(await window.nami.cats()); }

/* —— 左栏：全部应用 + 各分类（右边是当前范围的合计）—— */
function renderRail(catRows) {
  const totals = new Map((catRows || []).map((c) => [c.id, c.seconds]));
  const items = [`<button class="rail-item${state.cat === 'all' ? ' active' : ''}" data-cat="all">` +
    '<span class="cat-name">全部应用</span></button>'];
  for (const c of catState.list) {
    const s = totals.get(c.id) || 0;
    items.push(`<button class="rail-item${state.cat === c.id ? ' active' : ''}" data-cat="${c.id}">` +
      `<i class="cat-dot" style="background:${esc(c.color || '#8E8E93')}"></i>` +
      `<span class="cat-name">${esc(c.name)}</span>` +
      `<span class="cat-n">${s ? fmtShort(s) : ''}</span></button>`);
  }
  $('#railNav').innerHTML = items.join('');
  $('#btnGameTpl').hidden = catState.hasGame;
}

/* —— 三种行：应用行 / 分类行 / 分类里的成员行 —— */
function appRowHtml(r, max) {
  const pct = Math.max(2, Math.round((r.seconds / max) * 100));
  const icon = r.icon
    ? `<img src="nami-icon://${esc(r.icon)}" alt="">`
    : `<span class="letter">${esc((r.name || '?').trim().charAt(0).toUpperCase())}</span>`;
  const tags = (r.cats || []).map((id) => {
    const c = catById(id);
    return c ? `<span class="cat-tag"><i style="background:${esc(c.color || '#8E8E93')}"></i>${esc(c.name)}</span>` : '';
  }).join('');
  return `<div class="row" data-app="${r.id}"><div class="ico">${icon}</div><div class="col">` +
    `<div class="top"><span class="name">${esc(r.name)}</span>` +
    (tags ? `<span class="cat-tags">${tags}</span>` : '') +
    `<span class="dur">${fmtDur(r.seconds)}</span></div>` +
    `<div class="bar"><i style="width:${pct}%"></i></div></div>` +
    `<button class="row-more" data-more="${r.id}" title="归类到…">⋯</button></div>`;
}
function catRowHtml(c, max) {
  const pct = c.seconds ? Math.max(2, Math.round((c.seconds / max) * 100)) : 0;
  const open = catOpenId === c.id;
  const sub = c.apps.length
    ? `${c.apps.length} 个应用 · ${open ? '收起' : '点开看各自时长'}`
    : '还没有应用命中（规则可以再加）';
  return `<div class="row cat${open ? ' open' : ''}" data-catrow="${c.id}">` +
    `<div class="ico"><i class="swatch-lg" style="background:${esc(c.color || '#8E8E93')}"></i></div>` +
    `<div class="col"><div class="top"><span class="name">${esc(c.name)}</span>` +
    `<span class="dur">${c.seconds ? fmtDur(c.seconds) : '—'}</span></div>` +
    `<div class="bar"><i style="width:${pct}%"></i></div><div class="sub">${sub}</div></div>` +
    `<button class="row-more" data-editcat="${c.id}" title="编辑分类 / 规则">⋯</button>` +
    `<span class="caret">▶</span></div>`;
}
function memberRowHtml(a, total) {
  const pct = total ? Math.max(2, Math.round((a.seconds / total) * 100)) : 0;
  const icon = a.icon
    ? `<img src="nami-icon://${esc(a.icon)}" alt="">`
    : `<span class="letter">${esc((a.name || '?').trim().charAt(0).toUpperCase())}</span>`;
  return `<div class="row member" data-app="${a.id}"><div class="ico">${icon}</div><div class="col">` +
    `<div class="top"><span class="name">${esc(a.name)}</span><span class="dur">${fmtDur(a.seconds)}</span></div>` +
    `<div class="bar"><i style="width:${pct}%"></i></div></div>` +
    `<button class="row-more" data-more="${a.id}" title="归类到…">⋯</button></div>`;
}

/* —— 归类弹层（S3.2）：贴着那一行弹出 —— */
function renderAssign() {
  const manual = manualOf(assignApp);
  const manualMode = manual.length > 0;
  const auto = manualMode ? [] : autoCatsOf(assignApp);
  const row = state.lastRows.find((r) => r.id === assignApp);
  $('#catPopTitle').textContent = `归类到… · ${row ? row.name : ''}`;
  const chips = catState.list.map((c) => {
    const on = assignSel.has(c.id);
    const byRule = !manualMode && auto.includes(c.id);
    return `<button class="cat-chip${on ? ' on' : ''}" data-cid="${c.id}">` +
      `<i class="swatch-dot" style="background:${esc(c.color || '#8E8E93')}"></i>` +
      `<span class="cn">${esc(c.name)}</span>` +
      (byRule ? '<span class="rule-mark">规则</span>' : '') +
      '<span class="tick"></span></button>';
  }).join('');
  $('#catPopList').innerHTML = chips ||
    '<div class="pop-hint" style="margin:2px 4px 6px">还没有分类，点下面新建一个喵</div>';
  $('#catPopAuto').hidden = !manualMode;
  /* M7 主人第 6 条：这个应用是不是在用自定义图标（自定义压在版本链上面，覆盖全部日期） */
  const custom = !!(row && row.customIcon);
  $('#catPopIconClear').hidden = !custom;
  /* M8 主人第 9 条：这个应用是不是被主人改过名字（改过才给「恢复自动名称」） */
  const named = !!(row && row.customName);
  $('#catPopRenameClear').hidden = !named;
  $('#catPopRenameRow').hidden = true;
  $('#catPopNameIn').value = row ? (row.customName || row.name || '') : '';
  $('#catPopNote').textContent = custom
    ? '这个应用用的是你自定义的图标，全部日期都是它'
    : (named ? '这个名字是你自己起的，点「恢复自动名称」能变回去' : '手动归过类的应用，自动规则就不再插手（手动优先）');
}
function openAssign(appId, btn) {
  const pop = $('#catPop');
  assignApp = Number(appId);
  assignSel = new Set(manualOf(assignApp));
  renderAssign();
  pop.hidden = false;
  const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const left = clamp(r.right - w, 10, Math.max(10, window.innerWidth - w - 10));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
function closeAssign() { $('#catPop').hidden = true; assignApp = null; }

/* M8 主人第 9 条：改名（传空名字 = 恢复自动名称）。改完名字在列表行上，整列表强制重画一次。 */
async function submitRename(name) {
  const id = assignApp;
  if (id === null) return;
  const r = await window.nami.renameApp(id, name);
  if (r && r.ok) { closeAssign(); lastSig = ''; refresh(true); }
  else if (r && r.error) $('#catPopNote').textContent = r.error;
}
/* 详情页那份：就地弹个输入框（Electron 里 window.prompt 是空实现，不能用） */
function openDtRename() {
  const box = $('#dtIconRow');
  const cur = ($('#dtName').textContent || '').trim();
  box.innerHTML =
    `<input class="txt dt-name-in" id="dtNameIn" maxlength="40" spellcheck="false" value="${esc(cur)}">` +
    '<button class="dt-iconbtn" id="dtNameOk">改名</button>' +
    '<button class="dt-iconbtn" id="dtNameCancel">取消</button>';
  const inp = $('#dtNameIn');
  inp.focus(); inp.select();
}
async function submitDtRename(name) {
  const id = detailApp;
  if (id === null) return;
  const r = await window.nami.renameApp(id, name);
  if (r && r.ok) { lastSig = ''; openDetail(id, { force: true }); }
}

/* —— 分类编辑器（S3.1 / S3.3）—— */
function note(msg, bad) {
  const el = $('#catNote');
  el.textContent = msg || '';
  el.style.color = bad ? '#FF375F' : '';
}
function renderSwatches() {
  $('#catSwatches').innerHTML = catState.palette.map((p) =>
    `<button class="swatch${p === editColor ? ' on' : ''}" data-color="${esc(p)}" style="background:${esc(p)}" title="${esc(p)}"></button>`).join('');
}
function renderRules() {
  const mine = catState.rules.filter((r) => r.category_id === editId);
  $('#catRules').innerHTML = mine.map((r) =>
    `<div class="rule-row"><span class="k">${esc(catState.kindLabel[r.kind] || r.kind)}</span>` +
    `<span class="p">${esc(r.pattern)}</span>` +
    `<button class="x" data-rule="${r.id}" title="删掉这条规则">✕</button></div>`).join('');
  $('#ruleHint').textContent = editId
    ? '规则命中就自动归类；手动归过类的应用不受规则影响'
    : '先起个名字（保存或直接加规则都会自动建好）';
}
function openEdit(cat) {
  editId = cat ? cat.id : null;
  editColor = cat && cat.color ? cat.color : catState.palette[0];
  $('#catEditTitle').textContent = cat ? `编辑分类 · ${cat.name}` : '新建分类';
  $('#catName').value = cat ? cat.name : '';
  $('#catDelBtn').hidden = !cat;
  note('');
  renderSwatches();
  renderRules();
  $('#catEdit').hidden = false;
  $('#catName').focus();
}
function closeEdit() { $('#catEdit').hidden = true; editId = null; }

/* ============================================================
   M8（主人 6 号）：分类右键菜单 —— 建完就能改：改名 / 换色 / 规则 / 删除
   之前分类只有两个入口：「分类」视图里点行尾的 ⋯，或者干脆没有。
   主人在「全部应用」视图里新建完一个分类，左栏那一条是死的 —— 右键也没反应。
   现在左栏任何一个分类（以及分类视图里的分类行）右键都能改。
   ============================================================ */
let cmCat = null;         // 菜单正在改的分类 id
let cmArmed = false;      // 删除要不要再点一下确认

function openCatMenu(catId, x, y) {
  const c = catById(catId);
  if (!c) return;
  cmCat = c.id; cmArmed = false;
  $('#catMenuTitle').textContent = '分类 · ' + c.name;
  $('#catMenuName').value = c.name;
  $('#catMenuColors').innerHTML = catState.palette.map((p) =>
    `<button class="cm-sw${p === c.color ? ' on' : ''}" data-color="${esc(p)}" style="background:${esc(p)}" title="${esc(p)}"></button>`).join('');
  const del = $('#catMenuDel');
  del.textContent = '删除分类'; del.classList.remove('armed');
  const m = $('#catMenu');
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = clamp(x, 8, Math.max(8, window.innerWidth - w - 8)) + 'px';
  m.style.top = clamp(y, 8, Math.max(8, window.innerHeight - h - 8)) + 'px';
  $('#catMenuName').focus();
  $('#catMenuName').select();
}
function closeCatMenu() { $('#catMenu').hidden = true; cmCat = null; cmArmed = false; }
/** 菜单里的即时修改：只改传进来的字段，其余保持原样（名字冲突等错误直接写在菜单标题上） */
async function catMenuSave(patch) {
  const c = catById(cmCat);
  if (!c) return false;
  const name = patch.name != null ? patch.name : c.name;
  const color = patch.color != null ? patch.color : (c.color || catState.palette[0]);
  const r = await window.nami.catSave({ id: c.id, name, color });
  if (!r || !r.ok) { $('#catMenuTitle').textContent = (r && r.error) || '改不了喵'; return false; }
  applyCatState(r);
  lastSig = ''; refresh(true);
  return true;
}
async function catMenuRename() {
  const nm = $('#catMenuName').value.trim();
  if (!nm) { $('#catMenuTitle').textContent = '名字不能空着喵'; return; }
  if (await catMenuSave({ name: nm })) closeCatMenu();
}
/** 新建时先落库拿到 id，才能往它身上挂规则 —— 顺手把名字校验也做了 */
async function ensureCat() {
  const nm = $('#catName').value.trim();
  if (!nm) { note('先给分类起个名字喵', true); return null; }
  if (editId) return editId;
  const r = await window.nami.catSave({ id: null, name: nm, color: editColor });
  if (!r.ok) { note(r.error || '建不出来', true); return null; }
  applyCatState(r);
  const made = catState.list.find((c) => c.name === nm);
  if (!made) { note('建出来了却没找到，奇怪喵', true); return null; }
  editId = made.id;
  $('#catDelBtn').hidden = false;
  $('#catEditTitle').textContent = `编辑分类 · ${made.name}`;
  return editId;
}

async function pollLive() {
  try {
    const s = await window.nami.current();
    const c = s.current;
    const st = s.state || {};
    const t = st.paused ? '已暂停记录（右键托盘可继续）'
      : (MODE_TEXT[st.mode] ? MODE_TEXT[st.mode] : (c ? `正在记录 · ${c.displayName}` : '等待前台窗口…'));
    const el = $('#liveText');
    if (el.textContent !== t) el.textContent = t;          // 内容没变就不写 DOM（不触发重绘）
    const sheet = $('#sheet');
    if (state.info && sheet && !sheet.hidden) {
      const db = state.info.dbPath || '';
      const note = `采样 ${s.stats.lastSampleMs} ms · 空闲阈值 ${state.info.idleThresholdSec} s · 状态 ${MODE_TEXT[st.mode] || '记录中'}${state.info.tray ? ' · 托盘常驻' : ''}\n记录文件：${db}`;
      if ($('#sheetNote').textContent !== note) $('#sheetNote').textContent = note;
    }
  } catch (e) { /* 忽略 */ }
}

/* ============================================================
   外观 / 玻璃通透度
   ============================================================ */
function applyTheme(t, persist) {
  state.theme = t === 'dark' || t === 'auto' ? t : 'light';
  state.resolved = state.theme === 'auto' ? (state.info && state.info.resolved === 'dark' ? 'dark' : 'light') : state.theme;
  document.documentElement.setAttribute('data-theme', state.resolved);
  $('#btnTheme').textContent = state.resolved === 'dark' ? '☀' : '☾';
  $('#btnTheme').classList.toggle('on', state.resolved === 'dark');
  segTheme.sync(state.theme);
  if (persist) window.nami.setTheme(state.theme);
}

function applyGlass(v) {
  state.glass = clamp(Number(v) || 0, 0, 1);
  document.documentElement.style.setProperty('--k', state.glass.toFixed(3));
  const pct = Math.round(state.glass * 100);
  const sl = $('#glassSlider');
  if (sl) { sl.value = String(pct); sl.style.setProperty('--pct', pct + '%'); }
}

/* —— 图标大小（M5.5）：改成「比例驱动」——
   --ico 像素 = 窗口宽 × 倍率。设计基准 1170 → 33px；窗口越宽图标越大，
   所以拖窗口时图标会跟着窗口大小一起呼应（不再是固定像素）。
   设置里的滑块改的是「倍率」，像素只有窗口变化时才重算。 */
const ICON_MIN = 26, ICON_MAX = 62;
function iconPxFor(winW, level) {
  const sc = clamp(((winW || 1170) - 930) / (1170 - 930), 0, 2);
  return clamp(Math.round(33 + 11 * sc), ICON_MIN, ICON_MAX) * level;
}
function paintIcon() {
  const px = Math.round(iconPxFor(state.winW, state.iconLevel));
  if (px === state.iconPx) return;
  state.iconPx = px; state.icon = px;
  document.documentElement.style.setProperty('--ico', px + 'px');
}
const pctToSlider = (pct) => Math.round(((pct - 55) / 90) * 100);
function applyIcon(v) {
  const pct = clamp(Math.round(Number(v) || 100), 55, 145);
  state.iconLevel = pct / 100;
  paintIcon();
  const sl = $('#iconSlider');
  /* 每次都以「倍率」为准写回滑块：Chromium 会跨会话恢复表单状态，不写回就会被它带偏 */
  if (sl) { sl.value = String(pctToSlider(pct)); sl.setAttribute('value', String(pctToSlider(pct))); sl.style.setProperty('--pct', (((pct - 55) / 90) * 100).toFixed(1) + '%'); }
}
/* 图标倍率：新口径存在 setting 的 iconLevel（55..145 = 倍率×100）。
   旧库只有 icon（28..60 像素），首次遇到时按旧默认 48 反推倍率并迁到新键。 */
function restoreIcon(stored) {
  let pct = Math.round(Number(stored) || 100);
  if (pct < 71) {                       // 明显是旧「像素」口径（新倍率都在 100 附近）
    pct = clamp(Math.round(pct / 48 * 100), 55, 145);
    window.nami.setIconLevel(pct);
  } else pct = clamp(pct, 55, 145);
  applyIcon(pct);
}
/* 窗口尺寸变了：先刷新图标（列表行高 / 圆角都跟着变），分段条由 resize 事件那边刷新 */
function resizeView() {
  const ap = document.querySelector('.app');
  state.winW = (ap && ap.clientWidth) || window.innerWidth || state.winW;
  paintIcon();
}

window.addEventListener('DOMContentLoaded', async () => {
  const info = await window.nami.init();
  state.info = info;
  applyTheme(info.theme === 'light' || info.theme === 'dark' || info.theme === 'auto' ? info.theme : 'light', false);
  applyGlass(info.glass);
  state.winW = window.innerWidth || info.designW || 1170;
  restoreIcon(info.iconLevel != null ? info.iconLevel : info.icon);
  /* —— 设置滑块（M5.5）：先按库里的值把滑块摆正，再挂监听。
     Chromium 会跨会话恢复表单状态，所以用 hydrated 一票否决首次的“恢复值”，
     否则那次恢复会冒充用户输入、把倍率带偏（真实用户拖窗口也会连累图标大小）。 —— */
  const isl = $('#iconSlider');
  if (isl) {
    isl.value = String(pctToSlider(Math.round(state.iconLevel * 100)));
    isl.addEventListener('input', () => {
      if (!isl.dataset.hydrated) { isl.dataset.hydrated = '1'; isl.value = String(Math.round(state.iconLevel * 100)); return; }
      applyIcon(55 + (+isl.value / 100) * 90);
    });
    isl.addEventListener('change', () => {
      if (!isl.dataset.hydrated) { isl.dataset.hydrated = '1'; return; }
      window.nami.setIconLevel(Math.round(state.iconLevel * 100));
    });
  }

  if (info.material !== 'acrylic') document.documentElement.classList.add('glass-fallback');
  if (info.refract) document.documentElement.setAttribute('data-refract', '1');
  if (info.noFx) document.documentElement.classList.add('no-fx');
  window.addEventListener('focus', () => document.documentElement.classList.add('focused'));
  window.addEventListener('blur', () => document.documentElement.classList.remove('focused'));
  if (document.hasFocus()) document.documentElement.classList.add('focused');
  if (info.mockBg) {
    document.documentElement.classList.add('mock-bg');
    if (info.mockBg === 'light') document.documentElement.classList.add('mock-light');
    const m = document.createElement('div');
    m.className = 'mock-bg-layer';
    document.querySelector('.app').prepend(m);
  }
  if (window.nami.onTheme) window.nami.onTheme((t) => { if (state.theme === 'auto') { state.info.resolved = t; applyTheme('auto', false); } });
  // 托盘里暂停/继续后，主进程会推一条状态过来，界面立刻跟上
  if (window.nami.onState) window.nami.onState(() => { pollLive(); });
  /* 全屏退避（M4 S4.4）：主进程检测到前台被全屏应用/游戏占满时把我们切到「静默」。
     退回前台时再补一次刷新，所以看到的数字不会停在旧值。 */
  if (window.nami.onRetreat) window.nami.onRetreat((on) => {
    document.documentElement.classList.toggle('retreat', on);
    if (on) tickStop();
    else if (document.hasFocus()) { refresh(true); pollLive(); tickStart(); }
  });

  $('#prevDay').onclick = () => shift(-1);
  $('#nextDay').onclick = () => shift(1);
  $('#btnMin').onclick = () => window.nami.win('minimize');
  /* 第 28 轮（主人）：后台运行 —— 关掉界面（渲染进程销毁，最省内存），采集留在托盘继续 */
  $('#btnBackground').onclick = () => window.nami.win('background');
  /* M8（主人 8 号）：全屏按钮（再点一次退出）。返回值就是新状态，据此换图标 + 提示。
     主进程还会在「全屏状态被别的东西改掉」时推一条 nami:fullscreen 回来对表。 */
  const paintFull = (on) => {
    const b = $('#btnFull');
    if (!b) return;
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.textContent = on ? '⤡' : '⤢';
    b.title = on ? '退出全屏' : '全屏';
  };
  $('#btnFull').onclick = async () => { paintFull(await window.nami.win('fullscreen')); };
  if (window.nami.onFullscreen) window.nami.onFullscreen(paintFull);
  $('#btnClose').onclick = () => window.nami.win('close');
  initResize(info);
  bindTips();          // M5.6：自绘浮层提示（替掉原生 title）
  bindDetailChart();   // M5.6：详情页逐日柱的拖动平移 / 点选
  /* —— 详情页（M5）：返回按钮；标题栏月亮/太阳一键切浅色↔深色（跟随系统时切到当前的反面） —— */
  $('#dtBack').onclick = () => closeDetail();
  /* M7 主人第 6 条：详情页里直接换图标（挑图 / 恢复自动），改完就地重画详情页 */
  $('#dtIconRow').addEventListener('click', async (e) => {
    const id = detailApp;
    if (id === null) return;
    if (e.target.closest('#dtIconPick')) {
      const r = await window.nami.pickIcon(id);
      if (r && r.ok) { lastSig = ''; openDetail(id, { force: true }); }
      return;
    }
    if (e.target.closest('#dtIconClear')) {
      const r = await window.nami.clearIcon(id);
      if (r && r.ok) { lastSig = ''; openDetail(id, { force: true }); }
      return;
    }
    /* M8 主人第 9 条：详情页改名（就地弹输入框） */
    if (e.target.closest('#dtRename')) { openDtRename(); return; }
    if (e.target.closest('#dtRenameClear')) { await submitDtRename(''); return; }
    if (e.target.closest('#dtNameOk')) { await submitDtRename($('#dtNameIn').value); return; }
    if (e.target.closest('#dtNameCancel')) { openDetail(id, { force: true }); }
  });
  /* 详情页改名输入框：回车提交，Esc 撤回 */
  $('#dtIconRow').addEventListener('keydown', async (e) => {
    if (!e.target.closest('#dtNameIn')) return;
    if (e.key === 'Enter') { e.preventDefault(); await submitDtRename(e.target.value); }
    else if (e.key === 'Escape') { e.stopPropagation(); if (detailApp !== null) openDetail(detailApp, { force: true }); }
  });
  /* 概览卡折叠（M5.5）：默认展开，状态存 localStorage，下次进来保持 */
  const ovEl = $('#ov'), ovCaret = $('#ovCaret');
  const ovSet = (c) => {
    ovEl.classList.toggle('collapsed', c);
    ovCaret.setAttribute('aria-expanded', c ? 'false' : 'true');
    ovCaret.textContent = c ? '⌄' : '⌃';
    try { localStorage.setItem('nami.ovCollapsed', c ? '1' : '0'); } catch (e) {}
  };
  let ovStart = false;
  try { ovStart = localStorage.getItem('nami.ovCollapsed') === '1'; } catch (e) {}
  ovSet(ovStart);
  ovCaret.onclick = (e) => { e.stopPropagation(); ovSet(!ovEl.classList.contains('collapsed')); };
  detailSeg = initSegmented($('#dtSeg'), (k) => {
    if (k === dtKind) return;
    dtKind = k;
    if (detailApp !== null) openDetail(detailApp, { force: true });
  }, { position: false });
  $('#btnTheme').onclick = () => applyTheme(state.resolved === 'dark' ? 'light' : 'dark', true);

  const sheet = $('#sheet');
  const calpop = $('#calpop');
  const catPop = $('#catPop');
  const catEdit = $('#catEdit');
  const catMenu = $('#catMenu');
  const openSheet = (on) => {
    sheet.hidden = !on;
    $('#btnCfg').classList.toggle('on', on);
  };
  $('#btnCfg').onclick = (e) => { e.stopPropagation(); openSheet(sheet.hidden); };
  document.addEventListener('pointerdown', (e) => {
    if (!sheet.hidden && !(e.target.closest('#sheet') || e.target.closest('#btnCfg'))) openSheet(false);
    /* 日历：点外面关掉。点日期标题本身不算「外面」——那由它自己的 click 负责开/关，
       否则 pointerdown 先关、click 又开，会看起来「关不掉」。 */
    if (!calpop.hidden && !(e.target.closest('#calpop') || e.target.closest('#dateLabel'))) calOpen(false);
    /* 归类弹层 / 分类编辑器：点外面关掉（点自己的打开按钮不算「外面」） */
    if (!catPop.hidden && !(e.target.closest('#catPop') || e.target.closest('[data-more]'))) closeAssign();
    if (!catEdit.hidden && !(e.target.closest('#catEdit') || e.target.closest('#btnNewCat') || e.target.closest('[data-editcat]'))) closeEdit();
    if (!catMenu.hidden && !(e.target.closest('#catMenu') || e.target.closest('[data-catrow]') || e.target.closest('.rail-item'))) closeCatMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    openSheet(false); calOpen(false); closeAssign(); closeEdit(); closeCatMenu(); closeDetail();
  });

  /* —— 大日历（M2 尾巴）—— */
  $('#dateLabel').onclick = (e) => { e.stopPropagation(); calOpen(calpop.hidden); };
  $('#calPrev').onclick = () => calStep(-1);
  $('#calNext').onclick = () => calStep(1);
  $('#calTitle').onclick = () => { cal.view = cal.view === 'day' ? 'month' : 'day'; renderCal(); };
  $('#calToday').onclick = () => pickDay(dayKey());
  calpop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.ym) { cal.month = b.dataset.ym; cal.view = 'day'; renderCal(); return; }   // 年视图 → 点月份进当月
    if (b.dataset.day) pickDay(b.dataset.day);
  });

  const sl = $('#glassSlider');
  sl.addEventListener('input', () => { applyGlass(+sl.value / 100); });
  sl.addEventListener('change', () => { window.nami.setGlass(state.glass); });

  /* —— 分类（M3）：左栏 / 视图切换 / 归类 / 编辑器 —— */
  await loadCats();
  renderRail([]);
  const viewSeg = initSegmented($('#viewSeg'), (v) => { if (state.view === v) return; state.view = v; refresh(true); });

  $('#railNav').addEventListener('click', (e) => {
    const b = e.target.closest('.rail-item');
    if (!b) return;
    state.cat = b.dataset.cat === 'all' ? 'all' : Number(b.dataset.cat);
    // 左栏点某个分类 = 想看「这个分类下有哪些应用」，所以顺手切回应用视图
    if (state.cat !== 'all' && state.view === 'cat') { state.view = 'app'; viewSeg.sync('app'); }
    refresh(true);
  });

  /* —— M8（主人 6 号）：右键改分类 / 右键开应用行尾的 ⋯ 菜单 —— */
  $('#railNav').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.rail-item');
    if (!b || b.dataset.cat === 'all') return;      // 「全部应用」不是分类，不给菜单
    e.preventDefault();
    openCatMenu(Number(b.dataset.cat), e.clientX, e.clientY);
  });
  $('#list').addEventListener('contextmenu', (e) => {
    const appRow = e.target.closest('[data-app]');
    if (appRow) { e.preventDefault(); openAssign(appRow.dataset.app, e.target.closest('.row-more') || appRow); return; }
    const catRow = e.target.closest('[data-catrow]');
    if (catRow) { e.preventDefault(); openCatMenu(Number(catRow.dataset.catrow), e.clientX, e.clientY); }
  });
  $('#catMenu').addEventListener('click', async (e) => {
    const sw = e.target.closest('.cm-sw');
    if (sw) {
      const on = await catMenuSave({ color: sw.dataset.color });
      if (on) $('#catMenuColors').querySelectorAll('.cm-sw').forEach((x) => x.classList.toggle('on', x === sw));
      return;
    }
    if (e.target.closest('#catMenuNameOk')) { await catMenuRename(); return; }
    if (e.target.closest('#catMenuRules')) { const c = catById(cmCat); closeCatMenu(); if (c) openEdit(c); return; }
    if (e.target.closest('#catMenuDel')) {
      const del = $('#catMenuDel');
      if (!cmArmed) {                                  // 两步确认：误点一下不会直接把分类删了
        cmArmed = true; del.classList.add('armed'); del.textContent = '真的删掉？再点一下';
        return;
      }
      const gone = cmCat;
      applyCatState(await window.nami.catDelete(gone));
      if (state.cat === gone) state.cat = 'all';
      if (catOpenId === gone) catOpenId = null;
      closeCatMenu();
      lastSig = ''; refresh(true);
    }
  });
  $('#catMenuName').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await catMenuRename(); }
    else if (e.key === 'Escape') { e.stopPropagation(); closeCatMenu(); }
  });

  $('#list').addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); openAssign(more.dataset.more, more); return; }
    const ec = e.target.closest('[data-editcat]');
    if (ec) { e.stopPropagation(); openEdit(catById(ec.dataset.editcat)); return; }
    const appRow = e.target.closest('[data-app]');
    if (appRow) { openDetail(appRow.dataset.app); return; }
    const row = e.target.closest('[data-catrow]');
    if (row) {
      const id = Number(row.dataset.catrow);
      catOpenId = catOpenId === id ? null : id;
      refresh(true);
    }
  });

  /* —— M5.6（主人 1 号）：左栏热力图 + 概览「最近 7 天」的日期都能点，
        点了主列表直接跳到那天的单日记录（不用先回主页切范围，也不弹日历） —— */
  $('#heatGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (b) { hideTip(); pickDay(b.dataset.day); }
  });
  /* M8（主人 4/5 号）：两张卡片各自的前后翻页。热力图一次翻 4 周（上一次的「前四周」），
     概览卡一次翻 1 周；都已经到最新一段时按钮置灰（标题也会跟着变回「最近 …」）。 */
  $('#heatPrev').onclick = () => { heatEnd = shiftDay(weekEnd(heatEnd || dayKey()), -28); heatSig = ''; renderHeat(); };
  $('#heatNext').onclick = () => {
    const nx = shiftDay(weekEnd(heatEnd || dayKey()), 28);
    heatEnd = nx >= weekEnd(dayKey()) ? null : nx;
    heatSig = ''; renderHeat();
  };
  $('#ovPrev').onclick = () => { ovEnd = shiftDay(ovEnd || dayKey(), -OV_DAYS); ovSig = ''; renderOverview(); };
  $('#ovNext').onclick = () => {
    const nx = shiftDay(ovEnd || dayKey(), OV_DAYS);
    ovEnd = nx >= dayKey() ? null : nx;
    ovSig = ''; renderOverview();
  };
  $('#ovDayPlot').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (b) { hideTip(); pickDay(b.dataset.day); }
  });

  $('#btnNewCat').onclick = () => openEdit(null);
  $('#btnGameTpl').onclick = async () => { applyCatState(await window.nami.gameTemplate()); refresh(true); };

  catPop.addEventListener('click', async (e) => {
    const chip = e.target.closest('.cat-chip');
    if (chip) {
      const cid = Number(chip.dataset.cid);
      if (assignSel.has(cid)) assignSel.delete(cid); else assignSel.add(cid);
      applyCatState(await window.nami.catAssign({ appId: assignApp, categoryIds: [...assignSel] }));
      renderAssign();
      refresh(true);
      return;
    }
    if (e.target.closest('#catPopAuto')) {
      applyCatState(await window.nami.catAssign({ appId: assignApp, categoryIds: [] }));
      closeAssign();
      refresh(true);
      return;
    }
    if (e.target.closest('#catPopNew')) { closeAssign(); openEdit(null); return; }
    /* M7 主人第 6 条（自定义图标）：挑一张图 / 恢复自动图标。
       两个动作都会改这个应用全部日期的图标，所以整列表强制重画一次。 */
    if (e.target.closest('#catPopIcon')) {
      const id = assignApp;
      const r = await window.nami.pickIcon(id);
      if (r && r.ok) { closeAssign(); lastSig = ''; refresh(true); }
      else if (r && r.error) $('#catPopNote').textContent = r.error;
      return;
    }
    if (e.target.closest('#catPopIconClear')) {
      const id = assignApp;
      const r = await window.nami.clearIcon(id);
      if (r && r.ok) { closeAssign(); lastSig = ''; refresh(true); }
      else if (r && r.error) $('#catPopNote').textContent = r.error;
      return;
    }
    /* M8 主人第 9 条（自定义名称）：先展开输入行，再按「改名」/ 回车提交。
       空名字 = 恢复自动名称。改完整列表强制重画（名字在列表行上）。 */
    if (e.target.closest('#catPopRename')) {
      const row = $('#catPopRenameRow');
      row.hidden = false;
      const inp = $('#catPopNameIn');
      inp.value = (state.lastRows.find((r) => r.id === assignApp) || {}).name || inp.value;
      inp.focus(); inp.select();
      return;
    }
    if (e.target.closest('#catPopRenameClear')) { await submitRename(''); return; }
    if (e.target.closest('#catPopNameOk')) { await submitRename($('#catPopNameIn').value); return; }
  });

  /* 输入行里的回车 = 点「改名」 */
  $('#catPopNameIn').addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); await submitRename($('#catPopNameIn').value); }
    else if (e.key === 'Escape') { e.stopPropagation(); $('#catPopRenameRow').hidden = true; }
  });

  $('#catSwatches').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    editColor = sw.dataset.color;
    renderSwatches();
  });

  $('#catRules').addEventListener('click', async (e) => {
    const x = e.target.closest('[data-rule]');
    if (!x) return;
    applyCatState(await window.nami.ruleDelete(Number(x.dataset.rule)));
    renderRules();
    refresh(true);
  });

  $('#ruleAddBtn').onclick = async () => {
    const kind = $('#ruleKind').value;
    const pat = $('#rulePat').value.trim();
    if (!pat) { note('规则内容不能空着喵', true); return; }
    const id = await ensureCat();
    if (!id) return;
    const r = await window.nami.ruleAdd({ categoryId: id, kind, pattern: pat });
    if (!r.ok) { note(r.error || '加不上', true); return; }
    applyCatState(r);
    $('#rulePat').value = '';
    note('规则加好了喵~');
    renderRules();
    renderSwatches();
    refresh(true);
  };

  $('#catOk').onclick = async () => {
    const nm = $('#catName').value.trim();
    if (!nm) { note('先给分类起个名字喵', true); return; }
    const r = await window.nami.catSave({ id: editId, name: nm, color: editColor });
    if (!r.ok) { note(r.error || '存不上', true); return; }
    applyCatState(r);
    closeEdit();
    refresh(true);
  };
  $('#catCancel').onclick = () => closeEdit();
  $('#catDelBtn').onclick = async () => {
    if (!editId) return;
    const gone = editId;
    applyCatState(await window.nami.catDelete(gone));
    if (state.cat === gone) state.cat = 'all';
    if (catOpenId === gone) catOpenId = null;
    closeEdit();
    refresh(true);
  };

  const setSwitch = (on) => {
    $('#swRules').classList.toggle('on', on);
    $('#swRules').setAttribute('aria-checked', on ? 'true' : 'false');
    $('#swRulesHint').textContent = on ? '规则自动归类已开启' : '规则自动归类已关闭（手动归类仍生效）';
  };
  setSwitch(catState.rulesOn);
  $('#swRules').onclick = async () => {
    const on = !$('#swRules').classList.contains('on');
    applyCatState(await window.nami.catRulesOn(on));
    setSwitch(catState.rulesOn);
    refresh(true);
  };

  /* —— 定期备份（M5.6 主人 6 号 + M7 主人 5 号）：
        满血可导入的 nami-*.json/csv + ManicTime 兼容的 manictime-*.csv + 每周概览图 —— */
  const paintBackup = (b) => {
    const on = !!(b && b.on);
    $('#swBackup').classList.toggle('on', on);
    $('#swBackup').setAttribute('aria-checked', on ? 'true' : 'false');
    $('#backupHint').textContent = on ? '每周自动存一份满血备份 + ManicTime 兼容 csv + 一张概览图' : '已关闭（不会自动备份）';
    const note = (b && b.note) || (b && b.dir ? '存到：' + b.dir : '');
    $('#backupNote').textContent = note + (b && b.image ? ' · 概览图 ' + String(b.image).replace(/^.*[\\/]/, '') : '');
  };
  paintBackup(await window.nami.backupInfo());
  $('#swBackup').onclick = async () => {
    const on = !$('#swBackup').classList.contains('on');
    paintBackup(await window.nami.backup({ on }));
  };
  $('#btnBackupNow').onclick = async () => {
    const btn = $('#btnBackupNow');
    btn.disabled = true; btn.textContent = '正在备份…';
    try { paintBackup(await window.nami.backup({ now: true })); }
    finally { btn.disabled = false; btn.textContent = '立即备份'; }
  };
  /* 概览图要「能直接在备份文件夹里查看」：这两个按钮分别开目录、开最新那张图 */
  $('#btnBackupOpen').onclick = async () => {
    const r = await window.nami.backupOpen();
    if (!r || !r.ok) $('#backupNote').textContent = '打不开备份目录：' + ((r && r.err) || '未知原因');
  };
  $('#btnBackupImage').onclick = async () => {
    const r = await window.nami.backupImage();
    if (!r || !r.ok) $('#backupNote').textContent = (r && r.err) || '还没有概览图，先备份一次喵~';
  };

  /* —— M7 S7.2 开机自启（主人 2026-10-16 选定：启动文件夹快捷方式）——
     开关的真相在主进程的库里，这里只负责画状态 + 把点击递过去。 */
  const paintAutostart = (a) => {
    const on = !!(a && a.on);
    $('#swAutostart').classList.toggle('on', on);
    $('#swAutostart').setAttribute('aria-checked', on ? 'true' : 'false');
    $('#autostartHint').textContent = on
      ? '开机后自动开始记录（启动文件夹快捷方式）'
      : '已关闭（那枚快捷方式已经删掉了）';
  };
  paintAutostart(state.info && state.info.autostart ? state.info.autostart : await window.nami.autostartInfo());
  $('#swAutostart').onclick = async () => {
    const on = !$('#swAutostart').classList.contains('on');
    paintAutostart(await window.nami.autostart(on));
  };

  /* —— M7 S7.3 首次运行一句话引导：只弹一次，点过就写库 —— */
  if (!(state.info && state.info.onboarded)) {
    const h = $('#hello');
    if (h) {
      h.hidden = false;
      $('#helloOk').onclick = async () => { h.hidden = true; await window.nami.onboarded(); };
    }
  }

  await refresh();
  viewSeg.refresh();
  await pollLive();
  segKind.refresh();
  window.addEventListener('resize', () => {
    segKind.refresh(); segTheme.refresh(); viewSeg.refresh(); detailSeg.refresh();
    resizeView();
  });
  resizeView();

  /* 资源纪律：窗口不在前台时彻底停止轮询与重绘。
     主人打游戏 / 用大内存软件时它就是个静止的窗口，只有采集进程在跑。 */
  let fast = null, slow = null;
  function tickStart() {
    if (fast) return;
    fast = setInterval(pollLive, 4000);
    slow = setInterval(refresh, 20000);
  }
  function tickStop() {
    if (fast) { clearInterval(fast); clearInterval(slow); fast = slow = null; }
  }
  window.addEventListener('focus', () => { refresh(true); pollLive(); tickStart(); });
  window.addEventListener('blur', () => tickStop());
  document.addEventListener('visibilitychange', () => { if (document.hidden) tickStop(); else { refresh(true); pollLive(); tickStart(); } });
  if (document.hasFocus()) tickStart();
});
