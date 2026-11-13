const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: {}
};

const { SessionStore } = require(path.join(__dirname, '..', 'out', 'agent', 'session.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) {
    console.log('ok ' + name);
  } else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

function makeContext(initial) {
  let stored = initial;
  return {
    workspaceState: {
      get: () => stored,
      update: async (_k, v) => {
        stored = v;
      }
    },
    raw: () => stored
  };
}

const ctx = makeContext(undefined);
const store = new SessionStore(ctx);

for (let i = 0; i < 30; i++) {
  store.addUser('问题 ' + i);
  store.addAssistant('回答 ' + i);
}

expect('按轮数裁剪', store.all.length <= 40, 'len=' + store.all.length);
expect('保留最近消息', store.all[store.all.length - 1].content === '回答 29');
expect('会话条数统计', store.count === store.all.length);

for (let i = 0; i < 40; i++) {
  store.addUser('长文本'.repeat(2000));
}
expect('按字符预算裁剪', store.totalChars() <= 62000, 'chars=' + store.totalChars());

store.reset();
expect('重置后为空', store.all.length === 0);

const ctx2 = makeContext({
  messages: [
    { role: 'user', content: '历史问题' },
    { role: 'assistant', content: '历史回答' },
    { role: 'system', content: '非法角色应被过滤' },
    { role: 'user', content: 123 }
  ],
  startedAt: 1000
});
const restored = new SessionStore(ctx2);
expect('恢复过滤非法条目', restored.all.length === 2);
expect('恢复保留内容', restored.all[0].content === '历史问题');
expect('恢复开始时间', restored.sessionStartedAt === 1000);

const ctx3 = makeContext(undefined);
const s3 = new SessionStore(ctx3);
s3.addUser('hi');
s3.popLastIf('user');
expect('回滚最后一条', s3.all.length === 0);

if (fail > 0) {
  console.error(fail + ' check(s) failed');
  process.exit(1);
}
console.log('session store tests passed');
