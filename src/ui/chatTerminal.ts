import * as vscode from 'vscode';
import { ChatTui } from './chatTui';

export const CHAT_TERMINAL_NAME = 'AI Agent';

interface FileRefLink extends vscode.TerminalLink {
  ref: string;
}

const FILE_REF =
  /(?:[A-Za-z]:[\\/]|\/)?(?:[A-Za-z0-9_.@~-]+[\\/])*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}/g;

const CODE_EXTENSIONS = new Set(
  (
    'c cc cpp cs css csv go h hpp htm html ini ipynb java js json jsx kt less lua md mjs cjs php ' +
    'properties py rb rs scss sh sql svelte swift toml ts tsx txt vue xml yaml yml'
  ).split(' ')
);

/** 从终端的一行文本里找出像「src/a.ts:12」这样的文件引用（纯函数，便于自检） */
export function findFileRefs(line: string): FileRefLink[] {
  const links: FileRefLink[] = [];
  FILE_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_REF.exec(line))) {
    const text = m[0];
    const before = m.index > 0 ? line[m.index - 1] : '';
    // 跳过网址（https://host/a.html）和更长单词的一部分
    if (before === '/' || before === ':' || before === '\\' || /[A-Za-z0-9_]/.test(before)) {
      continue;
    }
    const file = text.replace(/(?::\d+){1,2}$/, '');
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
    const looksLikePath = /[\\/]/.test(file) || file !== text;
    if (!looksLikePath && !CODE_EXTENSIONS.has(ext)) {
      continue;
    }
    links.push({ startIndex: m.index, length: text.length, tooltip: '在编辑器中打开', ref: text });
  }
  return links;
}

/** 对话界面需要宿主提供的东西 */
export interface ChatTerminalHost {
  /** 界面发出的用户操作（发送、停止、审批结果、斜杠命令……） */
  onMessage(message: any): void;
  /** 显示在欢迎框里的工作目录 */
  cwd(): string | undefined;
  /** 对话窗口位置：编辑器右侧 或 底部面板 */
  location(): 'beside' | 'panel';
}

/**
 * 对话界面的 VS Code 封装：一个由扩展自己绘制的原生终端标签页（Pseudoterminal）。
 *
 * 不使用 webview 的原因：webview 依赖 Service Worker，只能在安全上下文（https 或 localhost）里加载；
 * 实训平台在局域网里以 http:// 提供 code-server，webview 会直接报错无法显示。
 * 终端由 workbench 自己渲染，不受这个限制。
 */
export class ChatTerminal implements vscode.Disposable {
  private terminal?: vscode.Terminal;
  private tui?: ChatTui;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: ChatTerminalHost) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTerminal((t) => this.updateContext(t)),
      vscode.window.onDidCloseTerminal((t) => {
        if (t === this.terminal) {
          this.forget();
        }
      }),
      // 对话里出现的「文件路径:行号」可以直接点击打开（Ctrl/Cmd + 单击）
      vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks: (context): FileRefLink[] =>
          context.terminal === this.terminal ? findFileRefs(context.line) : [],
        handleTerminalLink: (link: FileRefLink) => this.host.onMessage({ type: 'openFile', ref: link.ref })
      })
    );
  }

  /** 对话窗口存在时，审批直接在其中完成；否则宿主改用原生弹窗 */
  get canApprove(): boolean {
    return !!this.tui;
  }

  post(message: unknown): void {
    this.tui?.receive(message);
  }

  async reveal(preserveFocus = false): Promise<void> {
    if (!this.terminal) {
      this.create(preserveFocus);
    }
    this.terminal?.show(preserveFocus);
    if (!preserveFocus) {
      this.updateContext(this.terminal);
    }
  }

  /**
   * 打开文件、Diff 时应使用的编辑器列：避开对话所在的编辑器组，
   * 否则新标签页会盖住对话窗口。对话在底部面板时返回 undefined（使用默认位置）。
   */
  docColumn(): vscode.ViewColumn | undefined {
    try {
      const groups = vscode.window.tabGroups.all;
      const mine = groups.find((g) =>
        g.tabs.some((t) => t.input instanceof vscode.TabInputTerminal && t.label === CHAT_TERMINAL_NAME)
      );
      if (!mine) {
        return undefined;
      }
      const other = groups.find((g) => g !== mine);
      return other ? other.viewColumn : vscode.ViewColumn.Beside;
    } catch {
      return undefined;
    }
  }

  private create(preserveFocus: boolean): void {
    const writer = new vscode.EventEmitter<string>();
    const tui = new ChatTui({
      write: (data) => writer.fire(data),
      emit: (message) => this.host.onMessage(message),
      cwd: this.host.cwd()
    });
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writer.event,
      open: (dims) => tui.open(dims?.columns, dims?.rows),
      close: () => {
        tui.dispose();
        writer.dispose();
        if (this.tui === tui) {
          this.forget();
        }
      },
      handleInput: (data) => tui.handleInput(data),
      setDimensions: (dims) => tui.setDimensions(dims.columns, dims.rows)
    };
    this.tui = tui;
    this.terminal = vscode.window.createTerminal({
      name: CHAT_TERMINAL_NAME,
      pty,
      iconPath: new vscode.ThemeIcon('sparkle'),
      isTransient: true,
      location:
        this.host.location() === 'panel'
          ? vscode.TerminalLocation.Panel
          : { viewColumn: vscode.ViewColumn.Beside, preserveFocus }
    });
  }

  private forget(): void {
    this.tui?.dispose();
    this.tui = undefined;
    this.terminal = undefined;
    this.updateContext(vscode.window.activeTerminal);
    this.host.onMessage({ type: 'closed' });
  }

  /** 供快捷键使用：只有对话终端获得焦点时，Shift+Enter 才被映射为换行 */
  private updateContext(active: vscode.Terminal | undefined): void {
    void vscode.commands.executeCommand('setContext', 'ptnAgent.chatActive', !!this.terminal && active === this.terminal);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    const terminal = this.terminal;
    this.tui?.dispose();
    this.tui = undefined;
    this.terminal = undefined;
    terminal?.dispose();
  }
}
