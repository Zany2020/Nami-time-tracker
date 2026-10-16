'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodePng, decodeAnyPng } = require('./png');

/**
 * 图标内容寻址缓存：exe 图标 -> PNG -> sha256 前 16 位 -> icons/<hash>.png
 * 只增不删；源 exe 被删除后缓存依然在，历史图标永远可读。
 *
 * 取图标有两条路（都按 48x48）：
 *   1. Electron 的 app.getFileIcon —— 走 shell，大多数 exe 没问题
 *   2. readNativeIcon 原生回退 —— PrivateExtractIconsW 直读 exe 的 PE 图标资源
 *
 * 关键坑：路径 1 拿不到图标时【不报错】，而是返回一张 32x32 的「通用程序」占位图
 * （连不存在的路径也一样）。MSIX/WindowsApps 应用（ChatGPT）、部分系统 exe（Taskmgr）、
 * 一些自绘安装的第三方程序（SakuraCat）都踩这个坑，界面上看着就是"未知图标"。
 * 所以启动时先用一张不存在的 .exe 探出占位图指纹：命中就改走路径 2。
 * 但**光比字节 hash 会漏** —— 同一张占位图，Windows/Electron 会给两种字节编码
 * （实测 750B 与 745B，像素只差 10/9216 个通道各 1 级），hash 却完全不同。
 * 所以指纹同时记「字节 hash」和「像素」，识别时两条都认（像素按容差比）。
 * 路径 2 也拿不到的（exe 确实没有图标资源，如 SearchHost.exe）分两种：
 *   - exe 文件还在 → 保留那张通用图（资源管理器显示它也是这张，不自作聪明）
 *   - exe 文件已经没了 → 返回 null，绝不拿通用图顶掉历史图标（M2 验收项）
 * 界面在 hash 为 null 时用首字母方块兜底。
 */
const NATIVE_SIZE = 48;
const PH_TOL = 4;         // 单个通道允许的差（0~255）
const PH_MAX_RATIO = 0.005;   // 允许超差通道占比（实测占位图变体只有 10/9216 = 0.11%）

/** 两张 RGBA 图是不是「同一张图」（尺寸同、逐通道比，几乎处处相等才算） */
function sameImage(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return false;
  if (a.rgba.length !== b.rgba.length) return false;
  const limit = Math.floor(a.rgba.length * PH_MAX_RATIO);
  let over = 0;
  for (let i = 0; i < a.rgba.length; i++) {
    const d = a.rgba[i] - b.rgba[i];
    if (d > PH_TOL || d < -PH_TOL) { if (++over > limit) return false; }
  }
  return true;
}

function createIconCache({ dir, getFileIcon, readNativeIcon = null }) {
  fs.mkdirSync(dir, { recursive: true });
  const memo = new Map(); // exePath -> hash|null
  const stats = { extracts: 0, hits: 0, fails: 0, files: 0, placeholders: 0, variants: 0, native: 0 };
  let placeholder = null;      // 通用占位图的字节 hash（惰性探测一次）
  let placeholderImg = null;   // 通用占位图的像素（认「同图不同编码」的变体用）
  let probed = false;

  const sha16 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

  /** 这张 shell 给的 PNG 是不是那张通用占位图（字节 hash 或像素变体，命中任一即算） */
  function looksLikePlaceholder(png) {
    if (!png) return false;
    if (placeholder && sha16(png) === placeholder) return true;
    if (!placeholderImg) return false;
    try {
      if (sameImage(decodeAnyPng(png), placeholderImg)) { stats.variants++; return true; }
    } catch { /* 解不开就当它不是 */ }
    return false;
  }

  /** 用一张不存在的 .exe 探出"取不到图标时的通用占位图"长什么样 */
  async function probePlaceholder() {
    if (probed || !readNativeIcon) return placeholder;
    probed = true;
    try {
      const img = await getFileIcon(path.join(os.tmpdir(), 'nami-time-no-such-file.exe'), { size: 'large' });
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        placeholder = sha16(png);
        try { placeholderImg = decodeAnyPng(png); } catch { placeholderImg = null; }
      }
    } catch { placeholder = null; }
    return placeholder;
  }

  async function ensure(exePath, force) {
    if (!force && memo.has(exePath)) { stats.hits++; return memo.get(exePath); }
    await probePlaceholder();

    let hash = null;
    let png = null;
    try {
      const img = await getFileIcon(exePath, { size: 'large' }); // Win 上为 48x48
      if (img && !img.isEmpty()) png = img.toPNG();
      stats.extracts++;
    } catch (e) { stats.fails++; }

    const isPlaceholder = looksLikePlaceholder(png);
    if (isPlaceholder) stats.placeholders++;
    // exe 已经不在了：绝不能拿「通用占位图」去顶掉历史图标（M2：删掉 exe 后图标仍要正常）
    if (isPlaceholder && !fs.existsSync(exePath)) png = null;

    // shell 没给出真图标（占位图 / 空 / 抛错）→ 直读 exe 的 PE 图标资源
    if ((!png || isPlaceholder) && readNativeIcon) {
      try {
        const bmp = readNativeIcon(exePath, NATIVE_SIZE);
        if (bmp) { png = encodePng(bmp); stats.native++; }
      } catch { /* 回退失败就保持原样 */ }
    }

    if (png) {
      hash = sha16(png);
      const file = path.join(dir, hash + '.png');
      if (!fs.existsSync(file)) { fs.writeFileSync(file, png); stats.files++; }
    }
    memo.set(exePath, hash);
    return hash;
  }

  function fileFor(hash) { return hash ? path.join(dir, hash + '.png') : null; }
  function forget(exePath) { memo.delete(exePath); }
  /** 磁盘上某个已存的图标是不是占位图（含「同图不同编码」的变体 —— 启动修复要用它扫旧记录） */
  function isPlaceholderFile(hash) {
    if (!hash) return false;
    if (placeholder && hash === placeholder) return true;
    if (!placeholderImg) return false;
    const f = path.join(dir, hash + '.png');
    if (!fs.existsSync(f)) return false;
    try { return sameImage(decodeAnyPng(fs.readFileSync(f)), placeholderImg); } catch { return false; }
  }

  return {
    ensure, fileFor, forget, dir, stats,
    /** 主动探一次「通用占位图」指纹（启动修复要先拿到它，不能等 ensure 顺带探） */
    async detectPlaceholder() { return probePlaceholder(); },
    /** 通用占位图的 hash（探测完才有值；没有原生回退能力时恒为 null） */
    placeholderHash: () => placeholder,
    isPlaceholder: (hash) => !!hash && hash === placeholder,
    /** 判断磁盘上已存的图标是不是占位图（比 hash 更宽：认得出同图不同编码的变体） */
    isPlaceholderFile
  };
}

module.exports = { createIconCache, NATIVE_SIZE };
