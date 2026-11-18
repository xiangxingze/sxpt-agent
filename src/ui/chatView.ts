import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { ChatController, ChatSurface } from '../chatController';
import { SessionTree } from './sessionTree';

/** 原型侧栏：布局由扩展维护，Agent 执行和设置仍由原控制器处理。 */
export class ChatView implements vscode.WebviewViewProvider, ChatSurface {
  static readonly viewId = 'ptnAgent.sessionView';
  private readonly nativeView = new SessionTree('ptnAgent.nativeSessionView');
  private usingNative = false;
  private webviewReady = false;
  private readyTimer?: ReturnType<typeof setTimeout>;
  get canApprove(): boolean { return !this.usingNative; }
  private view?: vscode.WebviewView;
  private currentDraft = '';
  private sessionId = '';
  private historyRequested = false;

  constructor(private readonly extensionUri: vscode.Uri, private readonly controller: ChatController) {}

  register(context: vscode.ExtensionContext): void {
    void vscode.commands.executeCommand('setContext', 'ptnAgent.nativeFallback', false);
    this.nativeView.register(context);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatView.viewId, this, {
      webviewOptions: { retainContextWhenHidden: true }
    }), { dispose: () => this.clearReadyTimer() });
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }

  private watchReady(): void {
    if (this.webviewReady || this.usingNative || this.readyTimer) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = undefined;
      void this.useNativeChat().catch((error) => vscode.window.showErrorMessage(String(error)));
    }, 10000);
  }

  async useNativeChat(): Promise<void> {
    if (this.usingNative) return;
    this.clearReadyTimer();
    this.usingNative = true;
    await vscode.commands.executeCommand('setContext', 'ptnAgent.nativeFallback', true);
    // 切换时已有的待审批操作也交给原生弹窗，避免留在未加载的界面中。
    await this.controller.onMessage({ type: 'closed' });
    await this.controller.onMessage({ type: 'ready' });
    this.nativeView.receive({ type: 'notice', text: '已切换原生兼容视图。点击“输入任务…”开始；完整聊天布局需要浏览器信任平台 HTTPS 证书。' });
    await this.nativeView.reveal();
  }

  async retryChatView(): Promise<void> {
    this.clearReadyTimer();
    this.usingNative = false;
    this.webviewReady = false;
    await vscode.commands.executeCommand('setContext', 'ptnAgent.nativeFallback', false);
    await this.reveal();
    this.post({ type: 'requestReady' });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    this.watchReady();
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    const nonce = randomBytes(18).toString('base64');
    view.webview.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('chat.css')}"><title>聊天</title></head>
<body>
  <main class="workbench">
    <section class="sessions" aria-label="会话列表">
      <header class="section-heading"><span>会话</span><nav aria-label="会话操作">
        <button data-action="refresh" data-icon="refresh" title="刷新会话" aria-label="刷新会话"></button>
        <button data-action="search" data-icon="search" title="搜索会话" aria-label="搜索会话" aria-expanded="false"></button>
        <button data-action="filter" data-icon="filter" title="只显示当前会话" aria-label="只显示当前会话" aria-pressed="false"></button>
        <button data-action="toggleSessions" data-icon="panel" title="收起会话列表" aria-label="收起会话列表" aria-expanded="true"></button>
      </nav></header>
      <div id="session-body"><input id="search" type="search" placeholder="搜索会话" aria-label="搜索会话" hidden>
      <div id="sessions"></div><button id="more" class="more" hidden><span>更多</span><span id="more-count"></span></button></div>
    </section>
    <section id="conversation" class="conversation" aria-label="对话内容" tabindex="0">
      <div id="notice" role="status" hidden></div><div id="messages"></div>
      <div id="plan" hidden></div><div id="approvals"></div>
    </section>
    <footer class="footer">
      <form id="composer" class="composer">
        <p class="hint">提示: 在编辑器中选择代码块，然后右键单击以访问更多 AI 操作。</p>
        <div class="input-row"><span class="mention">@sxpt</span><textarea id="prompt" rows="2" aria-label="描述目标" placeholder="描述目标，我会阅读代码、修改文件并运行验证"></textarea></div>
        <div class="composer-tools"><div class="tool-group">
          <button type="button" data-action="context" data-icon="plus" title="查看当前代码上下文" aria-label="查看当前代码上下文"></button>
          <button type="button" data-action="mode" class="text-button" title="切换审批模式"><span data-icon="mode"></span><span id="mode">Ask</span><span class="chevron">⌄</span></button>
          <button type="button" data-action="model" class="text-button model-button" title="选择模型"><span data-icon="agent"></span><span id="model">选择模型</span><span class="chevron">⌄</span></button>
        </div><button id="send" type="submit" class="send" data-icon="send" title="发送（Enter）" aria-label="发送"></button></div>
      </form>
      <div class="status"><button data-action="newSession" class="text-button" title="新建会话"><span data-icon="agent"></span>SXPT Agent</button><span class="divider"></span><button data-action="mode" id="permission" class="text-button">逐项确认</button><span id="context" class="context" title="当前代码上下文"></span><span id="run-status" role="status"></span></div>
    </footer>
  </main><script nonce="${nonce}" src="${asset('chat.js')}"></script>
