require('./source-loader');
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
      return { description: undefined, badge: undefined, dispose: () => {} };
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
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    withProgress: async (_o, task) => task(),
    onDidChangeTextEditorSelection: () => disposable(),
    onDidChangeActiveTextEditor: () => disposable(),
    activeTextEditor: undefined,
    activeTerminal: undefined
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
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
    executeCommand: async () => undefined
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
  check('注册了原生树视图且没有 Webview', treeViews.length === 1 && treeViews[0].id === 'ptnAgent.sessionView' && webviews.length === 0);
  const navigation = manifest.contributes.menus['view/title'].filter((item) => item.group.startsWith('navigation') && !item.when.includes('ptnAgent.busy'));
  check('侧栏常驻操作只有新建、历史、设置', navigation.map((item) => item.command).join() === 'ptnAgent.newSession,ptnAgent.history,ptnAgent.settings');
  check('原生欢迎页存在', manifest.contributes.viewsWelcome.every((entry) => entry.view === treeViews[0].id));
  const titleButtons = manifest.contributes.menus['editor/title'] || [];
  check(
    '对话标签页标题栏有新建、历史、设置（与原型顶部图标一致）',
    titleButtons.filter((item) => !item.when.includes('ptnAgent.busy')).map((item) => item.command).join() === 'ptnAgent.newSession,ptnAgent.history,ptnAgent.settings' &&
      titleButtons.every((item) => item.when.includes('ptnAgent.chatActive') && item.when.includes('resourceScheme == vscode-terminal'))
  );
  check('注册了终端链接（文件:行号）', linkProviders.length === 1);
  check('激活时不创建对话终端', terminals.length === 0);

  await commands.get('ptnAgent.openChat')();
  const term = terminals[0];
  check('打开对话会创建一个终端标签页', terminals.length === 1 && term.name === 'AI Agent' && term.options.pty && term.shown === 1);
  check('对话终端默认放在编辑器右侧', term && term.options.location && term.options.location.viewColumn === stub.ViewColumn.Beside);
  let screen = '';
  term.options.pty.onDidWrite((d) => (screen += d));
  term.options.pty.open({ columns: 80, rows: 24 });
  await new Promise((r) => setTimeout(r, 50));
  const plain = screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  check('对话终端打开后绘制了标题行与欢迎页', /✦ AI Agent/.test(plain) && /\/settings/.test(plain) && /(有什么想一起完成的|先连接模型服务)/.test(plain));
  const headerLinks = linkProviders[0].provideTerminalLinks({ terminal: term, line: '✦ AI Agent     /new 新建 · /history 历史 · /settings 设置' });
  check('标题行的新建 / 历史 / 设置可以点击', headerLinks.map((l) => l.action && l.action.type).join() === 'newSession,openHistory,openSettings');
  check(
    '链接只作用于对话终端',
    linkProviders[0].provideTerminalLinks({ terminal: term, line: '见 src/a.ts:12' }).length === 1 &&
      linkProviders[0].provideTerminalLinks({ terminal: {}, line: '见 src/a.ts:12' }).length === 0
  );
  await commands.get('ptnAgent.openTerminalChat')();
  check('再次打开复用同一个终端', terminals.length === 1 && term.shown === 2);
  term.options.pty.handleInput('关闭前的草稿');
  term.options.pty.close();
  await commands.get('ptnAgent.openChat')();
  const reopened = terminals[1];
  let restoredScreen = '';
  reopened.options.pty.onDidWrite((data) => { restoredScreen += data; });
  reopened.options.pty.open({ columns: 80, rows: 24 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('关闭后重新打开原生终端会恢复草稿', restoredScreen.includes('关闭前的草稿'));
  reopened.options.pty.close();

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
