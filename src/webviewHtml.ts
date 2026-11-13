import * as vscode from 'vscode';

export function getChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = createNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));

  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`
  ].join('; ');

  const iconPlus = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>`;
  const iconGear = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zm0 1a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/><path d="M6.9 1h2.2l.35 1.6c.3.12.58.28.84.47l1.55-.5 1.1 1.9-1.2 1.1c.03.16.05.31.05.47s-.02.31-.05.47l1.2 1.1-1.1 1.9-1.55-.5c-.26.19-.54.35-.84.47L9.1 15H6.9l-.35-1.6a4.4 4.4 0 0 1-.84-.47l-1.55.5-1.1-1.9 1.2-1.1A3.4 3.4 0 0 1 4.2 8c0-.16.02-.31.05-.47l-1.2-1.1 1.1-1.9 1.55.5c.26-.19.54-.35.84-.47L6.9 1zm.8 1-.3 1.4-.3.1c-.4.13-.76.34-1.07.62l-.24.2-1.36-.44-.5.86 1.05.96-.07.32a3.3 3.3 0 0 0 0 1.12l.07.32-1.05.96.5.86 1.36-.44.24.2c.31.28.67.49 1.07.62l.3.1.3 1.4h.6l.3-1.4.3-.1c.4-.13.76-.34 1.07-.62l.24-.2 1.36.44.5-.86-1.05-.96.07-.32a3.3 3.3 0 0 0 0-1.12l-.07-.32 1.05-.96-.5-.86-1.36.44-.24-.2a3.4 3.4 0 0 0-1.07-.62l-.3-.1L8.3 2h-.6z"/></svg>`;
  const iconSend = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M8 13.5a.75.75 0 0 1-.75-.75V5.56L4.78 8.03a.75.75 0 1 1-1.06-1.06l3.75-3.75a.75.75 0 0 1 1.06 0l3.75 3.75a.75.75 0 1 1-1.06 1.06L8.75 5.56v7.19A.75.75 0 0 1 8 13.5z"/></svg>`;
  const iconStop = `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link rel="stylesheet" href="${styleUri}" />
<title>AI Agent</title>
</head>
<body>
  <header class="top">
    <span class="brand">AI Agent</span>
    <span class="spacer"></span>
    <button class="icon" id="btnNew" title="新建对话">${iconPlus}</button>
    <button class="icon" id="btnSettings" title="设置">${iconGear}</button>
  </header>

  <div class="view" id="chatView">
    <main class="messages" id="messages"></main>

    <footer class="composer">
      <div class="ctx" id="ctxBar">
        <span class="dot" id="ctxDot"></span>
        <span class="ctx-text" id="ctxText">正在读取上下文…</span>
        <button class="link" id="btnCtx" title="查看将随消息发送的上下文">查看</button>
      </div>
      <div class="box">
        <textarea id="input" rows="1" placeholder="让 Agent 帮你理解、修改或调试代码…"></textarea>
        <div class="box-bar">
          <select id="modelSelect" class="pick" title="模型"></select>
          <select id="modeSelect" class="pick" title="审批模式：控制修改文件、运行命令前是否需要确认">
            <option value="ask">逐项确认</option>
            <option value="autoEdit">自动应用修改</option>
            <option value="readOnly">只读</option>
          </select>
          <span class="spacer"></span>
          <button class="send" id="btnSend" title="发送（Enter）">${iconSend}</button>
          <button class="send stop hidden" id="btnStop" title="停止">${iconStop}</button>
        </div>
      </div>
      <div class="status" id="statusHint">就绪</div>
    </footer>
  </div>

  <div class="view hidden" id="settingsView">
    <div class="settings-body">
      <div class="settings-head">
        <button class="link" id="btnBack">← 返回对话</button>
        <span class="settings-title">设置</span>
      </div>

      <div class="banner hidden" id="setupBanner">先连接一个模型服务，才能开始使用。填写下面三项即可。</div>

      <section>
        <h3>模型服务</h3>
        <p class="muted">支持任何 OpenAI 兼容接口。模型列表会从你填写的 API 地址自动获取。</p>

        <label for="setBaseUrl">API 地址</label>
        <input id="setBaseUrl" type="text" spellcheck="false" autocomplete="off" placeholder="https://api.example.com/v1" />
        <div class="err" id="err-baseUrl"></div>

        <label for="setApiKey">API Key <span class="muted" id="keyState"></span></label>
        <div class="row">
          <input id="setApiKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-…（本地模型可留空）" />
          <button class="link hidden" id="btnClearKey" title="删除已保存的 Key">清除</button>
        </div>

        <label for="setModel">模型</label>
        <div class="row">
          <input id="setModel" type="text" list="modelList" spellcheck="false" autocomplete="off" placeholder="选择或输入模型名称" />
          <button class="secondary" id="btnFetch" title="从 API 地址获取可用模型">获取模型</button>
        </div>
        <datalist id="modelList"></datalist>
        <div class="err" id="err-model"></div>
        <div class="hint" id="modelHint"></div>

        <div class="row">
          <button class="secondary" id="btnTest">测试连接</button>
          <span class="test-result" id="testResult"></span>
        </div>
      </section>

      <section>
        <h3>Agent 行为</h3>
        <div class="radios" id="modeRadios">
          <label class="radio"><input type="radio" name="approvalMode" value="ask" /><span><b>逐项确认</b><i>每次修改文件、运行命令都先让你确认（推荐）</i></span></label>
          <label class="radio"><input type="radio" name="approvalMode" value="autoEdit" /><span><b>自动应用修改</b><i>工作区内的文件修改直接应用，可一键撤销；运行命令仍需确认</i></span></label>
          <label class="radio"><input type="radio" name="approvalMode" value="readOnly" /><span><b>只读</b><i>只能查看代码和诊断，不能修改文件或运行命令</i></span></label>
        </div>

        <label for="setAllowed">免确认的命令 <span class="muted">每行一个前缀</span></label>
        <textarea id="setAllowed" rows="3" spellcheck="false" placeholder="npm test&#10;dotnet build"></textarea>
        <div class="hint">命中前缀且不含 &amp;&amp;、|、; 等符号的命令不再询问；高危命令一律拦截。</div>
      </section>

      <details class="adv">
        <summary>高级</summary>
        <label for="setContextWindow">上下文窗口（token）</label>
        <input id="setContextWindow" type="number" min="2048" step="1024" />
        <div class="err" id="err-contextWindow"></div>

        <label for="setMaxOutput">单次回复最大输出（token）</label>
        <input id="setMaxOutput" type="number" min="256" step="256" />
        <div class="err" id="err-maxOutputTokens"></div>

        <label class="check"><input id="setAutoContext" type="checkbox" /> 自动附带当前文件与选区</label>

        <label for="setExtra">自定义指令 <span class="muted">追加到系统提示词，如代码规范</span></label>
        <textarea id="setExtra" rows="3" spellcheck="false"></textarea>
      </details>
    </div>

    <div class="settings-foot">
      <button class="primary" id="btnSave">保存</button>
      <button class="secondary" id="btnCancel">取消</button>
      <span class="save-msg" id="saveMsg"></span>
    </div>
  </div>

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
