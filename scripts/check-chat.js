/**
 * ChatViewProvider 集成自检：vscode 桩 + 真实 PiAgent + 假模型服务。
 * 验证侧栏消息协议的顺序与内容、审批卡片往返、拒绝/允许、侧栏不可见时的原生弹窗降级、
 * 修改汇总与撤销、停止。
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-chat-ws-'));
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-chat-store-'));
fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\nbeta\n');

const configValues = {
  provider: 'openai-compatible',
  model: 'test-model',
  approvalMode: 'ask',
  includeProjectContext: false,
  commandTimeoutMs: 20000
};
const nativeDialogs = [];
let nativeAnswer = undefined;

const stub = {
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p }),
    parse: (v) => ({ scheme: v.split(':')[0], path: v.slice(v.indexOf(':') + 1) }),
    joinPath: (base, ...parts) => stub.Uri.file(path.join(base.fsPath || base.path, ...parts))
  },
  window: {
    activeTextEditor: undefined,
    activeTerminal: undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async (message, ...rest) => {
      nativeDialogs.push(message);
      return nativeAnswer;
    },
    showQuickPick: async () => undefined
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws }, name: 'ws' }],
    textDocuments: [],
    getConfiguration: () => ({ get: (k) => configValues[k], update: async () => undefined }),
    asRelativePath: (u) => path.relative(ws, u.fsPath || u).replace(/\\/g, '/'),
    fs: {
      readFile: async (u) => fs.readFileSync(u.fsPath),
      writeFile: async (u, buf) => fs.writeFileSync(u.fsPath, buf),
      delete: async (u) => fs.rmSync(u.fsPath, { force: true })
    }
  },
  languages: { getDiagnostics: () => [] },
  extensions: { getExtension: () => undefined },
  commands: { executeCommand: async () => undefined }
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };

const { ChatViewProvider } = require(path.join(__dirname, '..', 'out', 'chatView.js'));
const { ChangeTracker } = require(path.join(__dirname, '..', 'out', 'changeTracker.js'));
const { createModelServer, listen } = require('./fake-model');

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

function setup(port, decisions) {
  configValues.baseUrl = `http://127.0.0.1:${port}/v1`;
  const posted = [];
  let handler;
  const diffCalls = { shown: [], closed: [] };
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'csp',
      asWebviewUri: (u) => u.fsPath,
      onDidReceiveMessage: (h) => {
        handler = h;
        return { dispose() {} };
      },
      postMessage: async (msg) => {
        posted.push(msg);
        if (msg.type === 'approval') {
          const decision = decisions.shift() || 'allow';
          setImmediate(() => handler({ type: 'approvalResponse', id: msg.request.id, decision }));
        }
        return true;
      }
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} })
  };
  const state = new Map();
  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: storage },
    workspaceState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) }
  };
  const output = { appendLine: () => undefined };
  const tracker = new ChangeTracker(context, output);
  const diffs = {
    show: async (r) => diffCalls.shown.push(r.id),
    close: async (id) => diffCalls.closed.push(id)
  };
  const secrets = { getApiKey: async () => 'k', getPlatformToken: async () => undefined };
  const platform = { getContext: async () => undefined, lastErrorMessage: undefined, clear() {} };
  const statusBar = { show() {}, text: '', tooltip: '' };
  const provider = new ChatViewProvider(
    { fsPath: path.join(__dirname, '..') },
    secrets,
    tracker,
    diffs,
    platform,
    output,
    statusBar,
    context
  );
  provider.resolveWebviewView(view);
  return { provider, posted, view, diffCalls, tracker, send: (m) => handler(m) };
}

const types = (posted) => posted.map((m) => m.type);

async function main() {
  // ===== 场景 1：侧栏可见，审批卡片往返 =====
  {
    const { server } = createModelServer([
      { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] } },
      { tool: 'bash', args: { command: 'node -e "console.log(1)"' } },
      { text: '已修改完成' }
    ]);
    const port = await listen(server);
    const t = setup(port, ['allow', 'deny']);
    await t.provider.handleUserText('把 alpha 改成大写');

    const seq = types(t.posted);
    const idx = (type) => seq.indexOf(type);
    expect('推送了 user / assistantStart', idx('user') >= 0 && idx('assistantStart') > idx('user'), seq.join(','));
    expect('顺序：toolStart → approval → approvalDone → toolEnd', idx('toolStart') < idx('approval') && idx('approval') < idx('approvalDone') && idx('approvalDone') < idx('toolEnd'), seq.join(','));
    const approvals = t.posted.filter((m) => m.type === 'approval');
    expect('出现两张审批卡片（edit + bash）', approvals.length === 2 && approvals[0].request.kind === 'edit' && approvals[1].request.kind === 'bash', JSON.stringify(approvals.map((a) => a.request.kind)));
    expect('edit 审批携带 Diff 统计与相对路径', approvals[0].request.canDiff === true && approvals[0].request.relPath === 'a.txt' && approvals[0].request.added === 1, JSON.stringify(approvals[0].request));
    expect('bash 审批携带命令', /console\.log\(1\)/.test(approvals[1].request.command) && approvals[1].request.canDiff === false);
    expect('edit 审批时打开了 Diff，决议后关闭', t.diffCalls.shown.length === 1 && t.diffCalls.closed.length === 2, JSON.stringify(t.diffCalls));
    expect('审批决议回显', t.posted.filter((m) => m.type === 'approvalDone').map((m) => m.decision).join() === 'allow,deny');
    expect('允许的 edit 已写入磁盘', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'ALPHA\nbeta\n');
    const ends = t.posted.filter((m) => m.type === 'toolEnd');
    expect('被拒绝的命令显示失败', ends.length === 2 && ends[0].ok === true && ends[1].ok === false, JSON.stringify(ends.map((e) => e.ok)));
    expect('推送了最终文本', t.posted.filter((m) => m.type === 'textDelta').map((m) => m.text).join('').includes('已修改完成'));
    const end = t.posted.find((m) => m.type === 'assistantEnd');
    expect('assistantEnd 含统计信息', end && /2 次工具调用/.test(end.meta), end && end.meta);
    const changes = t.posted.find((m) => m.type === 'changes');
    expect('推送修改汇总', changes && changes.files.length === 1 && changes.files[0] === 'a.txt', JSON.stringify(changes));
    expect('可撤销批次数 = 1', t.tracker.undoCount === 1);
    const lastState = [...t.posted].reverse().find((m) => m.type === 'state');
    expect('结束后 busy=false 且显示可回退次数', lastState && lastState.busy === false && lastState.undoCount === 1, JSON.stringify(lastState));

    // 撤销
    await t.send({ type: 'undo' });
    expect('撤销恢复文件', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'alpha\nbeta\n');
    expect('撤销后栈为空', t.tracker.undoCount === 0);
    server.close();
  }

  // ===== 场景 2：侧栏不可见 → 原生弹窗降级 =====
  {
    const { server } = createModelServer([
      { tool: 'write', args: { path: 'n.txt', content: 'x\n' } },
      { text: 'ok' }
    ]);
    const port = await listen(server);
    const t = setup(port, []);
    t.view.visible = false;
    nativeAnswer = '允许';
    nativeDialogs.length = 0;
    await t.provider.handleUserText('新建 n.txt');
    expect('不可见时没有向侧栏推送审批卡片', !types(t.posted).includes('approval'));
    expect('弹出原生审批弹窗', nativeDialogs.length === 1 && /n\.txt/.test(nativeDialogs[0]), nativeDialogs[0]);
    expect('原生弹窗允许后写入', fs.existsSync(path.join(ws, 'n.txt')));

    nativeAnswer = undefined; // 关闭弹窗 = 拒绝
    const { server: s2 } = createModelServer([
      { tool: 'write', args: { path: 'm.txt', content: 'x\n' } },
      { text: 'ok' }
    ]);
    const p2 = await listen(s2);
    const t2 = setup(p2, []);
    t2.view.visible = false;
    await t2.provider.handleUserText('新建 m.txt');
    expect('原生弹窗关闭视为拒绝', !fs.existsSync(path.join(ws, 'm.txt')));
    server.close();
    s2.close();
  }

  // ===== 场景 3：停止 =====
  {
    const { server } = createModelServer([
      { tool: 'write', args: { path: 'stop.txt', content: 'x' } },
      { text: 'never' }
    ]);
    const port = await listen(server);
    const decisions = [];
    const t = setup(port, decisions);
    // 让审批卡片不被自动响应：覆盖 postMessage，收到 approval 后改为发送 stop
    const origPost = t.view.webview.postMessage;
    t.view.webview.postMessage = async (msg) => {
      t.posted.push(msg);
      if (msg.type === 'approval') {
        setImmediate(() => t.send({ type: 'stop' }));
      }
      return true;
    };
    await t.provider.handleUserText('写 stop.txt');
    const done = t.posted.find((m) => m.type === 'approvalDone');
    expect('停止会结束等待中的审批并视为拒绝', done && done.decision === 'deny', JSON.stringify(done));
    expect('停止后未写入文件', !fs.existsSync(path.join(ws, 'stop.txt')));
    const end = t.posted.find((m) => m.type === 'assistantEnd');
    expect('停止后正常收尾', end && /已停止/.test(end.meta), end && end.meta);
    const lastState = [...t.posted].reverse().find((m) => m.type === 'state');
    expect('停止后 busy=false', lastState && lastState.busy === false);
    server.close();
  }

  // ===== 场景 4：未打开工作区 =====
  {
    const { server } = createModelServer([{ text: 'x' }]);
    const port = await listen(server);
    const t = setup(port, []);
    const saved = stub.workspace.workspaceFolders;
    stub.workspace.workspaceFolders = undefined;
    nativeDialogs.length = 0;
    await t.provider.handleUserText('hi');
    stub.workspace.workspaceFolders = saved;
    expect('无工作区时提示并不调用模型', !types(t.posted).includes('assistantStart'));
    server.close();
  }

  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('chat view tests passed');
}

main().catch((err) => {
  console.error('FATAL', err.stack || err.message);
  process.exit(1);
});
