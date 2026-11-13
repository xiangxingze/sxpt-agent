const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};

const store = new Map(); // 模拟磁盘：path -> string
const deletes = [];
const messages = [];

const stub = {
  Uri: { file: (p) => ({ fsPath: p }), parse: (v) => ({ path: v }) },
  workspace: {
    fs: {
      readFile: async (uri) => {
        if (!store.has(uri.fsPath)) throw new Error('ENOENT');
        return Buffer.from(store.get(uri.fsPath), 'utf8');
      },
      writeFile: async (uri, buf) => store.set(uri.fsPath, buf.toString('utf8')),
      delete: async (uri) => {
        deletes.push(uri.fsPath);
        store.delete(uri.fsPath);
      }
    }
  },
  window: {
    showInformationMessage: async (m) => {
      messages.push(m);
      return undefined;
    }
  }
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };

const { ChangeTracker } = require(path.join(__dirname, '..', 'out', 'changeTracker.js'));

let saved;
const fakeContext = {
  workspaceState: {
    get: () => saved,
    update: async (_k, v) => {
      saved = v;
    }
  }
};

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

(async () => {
  const tracker = new ChangeTracker(fakeContext, { appendLine: () => {} });

  store.set('/ws/a.cs', 'original content');
  // 模拟一次任务：修改 a.cs 两次（只应保存第一次的内容），新建 new.cs
  tracker.beginRun();
  await tracker.snapshot('/ws/a.cs');
  store.set('/ws/a.cs', 'after first edit');
  await tracker.snapshot('/ws/a.cs');
  store.set('/ws/a.cs', 'after second edit');
  await tracker.snapshot('/ws/new.cs');
  store.set('/ws/new.cs', 'brand new');
  const files = tracker.commitRun();

  expect('提交返回改动文件', files.length === 2 && files.includes('/ws/a.cs') && files.includes('/ws/new.cs'), JSON.stringify(files));
  expect('可回退批次数', tracker.undoCount === 1, String(tracker.undoCount));

  // 没有改动的任务不入栈
  tracker.beginRun();
  expect('空任务不产生批次', tracker.commitRun().length === 0 && tracker.undoCount === 1);
  // 重复提交是空操作
  expect('重复提交安全', tracker.commitRun().length === 0 && tracker.undoCount === 1);

  const ok = await tracker.undoLast();
  expect('撤销返回成功', ok === true);
  expect('覆盖恢复为第一次修改前的内容', store.get('/ws/a.cs') === 'original content', store.get('/ws/a.cs'));
  expect('删除新建文件', deletes.length === 1 && deletes[0] === '/ws/new.cs', JSON.stringify(deletes));
  expect('清空回退栈', saved.length === 0);
  expect('提示已撤销', typeof messages[0] === 'string' && messages[0].includes('已撤销 2'), messages[0]);

  const empty = await tracker.undoLast();
  expect('无记录时返回 false', empty === false);

  // 超大文件不保存快照，撤销时给出提示
  store.set('/ws/big.bin', 'x'.repeat(1_100_000));
  tracker.beginRun();
  await tracker.snapshot('/ws/big.bin');
  tracker.commitRun();
  messages.length = 0;
  await tracker.undoLast();
  expect('超大文件提示无法撤销', /无法自动撤销/.test(messages[0] || ''), messages[0]);
  expect('超大文件内容未被改写', store.get('/ws/big.bin').length === 1_100_000);

  // 批次上限
  for (let i = 0; i < 15; i++) {
    tracker.beginRun();
    await tracker.snapshot('/ws/f' + i);
    tracker.commitRun();
  }
  expect('批次数有上限', tracker.undoCount === 10, String(tracker.undoCount));

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('undo tests passed');
})();
