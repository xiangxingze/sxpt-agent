import * as vscode from 'vscode';

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'chat.css')
  );

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>AI Coding Agent</title>
</head>
<body>
  <header class="bar">
    <div class="model" id="modelChip" role="button" tabindex="0" title="模型设置">未配置模型</div>
    <div class="mode" id="modeChip" role="button" tabindex="0" title="审批模式：控制 Agent 修改文件、运行命令前是否需要确认">逐项确认</div>
    <div class="bar-actions">
      <button class="icon" id="btnNew" title="新建会话">＋</button>
      <button class="icon" id="btnClear" title="清空会话">⌫</button>
      <button class="icon" id="btnSettings" title="模型设置">⚙</button>
    </div>
  </header>

  <div class="ctx" id="ctxBar">
    <span class="ctx-dot" id="ctxDot"></span>
    <span class="ctx-text" id="ctxText">正在读取上下文…</span>
    <button class="link" id="btnCtx" title="查看将发送的上下文">查看</button>
  </div>

  <div class="ctx sub" id="platformBar">
    <span class="ctx-dot" id="platformDot"></span>
    <span class="ctx-text" id="platformText">平台未配置</span>
    <button class="link" id="btnPlatform" title="刷新平台上下文">刷新</button>
  </div>

  <main class="messages" id="messages">
    <div class="empty" id="emptyState">
      <p class="empty-title">AI Coding Agent</p>
      <p class="empty-sub">告诉我你想做什么：解释代码、修复错误、补充测试、实现功能。我会自己查看代码、修改文件并运行验证。</p>
      <ul class="empty-list">
        <li><kbd>Ctrl+Alt+I</kbd> 打开对话</li>
        <li><kbd>Ctrl+Alt+E</kbd> 解释选中代码</li>
        <li>每次修改都会先打开 Diff，由你确认后才写入</li>
        <li>改错了可以点「撤销本次修改」</li>
      </ul>
    </div>
  </main>

  <div class="quick" id="quick">
    <button data-action="explain">解释代码</button>
    <button data-action="problem">分析错误</button>
    <button data-action="fix">修复问题</button>
    <button data-action="tests">生成测试</button>
    <button data-action="runTests">运行测试</button>
    <button data-action="project">项目结构</button>
    <button data-action="refactor">重构</button>
  </div>

  <footer class="composer">
    <textarea id="input" rows="3" placeholder="让 Agent 帮你理解、修改或调试代码…（Enter 发送，Shift+Enter 换行）"></textarea>
    <div class="composer-bar">
      <span class="hint" id="statusHint">就绪</span>
      <button class="primary" id="btnSend">发送</button>
      <button class="secondary hidden" id="btnStop">停止</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
