const Module = require('module');
const path = require('path');

const disposables = [];
const commands = new Map();
const channels = [];

function disposable(fn) {
  return { dispose: fn || (() => {}) };
}

const stub = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ViewColumn: { One: 1, Active: -1 },
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
    registerWebviewViewProvider: () => disposable(),
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
      this.event = () => disposable();
    }
    fire() {}
    dispose() {}
  }
};

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

try {
  ext.activate(fakeContext);
  console.log('activate ok, registered commands:', commands.size);
  console.log([...commands.keys()].join('\n'));
  const expected = [
    'ptnAgent.openChat',
    'ptnAgent.explainSelection',
    'ptnAgent.settings',
    'ptnAgent.testConnection',
    'ptnAgent.showContext',
    'ptnAgent.undoLastPatch',
    'ptnAgent.runTests',
    'ptnAgent.runCommand',
    'ptnAgent.refreshPlatform',
    'ptnAgent.showProjectOutline',
    'ptnAgent.checkCommand'
  ];
  const missing = expected.filter((c) => !commands.has(c));
  if (missing.length) {
    console.error('MISSING COMMANDS:', missing.join(', '));
    process.exitCode = 1;
  } else {
    console.log('smoke test passed');
  }
  ext.deactivate();
} catch (err) {
  console.error('ACTIVATION FAILED:', err);
  process.exitCode = 1;
}