</body></html>`;
    view.onDidChangeVisibility(() => {
      if (view.visible) this.watchReady();
      else this.clearReadyTimer();
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.webviewReady = false;
      this.clearReadyTimer();
      if (!this.usingNative) void this.controller.onMessage({ type: 'closed' });
    });
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (this.usingNative) return;
        if (message?.type === 'ready') {
          this.webviewReady = true;
          this.clearReadyTimer();
        }
        if (message?.type === 'draft') {
          if (message.sessionId !== this.sessionId) return;
          this.currentDraft = String(message.text ?? '');
          await this.controller.onMessage({ type: 'saveDraft', text: this.currentDraft, sessionId: message.sessionId });
          return;
        }
        if (message?.type === 'command') {
          const commands: Record<string, string> = {
            settings: 'ptnAgent.settings', model: 'ptnAgent.pickModel', mode: 'ptnAgent.pickMode',
            context: 'ptnAgent.showContext', undo: 'ptnAgent.undoLastPatch'
          };
          const command = commands[String(message.action)];
          if (command) await vscode.commands.executeCommand(command);
          return;
        }
        if (['ready', 'send', 'stop', 'newSession', 'listSessions', 'selectSession', 'approvalResponse', 'openDiff', 'openFile'].includes(message?.type)) {
          if (message.type === 'send') this.currentDraft = '';
          await this.controller.onMessage(message);
          if (message.type === 'ready' && this.historyRequested) this.post({ type: 'showSessions' });
        }
      } catch (error) {
        this.post({ type: 'notice', level: 'warn', text: (error as Error).message });
      }
    });
  }

  post(message: unknown): void {
    this.nativeView.post(message);
    const msg = message as { type?: string; sessionId?: string; draft?: string; busy?: boolean; configured?: boolean };
    if (msg?.type === 'state') {
      if (msg.busy !== undefined) void vscode.commands.executeCommand('setContext', 'ptnAgent.busy', !!msg.busy);
      if (msg.configured !== undefined) void vscode.commands.executeCommand('setContext', 'ptnAgent.configured', !!msg.configured);
    }
    if (msg?.sessionId) this.sessionId = msg.sessionId;
    if (msg?.type === 'history') this.currentDraft = msg.draft ?? '';
    if (!this.usingNative) void this.view?.webview.postMessage(message);
  }
  async reveal(preserveFocus = false): Promise<void> {
    if (this.usingNative) { await this.nativeView.reveal(); return; }
    this.watchReady();
    await vscode.commands.executeCommand('workbench.view.extension.ptnAgent');
    this.view?.show(preserveFocus);
    if (!preserveFocus) this.post({ type: 'focus' });
  }
  showHistory(): void {
    if (this.usingNative) {
      this.nativeView.showHistory();
      void vscode.commands.executeCommand('ptnAgent.nativeSessionView.focus');
      return;
    }
    this.historyRequested = true;
    this.post({ type: 'showSessions' });
    void this.reveal(true);
  }
  docColumn(): vscode.ViewColumn { return vscode.ViewColumn.Beside; }
  draft(): string | undefined { return this.usingNative ? undefined : this.currentDraft; }
}
