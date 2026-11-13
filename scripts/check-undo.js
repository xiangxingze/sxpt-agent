const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};

const writes = [];
const deletes = [];
const messages = [];

const stub = {
  workspaceFolders: [{ uri: { fsPath: '/ws' } }],
  Uri: { file: (p) => ({ fsPath: p }), parse: (v) => ({ path: v }) },
  workspace: { fs: { readFile: async () => Buffer.from(''), writeFile: async (uri, buf) => writes.push([uri.fsPath, buf.toString('utf8')]), delete: async (uri) => deletes.push(uri.fsPath) } },
  window: {
    showInformationMessage: async (m) => {
      messages.push(m);
      return undefined;
    },
    showWarningMessage: async (m) => {
      messages.push(m);
      return undefined;
    },
    showErrorMessage: async () => undefined
  },
  commands: { executeCommand: async () => undefined },
  workspace_: null
};

require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };

const { PatchReviewService } = require(path.join(__dirname, '..', 'out', 'patchReview.js'));

let stored = [
  {
    id: 'b1',
    createdAt: Date.now(),
    entries: [
      { filePath: '/ws/a.cs', content: 'original content', existedBefore: true },
      { filePath: '/ws/new.cs', content: undefined, existedBefore: false }
    ]
  }
];

const fakeContext = {
  subscriptions: [],
  workspaceState: {
    get: () => stored,
    update: async (_k, v) => {
      stored = v;
    }
  }
};

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

(async () => {
  const output = { appendLine: () => {} };
  const svc = new PatchReviewService(output, fakeContext);

  expect('可回退批次数', svc.undoCount === 1, String(svc.undoCount));

  const ok = await svc.undoLast();
  expect('撤销返回成功', ok === true);
  expect('覆盖恢复原内容', writes.length === 1 && writes[0][1] === 'original content', JSON.stringify(writes));
  expect('删除新建文件', deletes.length === 1 && deletes[0] === '/ws/new.cs', JSON.stringify(deletes));
  expect('清空回退栈', stored.length === 0);
  expect('提示已撤销', typeof messages[0] === 'string' && messages[0].includes('已撤销'));

  const empty = await svc.undoLast();
  expect('无记录时返回 false', empty === false);

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('undo tests passed');
})();
