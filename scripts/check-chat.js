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
  model: 'test-model',
  approvalMode: 'ask',
  includeProjectContext: false,
  commandTimeoutMs: 20000
};
const nativeDialogs = [];
const clipboard = [];
const opened = [];
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
    showQuickPick: async () => undefined,
    showTextDocument: async (doc, opts) =>
      opened.push({ file: doc.fileName, line: opts && opts.selection ? opts.selection.start.line : undefined })
  },
  env: { clipboard: { writeText: async (t) => clipboard.push(t) } },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws }, name: 'ws' }],
    textDocuments: [],
    getConfiguration: () => ({
      get: (k) => configValues[k],
      update: async (k, v) => {
        configValues[k] = v;
      }
    }),
    findFiles: async () => [],
    openTextDocument: async (uri) => ({ fileName: uri.fsPath, lineCount: 100 }),
    asRelativePath: (u) => path.relative(ws, u.fsPath || u).replace(/\\/g, '/'),
    fs: {
      readFile: async (u) => fs.readFileSync(u.fsPath),
      writeFile: async (u, buf) => fs.writeFileSync(u.fsPath, buf),
      delete: async (u) => fs.rmSync(u.fsPath, { force: true }),
      stat: async (u) => fs.statSync(u.fsPath)
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
    workspaceState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) },
    globalState: { get: (k) => state.get('g:' + k), update: async (k, v) => state.set('g:' + k, v) }
  };
  const output = { appendLine: () => undefined };
  const tracker = new ChangeTracker(context, output);
  const diffs = {
    show: async (r) => diffCalls.shown.push(r.id),
    close: async (id) => diffCalls.closed.push(id)
  };
  let apiKey = 'k';
  const secrets = {
    getApiKey: async () => apiKey || undefined,
    setApiKey: async (v) => {
      apiKey = v;
    },
    hasApiKey: async () => !!apiKey
  };
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
  return { provider, posted, view, diffCalls, tracker, secrets, send: (m) => provider.onMessage(m), getKey: () => apiKey };
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


  // ===== 场景 5：未配置模型服务 → 引导到设置页，不调用模型 =====
  {
    const saved = { baseUrl: configValues.baseUrl, model: configValues.model };
    configValues.baseUrl = '';
    configValues.model = '';
    const t = setup(0, []);
    configValues.baseUrl = '';
    await t.provider.pushState();
    const st = [...t.posted].reverse().find((m) => m.type === 'state');
    expect('未配置时 state.configured=false', st && st.configured === false, JSON.stringify(st));
    await t.provider.handleUserText('你好');
    expect(
      '未配置时发送消息会打开设置页',
      types(t.posted).includes('showSettings') && !types(t.posted).includes('assistantStart'),
      types(t.posted).join(',')
    );
    configValues.baseUrl = saved.baseUrl;
    configValues.model = saved.model;
  }

  // ===== 场景 6：设置页的读写、模型获取、连接测试、校验 =====
  {
    const { server, seen } = createModelServer([{ text: 'pong' }], { models: ['alpha-1', 'beta-2', 'text-embedding-x'] });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/v1`;
    const t = setup(port, []);
    configValues.baseUrl = '';
    configValues.model = '';
    await t.secrets.setApiKey('');

    // 侧栏尚未就绪时请求打开设置：等 ready 后才展示
    const early = setup(port, []);
    early.provider.view = undefined;
    await early.provider.openSettings();
    expect('侧栏就绪前请求设置：暂不推送', !types(early.posted).includes('showSettings'));
    early.provider.view = early.view;
    await early.send({ type: 'ready' });
    expect('ready 后补发 showSettings', types(early.posted).includes('showSettings'));

    configValues.baseUrl = '';
    configValues.model = '';
    t.posted.length = 0;
    await t.send({ type: 'settingsOpen' });
    let data = t.posted.find((m) => m.type === 'settingsData');
    expect('打开设置页返回当前值', data && data.values.baseUrl === '' && data.configured === false && data.hasKey === false, JSON.stringify(data));
    expect(
      '设置页数据里包含默认项',
      data.values.approvalMode === 'ask' && data.values.contextWindow === 128000 && data.values.maxOutputTokens === 8192,
      JSON.stringify(data.values)
    );

    // 从填写的地址获取模型（尚未保存也可以）
    await t.send({ type: 'fetchModels', baseUrl: base, apiKey: 'typed-key' });
    const models = t.posted.find((m) => m.type === 'models');
    expect('按填写的地址获取模型列表', models && models.ok && models.models.join() === 'alpha-1,beta-2', JSON.stringify(models));
    expect('获取模型时使用表单里输入的 Key', seen.listAuth === 'Bearer typed-key', seen.listAuth);

    await t.send({ type: 'testConnection', baseUrl: base, model: 'alpha-1', apiKey: 'typed-key' });
    const test = t.posted.find((m) => m.type === 'testResult');
    expect('测试连接成功', test && test.ok, JSON.stringify(test));

    // 校验：错误不落盘
    await t.send({ type: 'settingsSave', values: { baseUrl: 'ftp://bad', model: 'm', contextWindow: 128000, maxOutputTokens: 8192 } });
    let err = t.posted.find((m) => m.type === 'settingsError');
    expect('非法 API 地址被拒绝', err && err.field === 'baseUrl', JSON.stringify(err));
    t.posted.length = 0;
    await t.send({ type: 'settingsSave', values: { baseUrl: base, model: '', contextWindow: 128000, maxOutputTokens: 8192 } });
    err = t.posted.find((m) => m.type === 'settingsError');
    expect('填了地址但没选模型被拒绝', err && err.field === 'model', JSON.stringify(err));
    t.posted.length = 0;
    await t.send({ type: 'settingsSave', values: { baseUrl: base, model: 'alpha-1', contextWindow: 10, maxOutputTokens: 8192 } });
    err = t.posted.find((m) => m.type === 'settingsError');
    expect('上下文窗口越界被拒绝', err && err.field === 'contextWindow', JSON.stringify(err));
    expect('校验失败时没有写入配置', !configValues.baseUrl, configValues.baseUrl);

    // 保存
    t.posted.length = 0;
    await t.send({
      type: 'settingsSave',
      apiKey: 'secret-1234',
      values: {
        baseUrl: base + '/',
        model: 'beta-2',
        approvalMode: 'autoEdit',
        allowedCommands: 'npm test\n  dotnet build  \n\n',
        contextWindow: '64000',
        maxOutputTokens: '4096',
        autoContext: false,
        systemPromptExtra: '变量用 camelCase'
      }
    });
    expect('保存后推送 settingsSaved 且 configured=true', t.posted.some((m) => m.type === 'settingsSaved' && m.configured === true));
    expect('API 地址去掉末尾斜杠', configValues.baseUrl === base, configValues.baseUrl);
    expect('模型与审批模式写入', configValues.model === 'beta-2' && configValues.approvalMode === 'autoEdit');
    expect(
      '命令白名单按行拆分并去空',
      JSON.stringify(configValues.allowedCommands) === JSON.stringify(['npm test', 'dotnet build']),
      JSON.stringify(configValues.allowedCommands)
    );
    expect('数值写入', configValues.contextWindow === 64000 && configValues.maxOutputTokens === 4096 && configValues.autoContext === false);
    expect('API Key 写入 SecretStorage', t.getKey() === 'secret-1234');

    // 再次打开：Key 不会回传给前端
    t.posted.length = 0;
    await t.send({ type: 'settingsOpen' });
    data = t.posted.find((m) => m.type === 'settingsData');
    expect('再次打开时只告知「已保存 Key」', data.hasKey === true && !JSON.stringify(t.posted).includes('secret-1234'), JSON.stringify(data));
    expect(
      '再次打开时能读回保存的值',
      data.values.model === 'beta-2' && data.values.allowedCommands === 'npm test\ndotnet build' && data.configured === true
    );

    // 留空 Key = 不修改；清除
    await t.send({ type: 'settingsSave', apiKey: '', values: { baseUrl: base, model: 'beta-2', contextWindow: 64000, maxOutputTokens: 4096 } });
    expect('Key 留空保持不变', t.getKey() === 'secret-1234');
    await t.send({ type: 'settingsSave', clearKey: true, values: { baseUrl: base, model: 'beta-2', contextWindow: 64000, maxOutputTokens: 4096 } });
    expect('点击清除后删除已保存的 Key', !t.getKey());

    // 输入框下方的快速切换
    t.posted.length = 0;
    await t.send({ type: 'setModel', model: 'alpha-1' });
    await t.send({ type: 'setMode', mode: 'readOnly' });
    await t.send({ type: 'setMode', mode: 'evil' });
    expect('快速切换模型', configValues.model === 'alpha-1');
    expect('快速切换审批模式（非法值被忽略）', configValues.approvalMode === 'readOnly');
    const st = [...t.posted].reverse().find((m) => m.type === 'state');
    expect(
      '切换后推送最新状态',
      st && st.model === 'alpha-1' && st.mode === 'readOnly' && st.models.join() === 'alpha-1,beta-2',
      JSON.stringify(st)
    );
    server.close();
  }

  // ===== 场景 7：复制与打开文件引用 =====
  {
    const { server } = createModelServer([{ text: 'x' }]);
    const port = await listen(server);
    const t = setup(port, []);
    await t.send({ type: 'copy', text: 'const a = 1;' });
    expect('复制代码到剪贴板', clipboard[0] === 'const a = 1;');
    opened.length = 0;
    await t.send({ type: 'openFile', ref: 'a.txt:12' });
    expect(
      '点击「文件:行号」在编辑器中打开',
      opened.length === 1 && /a\.txt$/.test(opened[0].file) && opened[0].line === 11,
      JSON.stringify(opened)
    );
    opened.length = 0;
    await t.send({ type: 'openFile', ref: '../../etc/passwd:1' });
    expect('工作区外的引用不会被打开', opened.length === 0, JSON.stringify(opened));
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
