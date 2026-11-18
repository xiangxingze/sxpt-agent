/**
 * ChatController 集成自检：vscode 桩 + 真实 PiAgent + 假模型服务。
 * 验证界面消息协议的顺序与内容、审批往返（对话窗口 / 原生弹窗 / 侧栏按钮）、停止、
 * 修改汇总与撤销、原生设置菜单（QuickPick / InputBox）、侧栏树视图。
 */
require('./source-loader');
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

const DEFAULTS = { model: 'test-model', approvalMode: 'ask', includeProjectContext: false, commandTimeoutMs: 20000 };
const configValues = { ...DEFAULTS };
function resetConfig(port) {
  for (const k of Object.keys(configValues)) delete configValues[k];
  Object.assign(configValues, DEFAULTS);
  if (port) configValues.baseUrl = `http://127.0.0.1:${port}/v1`;
}

/** 原生界面的脚本化应答 */
const ui = {
  picks: [],
  inputs: [],
  shownPicks: [],
  shownInputs: [],
  validationErrors: [],
  infos: [],
  errors: [],
  commands: []
};
function resetUi() {
  for (const k of Object.keys(ui)) ui[k].length = 0;
}
const nativeDialogs = [];
const opened = [];
let nativeAnswer = undefined;

class Emitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => undefined };
    };
  }
  fire(value) {
    for (const fn of this.listeners) fn(value);
  }
  dispose() {}
}

const stub = {
  StatusBarAlignment: { Right: 2 },
  ConfigurationTarget: { Global: 1 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { Notification: 15 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  EventEmitter: Emitter,
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p }),
    parse: (v) => ({ scheme: v.split(':')[0], path: v.slice(v.indexOf(':') + 1) }),
    joinPath: (base, ...parts) => stub.Uri.file(path.join(base.fsPath || base.path, ...parts))
  },
  window: {
    activeTextEditor: undefined,
    activeTerminal: undefined,
    showInformationMessage: async (message) => {
      ui.infos.push(message);
      return undefined;
    },
    showErrorMessage: async (message) => {
      ui.errors.push(message);
      return undefined;
    },
    showWarningMessage: async (message) => {
      nativeDialogs.push(message);
      return nativeAnswer;
    },
    showQuickPick: async (items, opts) => {
      ui.shownPicks.push({ items, opts });
      const answer = ui.picks.shift();
      if (answer === undefined) return undefined;
      return items.find((i) => i.value === answer) || items.find((i) => i.id === answer);
    },
    showInputBox: async (opts) => {
      ui.shownInputs.push(opts);
      const value = ui.inputs.shift();
      if (value === undefined) return undefined;
      const error = opts.validateInput ? opts.validateInput(value) : undefined;
      if (error) {
        // 原生输入框在校验不通过时不允许提交
        ui.validationErrors.push(error);
        return undefined;
      }
      return value;
    },
    withProgress: async (_options, task) => task(),
    showTextDocument: async (doc, opts) =>
      opened.push({
        file: doc.fileName,
        content: doc.content,
        line: opts && opts.selection ? opts.selection.start.line : undefined,
        viewColumn: opts ? opts.viewColumn : undefined
      }),
    createTreeView: () => ({ description: undefined, badge: undefined, dispose() {} })
  },
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
    openTextDocument: async (arg) =>
      arg && arg.fsPath ? { fileName: arg.fsPath, lineCount: 100 } : { fileName: 'untitled', content: arg.content, lineCount: 1 },
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
  commands: {
    executeCommand: async (...args) => {
      ui.commands.push(args);
      return undefined;
    }
  }
};
stub.ThemeIcon.File = new stub.ThemeIcon('file');
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: stub };

const outDir = path.join(__dirname, '..', 'out');
const { ChatController } = require(path.join(outDir, 'chatController.js'));
const { ChangeTracker } = require(path.join(outDir, 'changeTracker.js'));
const { SessionTree } = require(path.join(outDir, 'ui', 'sessionTree.js'));
const { validateBaseUrlInput, validateContextWindowInput, validateMaxOutputInput } = require(path.join(outDir, 'settingsController.js'));
const { createModelServer, listen } = require('./fake-model');

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 组装一个控制器和一个假的对话界面。
 * options.decisions：界面对每次审批依次给出的决定；
 * options.onApproval：自定义「界面收到审批」时的行为（此时不再自动回应）。
 */
