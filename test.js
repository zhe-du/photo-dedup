#!/usr/bin/env node
'use strict';

/*
 * photo-dedup 自测：零依赖，直接 `node test.js`
 * 每个用例在系统临时目录下建独立沙箱，跑完即删。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, 'photo-dedup.js');

// ---- 测试框架（极简） ----
const results = [];
let current = null;

function test(name, fn) {
  current = { name, ok: true, msg: '', error: null };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
  try {
    fn(sandbox);
  } catch (e) {
    current.ok = false;
    current.msg = current.msg || (e && e.message ? e.message : String(e));
    current.error = e;
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    results.push(current);
    current = null;
  }
}

function fail(msg) {
  if (current && current.ok) { current.ok = false; current.msg = msg; }
  throw new Error(msg);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail((label ? label + ': ' : '') + '期望 ' + b + '，实际 ' + a);
}

function ok(cond, label) {
  if (!cond) fail(label || '断言失败');
}

// ---- 工具 ----
function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function run(cwd, args) {
  const env = Object.assign({}, process.env);
  // 去掉可能干扰子进程的环境变量
  delete env.NODE_OPTIONS;
  delete env.NODE_EXTRA_CA_CERTS;
  const r = spawnSync(process.execPath, [TOOL].concat(args), {
    cwd, env, encoding: 'utf8', timeout: 120000
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
      else if (ent.isFile()) out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashSetOf(root) {
  const set = new Set();
  for (const rel of listFiles(root)) set.add(sha(fs.readFileSync(path.join(root, rel))));
  return set;
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ================= 用例 =================

test('--help 显示用法并退出 0', (sb) => {
  const r = run(sb, ['--help']);
  eq(r.code, 0, '退出码');
  ok(r.out.indexOf('用法') !== -1, '缺少用法说明');
});

test('无参数时报错并退出 2', (sb) => {
  const r = run(sb, []);
  eq(r.code, 2, '退出码');
  ok(/至少需要指定一个源文件夹/.test(r.out), '缺少错误提示');
});

test('非法 --hash 被拒绝', (sb) => {
  write(sb, 'A/x.jpg', 'aaa');
  const r = run(sb, ['A', '--hash', 'crc32']);
  eq(r.code, 2, '退出码');
});

test('--dry-run 不移动不删除、不创建输出目录', (sb) => {
  write(sb, 'A/p1.jpg', 'content-one');
  write(sb, 'A/p2.jpg', 'content-two');
  write(sb, 'B/p1-copy.jpg', 'content-one');
  const before = listFiles(sb).filter(p => !p.startsWith('dedup-report-'));
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--dry-run']);
  eq(r.code, 0, '退出码');
  ok(!fs.existsSync(path.join(sb, 'OUT')), 'dry-run 不应创建输出目录');
  const after = listFiles(sb).filter(p => !p.startsWith('dedup-report-'));
  eq(after, before, '文件列表应完全不变');
});

test('合并去重：每份内容只保留一个，重复被删除', (sb) => {
  write(sb, 'A/p1.jpg', 'content-one');
  write(sb, 'A/p2.jpg', 'content-two');
  write(sb, 'B/p1-copy.jpg', 'content-one');
  write(sb, 'B/p3.jpg', 'content-three');
  const r = run(sb, ['A', 'B', '--out', 'OUT']);
  eq(r.code, 0, '退出码');
  const files = listFiles(path.join(sb, 'OUT'));
  eq(files.length, 3, '输出文件数');
  eq(hashSetOf(path.join(sb, 'OUT')).size, 3, '输出内容应互不相同');
  ok(!fs.existsSync(path.join(sb, 'B/p1-copy.jpg')), '重复文件应被删除');
  ok(fs.existsSync(path.join(sb, 'OUT/p1.jpg')), '胜者应被移入输出目录');
  ok(!fs.existsSync(path.join(sb, 'A/p1.jpg')), '胜者应离开原目录(移动而非复制)');
});

test('报告 JSON: version 2、含 winners / duplicates', (sb) => {
  write(sb, 'A/p1.jpg', 'content-one');
  write(sb, 'B/p1-copy.jpg', 'content-one');
  write(sb, 'B/p2.jpg', 'unique-content');
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--log', 'report.json']);
  eq(r.code, 0, '退出码');
  const rep = readJSON(path.join(sb, 'report.json'));
  eq(rep.version, 2, 'version');
  ok(Array.isArray(rep.winners) && rep.winners.length === 2, 'winners 应为 2 个');
  ok(Array.isArray(rep.duplicates) && rep.duplicates.length === 1, 'duplicates 应为 1 个');
  eq(rep.duplicateGroups, 1, 'duplicateGroups');
  eq(rep.hashAlgorithm, 'sha256', '默认算法');
});

test('--trash 把重复移入回收目录而不是删除', (sb) => {
  write(sb, 'A/p1.jpg', 'same-content');
  write(sb, 'B/p1-copy.jpg', 'same-content');
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--trash', 'TRASH']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')).length, 1, '输出文件数');
  eq(listFiles(path.join(sb, 'TRASH')).length, 1, '回收目录应有 1 个文件');
  ok(fs.existsSync(path.join(sb, 'TRASH/p1-copy.jpg')), '回收目录里应是重复的那份');
});

test('--no-delete 只合并不删重复', (sb) => {
  write(sb, 'A/p1.jpg', 'same-content');
  write(sb, 'B/p1-copy.jpg', 'same-content');
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--no-delete']);
  eq(r.code, 0, '退出码');
  ok(fs.existsSync(path.join(sb, 'B/p1-copy.jpg')), '重复文件应留在原处');
  eq(listFiles(path.join(sb, 'OUT')).length, 1, '输出文件数');
});

test('--keep newest 保留最新的那份', (sb) => {
  // 重复组内内容相同 ⇒ 大小必然相同，唯一能区分的就是时间/来源顺序
  write(sb, 'A/big.jpg', 'a'.repeat(300));
  write(sb, 'B/big-copy.jpg', 'a'.repeat(300));
  const t = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(sb, 'A/big.jpg'), t, t);      // A 更旧
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--keep', 'newest']);
  eq(r.code, 0, '退出码');
  const left = listFiles(path.join(sb, 'OUT'));
  eq(left.length, 1, '输出文件数');
  eq(left[0], 'big-copy.jpg', 'newest 应保留 B 里较新的那份');
});

test('--keep largest 与 first 等价（同内容必然同大小）', (sb) => {
  write(sb, 'A/x.jpg', 'a'.repeat(120));
  write(sb, 'B/x-copy.jpg', 'a'.repeat(120));
  const t = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(sb, 'A/x.jpg'), t, t);        // A 更旧，但排在前面
  const r = run(sb, ['A', 'B', '--out', 'OUT', '--keep', 'largest']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')), ['x.jpg'], 'largest 退化为按源顺序取第一份');
});

test('同名不同内容不覆盖，自动加 (1) 后缀', (sb) => {
  write(sb, 'A/photo.jpg', 'short');
  write(sb, 'B/photo.jpg', 'much-longer-content');  // 大小不同 → 不同哈希
  const r = run(sb, ['A', 'B', '--out', 'OUT']);
  eq(r.code, 0, '退出码');
  const files = listFiles(path.join(sb, 'OUT'));
  eq(files, ['photo(1).jpg', 'photo.jpg'], '应保留两份并加后缀');
  eq(hashSetOf(path.join(sb, 'OUT')).size, 2, '两份内容应都在');
});

test('--skip-existing 二次运行跳过已存在内容', (sb) => {
  write(sb, 'A/p1.jpg', 'content-one');
  write(sb, 'A/p2.jpg', 'content-two');
  run(sb, ['A', '--out', 'OUT']);                                  // 第一次
  // 复原源文件用于第二次
  write(sb, 'A/p1.jpg', 'content-one');
  write(sb, 'A/p2.jpg', 'content-two');
  const r = run(sb, ['A', '--out', 'OUT', '--skip-existing']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')).length, 2, '不应重复合并出 4 个文件');
  ok(/跳过输出目录已存在: 2 个/.test(r.out), '汇总里应显示跳过 2 个');
});

test('--sort-by-date 按文件名日期重命名', (sb) => {
  write(sb, 'A/IMG_20240102_030405.jpg', 'x1');
  write(sb, 'A/random-name.jpg', 'x2');
  const r = run(sb, ['A', '--out', 'OUT', '--sort-by-date']);
  eq(r.code, 0, '退出码');
  ok(fs.existsSync(path.join(sb, 'OUT/2024-01-02_030405_IMG_20240102_030405.jpg')),
    '应按日期前缀重命名，实际: ' + listFiles(path.join(sb, 'OUT')).join(','));
});

test('--include-ext 只处理指定扩展名', (sb) => {
  write(sb, 'A/p.jpg', 'photo-content');
  write(sb, 'A/p.txt', 'text-content');
  write(sb, 'A/p.mov', 'video-content');
  const r = run(sb, ['A', '--out', 'OUT', '--include-ext', 'jpg,png']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')), ['p.jpg'], '只应合并 jpg');
});

test('--min-size 忽略过小文件', (sb) => {
  write(sb, 'A/small.jpg', 'tiny');
  write(sb, 'A/big.jpg', 'y'.repeat(200));
  const r = run(sb, ['A', '--out', 'OUT', '--min-size', '10']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')), ['big.jpg'], '小文件应被忽略');
});

test('--hash md5 与 sha256 结果一致', (sb) => {
  for (const algo of ['md5', 'sha256']) {
    write(sb, 'S/' + algo + '/p1.jpg', 'same-bytes');
    write(sb, 'S/' + algo + '/p2-copy.jpg', 'same-bytes');
    const r = run(sb, ['S/' + algo, '--out', 'OUT-' + algo, '--hash', algo]);
    eq(r.code, 0, '退出码(' + algo + ')');
    eq(listFiles(path.join(sb, 'OUT-' + algo)).length, 1, algo + ' 去重结果');
  }
});

test('多线程 --jobs 8 与单线程结果一致', (sb) => {
  // 造 130 个文件，其中 65 个是重复
  for (let i = 0; i < 65; i++) {
    const body = 'payload-' + i + '-' + 'z'.repeat(20);
    write(sb, 'A/f' + i + '.jpg', body);
    write(sb, 'B/f' + i + '-copy.jpg', body);
  }
  const r1 = run(sb, ['A', 'B', '--out', 'OUT1', '--jobs', '1', '--quiet', '--dry-run', '--log', 'r1.json']);
  eq(r1.code, 0, '单线程退出码');
  const r8 = run(sb, ['A', 'B', '--out', 'OUT1', '--jobs', '8', '--quiet', '--dry-run', '--log', 'r8.json']);
  eq(r8.code, 0, '多线程退出码');
  const a = readJSON(path.join(sb, 'r1.json'));
  const b = readJSON(path.join(sb, 'r8.json'));
  eq(b.winners.length, a.winners.length, 'winners 数量');
  eq(b.duplicatesToDelete, a.duplicatesToDelete, '重复数量');
  eq(b.uniqueFiles, 65, '去重后应保留 65 个');
  // 真跑一次并发写入，确认落盘结果
  const r = run(sb, ['A', 'B', '--out', 'OUT8', '--jobs', '8', '--quiet']);
  eq(r.code, 0, '并发合并退出码');
  eq(listFiles(path.join(sb, 'OUT8')).length, 65, '输出文件数应为 65');
  eq(hashSetOf(path.join(sb, 'OUT8')).size, 65, '输出内容应互不相同');
});

test('输出目录名与源同名冲突不会死循环', (sb) => {
  write(sb, 'A/a.jpg', '1-content');
  write(sb, 'B/a.jpg', '1-content');       // 重复
  write(sb, 'B/a(1).jpg', '1-content');    // 同名候选已被占用
  const r = run(sb, ['A', 'B', '--out', 'OUT']);
  eq(r.code, 0, '退出码');
  eq(listFiles(path.join(sb, 'OUT')).length, 1, '同内容仍应只保留一份');
});

test('源文件夹不存在时跳过而不是崩溃', (sb) => {
  write(sb, 'A/a.jpg', 'ok-content');
  const r = run(sb, ['A', 'NOT_EXIST', '--out', 'OUT']);
  eq(r.code, 0, '退出码');
  ok(/跳过不存在的文件夹/.test(r.out), '应有跳过提示');
  eq(listFiles(path.join(sb, 'OUT')).length, 1, '仍应合并 A');
});

// ================= 汇总 =================
console.log('');
const width = 46;
const pad = s => s + ' '.repeat(Math.max(0, width - [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
let passed = 0;
for (const r of results) {
  if (r.ok) { passed++; console.log('  [PASS] ' + pad(r.name)); }
  else console.log('  [FAIL] ' + pad(r.name) + '\n         ' + r.msg);
}
console.log('');
console.log('通过 ' + passed + '/' + results.length);
if (passed !== results.length) process.exit(1);
