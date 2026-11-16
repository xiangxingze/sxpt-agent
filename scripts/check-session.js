require('./source-loader');
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
expect('新建会话保留旧会话', store.history.length === 1);
const previousId = store.history[0].id;
store.saveDraft('新会话草稿');
const freshId = store.currentId;
store.select(previousId);
expect('切换历史恢复消息', store.all.length > 0);
store.select(freshId);
expect('切回新会话恢复草稿', store.currentDraft === '新会话草稿');

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

const persisted = new Map();
const historyContext = { workspaceState: { get: (key) => persisted.get(key), update: async (key, value) => persisted.set(key, structuredClone(value)) } };
const historyStore = new SessionStore(historyContext);
historyStore.addUser('保留这条会话');
historyStore.addAssistant('历史回答');
const retainedId = historyStore.currentId;
historyStore.reset();
historyStore.saveDraft('重启后继续');
const reloaded = new SessionStore(historyContext);
expect('重启恢复当前草稿', reloaded.currentDraft === '重启后继续');
reloaded.select(retainedId);
expect('重启恢复历史和上下文', reloaded.all[1].content === '历史回答');
for (let index = 0; index < 25; index++) { reloaded.reset(); reloaded.addUser('会话 ' + index); }
expect('会话历史限制数量', reloaded.history.length <= 20);

if (fail > 0) {
  console.error(fail + ' check(s) failed');
  process.exit(1);
}
console.log('session store tests passed');
