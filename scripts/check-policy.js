const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  previewEdits,
  isInsideRoots,
  isProtectedPath,
  isSensitiveFile,
  resolveInWorkspace,
  normalizeToolPath
} = require(path.join(__dirname, '..', 'out', 'agent', 'policy.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

// ---- previewEdits ----
let r = previewEdits('a\nb\nc\n', [{ oldText: 'b', newText: 'B' }]);
expect('单处替换', r.ok && r.proposed === 'a\nB\nc\n', JSON.stringify(r));
expect('统计增删行', r.ok && r.added === 1 && r.removed === 1);

r = previewEdits('one\ntwo\nthree\n', [
  { oldText: 'three', newText: '3' },
  { oldText: 'one', newText: '1' }
]);
expect('多处修改与顺序无关', r.ok && r.proposed === '1\ntwo\n3\n', JSON.stringify(r));

r = previewEdits('x\nx\n', [{ oldText: 'x', newText: 'y' }]);
expect('多处匹配被拒绝', !r.ok && /多次/.test(r.error), JSON.stringify(r));

r = previewEdits('abc', [{ oldText: 'zzz', newText: 'y' }]);
expect('找不到被拒绝', !r.ok && /找不到/.test(r.error), JSON.stringify(r));

r = previewEdits('abcdef', [
  { oldText: 'abcd', newText: '1' },
  { oldText: 'cdef', newText: '2' }
]);
expect('重叠被拒绝', !r.ok && /重叠/.test(r.error), JSON.stringify(r));

r = previewEdits('abc', []);
expect('空 edits 被拒绝', !r.ok);

r = previewEdits('abc', [{ oldText: '', newText: 'x' }]);
expect('空 oldText 被拒绝', !r.ok);

// CRLF：模型给 LF，文件是 CRLF，应能匹配并保持 CRLF
r = previewEdits('line1\r\nline2\r\nline3\r\n', [{ oldText: 'line1\nline2', newText: 'A\nB' }]);
expect('CRLF 文件可匹配且保持 CRLF', r.ok && r.proposed === 'A\r\nB\r\nline3\r\n', JSON.stringify(r));

// BOM 保留
r = previewEdits('﻿hello', [{ oldText: 'hello', newText: 'hi' }]);
expect('BOM 保留', r.ok && r.proposed === '﻿hi', JSON.stringify(r));

// 新文本中出现旧文本不应被二次替换
r = previewEdits('foo bar', [{ oldText: 'foo', newText: 'foo foo' }]);
expect('替换结果不二次匹配', r.ok && r.proposed === 'foo foo bar', JSON.stringify(r));

// ---- 路径围栏 ----
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-policy-ws-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-policy-other-'));
fs.mkdirSync(path.join(ws, 'src'));
fs.writeFileSync(path.join(ws, 'src', 'a.ts'), '');
fs.writeFileSync(path.join(other, 'x.txt'), '');

expect('工作区内文件', isInsideRoots([ws], path.join(ws, 'src', 'a.ts')));
expect('工作区根本身', isInsideRoots([ws], ws));
expect('尚不存在的新文件（父目录在工作区内）', isInsideRoots([ws], path.join(ws, 'src', 'new', 'b.ts')));
expect('工作区外', !isInsideRoots([ws], path.join(other, 'x.txt')));
expect('.. 逃逸', !isInsideRoots([ws], resolveInWorkspace(ws, '../' + path.basename(other) + '/x.txt')));
expect('前缀相似的兄弟目录', !isInsideRoots([ws], ws + '-evil/a.txt'));
expect('多根工作区', isInsideRoots([ws, other], path.join(other, 'x.txt')));

// 符号链接逃逸（Windows 创建 symlink 可能需要权限，失败则跳过）
try {
  fs.symlinkSync(other, path.join(ws, 'link'), 'junction');
  expect('符号链接指向工作区外被识别', !isInsideRoots([ws], path.join(ws, 'link', 'x.txt')));
  expect('经符号链接新建工作区外文件被识别', !isInsideRoots([ws], path.join(ws, 'link', 'sub', 'new.txt')));
  expect('工作区内真实文件仍可访问', isInsideRoots([ws], path.join(ws, 'src', 'a.ts')));
} catch (err) {
  console.log('skip 符号链接（无权限创建）: ' + err.code);
}

expect('@ 前缀被去除', normalizeToolPath('@src/a.ts') === 'src/a.ts');
expect('缺省路径为当前目录', normalizeToolPath(undefined) === '.');

// ---- 受保护路径 / 敏感文件 ----
expect('.git 内部受保护', isProtectedPath(path.join(ws, '.git', 'config')));
expect('.gitignore 不受保护', !isProtectedPath(path.join(ws, '.gitignore')));
expect('.env 敏感', isSensitiveFile('/p/.env'));
expect('.env.local 敏感', isSensitiveFile('/p/.env.local'));
expect('.env.example 放行', !isSensitiveFile('/p/.env.example'));
expect('私钥敏感', isSensitiveFile('/home/u/.ssh/id_rsa'));
expect('pem 敏感', isSensitiveFile('/p/server.pem'));
expect('.npmrc 敏感', isSensitiveFile('/p/.npmrc'));
expect('普通源码不敏感', !isSensitiveFile('/p/src/app.ts'));

for (const d of [ws, other]) {
  fs.rmSync(d, { recursive: true, force: true });
}

if (fail > 0) {
  console.error(fail + ' check(s) failed');
  process.exit(1);
}
console.log('policy tests passed');
