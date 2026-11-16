const Module = require('module');
const path = require('path');

const disposables = [];
const commands = new Map();
const channels = [];
const treeViews = [];
const terminals = [];
const linkProviders = [];

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

  // 原生界面：侧栏树视图 + 终端对话窗口，不再使用 webview
  const check = (name, cond) => {
    if (!cond) {
      console.error('FAIL ' + name);
      process.exitCode = 1;
    }
  };
  check('注册了侧栏树视图', treeViews.length === 1 && treeViews[0].id === 'ptnAgent.sessionView');
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
  check('对话终端打开后绘制了欢迎框', /AI Coding Agent/.test(screen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')));
  check(
    '链接只作用于对话终端',
    linkProviders[0].provideTerminalLinks({ terminal: term, line: '见 src/a.ts:12' }).length === 1 &&
      linkProviders[0].provideTerminalLinks({ terminal: {}, line: '见 src/a.ts:12' }).length === 0
  );
  await commands.get('ptnAgent.openChat')();
  check('再次打开复用同一个终端', terminals.length === 1 && term.shown === 2);
  term.options.pty.close();

  if (!process.exitCode) {
    console.log('smoke test passed');
  }
  ext.deactivate();
}

main().catch((err) => {
  console.error('ACTIVATION FAILED:', err);
  process.exitCode = 1;
});
