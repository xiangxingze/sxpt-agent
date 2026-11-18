if (!process.argv.includes('--runtime')) require('./source-loader');
const Module = require('module');
const path = require('path');
const manifest = require('../package.json');

const disposables = [];
const commands = new Map();
const channels = [];
const treeViews = [];
const terminals = [];
const linkProviders = [];
const webviews = [];
const chatParticipants = [];
const executedCommands = [];
const settingsInputs = [];
const settingsMenus = [];
const configuration = {};

function disposable(fn) {
  return { dispose: fn || (() => {}) };
}

const stub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TerminalLocation: { Panel: 1, Editor: 2 },
  TextEditorRevealType: { Default: 0, InCenter: 1 },
  TabInputTerminal: class {},
  TabInputTextDiff: class {},
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
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Selection: class {
    constructor(anchor, active) {
      this.anchor = anchor;
      this.active = active;
    }
  },
  Uri: {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p, toString: () => 'file://' + p }),
    parse: (v) => ({ scheme: v.split(':')[0], path: v.slice(v.indexOf(':') + 1), toString: () => v }),
    joinPath: (base, ...parts) => stub.Uri.file(path.join(base.fsPath || base.path, ...parts))
  },
  window: {
    registerWebviewViewProvider: (id, provider, options) => { webviews.push({ id, provider, options }); return disposable(); },
    createOutputChannel: (name) => {
      const ch = { appendLine: () => {}, show: () => {}, dispose: () => {}, name };
      channels.push(ch);
      return ch;
    },
    createStatusBarItem: () => ({
      show: () => {},
      hide: () => {},
      dispose: () => {},
      text: '',
      tooltip: '',
      command: ''
    }),
    createTreeView: (id, options) => {
      const declaration = Object.values(manifest.contributes.views).flat().find((view) => view.id === id);
      if (!declaration || declaration.type === 'webview') throw new Error('No view is registered with id: ' + id);
      treeViews.push({ id, options });
      return { description: undefined, badge: undefined, onDidChangeVisibility: () => disposable(), dispose: () => {} };
    },
    createTerminal: (options) => {
      const terminal = {
        name: options.name,
        options,
        shown: 0,
        show: () => {
          terminal.shown++;
        },
        dispose: () => {}
      };
      terminals.push(terminal);
      return terminal;
    },
    registerTerminalLinkProvider: (provider) => {
      linkProviders.push(provider);
      return disposable();
    },
    onDidChangeActiveTerminal: () => disposable(),
    onDidCloseTerminal: () => disposable(),
    tabGroups: { all: [] },
    visibleTextEditors: [],
    showTextDocument: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async (options) => { settingsInputs.push(options); return undefined; },
    showQuickPick: async (items, options) => { settingsMenus.push({ items, options }); return undefined; },
    withProgress: async (_o, task) => task(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    activeTextEditor: undefined,
    activeTerminal: undefined
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => configuration[key] ?? fallback,
      update: async () => {}
    }),
    registerTextDocumentContentProvider: () => disposable(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeConfiguration: () => disposable(),
    textDocuments: [],
    findFiles: async () => [],
    workspaceFolders: [],
    asRelativePath: (p) => p,
    openTextDocument: async () => ({ getText: () => '', lineCount: 1, lineAt: () => ({ text: '' }), positionAt: () => ({}) }),
    applyEdit: async () => true,
    fs: { writeFile: async () => {} }
  },
  commands: {
    registerCommand: (id, handler) => {
      commands.set(id, handler);
      return disposable();
    },
    executeCommand: async (...args) => {
      executedCommands.push(args);
      if (commands.has(args[0])) return commands.get(args[0])(...args.slice(1));
      return undefined;
    }
  },
  chat: {
    createChatParticipant: (id, handler) => {
      const participant = { id, handler, dispose: () => {} };
      chatParticipants.push(participant);
      return participant;
    }
  },
  extensions: { getExtension: () => undefined },
  languages: { getDiagnostics: () => [] },
  Range: class {
    constructor(a, b, c, d) {
      Object.assign(this, { startLine: a, startChar: b, endLine: c, endChar: d });
    }
  },
  WorkspaceEdit: class {
    replace() {}
  },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class {
    constructor() {
      this.listeners = [];
      this.event = (fn) => {
        this.listeners.push(fn);
        return disposable();
      };
    }
    fire(value) {
      for (const fn of this.listeners) fn(value);
    }
    dispose() {}
  }
};
stub.ThemeIcon.File = new stub.ThemeIcon('file');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return 'vscode-stub';
  }
  return origResolve.call(this, request, ...args);
};

require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: stub
};

const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));

const fakeContext = {
  subscriptions: [],
  extensionUri: stub.Uri.file(path.join(__dirname, '..')),
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  workspaceState: { get: () => undefined, update: async () => {} },
  globalState: { get: () => undefined, update: async () => {} }
};