function setup(port, options) {
  const o = options || {};
  resetConfig(port);
  const posted = [];
  const reveals = [];
  const diffCalls = { shown: [], closed: [] };
  const statusAtApproval = [];
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
    show: async (r, column) => diffCalls.shown.push({ id: r.id, column }),
    close: async (id) => diffCalls.closed.push(id)
  };
  let apiKey = o.noKey ? '' : 'k';
  const secrets = {
    getApiKey: async () => apiKey || undefined,
    setApiKey: async (v) => {
      apiKey = v;
    },
    hasApiKey: async () => !!apiKey
  };
  const platform = { getContext: async () => undefined, lastErrorMessage: undefined, clear() {} };
  const statusBar = { show() {}, text: '', tooltip: '', backgroundColor: undefined };
  const controller = new ChatController(secrets, tracker, diffs, platform, output, statusBar, context);

  const decisions = o.decisions || [];
  const surface = {
    canApprove: true,
    post(msg) {
      posted.push(msg);
      if (msg.type === 'approval') {
        statusAtApproval.push(statusBar.text);
        if (o.onApproval) {
          o.onApproval(msg, t);
        } else if (surface.canApprove) {
          const decision = decisions.shift() || 'allow';
          setImmediate(() => controller.onMessage({ type: 'approvalResponse', id: msg.request.id, decision }));
        }
      }
    },
    reveal: async (preserveFocus) => {
      reveals.push(!!preserveFocus);
    },
    docColumn: () => 2
  };
  controller.attachSurface(surface);
  const observed = [];
  controller.addObserver((m) => observed.push(m));
  const t = {
    controller,
    surface,
    posted,
    observed,
    reveals,
    diffCalls,
    tracker,
    secrets,
    statusBar,
    statusAtApproval,
    context,
    send: (m) => controller.onMessage(m),
    getKey: () => apiKey
  };
  return t;
}

const types = (posted) => posted.map((m) => m.type);
const lastState = (posted) => [...posted].reverse().find((m) => m.type === 'state' && m.configured !== undefined);

