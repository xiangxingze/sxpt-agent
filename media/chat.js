(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const paths = {
    refresh: '<path d="M13 6a5.5 5.5 0 1 0 .2 4M13 2v4H9"/>',
    search: '<circle cx="6.8" cy="6.8" r="4.7"/><path d="m10.3 10.3 4 4"/>',
    filter: '<path d="M2 2.5h12L9 8v5l-2 1V8z"/>',
    panel: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M7 2v12"/>',
    plus: '<path d="M8 2v12M2 8h12"/>',
    send: '<path d="M8 3v10M3 8h10"/>',
    stop: '<rect x="4" y="4" width="8" height="8"/>',
    mode: '<circle cx="8" cy="8" r="5"/><path d="m6 10 2-5 2 5M6.7 8.5h2.6"/>',
    agent: '<rect x="3" y="4" width="10" height="8" rx="3"/><path d="M8 2v2M1 7v3m14-3v3M6 7v2m4-2v2M6 12v2m4-2v2"/>',
    monitor: '<rect x="2" y="2" width="12" height="9" rx="1"/><path d="M8 11v3m-3 0h6"/>',
    user: '<circle cx="8" cy="5" r="3"/><path d="M2 15a6 6 0 0 1 12 0"/>'
  };
  function icon(name) {
    const template = document.createElement('template');
    template.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.agent}</svg>`;
    return template.content.firstChild;
  }
  document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(icon(el.dataset.icon)));
  const post = (type, extra = {}) => vscode.postMessage({ type, ...extra });
  let sessions = [];
  let sessionId = '';
  let busy = false;
  let configured = false;
  let expanded = false;
  let currentOnly = false;
  let assistant;
  let assistantText = '';
  let steps;
  let draftTimer;
  let renderFrame;
  const toolRows = new Map();
  const approvals = new Map();
  const previous = vscode.getState() || {};
  $('prompt').value = previous.draft || '';

  function relativeTime(timestamp) {
    if (!timestamp) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
  }
  function renderSessions() {
    $('sessions').replaceChildren();
    const query = $('search').value.trim().toLowerCase();
    const matches = sessions.filter((s) => (!currentOnly || s.id === sessionId) && s.title.toLowerCase().includes(query));
    for (const session of expanded ? matches : matches.slice(0, 3)) {
      const button = document.createElement('button');
      button.className = `session${session.id === sessionId ? ' active' : ''}`;
      button.title = session.title;
      if (session.id === sessionId) button.setAttribute('aria-current', 'true');
      const dot = document.createElement('span');
      dot.className = 'session-dot';
      const content = document.createElement('span');
      content.className = 'session-content';
      const title = document.createElement('span');
      title.className = 'session-title';
      title.textContent = session.title || '新会话';
      const meta = document.createElement('span');
      meta.className = 'session-meta';
      meta.append(icon('monitor'), document.createTextNode(`· ${relativeTime(session.updatedAt)}`));
      content.append(title, meta);
      button.append(dot, content);
      button.onclick = () => switchSession('selectSession', { id: session.id });
      $('sessions').append(button);
    }
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-sessions';
      empty.textContent = sessions.length ? '没有匹配的会话' : '暂无会话，从下方输入开始';
      $('sessions').append(empty);
    }
    $('more').hidden = matches.length <= 3;
    $('more').firstElementChild.textContent = expanded ? '收起' : '更多';
    $('more-count').textContent = expanded ? '' : String(matches.length - 3);
  }
  function saveDraft() {
    clearTimeout(draftTimer);
    vscode.setState({ draft: $('prompt').value, sessionId });
    post('draft', { text: $('prompt').value, sessionId });
  }
  function switchSession(type, extra = {}) {
    saveDraft();
    post(type, { ...extra, draft: $('prompt').value });
  }
  function resizeInput() {
    $('prompt').style.height = 'auto';
    $('prompt').style.height = `${Math.min(160, $('prompt').scrollHeight)}px`;
  }
  function updateSend() {
    $('send').replaceChildren(icon(busy ? 'stop' : 'send'));
    $('send').disabled = !busy && configured && !$('prompt').value.trim();
    $('send').title = busy ? '停止当前任务' : configured ? '发送（Enter）' : '配置模型服务';
    $('send').setAttribute('aria-label', $('send').title);
    $('run-status').textContent = busy ? '执行中…' : '';
  }
  function addMessage(role, text) {
    const message = document.createElement('article');
    message.className = 'message';
    const heading = document.createElement('div');
    heading.className = 'message-heading';
    heading.append(icon(role === 'user' ? 'user' : 'agent'), document.createTextNode(role === 'user' ? '你' : 'SXPT Agent'));
    const body = document.createElement('div');
    body.className = 'message-body';
    renderText(body, text);
    message.append(heading, body);
    $('messages').append(message);
    return body;
  }
  // 文本只以文本节点渲染；代码围栏独立展示，不执行模型返回的 HTML。
  function renderText(body, text) {
    body.replaceChildren();
    const parts = text.split(/```[^\n]*\n([\s\S]*?)(?:```|$)/g);
    parts.forEach((part, index) => {
      if (index % 2) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = part;
        pre.append(code);
        body.append(pre);
      } else body.append(document.createTextNode(part));
    });
  }
  function nearBottom() {
    const area = $('conversation');
    return area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  }
  function scrollDown() { $('conversation').scrollTop = $('conversation').scrollHeight; }
  function ensureAssistant() {
    if (assistant) return;
    assistantText = '';
    assistant = addMessage('assistant', '');
    steps = document.createElement('div');
    steps.className = 'steps';
    assistant.before(steps);
  }
  function resetConversation() {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = undefined;
    $('messages').replaceChildren();
    $('approvals').replaceChildren();
    $('plan').hidden = true;
    $('notice').hidden = true;
    assistant = undefined;
    assistantText = '';
    steps = undefined;
    toolRows.clear();
    approvals.clear();
  }
  function notice(text) {
    $('notice').className = 'notice';
    $('notice').textContent = text;
    $('notice').hidden = !text;
  }
  function command(action) { post('command', { action }); }
  function showSessions() {
    $('session-body').hidden = false;
    document.querySelector('[data-action="toggleSessions"]').setAttribute('aria-expanded', 'true');
  }
  const actions = {
    refresh: () => post('listSessions'),
    search: () => { showSessions(); $('search').hidden = !$('search').hidden; document.querySelector('[data-action="search"]').setAttribute('aria-expanded', String(!$('search').hidden)); if (!$('search').hidden) $('search').focus(); else { $('search').value = ''; renderSessions(); } },
    filter: () => { currentOnly = !currentOnly; document.querySelector('[data-action="filter"]').setAttribute('aria-pressed', String(currentOnly)); renderSessions(); },
    toggleSessions: () => { $('session-body').hidden = !$('session-body').hidden; const button = document.querySelector('[data-action="toggleSessions"]'); button.setAttribute('aria-expanded', String(!$('session-body').hidden)); button.title = $('session-body').hidden ? '展开会话列表' : '收起会话列表'; button.setAttribute('aria-label', button.title); },
    newSession: () => switchSession('newSession'),
    context: () => command('context'), model: () => command('model'), mode: () => command('mode')
  };
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => actions[button.dataset.action]?.()));
  $('more').onclick = () => { expanded = !expanded; renderSessions(); };
  $('search').oninput = renderSessions;
  $('prompt').addEventListener('input', () => { resizeInput(); updateSend(); clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 250); });
  $('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!busy) $('composer').requestSubmit();
    }
  });
  $('composer').onsubmit = (event) => {
    event.preventDefault();
    if (busy) { post('stop'); return; }
    if (!configured) { command('settings'); return; }
    const text = $('prompt').value.trim();
    if (!text) return;
    busy = true;
    post('send', { text });
    $('prompt').value = '';
    saveDraft();
    resizeInput();
    updateSend();
  };
  window.addEventListener('message', ({ data: msg }) => {
    if (!msg || typeof msg !== 'object') return;
    const follow = nearBottom();
    switch (msg.type) {
      case 'state': {
        if (msg.configured !== undefined) configured = !!msg.configured;
        if (msg.busy !== undefined) busy = !!msg.busy;
        sessionId = msg.sessionId || sessionId;
        if (msg.model !== undefined) $('model').textContent = msg.model || '选择模型';
        if (msg.mode !== undefined) {
          $('permission').textContent = { ask: '逐项确认', autoEdit: '自动应用修改', readOnly: '只读' }[msg.mode] || '逐项确认';
          $('mode').textContent = { ask: 'Ask', autoEdit: '自动编辑', readOnly: '只读' }[msg.mode] || 'Ask';
        }
        if (msg.contextLabel !== undefined) { $('context').textContent = msg.contextLabel || ''; $('context').title = msg.contextLabel || '当前代码上下文'; }
        if (!busy && assistant && !assistantText) assistant.textContent = '任务已结束。';
        if (!busy) for (const row of toolRows.values()) if (row.textContent.startsWith('◌')) row.textContent = row.textContent.replace(/^◌/, '—').replace(/…$/, '（已结束）');
        updateSend();
        break;
      }
      case 'context': $('context').textContent = msg.label || ''; $('context').title = msg.label || ''; break;
      case 'sessions': sessions = msg.sessions || []; sessionId = msg.activeId || sessionId; renderSessions(); break;
      case 'showSessions': showSessions(); expanded = true; renderSessions(); break;
      case 'requestReady': post('ready'); break;
      case 'focus': $('prompt').focus(); break;
      case 'history':
        resetConversation();
        sessionId = msg.sessionId || sessionId;
        for (const item of msg.messages || []) addMessage(item.role, item.content || '');
        $('prompt').value = previous.sessionId === sessionId && previous.draft ? previous.draft : msg.draft || '';
        previous.draft = '';
        resizeInput(); updateSend(); saveDraft(); scrollDown();
        break;
      case 'cleared': resetConversation(); $('prompt').value = ''; resizeInput(); break;
      case 'user':
        if (renderFrame) cancelAnimationFrame(renderFrame);
        renderFrame = undefined;
        assistant = undefined; assistantText = ''; steps = undefined; toolRows.clear();
        $('notice').hidden = true; $('plan').hidden = true;
        addMessage('user', msg.text || '');
        break;
      case 'assistantStart': ensureAssistant(); break;
      case 'textDelta':
        ensureAssistant(); assistantText += msg.text || '';
        if (!renderFrame) renderFrame = requestAnimationFrame(() => {
          renderFrame = undefined;
          const followStream = nearBottom();
          renderText(assistant, assistantText);
          if (followStream) scrollDown();
        });
        break;
      case 'textReset': assistantText = ''; if (assistant) renderText(assistant, ''); break;
      case 'toolStart': {
        ensureAssistant();
        const row = document.createElement('div'); row.className = 'step'; row.textContent = `◌ ${msg.label || msg.name}…`;
        steps.append(row); toolRows.set(msg.id, row); break;
      }
      case 'toolEnd': { const row = toolRows.get(msg.id); if (row) row.textContent = `${msg.ok ? '✓' : '×'} ${msg.summary || '操作完成'}`; break; }
      case 'info': notice(msg.message || ''); break;
      case 'notice': notice(msg.text || ''); break;
      case 'error': ensureAssistant(); assistant.classList.add('error'); assistantText += `${assistantText ? '\n\n' : ''}${msg.message || '执行失败，请重试。'}`; renderText(assistant, assistantText); break;
      case 'assistantEnd':
        ensureAssistant();
        if (typeof msg.text === 'string') assistantText = msg.text;
        renderText(assistant, assistantText);
        break;
      case 'plan':
        $('plan').hidden = !msg.steps?.length;
        $('plan').textContent = (msg.steps || []).map((s) => `${s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◌' : '○'} ${s.step}`).join('\n');
        break;
      case 'approval': {
        const request = msg.request || {};
        if (approvals.has(request.id)) break;
        const card = document.createElement('div'); card.className = 'approval';
        const title = document.createElement('div'); title.textContent = `等待确认 · ${request.title || '执行操作'}`;
        const detail = document.createElement('div'); detail.textContent = request.command || `新增 ${request.added || 0} 行，删除 ${request.removed || 0} 行`;
        const controls = document.createElement('div'); controls.className = 'approval-actions';
        for (const [label, type, extra] of [
          ['允许', 'approvalResponse', { decision: 'allow' }], ['拒绝', 'approvalResponse', { decision: 'deny' }],
          ...(request.canDiff ? [['查看修改', 'openDiff', {}]] : [])
        ]) {
          const button = document.createElement('button'); button.textContent = label;
          button.onclick = () => { post(type, { id: request.id, ...extra }); };
          controls.append(button);
        }
        card.append(title, detail, controls); approvals.set(request.id, card); $('approvals').append(card); break;
      }
      case 'approvalDone': approvals.get(msg.id)?.remove(); approvals.delete(msg.id); break;
      case 'changes':
        ensureAssistant();
        for (const file of msg.files || []) {
          const button = document.createElement('button'); button.className = 'file-link'; button.textContent = file;
          button.onclick = () => post('openFile', { ref: file }); assistant.parentElement.append(button);
        }
        break;
      default: return;
    }
    if (follow) scrollDown();
  });
  window.addEventListener('pagehide', saveDraft);
  updateSend();
  post('ready');
})();
