#!/usr/bin/env node
'use strict';

/*
 * photo-dedup.js —— 照片合并去重工具 v2
 * 功能:
 *   1. 合并多个文件夹里的文件到一个文件夹
 *   2. 按文件内容哈希(默认 sha256)去重，重复时保留体积最大的文件(可用 --keep 调整策略)
 *   3. 可选: 按拍摄时间(EXIF/文件名/修改时间)重命名排序
 *   4. 性能优化: 先按文件大小分组，只有同大小的文件才计算哈希；支持多线程并发哈希
 *   5. 安全增强: 只有"胜者"真正移入输出目录后才会删除对应重复文件；可选把重复文件移入回收目录
 * 零依赖，Node.js >= 18 即可运行。
 *
 * 用法:
 *   node photo-dedup.js <源文件夹...> [选项]
 *   详见 README.md
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

let Worker = null;
try { Worker = require('node:worker_threads').Worker; } catch (e) { Worker = null; }

const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
const KEEP_POLICIES = ['largest', 'smallest', 'newest', 'oldest', 'first'];

const HELP = [
  '用法: node photo-dedup.js <源文件夹...> [选项]',
  '',
  '把多个文件夹里的文件按内容去重后合并到一个文件夹。',
  '去重基于文件内容哈希(默认 sha256)，重复时保留体积最大的文件(可用 --keep 调整)。',
  '',
  '选项:',
  '  --out <目录>         合并输出目录(默认: 第一个源文件夹同级下的 "合并后")',
  '  --dry-run            只分析并输出报告，不移动/删除任何文件',
  '  --hash <算法>        内容哈希算法: md5 | sha1 | sha256 | sha512 (默认 sha256)',
  '  --no-delete          只合并，不删除重复文件',
  '  --trash <目录>       不直接删除重复文件，而是移动到该目录(回收备份)',
  '  --keep <策略>        重复组保留策略: largest | smallest | newest | oldest | first (默认 largest)',
  '  --jobs <n>           并发哈希线程数，0=自动(默认)，1=单线程',
  '  --hash-all           即使文件大小唯一也计算哈希(默认跳过，报告 hash 为 null)',
  '  --skip-existing      输出目录中已存在相同内容的文件时不再重复合并',
  '  --sort-by-date       合并后按拍摄时间重命名: YYYY-MM-DD_HHMMSS_原名',
  '  --exif-only          排序时只用 EXIF 拍摄时间，不回退到文件名/修改时间',
  '  --log <文件>         把详细报告写到 JSON 文件(默认自动生成带时间戳的报告)',
  '  --min-size <字节>    忽略小于该体积的文件',
  '  --include-ext <列表> 只处理指定扩展名，如 jpg,png,heic',
  '  --quiet              只输出最终汇总',
  '  --help, -h           显示本帮助',
  '',
  '示例:',
  '  node photo-dedup.js "照片/备份A" "照片/备份B" --out "照片/合并后"',
  '  node photo-dedup.js "照片/备份A" --out "照片/合并后" --dry-run',
  '  node photo-dedup.js "照片/备份A" "照片/备份B" --out "照片/合并后" --sort-by-date',
  '  node photo-dedup.js "照片/备份A" "照片/备份B" --out "照片/合并后" --keep newest --trash "照片/回收"',
  ''
].join('\n');

// ---------------- 参数解析 ----------------
function parseArgs(argv) {
  const opts = {
    out: null,
    dryRun: false,
    hash: 'sha256',
    noDelete: false,
    sortByDate: false,
    exifOnly: false,
    log: null,
    quiet: false,
    minSize: 0,
    includeExt: null,
    folders: [],
    keep: 'largest',
    jobs: 0,
    hashAll: false,
    skipExisting: false,
    trash: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--hash') opts.hash = String(argv[++i] || '').toLowerCase();
    else if (a === '--no-delete') opts.noDelete = true;
    else if (a === '--trash') opts.trash = argv[++i];
    else if (a === '--keep') opts.keep = String(argv[++i] || '').toLowerCase();
    else if (a === '--jobs') opts.jobs = Math.max(0, parseInt(argv[++i], 10) || 0);
    else if (a === '--hash-all') opts.hashAll = true;
    else if (a === '--skip-existing') opts.skipExisting = true;
    else if (a === '--sort-by-date') opts.sortByDate = true;
    else if (a === '--exif-only') opts.exifOnly = true;
    else if (a === '--log') opts.log = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--min-size') opts.minSize = Number(argv[++i]) || 0;
    else if (a === '--include-ext') opts.includeExt = String(argv[++i] || '').split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
    else if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a.startsWith('-')) { console.error('未知参数: ' + a); process.exit(2); }
    else opts.folders.push(a);
  }
  if (opts.folders.length === 0) { console.error('错误: 至少需要指定一个源文件夹。用 --help 查看用法。'); process.exit(2); }
  if (HASH_ALGOS.indexOf(opts.hash) === -1) { console.error('错误: --hash 只支持 ' + HASH_ALGOS.join(' / ')); process.exit(2); }
  if (KEEP_POLICIES.indexOf(opts.keep) === -1) { console.error('错误: --keep 只支持 ' + KEEP_POLICIES.join(' | ')); process.exit(2); }
  if (opts.minSize < 0) opts.minSize = 0;
  if (opts.noDelete && opts.trash) { console.error('错误: --no-delete 与 --trash 不能同时使用'); process.exit(2); }
  return opts;
}

// ---------------- 文件收集 ----------------
function collectFiles(folders, opts) {
  const files = [];
  const targetReal = opts.out ? path.resolve(opts.out) : null;
  for (let fi = 0; fi < folders.length; fi++) {
    const root = path.resolve(folders[fi]);
    if (!fs.existsSync(root)) { console.error('跳过不存在的文件夹: ' + root); continue; }
    if (!fs.statSync(root).isDirectory()) { console.error('跳过非文件夹: ' + root); continue; }
    const walk = (dir, rel) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { console.error('读取失败 ' + dir + ': ' + e.message); return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        const r = rel ? rel + '/' + ent.name : ent.name;
        if (targetReal && path.resolve(full).toLowerCase() === targetReal.toLowerCase()) continue;
        if (ent.isDirectory()) { walk(full, r); continue; }
        if (!ent.isFile()) continue;
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.size < opts.minSize) continue;
        const ext = path.extname(ent.name).toLowerCase().replace('.', '');
        if (opts.includeExt && opts.includeExt.indexOf(ext) === -1) continue;
        files.push({ abs: full, rel: r, size: st.size, mtime: st.mtimeMs, folderIndex: fi });
      }
    };
    walk(root, '');
  }
  return files;
}

// ---------------- 内容哈希 ----------------
function hashFile(file, algo) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// 工作线程: 每个 worker 负责一批路径的哈希
const WORKER_SRC = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const crypto = require('node:crypto');",
  "const fs = require('node:fs');",
  'function hashOne(file, algo) {',
  "  const h = crypto.createHash(algo);",
  "  const fd = fs.openSync(file, 'r');",
  "  const buf = Buffer.alloc(1 << 20);",
  "  try {",
  "    let n;",
  "    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));",
  "  } finally {",
  "    fs.closeSync(fd);",
  "  }",
  "  return h.digest('hex');",
  '}',
  'const paths = workerData.paths;',
  'const algo = workerData.algo;',
  'const hashes = new Array(paths.length).fill(null);',
  'const errors = new Array(paths.length).fill(null);',
  'for (let i = 0; i < paths.length; i++) {',
  '  try { hashes[i] = hashOne(paths[i], algo); }',
  '  catch (e) { errors[i] = e.message; }',
  '}',
  'parentPort.postMessage({ hashes: hashes, errors: errors });',
  ''
].join('\n');

// 并发哈希: paths 为绝对路径数组，返回 { hashes, errors }，一一对应
function hashFilesInParallel(paths, algo, jobs, onProgress) {
  return new Promise((resolve) => {
    const n = paths.length;
    const hashes = new Array(n).fill(null);
    const errors = new Array(n).fill(null);
    if (n === 0) { resolve({ hashes: hashes, errors: errors }); return; }
    const report = c => { if (onProgress) onProgress(c); };
    if (jobs <= 1 || !Worker) {
      for (let i = 0; i < n; i++) {
        try { hashes[i] = hashFile(paths[i], algo); }
        catch (e) { errors[i] = e.message; }
        report(i + 1);
      }
      resolve({ hashes: hashes, errors: errors });
      return;
    }
    const chunk = Math.max(1, Math.ceil(n / jobs));
    let finished = 0;
    let settled = false;
    const settle = () => { if (!settled && finished >= n) { settled = true; resolve({ hashes: hashes, errors: errors }); } };
    const count = k => { finished += k; report(finished); settle(); };
    for (let w = 0; w < jobs; w++) {
      const start = w * chunk;
      const end = Math.min(n, start + chunk);
      if (start >= end) continue;
      const wPaths = paths.slice(start, end);
      let done = false;
      const worker = new Worker(WORKER_SRC, { eval: true, workerData: { paths: wPaths, algo: algo } });
      worker.on('message', m => {
        if (done) return;
        done = true;
        for (let i = start; i < end; i++) {
          const j = i - start;
          if (m.errors && m.errors[j]) errors[i] = m.errors[j];
          else hashes[i] = m.hashes[j] || null;
        }
        count(end - start);
      });
      worker.on('error', e => {
        if (done) return;
        done = true;
        for (let i = start; i < end; i++) if (!errors[i]) errors[i] = 'worker error: ' + e.message;
        count(end - start);
      });
      worker.on('exit', code => {
        if (done) return;
        done = true;
        for (let i = start; i < end; i++) {
          if (!errors[i]) errors[i] = 'worker exited without result (code ' + code + ')';
        }
        count(end - start);
      });
    }
  });
}

// ---------------- 移动(跨盘回退为复制+删除) ----------------
function moveFile(src, dest) {
  try { fs.renameSync(src, dest); return; }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

// ---------------- EXIF 拍摄时间提取(JPEG/PNG/WebP/HEIC 等) ----------------
function parseTiff(buf, base) {
  try {
    if (base + 8 > buf.length) return null;
    const isLE = buf[base] === 0x49;
    const dv = new DataView(buf.buffer, buf.byteOffset + base, buf.length - base);
    const u16 = o => isLE ? dv.getUint16(o, true) : dv.getUint16(o, false);
    const u32 = o => isLE ? dv.getUint32(o, true) : dv.getUint32(o, false);
    const ifd0 = u32(4);
    const found = [];
    let exifIfd = null;
    const scan = off => {
      if (off + 2 > dv.byteLength) return;
      const n = u16(off);
      let p = off + 2;
      for (let i = 0; i < n && p + 12 <= dv.byteLength; i++, p += 12) {
        const tag = u16(p), type = u16(p + 2), count = u32(p + 4);
        if (type === 2) {
          const off2 = u32(p + 8);
          if (off2 + count <= dv.byteLength) {
            const s = buf.toString('ascii', base + off2, base + off2 + count).replace(/\0+$/, '').trim();
            if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) found.push({ tag: tag, s: s });
          }
        } else if (tag === 0x8769 && type === 4) exifIfd = u32(p + 8);
      }
    };
    scan(ifd0);
    if (exifIfd !== null) scan(exifIfd);
    if (!found.length) return null;
    const order = { 0x9003: 0, 0x9004: 1, 0x0132: 2 };
    found.sort((a, b) => (order[a.tag] === undefined ? 3 : order[a.tag]) - (order[b.tag] === undefined ? 3 : order[b.tag]));
    return validDateStr(found[0].s);
  } catch (e) { return null; }
}

function extractExifDate(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
  try {
    const st = fs.fstatSync(fd);
    const readLen = Math.min(st.size || 0, 32 * 1024 * 1024);
    if (readLen < 12) return null;
    const head = Buffer.alloc(readLen);
    const n = fs.readSync(fd, head, 0, readLen, 0);
    const buf = head.subarray(0, n);
    if (n < 12) return null;

    // JPEG: 按段遍历，找 APP1(FFE1) 中的 Exif
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      let p = 2;
      while (p + 4 <= n) {
        if (buf[p] !== 0xFF) { p++; continue; }
        const marker = buf[p + 1];
        if (marker === 0xFF) { p++; continue; }
        if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { p += 2; continue; }
        if (marker === 0xDA) break; // SOS: 图像数据开始
        if (p + 4 > n) break;
        const segLen = buf.readUInt16BE(p + 2);
        if (segLen < 2) break;
        if (marker === 0xE1 && p + 4 + 6 <= n && buf.toString('ascii', p + 4, p + 10) === 'Exif\0\0') {
          const d = parseTiff(buf, p + 10);
          if (d) return d;
        }
        p += 2 + segLen;
      }
      return null;
    }

    // PNG: eXIf 块
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      let p = 8;
      while (p + 8 <= n) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        if (type === 'eXIf' && p + 8 + len <= n) {
          const d = parseTiff(buf, p + 8);
          if (d) return d;
        }
        if (len < 0 || len > (1 << 24)) break;
        p += 12 + len;
      }
      return null;
    }

    // WebP(RIFF): EXIF 块
    if (buf.toString('ascii', 0, 4) === 'RIFF') {
      const needle = Buffer.from('EXIF');
      let idx = buf.indexOf(needle);
      while (idx !== -1) {
        const len = buf.readUInt32LE(idx + 4);
        let off = idx + 8;
        if (off + 6 <= n && buf.toString('ascii', off, off + 6) === 'Exif\0\0') off += 6;
        const d = parseTiff(buf, off);
        if (d) return d;
        idx = buf.indexOf(needle, idx + 1);
      }
      return null;
    }

    // HEIC / ISO-BMFF 等: 在文件头附近查找 Exif 标记
    const needle = Buffer.from('Exif\0\0');
    let idx = buf.indexOf(needle);
    while (idx !== -1) {
      const d = parseTiff(buf, idx + 6);
      if (d) return d;
      idx = buf.indexOf(needle, idx + 1);
    }
    return null;
  } catch (e) { return null; }
  finally { try { fs.closeSync(fd); } catch (e) {} }
}

function validDateStr(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +m[6];
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  const p = n => String(n).padStart(2, '0');
  return y + '-' + p(mo) + '-' + p(d) + '_' + p(h) + p(mi) + p(se);
}

function dateFromName(base) {
  const pad = n => String(n).padStart(2, '0');
  const pats = [
    /(20\d{2})[-_.](\d{2})[-_.](\d{2})[ _-](\d{2})[.:-]?(\d{2})[.:-]?(\d{2})/,
    /(20\d{2})(\d{2})(\d{2})[ _-](\d{2})[.:-]?(\d{2})[.:-]?(\d{2})/,
    /(20\d{2})[-_.](\d{2})[-_.](\d{2})/
  ];
  for (const re of pats) {
    const m = re.exec(base);
    if (!m) continue;
    if (m.length >= 7) {
      const v = validDateStr(m[1] + ':' + m[2] + ':' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6]);
      if (v) return v;
    } else {
      const v = validDateStr(m[1] + ':' + m[2] + ':' + m[3] + ' 00:00:00');
      if (v) return v;
    }
  }
  const m = /(1[5-9]\d{12}|20\d{12})/.exec(base);
  if (m) {
    const dt = new Date(Number(m[1]));
    if (!isNaN(dt.getTime()) && dt.getFullYear() >= 1970 && dt.getFullYear() <= 2100) {
      return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + '_' + pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds());
    }
  }
  return null;
}

function dateFromMtime(file) {
  const st = fs.statSync(file);
  const dt = new Date(st.mtimeMs);
  const p = n => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + '_' + p(dt.getHours()) + p(dt.getMinutes()) + p(dt.getSeconds());
}

// ---------------- 重复组保留策略 ----------------
function compareForKeep(policy) {
  return function (a, b) {
    let c = 0;
    if (policy === 'largest') c = b.size - a.size;
    else if (policy === 'smallest') c = a.size - b.size;
    else if (policy === 'newest') c = b.mtime - a.mtime;
    else if (policy === 'oldest') c = a.mtime - b.mtime;
    else c = a.folderIndex - b.folderIndex; // first
    if (c !== 0) return c;
    c = a.folderIndex - b.folderIndex;
    if (c !== 0) return c;
    return a.rel.localeCompare(b.rel);
  };
}

// ---------------- 主流程 ----------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const files = collectFiles(opts.folders, opts);
  if (files.length === 0) { console.error('没有找到任何文件。'); process.exit(1); }

  // 1) 大小预过滤: 只有同大小的文件才需要哈希
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const toHash = [];
  for (const list of bySize.values()) {
    if (list.length > 1 || opts.hashAll) toHash.push.apply(toHash, list);
  }
  const skippedUnique = files.length - toHash.length;

  let autoJobs = 1;
  try {
    const c = os.availableParallelism ? os.availableParallelism() : ((os.cpus() || []).length || 1);
    autoJobs = Math.max(1, Math.min(8, c));
  } catch (e) { autoJobs = 1; }
  const jobs = opts.jobs > 0 ? opts.jobs : (toHash.length >= 64 ? autoJobs : 1);

  let done = 0;
  const onProgress = c => {
    done = c;
    if (!opts.quiet && (c % 1000 === 0 || c === toHash.length)) {
      process.stderr.write('\r已哈希 ' + c + '/' + toHash.length + ' ...');
    }
  };
  const hashed = await hashFilesInParallel(toHash.map(f => f.abs), opts.hash, jobs, onProgress);
  if (!opts.quiet && toHash.length) process.stderr.write('\n');
  for (let i = 0; i < toHash.length; i++) {
    if (hashed.errors[i]) toHash[i].hashError = hashed.errors[i];
    else toHash[i].hash = hashed.hashes[i];
  }
  // 刷新文件大小(哈希期间可能被改动)
  for (const f of files) { try { f.size = fs.statSync(f.abs).size; } catch (e) { /* 忽略 */ } }

  // 2) 按哈希分组
  const groups = new Map();
  const hashErrors = [];
  for (const f of files) {
    if (f.hashError) { hashErrors.push({ path: f.abs, error: f.hashError }); continue; }
    if (!f.hash) continue; // 唯一大小、未哈希 → 单独保留
    if (!groups.has(f.hash)) groups.set(f.hash, []);
    groups.get(f.hash).push(f);
  }
  const winners = [];
  const duplicates = [];
  let dupGroups = 0;
  const seen = new Set();
  for (const g of groups.values()) {
    for (const f of g) seen.add(f);
    if (g.length === 1) { winners.push(g[0]); continue; }
    dupGroups++;
    const sorted = g.slice().sort(compareForKeep(opts.keep));
    winners.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) duplicates.push(sorted[i]);
  }
  for (const f of files) { if (!seen.has(f) && !f.hashError) winners.push(f); }

  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const freedBytes = duplicates.reduce((s, f) => s + f.size, 0);

  const fmt = b => (b / 1048576).toFixed(1) + ' MB';

  const outDir = opts.out ? path.resolve(opts.out) : path.join(path.dirname(path.resolve(opts.folders[0])), '合并后');
  const logPath = opts.log ? path.resolve(opts.log)
    : path.join(process.cwd(), 'dedup-report-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json');

  const report = {
    version: 2,
    tool: 'photo-dedup.js',
    time: new Date().toISOString(),
    sources: opts.folders.map(f => path.resolve(f)),
    outDir: outDir,
    hashAlgorithm: opts.hash,
    keep: opts.keep,
    jobs: jobs,
    dryRun: opts.dryRun,
    hashAll: opts.hashAll,
    skipExisting: opts.skipExisting,
    trashDir: opts.trash ? path.resolve(opts.trash) : null,
    totalFiles: files.length,
    totalBytes: totalBytes,
    uniqueFiles: winners.length,
    duplicateGroups: dupGroups,
    duplicatesToDelete: duplicates.length,
    freedBytes: freedBytes,
    hashSkippedUnique: skippedUnique,
    hashErrors: hashErrors,
    winners: winners.map(w => ({ path: w.abs, size: w.size, hash: w.hash || null, mtime: new Date(w.mtime).toISOString() })),
    duplicates: duplicates.map(d => ({ path: d.abs, size: d.size, hash: d.hash }))
  };

  // 3) --skip-existing: 计算输出目录中已有内容(只哈希大小与胜者相同的文件)
  let existingHashes = new Set();
  if (opts.skipExisting) {
    try {
      if (fs.existsSync(outDir)) {
        const outFiles = [];
        const entries = fs.readdirSync(outDir, { withFileTypes: true });
        for (const ent of entries) {
          if (!ent.isFile()) continue;
          const full = path.join(outDir, ent.name);
          let st;
          try { st = fs.statSync(full); } catch (e) { continue; }
          outFiles.push({ abs: full, size: st.size });
        }
        const winnerSizes = new Set();
        for (const w of winners) winnerSizes.add(w.size);
        const toHashOut = outFiles.filter(o => winnerSizes.has(o.size)).map(o => o.abs);
        if (toHashOut.length) {
          const hr = await hashFilesInParallel(toHashOut, opts.hash, jobs, null);
          for (let i = 0; i < toHashOut.length; i++) {
            if (!hr.errors[i] && hr.hashes[i]) existingHashes.add(hr.hashes[i]);
          }
        }
      }
    } catch (e) { console.error('跳过已有文件检测失败: ' + e.message); }
  }
  const skippedExisting = [];
  if (opts.skipExisting) {
    for (const w of winners) {
      if (w.hash && existingHashes.has(w.hash)) skippedExisting.push({ path: w.abs, size: w.size, hash: w.hash });
    }
  }

  const printSummary = () => {
    console.log('源文件总数: ' + files.length + ' 个 (' + fmt(totalBytes) + ')');
    console.log('去重后保留: ' + winners.length + ' 个 (' + fmt(totalBytes - freedBytes) + ')');
    console.log('重复组: ' + dupGroups + ' 组, 待删除重复: ' + duplicates.length + ' 个 (' + fmt(freedBytes) + ')');
    if (opts.hashAll) console.log('哈希: 全部文件 (' + toHash.length + ' 个)');
    else console.log('哈希: ' + toHash.length + ' 个, 跳过大小唯一文件 ' + skippedUnique + ' 个');
    if (skippedExisting.length) console.log('跳过输出目录已存在: ' + skippedExisting.length + ' 个');
    console.log('输出目录: ' + outDir);
    console.log('报告: ' + logPath);
  };

  if (opts.dryRun) {
    report.skippedExisting = skippedExisting;
    if (!opts.quiet) printSummary();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
    console.log('[dry-run] 未做任何移动/删除。');
    return;
  }

  // 4) 合并: 把胜者移动到输出目录
  fs.mkdirSync(outDir, { recursive: true });
  const usedNames = new Set();
  try { for (const n of fs.readdirSync(outDir)) usedNames.add(n.toLowerCase()); } catch (e) { /* 忽略 */ }
  const moved = [];
  const moveFailures = [];
  const movedOk = new Set();
  for (const w of winners) {
    if (opts.skipExisting && w.hash && existingHashes.has(w.hash)) continue; // 已在 skippedExisting 中统计
    const base = path.basename(w.abs);
    let cand = base;
    let i = 1;
    while (usedNames.has(cand.toLowerCase())) {
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      cand = stem + '(' + i + ')' + ext;
      i++;
    }
    usedNames.add(cand.toLowerCase());
    const dest = path.join(outDir, cand);
    try {
      moveFile(w.abs, dest);
      moved.push({ from: w.abs, to: dest, size: w.size });
      if (w.hash) movedOk.add(w.hash);
    } catch (e) {
      moveFailures.push({ path: w.abs, error: e.message });
      console.error('移动失败 ' + w.abs + ': ' + e.message);
    }
  }
  console.log('已合并 ' + moved.length + ' 个文件到 ' + outDir + (skippedExisting.length ? ', 跳过已存在 ' + skippedExisting.length + ' 个' : ''));

  // 5) 删除/回收重复(只有对应胜者成功合并后才执行)
  let deleted = 0, trashed = 0, fail = 0, kept = 0, gone = 0;
  const deletedList = [];
  const trashedList = [];
  if (!opts.noDelete) {
    const trashDir = opts.trash ? path.resolve(opts.trash) : null;
    for (const d of duplicates) {
      if (!movedOk.has(d.hash)) { kept++; continue; }
      if (!fs.existsSync(d.abs)) { gone++; continue; }
      try {
        if (trashDir) {
          fs.mkdirSync(trashDir, { recursive: true });
          const base = path.basename(d.abs);
          let cand = base;
          let i = 1;
          while (fs.existsSync(path.join(trashDir, cand))) {
            const ext = path.extname(base);
            const stem = base.slice(0, base.length - ext.length);
            cand = stem + '(' + i + ')' + ext;
            i++;
          }
          const dest = path.join(trashDir, cand);
          moveFile(d.abs, dest);
          trashed++;
          trashedList.push({ from: d.abs, to: dest, size: d.size, hash: d.hash });
        } else {
          fs.unlinkSync(d.abs);
          deleted++;
          deletedList.push({ path: d.abs, size: d.size, hash: d.hash });
        }
      } catch (e) {
        fail++;
        console.error((trashDir ? '移入回收失败 ' : '删除失败 ') + d.abs + ': ' + e.message);
      }
    }
    const parts = [];
    if (trashDir) parts.push('已移入回收 ' + trashed + ' 个');
    else parts.push('已删除重复文件 ' + deleted + ' 个');
    if (kept) parts.push('保留 ' + kept + ' 个(胜者未成功合并)');
    if (gone) parts.push('原本已不存在 ' + gone + ' 个');
    if (fail) parts.push('失败 ' + fail + ' 个');
    console.log(parts.join(', '));
  } else {
    console.log('已跳过删除(--no-delete)，重复文件仍留在原处。');
  }

  // 6) 可选: 按拍摄时间重命名
  if (opts.sortByDate) {
    const names = fs.readdirSync(outDir);
    const used = new Set();
    for (const n of names) used.add(n.toLowerCase());
    let renamed = 0, already = 0, skipped = 0;
    const renamedList = [];
    for (const n of names) {
      const full = path.join(outDir, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      if (/^\d{4}-\d{2}-\d{2}_\d{6}/.test(n)) { already++; continue; }
      let pref = extractExifDate(full);
      if (!pref && !opts.exifOnly) pref = dateFromName(n);
      if (!pref && !opts.exifOnly) pref = dateFromMtime(full);
      if (!pref) { skipped++; continue; }
      let cand = pref + '_' + n;
      let i = 1;
      while (used.has(cand.toLowerCase())) {
        const ext = path.extname(n);
        const stem = n.slice(0, n.length - ext.length);
        cand = pref + '_' + stem + '(' + i + ')' + ext;
        i++;
      }
      used.add(cand.toLowerCase());
      try {
        fs.renameSync(full, path.join(outDir, cand));
        renamed++;
        renamedList.push({ from: n, to: cand });
      } catch (e) {
        console.error('排序重命名失败 ' + n + ': ' + e.message);
      }
    }
    report.renamed = renamedList;
    let msg = '按拍摄时间重命名 ' + renamed + ' 个文件';
    if (already) msg += ', ' + already + ' 个已带日期前缀';
    if (skipped) msg += ', ' + skipped + ' 个无法确定时间(原样保留)';
    console.log(msg);
  }

  report.moved = moved;
  report.skippedExisting = skippedExisting;
  report.moveFailures = moveFailures;
  report.deleted = opts.noDelete ? [] : deletedList;
  report.trashed = trashedList;
  report.elapsedMs = Date.now() - t0;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(report, null, 2));
  } catch (e) { console.error('写报告失败: ' + e.message); }

  if (!opts.quiet) { console.log(''); printSummary(); }
}

main().catch(err => {
  console.error('运行失败: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