async function main() {
  // ===== 场景 1：对话窗口可用，审批往返 =====
  {
    const { server } = createModelServer([
      { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] } },
      { tool: 'bash', args: { command: 'node -e "console.log(1)"' } },
      { text: '已修改完成' }
    ]);
    const port = await listen(server);
    const t = setup(port, { decisions: ['allow', 'deny'] });
    const tree = new SessionTree();
    tree.register(t.context);
    t.controller.addObserver((m) => tree.receive(m));

    expect('订阅时立即补发状态与历史', t.observed[0].type === 'state' && t.observed[0].configured === true && t.observed[1].type === 'history', types(t.observed).join());
    await t.controller.handleUserText('把 alpha 改成大写');

    const seq = types(t.posted);
    const idx = (type) => seq.indexOf(type);
    expect('推送了 user / assistantStart', idx('user') >= 0 && idx('assistantStart') > idx('user'), seq.join(','));
    expect('顺序：toolStart → approval → approvalDone → toolEnd', idx('toolStart') < idx('approval') && idx('approval') < idx('approvalDone') && idx('approvalDone') < idx('toolEnd'), seq.join(','));
    const approvals = t.posted.filter((m) => m.type === 'approval');
    expect('出现两次审批（edit + bash）', approvals.length === 2 && approvals[0].request.kind === 'edit' && approvals[1].request.kind === 'bash', JSON.stringify(approvals.map((a) => a.request.kind)));
    expect('edit 审批携带 Diff 统计与相对路径', approvals[0].request.canDiff === true && approvals[0].request.relPath === 'a.txt' && approvals[0].request.added === 1, JSON.stringify(approvals[0].request));
    const diff = approvals[0].request.diff || [];
    expect(
      'edit 审批携带精简的行级 Diff，不带文件全文',
      diff.some((d) => d.kind === 'del' && d.text === 'alpha') && diff.some((d) => d.kind === 'add' && d.text === 'ALPHA') && approvals[0].request.proposed === undefined && approvals[0].request.original === undefined,
      JSON.stringify(approvals[0].request)
    );
    expect('bash 审批携带命令且没有 Diff', /console\.log\(1\)/.test(approvals[1].request.command) && approvals[1].request.canDiff === false && approvals[1].request.diff === undefined);
    expect(
      'edit 审批时在对话窗口之外的编辑器列打开 Diff，决议后关闭',
      t.diffCalls.shown.length === 1 && t.diffCalls.shown[0].column === 2 && t.diffCalls.closed.length === 2,
      JSON.stringify(t.diffCalls)
    );
    expect('审批时把对话窗口带到前面但不抢焦点', t.reveals.length === 2 && t.reveals.every((p) => p === true), JSON.stringify(t.reveals));
    expect('等待审批时状态栏有提示', t.statusAtApproval.every((s) => /等待确认/.test(s)) && !/等待确认/.test(t.statusBar.text), JSON.stringify(t.statusAtApproval));
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
    const st = lastState(t.posted);
    expect('结束后 busy=false 且显示可回退次数', st && st.busy === false && st.undoCount === 1, JSON.stringify(st));
    expect(
      '侧栏订阅者收到与对话窗口相同的消息',
      types(t.observed.slice(2)).join() === types(t.posted).join(),
      `${types(t.observed.slice(2)).join()}\n${types(t.posted).join()}`
    );

    // 侧栏树视图：一轮对话 → 工具步骤、回答、改动文件
    const roots = tree.getChildren();
    const turn = roots[0];
    const children = turn ? tree.getChildren(turn) : [];
    expect('树视图：根节点是这一轮对话', roots.length === 1 && turn.kind === 'turn' && tree.getTreeItem(turn).label === '把 alpha 改成大写', JSON.stringify(roots.map((r) => r.kind)));
    expect(
      '树视图：工具步骤 / 回答 / 改动文件',
      children.map((c) => c.kind).join() === 'step,step,reply,file' && children[0].state === 'ok' && children[1].state === 'fail',
      JSON.stringify(children.map((c) => [c.kind, c.state]))
    );
    const replyItem = tree.getTreeItem(children[2]);
    expect('树视图：点击回答在编辑器中打开', replyItem.command.command === 'ptnAgent.openReply' && replyItem.command.arguments[0].turn.reply.includes('已修改完成'));
    expect('树视图：改动文件可点击打开', tree.getTreeItem(children[3]).command.command === 'vscode.open' && tree.getTreeItem(children[3]).label === 'a.txt');
    expect('树视图：审批结束后没有待确认节点', !roots.some((r) => r.kind === 'approval'));

    // 撤销
    await t.send({ type: 'undo' });
    expect('撤销恢复文件', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'alpha\nbeta\n');
    expect('撤销后栈为空', t.tracker.undoCount === 0);

    // 新建对话
    await t.send({ type: 'newSession' });
    expect('新建对话推送 cleared 并清空树', types(t.posted).includes('cleared') && tree.getChildren().length === 0);
    server.close();
  }

  // ===== 场景 2：对话窗口不可用 → 原生弹窗降级 =====
  {
    const { server } = createModelServer([
      { tool: 'write', args: { path: 'n.txt', content: 'x\n' } },
      { text: 'ok' }
    ]);
    const port = await listen(server);
    const t = setup(port);
    t.surface.canApprove = false;
    nativeAnswer = '允许';
    nativeDialogs.length = 0;
    await t.controller.handleUserText('新建 n.txt');
    expect('弹出原生审批弹窗', nativeDialogs.length === 1 && /n\.txt/.test(nativeDialogs[0]), nativeDialogs[0]);
    expect('侧栏仍然能看到这条待确认的操作', t.observed.some((m) => m.type === 'approval') && t.observed.some((m) => m.type === 'approvalDone'));
    expect('原生弹窗允许后写入', fs.existsSync(path.join(ws, 'n.txt')));
    expect('原生弹窗同样打开 Diff', t.diffCalls.shown.length === 1);

    nativeAnswer = undefined; // 关闭弹窗 = 拒绝
    const { server: s2 } = createModelServer([
      { tool: 'write', args: { path: 'm.txt', content: 'x\n' } },
      { text: 'ok' }
    ]);
    const p2 = await listen(s2);
    const t2 = setup(p2);
    t2.surface.canApprove = false;
    await t2.controller.handleUserText('新建 m.txt');
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
    const t = setup(port, { onApproval: (_msg, self) => setImmediate(() => self.send({ type: 'stop' })) });
    await t.controller.handleUserText('写 stop.txt');
    const done = t.posted.find((m) => m.type === 'approvalDone');
    expect('停止会结束等待中的审批并视为拒绝', done && done.decision === 'deny', JSON.stringify(done));
    expect('停止后未写入文件', !fs.existsSync(path.join(ws, 'stop.txt')));
    const end = t.posted.find((m) => m.type === 'assistantEnd');
    expect('停止后正常收尾', end && /已停止/.test(end.meta), end && end.meta);
    const st = lastState(t.posted);
    expect('停止后 busy=false', st && st.busy === false);
    server.close();
  }

  // ===== 场景 4：等待审批时的其他入口 =====
  {
    // 4a 对话窗口被关闭 → 改用原生弹窗
    const steps = (file) => [{ tool: 'write', args: { path: file, content: 'x\n' } }, { text: 'ok' }];
    let { server } = createModelServer(steps('closed.txt'));
    let port = await listen(server);
    nativeAnswer = '允许';
    nativeDialogs.length = 0;
    let t = setup(port, {
      onApproval: (_msg, self) =>
        setImmediate(() => {
          self.surface.canApprove = false;
          void self.send({ type: 'closed' });
        })
    });
    await t.controller.handleUserText('写 closed.txt');
    expect('对话窗口关闭后，等待中的审批改用原生弹窗', nativeDialogs.length === 1 && fs.existsSync(path.join(ws, 'closed.txt')), JSON.stringify(nativeDialogs));
    server.close();
    nativeAnswer = undefined;

    // 4b 侧栏树上的「查看修改」「允许」按钮
    ({ server } = createModelServer(steps('tree.txt')));
    port = await listen(server);
    t = setup(port, {
      onApproval: (msg, self) =>
        setImmediate(async () => {
          await self.controller.openDiff(msg.request.id);
          self.controller.resolveApproval(undefined, 'allow');
        })
    });
    await t.controller.handleUserText('写 tree.txt');
    expect('侧栏按钮：重新打开 Diff', t.diffCalls.shown.length === 2 && t.diffCalls.shown[1].column === 2, JSON.stringify(t.diffCalls.shown));
    expect('侧栏按钮：允许后写入', fs.existsSync(path.join(ws, 'tree.txt')));
    server.close();

    // 4c 对话窗口在等待审批时才打开（ready）→ 同步回送状态、历史，并补发审批
    ({ server } = createModelServer(steps('late.txt')));
    port = await listen(server);
    let first = true;
    let afterReady = [];
    t = setup(port, {
      onApproval: (_msg, self) => {
        if (!first) return;
        first = false;
        setImmediate(() => {
          self.posted.length = 0;
          const pending = self.send({ type: 'ready' });
          afterReady = types(self.posted); // ready 的回送必须是同步的
          void pending.then(() => self.controller.resolveApproval(undefined, 'deny'));
        });
      }
    });
    await t.controller.handleUserText('写 late.txt');
    expect('ready 补回历史、运行中步骤和等待中的审批', afterReady[0] === 'state' && afterReady[1] === 'history' && afterReady.includes('toolStart') && afterReady.includes('approval'), afterReady.join());
    expect('侧栏按钮：拒绝后不写入', !fs.existsSync(path.join(ws, 'late.txt')));
    server.close();

    // 4d 运行中不能撤销
    ({ server } = createModelServer(steps('busy.txt')));
    port = await listen(server);
    resetUi();
    t = setup(port, {
      onApproval: (_msg, self) =>
        setImmediate(async () => {
          await self.controller.undo();
          await self.controller.ask();
          self.controller.resolveApproval(undefined, 'deny');
        })
    });
    await t.controller.handleUserText('写 busy.txt');
    expect('任务运行中拒绝撤销和新任务', ui.infos.filter((m) => /正在运行/.test(m)).length === 2 && ui.shownInputs.length === 0, JSON.stringify(ui.infos));
    server.close();
  }

  // ===== 场景 5：未打开工作区 =====
  {
    const { server } = createModelServer([{ text: 'x' }]);
    const port = await listen(server);
    const t = setup(port);
    const saved = stub.workspace.workspaceFolders;
    stub.workspace.workspaceFolders = undefined;
    nativeDialogs.length = 0;
    await t.controller.handleUserText('hi');
    stub.workspace.workspaceFolders = saved;
    expect('无工作区时提示并不调用模型', nativeDialogs.length === 1 && !types(t.posted).includes('assistantStart'));
    server.close();
  }

  // ===== 场景 6：未配置模型服务 → 原生引导，不调用模型 =====
  {
    const t = setup(0);
    t.surface.showSettings = () => { throw new Error('设置不能通过聊天界面分流'); };
    configValues.baseUrl = '';
    configValues.model = '';
    resetUi();
    await t.controller.pushState();
    const st = lastState(t.posted);
    expect('未配置时 state.configured=false', st && st.configured === false, JSON.stringify(st));
    expect('未配置时状态栏提示', /未配置模型/.test(t.statusBar.text), t.statusBar.text);
    await t.controller.handleUserText('你好');
    expect(
      '未配置时发送消息会打开原生引导（第一步：API 地址）',
      ui.shownInputs.length === 1 && /连接模型服务（1\/3）/.test(ui.shownInputs[0].title) && !types(t.posted).includes('assistantStart'),
      JSON.stringify(ui.shownInputs.map((i) => i.title))
    );
    resetUi();
    await t.send({ type: 'openSettings' });
    expect('设置消息直接打开原生引导，不调用界面的 showSettings', ui.shownInputs.length === 1 && /连接模型服务/.test(ui.shownInputs[0].title));
  }

  // ===== 场景 7：原生设置（QuickPick / InputBox） =====
  {
    const { server, seen } = createModelServer([{ text: 'pong' }], { models: ['alpha-1', 'beta-2', 'text-embedding-x'] });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/v1`;
    const t = setup(port, { noKey: true });
    t.surface.showSettings = () => { throw new Error('设置不能通过聊天界面分流'); };
    configValues.baseUrl = '';
    configValues.model = '';

    expect('校验函数：API 地址', validateBaseUrlInput('ftp://bad') !== undefined && validateBaseUrlInput('http://10.0.0.8:8000/v1') === undefined && validateBaseUrlInput('') === undefined);
    expect('校验函数：上下文窗口', validateContextWindowInput('10') !== undefined && validateContextWindowInput('abc') !== undefined && validateContextWindowInput('64000') === undefined);
    expect('校验函数：最大输出', validateMaxOutputInput('100') !== undefined && validateMaxOutputInput('') !== undefined && validateMaxOutputInput('4096') === undefined);

    // 首次引导：地址 → Key → 模型 → 测试连接
    resetUi();
    ui.inputs.push('ftp://bad');
    await t.controller.openSettings();
    expect('引导：非法 API 地址不能提交、不落盘', ui.validationErrors.length === 1 && !configValues.baseUrl, JSON.stringify(ui.validationErrors));

    resetUi();
    t.reveals.length = 0;
    ui.inputs.push(base + '/', 'secret-1234');
    ui.picks.push('beta-2');
    await t.controller.openSettings();
    expect('引导：API 地址去掉末尾斜杠', configValues.baseUrl === base, configValues.baseUrl);
    expect('引导：API Key 写入 SecretStorage，输入框为密码框', t.getKey() === 'secret-1234' && ui.shownInputs[1].password === true && ui.shownInputs[1].value === undefined);
    expect('引导：用刚填的 Key 获取模型列表', seen.listAuth === 'Bearer secret-1234', seen.listAuth);
    const modelItems = ui.shownPicks[0].items.filter((i) => i.id === 'model').map((i) => i.value);
    expect('引导：模型列表来自接口（过滤掉非对话模型）', modelItems.join() === 'alpha-1,beta-2', modelItems.join());
    expect('引导：没有任何预设供应商', !/deepseek|ollama|qwen|moonshot|api\.openai\.com|localhost:11434/i.test(JSON.stringify(ui.shownPicks) + JSON.stringify(ui.shownInputs.map((i) => [i.title, i.prompt, i.placeHolder]))));
    expect('引导：选择的模型写入配置', configValues.model === 'beta-2', configValues.model);
    expect('引导：最后测试连接并提示成功', ui.infos.some((m) => /可以开始对话了/.test(m)), JSON.stringify(ui.infos) + JSON.stringify(ui.errors));
    expect('引导完成后打开对话窗口', t.reveals.length === 1 && t.reveals[0] === false, JSON.stringify(t.reveals));
    const st1 = lastState(t.posted);
    expect('引导完成后推送 configured=true 与模型列表', st1 && st1.configured === true && st1.model === 'beta-2' && st1.models.join() === 'alpha-1,beta-2', JSON.stringify(st1));

    // 设置菜单
    const menu = async (picks, inputs) => {
      resetUi();
      ui.picks.push(...picks);
      ui.inputs.push(...(inputs || []));
      await t.controller.openSettings();
    };
    await menu([]);
    const items = ui.shownPicks[0].items;
    const byId = (id) => items.find((i) => i.id === id);
    expect('设置菜单：分组与当前值', items.filter((i) => i.kind === -1).map((i) => i.label).join() === '模型服务,Agent 行为,高级' && byId('baseUrl').description === base && byId('model').description === 'beta-2');
    expect('设置菜单：Key 只显示「已保存」', byId('apiKey').description === '已保存');
    expect('设置菜单：学生界面没有平台配置入口', !/platform|平台/i.test(JSON.stringify(items)));

    await menu(['mode', 'readOnly', undefined]);
    expect('设置菜单：切换审批模式', configValues.approvalMode === 'readOnly' && ui.shownPicks.length === 3);
    await t.controller.settings.setMode('evil');
    expect('非法的审批模式被忽略', configValues.approvalMode === 'readOnly');

    await menu(['allowed', 'add', undefined, undefined], ['npm test']);
    expect('设置菜单：添加免确认命令', JSON.stringify(configValues.allowedCommands) === '["npm test"]', JSON.stringify(configValues.allowedCommands));
    await menu(['allowed', 'add', undefined, undefined], ['npm test && rm -rf /']);
    expect('设置菜单：命令前缀里不能有 shell 元字符', ui.validationErrors.length === 1 && JSON.stringify(configValues.allowedCommands) === '["npm test"]');
    await menu(['allowed', 'npm test', undefined, undefined]);
    expect('设置菜单：选中已有前缀即删除', JSON.stringify(configValues.allowedCommands) === '[]', JSON.stringify(configValues.allowedCommands));

    await menu(['contextWindow', undefined], ['64000']);
    expect('设置菜单：上下文窗口写入为数值', configValues.contextWindow === 64000);
    await menu(['contextWindow', undefined], ['10']);
    expect('设置菜单：上下文窗口越界不落盘', configValues.contextWindow === 64000 && ui.validationErrors.length === 1);
    await menu(['maxOutput', undefined], ['4096']);
    expect('设置菜单：最大输出', configValues.maxOutputTokens === 4096);
    await menu(['autoContext', undefined]);
    expect('设置菜单：开关自动上下文', configValues.autoContext === false);
    await menu(['extra']);
    expect(
      '设置菜单：自定义指令转到设置编辑器',
      ui.commands.some((c) => c[0] === 'workbench.action.openSettings' && c[1] === 'ptnAgent.systemPromptExtra'),
      JSON.stringify(ui.commands)
    );

    // API Key：保留 / 清除 / 重新输入；任何界面都不回显 Key
    await menu(['apiKey', 'keep', undefined]);
    expect('API Key：保留', t.getKey() === 'secret-1234');
    await menu(['apiKey', 'new', undefined], ['secret-5678']);
    expect('API Key：输入新的', t.getKey() === 'secret-5678');
    const shown =
      JSON.stringify(ui.shownPicks) + JSON.stringify(ui.shownInputs.map((i) => ({ ...i, validateInput: undefined }))) + JSON.stringify(t.posted) + JSON.stringify(t.observed);
    expect('Key 不会出现在任何菜单、输入框默认值或界面消息里', !/secret-/.test(shown));
    await menu(['apiKey', 'clear', undefined]);
    expect('API Key：清除', !t.getKey() && ui.infos.some((m) => /已清除/.test(m)));
    await menu([]);
    expect('清除后菜单显示未填写', /未填写/.test(ui.shownPicks[0].items.find((i) => i.id === 'apiKey').description));

    // 模型：手动输入、重新获取
    resetUi();
    ui.picks.push('manual');
    ui.inputs.push('  custom-x ');
    await t.controller.pickModel();
    expect('模型：手动输入', configValues.model === 'custom-x', configValues.model);
    resetUi();
    const callsBefore = seen.listCalls;
    ui.picks.push('refresh', 'alpha-1');
    await t.controller.pickModel();
    expect('模型：重新获取列表后选择', seen.listCalls === callsBefore + 1 && configValues.model === 'alpha-1', `${seen.listCalls} ${configValues.model}`);
    expect('模型：列表里保留手动输入的当前模型', ui.shownPicks[0].items.some((i) => i.value === 'custom-x' && /手动输入/.test(i.description)));
    resetUi();
    await t.controller.pickModel();
    expect('模型：10 分钟内使用缓存，不重复请求', seen.listCalls === callsBefore + 1 && ui.shownPicks[0].items.some((i) => i.value === 'beta-2'));
    server.close();

    // 接口不提供模型列表：提示并允许手动输入
    const { server: s2 } = createModelServer([{ text: 'pong' }]);
    const p2 = await listen(s2);
    configValues.baseUrl = `http://127.0.0.1:${p2}/v1`;
    resetUi();
    ui.picks.push('manual');
    ui.inputs.push('local-model');
    await t.controller.pickModel();
    expect(
      '接口没有模型列表时提示并可手动输入',
      configValues.model === 'local-model' && /手动输入/.test(ui.shownPicks[0].opts.placeHolder) && !ui.shownPicks[0].items.some((i) => i.id === 'model' && i.value !== 'alpha-1'),
      JSON.stringify(ui.shownPicks[0].opts)
    );
    s2.close();
  }

  // ===== 场景 8：打开文件引用、在编辑器中查看回答、输入框发起任务 =====
  {
    const { server } = createModelServer([{ text: '好的' }]);
    const port = await listen(server);
    const t = setup(port);
    opened.length = 0;
    await t.send({ type: 'openFile', ref: 'a.txt:12' });
    expect(
      '点击「文件:行号」在对话窗口之外的编辑器列打开',
      opened.length === 1 && /a\.txt$/.test(opened[0].file) && opened[0].line === 11 && opened[0].viewColumn === 2,
      JSON.stringify(opened)
    );
    opened.length = 0;
    await t.send({ type: 'openFile', ref: '../../etc/passwd:1' });
    expect('工作区外的引用不会被打开', opened.length === 0, JSON.stringify(opened));
    await t.controller.openReply('# 回答\n内容');
    expect('回答可作为 Markdown 文档打开', opened.length === 1 && opened[0].content === '# 回答\n内容' && opened[0].viewColumn === 2, JSON.stringify(opened));

    resetUi();
    ui.inputs.push('  你好  ');
    await t.controller.ask();
    expect('原生输入框发起任务', t.posted.some((m) => m.type === 'user' && m.text === '你好') && t.posted.some((m) => m.type === 'assistantEnd'), types(t.posted).join());
    const history = t.posted.length;
    t.posted.length = 0;
    await t.send({ type: 'ready' });
    const h = t.posted.find((m) => m.type === 'history');
    expect('ready 时回送历史对话', h && h.messages.length === 2 && h.messages[0].content === '你好' && h.messages[1].role === 'assistant' && history > 0, JSON.stringify(h));
    server.close();
  }

  // ===== 场景 9：侧栏树视图的节点与状态 =====
  {
    resetUi();
    const tree = new SessionTree();
    const context = { subscriptions: [] };
    tree.register(context);
    const view = context.subscriptions[0];
    expect('会话为空时返回空列表（显示原生欢迎页）', tree.getChildren().length === 0);
    tree.receive({ type: 'state', configured: true, model: 'm1', mode: 'autoEdit', busy: false });
    tree.receive({ type: 'history', messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }] });
    tree.receive({ type: 'user', text: '# 新问题\n第二行' });
    tree.receive({ type: 'state', busy: true });
    tree.receive({ type: 'toolStart', id: 't1', name: 'edit', label: '修改 a.txt' });
    tree.receive({ type: 'toolStart', id: 'tp', name: 'update_plan', label: '更新计划' });
    tree.receive({ type: 'plan', steps: [{ step: '读代码', status: 'completed' }, { step: '改文件', status: 'in_progress' }] });
    tree.receive({ type: 'approval', request: { id: 'p1', kind: 'edit', title: '修改 a.txt', added: 2, removed: 1 } });
    tree.receive({ type: 'approval', request: { id: 'p2', kind: 'bash', title: '运行命令', command: 'npm test' } });

    let roots = tree.getChildren();
    expect('根节点顺序：待确认 → 计划 → 最新对话 → 更早的对话', roots.map((r) => r.kind).join() === 'approval,approval,plan,turn,turn' && roots[3].prompt.includes('新问题') && roots[4].prompt === '旧问题', roots.map((r) => r.kind).join());
    const a1 = tree.getTreeItem(roots[0]);
    const a2 = tree.getTreeItem(roots[1]);
    expect('待确认节点带内联按钮所需的 contextValue', a1.contextValue === 'approvalEdit' && a2.contextValue === 'approvalCommand' && /\+2 −1/.test(a1.description) && /npm test/.test(a2.description), `${a1.contextValue} ${a2.contextValue} ${a1.description}`);
    const planItem = tree.getTreeItem(roots[2]);
    expect('计划节点显示进度', planItem.description === '1/2' && tree.getChildren(roots[2]).length === 2);
    const turnItem = tree.getTreeItem(roots[3]);
    expect('对话节点：标题取首行并去掉 Markdown 标记', turnItem.label === '新问题' && turnItem.description === '进行中…' && turnItem.collapsibleState === 2, JSON.stringify(turnItem));
    expect('更早的对话默认折叠，回答可展开', tree.getTreeItem(roots[4]).collapsibleState === 1 && tree.getChildren(roots[4])[0].kind === 'reply');
    expect('update_plan 不作为步骤显示', tree.getChildren(roots[3]).length === 1 && tree.getChildren(roots[3])[0].label === '修改 a.txt');

    await sleep(250);
    expect('视图标题显示模型与模式，徽标为待确认数量', view.description === 'm1 · 自动应用修改' && view.badge && view.badge.value === 2, `${view.description} ${JSON.stringify(view.badge)}`);
    expect(
      '设置了欢迎页 / 标题栏按钮用到的上下文键',
      ui.commands.some((c) => c[0] === 'setContext' && c[1] === 'ptnAgent.configured' && c[2] === true) && ui.commands.some((c) => c[0] === 'setContext' && c[1] === 'ptnAgent.busy' && c[2] === true),
      JSON.stringify(ui.commands)
    );

    tree.receive({ type: 'approvalDone', id: 'p1', decision: 'allow' });
    tree.receive({ type: 'approvalDone', id: 'p2', decision: 'deny' });
    tree.receive({ type: 'toolEnd', id: 't1', name: 'edit', ok: true, summary: '+2 −1' });
    tree.receive({ type: 'textDelta', text: '改好了。' });
    tree.receive({ type: 'error', message: '连接中断' });
    tree.receive({ type: 'assistantEnd', id: 'a1', meta: 'm1 · 2.0s' });
    tree.receive({ type: 'changes', files: ['a.txt'] });
    tree.receive({ type: 'state', busy: false });
    roots = tree.getChildren();
    const kids = tree.getChildren(roots[1]);
    expect('结束后：步骤带摘要、回答、错误、改动文件', roots[0].kind === 'plan' && kids.map((k) => k.kind).join() === 'step,reply,error,file' && tree.getTreeItem(kids[0]).description === '+2 −1', kids.map((k) => k.kind).join());
    expect('结束后对话节点显示统计信息', tree.getTreeItem(roots[1]).description === 'm1 · 2.0s');
    await sleep(250);
    expect('审批结束后徽标清除', view.badge === undefined);
    tree.receive({ type: 'cleared' });
    expect('新建对话后清空', tree.getChildren().length === 0);
  }

  {
    resetUi();
    const { server } = createModelServer([{ text: '历史中的回答' }]);
    const port = await listen(server);
    const t = setup(port);
    await t.controller.openHistory();
    expect('没有历史会话时使用原生提示', ui.infos.some((message) => /还没有历史会话/.test(message)));
    await t.controller.handleUserText('第一条会话的问题');
    await t.send({ type: 'listSessions' });
    const firstId = t.posted.at(-1).activeId;
    await t.send({ type: 'newSession', draft: '第一条的未发送草稿' });
    await t.controller.handleUserText('第二条会话的问题');
    await t.send({ type: 'selectSession', id: firstId, draft: '第二条的草稿' });
    const restored = [...t.posted].reverse().find((message) => message.type === 'history');
    expect('真实会话切换恢复消息和草稿', restored.messages[0].content === '第一条会话的问题' && restored.draft === '第一条的未发送草稿');
    resetUi();
    let draft = '原生终端未发送的内容';
    t.surface.draft = () => draft;
    const currentId = restored.sessionId;
    const beforeCancel = t.posted.length;
    await t.controller.openHistory();
    expect('原生历史选择器可取消且不切换当前会话', ui.shownPicks.at(-1).opts.title === '历史会话' && ui.shownPicks.at(-1).items.some((item) => item.id === currentId) && !t.posted.slice(beforeCancel).some((message) => message.type === 'history'));
    await t.controller.newSession();
    const empty = [...t.posted].reverse().find((message) => message.type === 'history');
    expect('原生新建会话保留旧会话草稿', empty.sessionId !== currentId && empty.messages.length === 0);
    draft = '';
    ui.picks.push(currentId);
    await t.send({ type: 'openHistory' });
    const picked = [...t.posted].reverse().find((message) => message.type === 'history');
    expect('原生 QuickPick 选择后恢复会话与终端草稿', picked.sessionId === currentId && picked.draft === '原生终端未发送的内容');
    server.close(); t.controller.dispose();
  }
  {
    const { server } = createModelServer([
      { tool: 'write', args: { path: 'switching.txt', content: 'must not be written' } },
      { text: '已停止' }
    ]);
    const port = await listen(server);
    let transition;
    const t = setup(port, { onApproval: (_message, self) => { transition = self.send({ type: 'newSession', draft: '旧任务草稿' }); } });
    await t.controller.handleUserText('运行中切换会话');
    await transition;
    await t.send({ type: 'listSessions' });
    const history = t.posted.at(-1);
    expect('新建会话先收尾旧任务且不会执行待审批写入', !fs.existsSync(path.join(ws, 'switching.txt')) && t.controller.sessionMessageCount === 0);
    await t.send({ type: 'selectSession', id: history.sessions[0].id });
    const restored = [...t.posted].reverse().find((message) => message.type === 'history');
    expect('被停止的旧任务仍保存在原会话', restored.messages[0].content === '运行中切换会话' && restored.messages.length === 2);
    server.close(); t.controller.dispose();
  }
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(storage, { recursive: true, force: true });
  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('chat controller tests passed');
}

main().catch((err) => {
  console.error('FATAL', err.stack || err.message);
  process.exit(1);
});