async function main() {
  ext.activate(fakeContext);
  console.log('activate ok, registered commands:', commands.size);
  console.log([...commands.keys()].join('\n'));
  const expected = [
    'ptnAgent.openChat',
    'ptnAgent.ask',
    'ptnAgent.stop',
    'ptnAgent.newSession',
    'ptnAgent.pickModel',
    'ptnAgent.approval.allow',
    'ptnAgent.approval.deny',
    'ptnAgent.approval.diff',
    'ptnAgent.openReply',
    'ptnAgent.explainSelection',
    'ptnAgent.settings',
    'ptnAgent.showContext',
    'ptnAgent.undoLastPatch',
    'ptnAgent.fixProblems',
    'ptnAgent.pickMode',
    'ptnAgent.checkPi',
    'ptnAgent.runTests',
    'ptnAgent.runCommand',
    'ptnAgent.showProjectOutline',
    'ptnAgent.gotoProblem'
  ];
  // package.json 声明的每个命令都必须已注册，否则命令面板里点了没反应
  const declared = require(path.join(__dirname, '..', 'package.json')).contributes.commands.map((c) => c.command);
  const undeclaredButMissing = declared.filter((c) => !commands.has(c));
  if (undeclaredButMissing.length) {
    console.error('DECLARED BUT NOT REGISTERED:', undeclaredButMissing.join(', '));
    process.exitCode = 1;
  }
  const missing = expected.filter((c) => !commands.has(c));
  if (missing.length) {
    console.error('MISSING COMMANDS:', missing.join(', '));
    process.exitCode = 1;
  }

  // 对照真实清单校验树视图类型，防止清单与运行注册方式不一致。
  const check = (name, cond) => {
    if (!cond) {
      console.error('FAIL ' + name);
      process.exitCode = 1;
    }
  };
  check('分别注册完整聊天与原生兼容视图', treeViews.length === 1 && treeViews[0].id === 'ptnAgent.nativeSessionView' && webviews.length === 1 && webviews[0].id === 'ptnAgent.sessionView');
  const navigation = manifest.contributes.menus['view/title'].filter((item) => item.group.startsWith('navigation') && !item.when.includes('ptnAgent.busy'));
  const sidebarNavigation = navigation.filter((item) => item.when.includes('view == ptnAgent.sessionView'));
  check('侧栏常驻操作只有新建、历史、设置', sidebarNavigation.map((item) => item.command).join() === 'ptnAgent.newSession,ptnAgent.history,ptnAgent.settings');
  check('清单与 Webview 注册方式一致', manifest.contributes.views.ptnAgent[0].type === 'webview');
  check('不再注册宿主 Chat 参与者', chatParticipants.length === 0 && !manifest.contributes.chatParticipants);
  const titleButtons = manifest.contributes.menus['view/title'] || [];
  check(
    'Agent 面板标题栏有输入、新建、历史、设置',
    titleButtons.filter((item) => item.group.startsWith('navigation') && item.when.includes('view == ptnAgent.sessionView') && !item.when.includes('ptnAgent.busy')).map((item) => item.command).join() === 'ptnAgent.newSession,ptnAgent.history,ptnAgent.settings' &&
      titleButtons.some((item) => item.command === 'ptnAgent.ask' && item.when.includes('view == ptnAgent.sessionView'))
  );
  check('没有终端标题菜单或终端链接', linkProviders.length === 0 && !manifest.contributes.menus['editor/title']);
  check('激活时不创建对话终端', terminals.length === 0);

  await commands.get('ptnAgent.openChat')();
  check('打开对话聚焦 Agent 侧栏', terminals.length === 0 && executedCommands.some((args) => args[0] === 'workbench.view.extension.ptnAgent'));
  await commands.get('ptnAgent.openTerminalChat')();
  check('兼容旧入口仍复用同一个 Agent 侧栏', terminals.length === 0 && executedCommands.filter((args) => args[0] === 'workbench.view.extension.ptnAgent').length >= 2);
  check('聊天入口不调用 Copilot Chat 命令', !executedCommands.some((args) => /^workbench\.(action\.chat\.|panel\.chat)/.test(args[0])));

  const messages = [];
  let receive;
  const view = {
    webview: {
      cspSource: 'vscode-webview:',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage: (handler) => { receive = handler; return disposable(); },
      postMessage: (message) => { messages.push(message); return Promise.resolve(true); }
    },
    visible: true,
    show: () => {},
    onDidChangeVisibility: () => disposable(),
    onDidDispose: () => disposable()
  };
  webviews[0].provider.resolveWebviewView(view);
  check('默认就有底部输入框与会话区', view.webview.html.includes('id="composer"') && view.webview.html.includes('id="sessions"'));
  check('启用本地脚本并限定资源目录', view.webview.options.enableScripts && view.webview.options.localResourceRoots.length === 1);
  await receive({ type: 'ready' });
  check('侧栏就绪后同步状态、历史与会话列表', ['state', 'history', 'sessions'].every((type) => messages.some((message) => message.type === type)));
  await commands.get('ptnAgent.settings')();
  check('标题栏设置未配置时直接打开 API 地址引导', settingsInputs.length === 1 && /连接模型服务/.test(settingsInputs[0].title));
  configuration.baseUrl = 'https://model.invalid/v1';
  configuration.model = 'test-model';
  await commands.get('ptnAgent.settings')();
  check('标题栏设置已配置时直接打开配置菜单', settingsMenus.length === 1 && settingsMenus[0].items.some((item) => item.id === 'baseUrl'));
  await receive({ type: 'command', action: 'settings' });
  check('侧栏内设置操作到达同一个配置菜单', settingsMenus.length === 2);
  const { NativeChatSurface } = require(path.join(__dirname, '..', 'out', 'ui', 'nativeChat.js'));
  const legacySurface = new NativeChatSurface(fakeContext.extensionUri);
  let legacySettings = 0;
  legacySurface.onSettings = () => { legacySettings++; };
  legacySurface.showSettings();
  check('旧原生界面的设置入口直接调用设置回调', legacySettings === 1);
  check('设置完整操作链不调用 Copilot Chat', !executedCommands.some((args) => /^workbench\.(action\.chat\.|panel\.chat)/.test(args[0])));
  const beforeUnknown = executedCommands.length;
  await receive({ type: 'command', action: 'arbitrary-command' });
  check('拒绝未列入白名单的界面命令', executedCommands.length === beforeUnknown);

  const chatView = webviews[0].provider;
  const nativeTree = treeViews[0].options.treeDataProvider;
  configuration.baseUrl = '';
  configuration.model = '';
  // 捕获真实的就绪超时回调，无需等待 10 秒，也不执行模型请求。
  const originalSetTimeout = global.setTimeout;
  let readyTimeout;
  try {
    global.setTimeout = (callback, delay, ...args) => {
      const handle = originalSetTimeout(callback, delay, ...args);
      if (delay === 10000) readyTimeout = () => { clearTimeout(handle); callback(); };
      return handle;
    };
    await commands.get('ptnAgent.retryChatView')();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
  check('打开完整界面启动就绪超时检测', typeof readyTimeout === 'function');
  readyTimeout();
  await new Promise((resolve) => setImmediate(resolve));
  check('界面未就绪时自动切换原生视图', executedCommands.some((args) => args[0] === 'setContext' && args[1] === 'ptnAgent.nativeFallback' && args[2] === true) && !chatView.canApprove);
  check('原生兼容视图始终提供输入任务入口', nativeTree.getChildren().some((node) => node.command === 'ptnAgent.ask'));
  chatView.post({ type: 'user', text: '兼容视图任务' });
  chatView.post({ type: 'textDelta', text: '兼容视图回复' });
  chatView.post({ type: 'assistantEnd', text: '兼容视图回复' });
  const nativeTurn = nativeTree.getChildren().find((node) => node.kind === 'turn');
  check('兼容视图显示任务和流式回复', nativeTurn && nativeTree.getChildren(nativeTurn).some((node) => node.kind === 'reply' && node.turn.reply === '兼容视图回复'));
  const menuCount = settingsInputs.length;
  await commands.get('ptnAgent.ask')();
  check('兼容视图未配置时打开自有模型引导', settingsInputs.length === menuCount + 1);
  await commands.get('ptnAgent.retryChatView')();
  await receive({ type: 'ready' });
  check('重试后可恢复完整聊天界面', chatView.canApprove && messages.some((msg) => msg.type === 'requestReady'));
  await commands.get('ptnAgent.useNativeChat')();
  check('命令面板可立即切换原生兼容视图', !chatView.canApprove);
  await commands.get('ptnAgent.retryChatView')();
  await receive({ type: 'ready' });
  check('兼容和恢复流程不调用 Copilot Chat', !executedCommands.some((args) => /^workbench\.(action\.chat\.|panel\.chat)/.test(args[0])));
  const inputKey = manifest.contributes.keybindings.find((entry) => entry.command === 'ptnAgent.openChat');
  check('SXPT 聊天使用独立快捷键', inputKey.key === 'ctrl+alt+shift+i');

  if (!process.exitCode) {
    console.log('smoke test passed');
  }
  for (const subscription of fakeContext.subscriptions) subscription.dispose();
  ext.deactivate();
}

main().catch((err) => {
  console.error('ACTIVATION FAILED:', err);
  process.exitCode = 1;
});
