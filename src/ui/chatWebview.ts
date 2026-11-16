import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ChatSurface } from '../chatController';

export class ChatWebview implements vscode.WebviewViewProvider, ChatSurface, vscode.Disposable {
  private view?: vscode.WebviewView;
  private ready = false;
  private panel: 'settings' | 'history' | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: any) => Promise<void>,
    private readonly output: vscode.OutputChannel
  ) {}

  get canApprove(): boolean {
    return this.ready && !!this.view?.visible;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    clearTimeout(this.timer);
    this.view = view;
    this.ready = false;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(18).toString('base64');
    const template = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'chat.html'))).toString('utf8');
    const replacements: Record<string, string> = {
      '{{nonce}}': nonce,
      '{{cspSource}}': view.webview.cspSource,
      '{{styleUri}}': view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.css')).toString(),
      '{{scriptUri}}': view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'chat.js')).toString()
    };
    this.disposables.push(view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message?.type === 'ready') {
          this.ready = true;
          clearTimeout(this.timer);
        }
        await this.onMessage(message);
        if (message?.type === 'ready' && this.panel) {
          this.post({ type: 'showPanel', panel: this.panel });
          this.panel = undefined;
        }
      } catch (error) {
        this.output.appendLine(`[webview] ${(error as Error).message}`);
        this.post({ type: 'error', message: '操作失败，请重试或查看 AI Coding Agent 输出。' });
      }
    }), view.onDidDispose(() => {
      if (this.view !== view) return;
      clearTimeout(this.timer);
      this.view = undefined;
      this.ready = false;
      void this.onMessage({ type: 'closed' });
    }));
    view.webview.html = template.replace(/\{\{\w+\}\}/g, (placeholder) => replacements[placeholder] ?? '');
    this.timer = setTimeout(() => {
      if (this.ready) return;
      void vscode.window.showWarningMessage('Agent 面板未能加载。局域网 HTTP code-server 可使用原生备用对话。', '打开原生备用对话')
        .then((choice) => { if (choice) void vscode.commands.executeCommand('ptnAgent.openTerminalChat'); });
    }, 8000);
  }

  post(message: unknown): void {
    if (this.ready) void this.view?.webview.postMessage(message);
  }

  async reveal(preserveFocus = false): Promise<void> {
    if (this.view) this.view.show(preserveFocus);
    else await vscode.commands.executeCommand('ptnAgent.sessionView.focus');
  }

  async openSettings(): Promise<void> {
    await this.openPanel('settings');
  }

  async openHistory(): Promise<void> {
    await this.openPanel('history');
  }

  private async openPanel(panel: 'settings' | 'history'): Promise<void> {
    this.panel = panel;
    await this.reveal();
    if (this.ready) {
      this.post({ type: 'showPanel', panel });
      this.panel = undefined;
    }
  }

  docColumn(): vscode.ViewColumn | undefined {
    return vscode.ViewColumn.Active;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.view = undefined;
    this.ready = false;
  }
}
