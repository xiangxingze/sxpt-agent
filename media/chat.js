(() => {
  const api = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const local = api.getState() || {};
  const drafts = local.drafts || {};
  const state = { configured: false, busy: false, sessionId: '', undoCount: 0 };
  let settingsLoaded = false;
  let settingsDirty = false;
  let settingsValues;
  let formRevision = 0;
  let requestSequence = 0;
  let pendingRequest;
  let sending = false;
  let switching = false;
  let activeTurn;
  let displayedSessionId = '';
  let draftTimer;
  let noticeTimer;
  let paintFrame;
  const tools = new Map();
  const approvals = new Map();
  const post = (message) => api.postMessage(message);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className || '';
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  function inline(text) {
    const codes = [];
    let result = escape(text).replace(/`([^`\n]+)`/g, (_, code) => {
      const reference = /^(?:[A-Za-z]:)?[\w@.\\/-]+\.[A-Za-z0-9]{1,8}(?::\d+){0,2}$/.test(code);
      codes.push(reference ? `<code class="fileref" data-ref="${code}" tabindex="0" role="button">${code}</code>` : `<code>${code}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    return result.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)] || '');
  }
  function markdown(text) {
    const lines = String(text).replace(/\u0000/g, '').split('\n');
    const result = [];
    const row = (line) => line.trim().replace(/^\||\|$/g, '').split('|');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/^\s*```/.test(line)) {
        const code = [];
        while (++index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index]);
        result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      } else if (line.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] || '')) {
        const headers = row(line).map((cell) => `<th>${inline(cell.trim())}</th>`).join('');
        index++;
        const rows = [];
        while (index + 1 < lines.length && lines[index + 1].includes('|') && lines[index + 1].trim()) {
          rows.push(`<tr>${row(lines[++index]).map((cell) => `<td>${inline(cell.trim())}</td>`).join('')}</tr>`);
        }
        result.push(`<table><thead><tr>${headers}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      } else if (/^#{1,6}\s/.test(line)) {
        result.push(`<h3>${inline(line.replace(/^#{1,6}\s+/, ''))}</h3>`);
      } else if (/^\s*([-*+] |\d+[.)] )/.test(line)) {
        const ordered = /^\s*\d/.test(line);
        const tag = ordered ? 'ol' : 'ul';
        const items = [line];
        const pattern = ordered ? /^\s*\d+[.)] / : /^\s*[-*+] /;
        while (pattern.test(lines[index + 1] || '')) items.push(lines[++index]);
        result.push(`<${tag}>${items.map((item) => `<li>${inline(item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ''))}</li>`).join('')}</${tag}>`);
      } else if (/^>\s?/.test(line)) {
        result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      } else if (line.trim()) {
        result.push(`<p>${inline(line)}</p>`);
      }
    }
    return result.join('');
  }
  function persistDraft() {
    if (!state.sessionId) return;
    drafts[state.sessionId] = byId('messageInput').value;
    api.setState({ drafts });
    post({ type: 'saveDraft', sessionId: state.sessionId, text: drafts[state.sessionId] });
  }
  function setView(view) {
    persistDraft();
    for (const [id, name] of [['settingsPanel', 'settings'], ['historyPanel', 'history'], ['scrollArea', 'chat'], ['composerArea', 'chat']]) {
      byId(id).inert = view !== name;
      byId(id).setAttribute('aria-hidden', String(view !== name));
    }
    byId('agent').dataset.view = view;
    byId('toggleSettings').setAttribute('aria-expanded', String(view === 'settings'));
    byId('toggleHistory').setAttribute('aria-expanded', String(view === 'history'));
    if (view === 'settings') {
      if (!settingsDirty && !pendingRequest) post({ type: 'getSettings' });
      byId('closeSettings').focus();
    } else if (view === 'history') {
      post({ type: 'listSessions' });
      byId('closeHistory').focus();
    }
  }
  function notice(text) {
    byId('savedNotice').textContent = text;
    byId('savedNotice').classList.add('visible');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => byId('savedNotice').classList.remove('visible'), 2200);
  }
  function scrollBottom() {
    if (byId('agent').dataset.view === 'chat') byId('scrollArea').scrollTop = byId('scrollArea').scrollHeight;
  }
  function hideWelcome() { byId('welcome').hidden = true; }
  function addUser(text) {
    hideWelcome();
    byId('messages').append(node('div', 'message user', text));
    if (byId('threadTitle').hidden) byId('threadTitle').textContent = text.slice(0, 60);
    byId('threadTitle').hidden = false;
    scrollBottom();
  }
  function startAssistant() {
    hideWelcome();
    const root = node('section', 'message assistant');
    root.append(node('div', 'assistant-label', '✦ AI Agent'));
    byId('messages').append(root);
    activeTurn = { root, segment: undefined, segments: [], plan: undefined };
    return activeTurn;
  }
  function segment() {
    if (!activeTurn) startAssistant();
    if (!activeTurn.segment) {
      const body = node('div', 'markdown');
      activeTurn.root.append(body);
      activeTurn.segment = { body, text: '' };
      activeTurn.segments.push(activeTurn.segment);
    }
    return activeTurn.segment;
  }
  function paint() {
    if (paintFrame) cancelAnimationFrame(paintFrame);
    paintFrame = undefined;
    if (activeTurn?.segment) activeTurn.segment.body.innerHTML = markdown(activeTurn.segment.text);
    scrollBottom();
  }
  function setBusy() {
    byId('sendMessage').textContent = state.busy ? '■' : '↑';
    byId('sendMessage').title = state.busy ? '停止当前任务' : '发送（Enter）';
    byId('sendMessage').setAttribute('aria-label', state.busy ? '停止当前任务' : '发送');
    byId('sendMessage').disabled = !state.sessionId || switching || sending;
    byId('runStatus').textContent = state.busy ? '正在处理…' : '';
    byId('undo').hidden = !state.undoCount;
    byId('undo').disabled = state.busy;
    byId('saveSettings').disabled = !!pendingRequest || state.busy;
  }
  function fillSettings(values) {
    settingsValues = values;
    settingsLoaded = true;
    for (const id of ['baseUrl', 'model', 'approvalMode', 'contextWindow', 'maxOutputTokens', 'allowedCommands', 'systemPromptExtra']) byId(id).value = values[id] ?? '';
    byId('autoContext').checked = values.autoContext;
    byId('apiKey').value = '';
    byId('clearKey').checked = false;
    byId('keyState').textContent = values.hasKey ? '已保存' : '未填写';
    settingsDirty = false;
    keyHint();
  }
  function keyHint() {
    const changed = settingsValues && byId('baseUrl').value.trim().replace(/\/+$/, '') !== settingsValues.baseUrl;
    byId('keyHint').textContent = changed && settingsValues.hasKey ? '地址已变化，请填写新 Key；使用本地模型时可在高级设置中清除旧 Key。' : '已保存的 Key 无需重复填写；本地模型可留空。';
  }
  function formValues() {
    const values = {};
    for (const id of ['baseUrl', 'apiKey', 'model', 'approvalMode', 'contextWindow', 'maxOutputTokens', 'allowedCommands', 'systemPromptExtra']) values[id] = byId(id).value;
    values.autoContext = byId('autoContext').checked;
    values.clearKey = byId('clearKey').checked;
    return values;
  }
  function formAction(action) {
    if (pendingRequest || !settingsLoaded) return;
    if (action === 'fetchModels' ? !byId('baseUrl').reportValidity() : !byId('settingsForm').reportValidity()) return;
    const requestId = ++requestSequence;
    pendingRequest = { requestId, action, revision: formRevision };
    byId('formResult').classList.remove('error');
    byId('formResult').textContent = action === 'saveSettings' ? '正在保存…' : action === 'fetchModels' ? '正在获取模型…' : '正在测试连接…';
    for (const id of ['fetchModels', 'testConnection', 'saveSettings']) byId(id).disabled = true;
    post({ type: action, requestId, values: formValues() });
  }
  function renderSessions(message) {
    byId('historyList').replaceChildren();
    const records = message.sessions || [];
    for (const record of records) {
      const button = node('button', 'session-item');
      button.setAttribute('aria-current', String(record.id === message.activeId));
      const date = new Date(record.updatedAt);
      button.append(node('span', '', record.title), node('small', '', date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
      button.onclick = () => {
        if (switching) return;
        if (record.id === state.sessionId) { setView('chat'); byId('messageInput').focus(); return; }
        switching = true;
        persistDraft();
        setBusy();
        post({ type: 'selectSession', id: record.id, draft: byId('messageInput').value });
      };
      byId('historyList').append(button);
    }
    if (!records.length) byId('historyList').append(node('p', 'muted', '还没有历史会话。开始对话后会保存在这里。'));
    const current = records.find((record) => record.id === message.activeId);
    if (current) byId('threadTitle').textContent = current.title;
    const ids = new Set(records.map((record) => record.id).concat(state.sessionId));
    for (const id of Object.keys(drafts)) if (!ids.has(id)) delete drafts[id];
  }
  function approvalCard(request) {
    if (approvals.has(request.id)) return;
    paint();
    if (!activeTurn) startAssistant();
    activeTurn.segment = undefined;
    const card = node('section', 'approval');
    card.append(node('strong', '', '等待你确认'), node('div', '', request.title));
    if (request.command) card.append(node('pre', '', request.command));
    else card.append(node('div', 'muted', `${request.relPath || ''}　+${request.added || 0} −${request.removed || 0}`));
    const actions = node('div', 'row');
    const button = (text, className, handler) => { const element = node('button', className, text); element.onclick = handler; actions.append(element); };
    if (request.canDiff) button('查看修改', 'secondary', () => post({ type: 'openDiff', id: request.id }));
    const respond = (decision) => {
      for (const control of actions.querySelectorAll('button')) control.disabled = true;
      post({ type: 'approvalResponse', id: request.id, decision });
    };
    button(request.kind === 'bash' ? '允许运行' : '允许修改', 'primary', () => respond('allow'));
    button('暂不执行', 'secondary', () => respond('deny'));
    card.append(actions);
    activeTurn.root.append(card);
    approvals.set(request.id, card);
    if (byId('agent').dataset.view === 'chat') scrollBottom();
    notice('有操作正在等待确认');
  }
  function receive(message) {
    switch (message.type) {
      case 'state': {
        const { sessionId, ...details } = message;
        Object.assign(state, details);
        if (message.busy === false) sending = false;
        byId('composerModel').textContent = state.configured ? state.model : '请先配置模型';
        byId('connectionDot').classList.toggle('off', !state.configured);
        if (message.contextLabel !== undefined) byId('showContext').textContent = message.contextLabel;
        byId('footnote').textContent = state.mode === 'readOnly' ? '只读模式 · Enter 发送 · Shift + Enter 换行' : state.mode === 'autoEdit' || state.autoEdits ? '命令执行前确认 · Enter 发送' : '修改前会请你确认 · Enter 发送';
        if (message.models) {
          byId('modelList').replaceChildren(...message.models.map((model) => { const option = node('option'); option.value = model; return option; }));
        }
        setBusy();
        break;
      }
      case 'history': {
        const changed = displayedSessionId !== message.sessionId;
        displayedSessionId = message.sessionId;
        state.sessionId = message.sessionId;
        byId('messages').replaceChildren();
        tools.clear(); approvals.clear(); activeTurn = undefined;
        if (paintFrame) cancelAnimationFrame(paintFrame);
        paintFrame = undefined;
        byId('welcome').hidden = !!message.messages?.length;
        byId('threadTitle').hidden = !message.messages?.length;
        for (const item of message.messages || []) {
          if (item.role === 'user') addUser(item.content);
          else { startAssistant(); segment().text = item.content; paint(); activeTurn = undefined; }
        }
        if (changed || !byId('messageInput').value) byId('messageInput').value = drafts[message.sessionId] ?? message.draft ?? '';
        switching = false; sending = false;
        setView('chat'); setBusy(); scrollBottom();
        break;
      }
      case 'sessions': renderSessions(message); break;
      case 'user':
        sending = false;
        if (!message.replay) {
          byId('messageInput').value = '';
          drafts[state.sessionId] = '';
          persistDraft();
        }
        addUser(message.text);
        setBusy();
        break;
      case 'assistantStart': startAssistant(); break;
      case 'textDelta': segment().text += message.text; if (!paintFrame) paintFrame = requestAnimationFrame(paint); break;
      case 'textReset':
        if (activeTurn) { for (const part of activeTurn.segments) part.body.remove(); activeTurn.segments = []; activeTurn.segment = undefined; }
        break;
      case 'assistantEnd':
        if (message.text) segment().text = message.text;
        paint();
        if (activeTurn && message.meta) activeTurn.root.append(node('div', 'meta', message.meta));
        activeTurn = undefined;
        break;
      case 'toolStart': {
        paint();
        if (!activeTurn) startAssistant();
        activeTurn.segment = undefined;
        const tool = node('details', 'tool');
        tool.append(node('summary', '', `处理中 · ${message.label || message.name}`));
        activeTurn.root.append(tool); tools.set(message.id, tool); scrollBottom();
        break;
      }
      case 'toolEnd': {
        const tool = tools.get(message.id);
        if (tool) {
          tool.querySelector('summary').textContent = `${message.ok ? '✓' : '×'} ${tool.querySelector('summary').textContent.replace(/^处理中 · /, '')} ${message.summary || ''}`;
          if (message.output) tool.append(node('pre', '', message.output));
        }
        break;
      }
      case 'plan':
        paint();
        if (!activeTurn) startAssistant();
        if (!activeTurn.plan) { activeTurn.plan = node('div', 'plan'); activeTurn.root.append(activeTurn.plan); }
        activeTurn.plan.replaceChildren(...(message.steps || []).map((step) => node('div', '', `${step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○'} ${step.step}`)));
        break;
      case 'approval': approvalCard(message.request); break;
      case 'approvalDone': {
        const card = approvals.get(message.id);
        if (card) { card.replaceChildren(node('div', 'muted', message.decision === 'deny' ? '已暂缓执行' : '✓ 已允许')); approvals.delete(message.id); }
        break;
      }
      case 'changes': {
        const changes = node('div', 'muted', '本次修改：');
        for (const file of message.files || []) {
          const link = node('button', 'text-button', file);
          link.onclick = () => post({ type: 'openFile', ref: file });
          changes.append(node('br'), link);
        }
        byId('messages').append(changes); scrollBottom(); break;
      }
      case 'context': byId('showContext').textContent = message.label; break;
      case 'info': byId('runStatus').textContent = message.message; break;
      case 'notice': notice(message.text); break;
      case 'sessionSwitchFailed': switching = false; setBusy(); notice(message.message); break;
      case 'error':
        sending = false; switching = false; setBusy();
        byId('messages').append(node('div', 'message error', message.message)); hideWelcome(); scrollBottom(); break;
      case 'settingsData': if (!settingsLoaded || !settingsDirty) fillSettings(message.values); break;
      case 'settingsResult': {
        if (!pendingRequest || message.requestId !== pendingRequest.requestId) break;
        const request = pendingRequest; pendingRequest = undefined;
        for (const id of ['fetchModels', 'testConnection']) byId(id).disabled = false;
        setBusy();
        const changed = request.revision !== formRevision;
        byId('formResult').textContent = changed ? '表单已变更，请使用当前内容重新操作。' : message.message;
        byId('formResult').classList.toggle('error', !message.ok);
        if (message.models && !changed) byId('modelList').replaceChildren(...message.models.map((model) => { const option = node('option'); option.value = model; return option; }));
        if (message.ok && message.action === 'saveSettings' && !changed) {
          fillSettings(message.values); setView('chat'); byId('messageInput').focus(); notice('✓ 设置已保存');
        }
        break;
      }
      case 'showPanel': setView(message.panel === 'history' ? 'history' : 'settings'); break;
      case 'cleared': sending = false; activeTurn = undefined; break;
    }
  }
  byId('toggleSettings').onclick = () => setView(byId('agent').dataset.view === 'settings' ? 'chat' : 'settings');
  byId('toggleHistory').onclick = () => setView(byId('agent').dataset.view === 'history' ? 'chat' : 'history');
  byId('closeSettings').onclick = () => { setView('chat'); byId('toggleSettings').focus(); };
  byId('closeHistory').onclick = () => { setView('chat'); byId('toggleHistory').focus(); };
  byId('newChat').onclick = () => {
    if (switching) return;
    persistDraft(); switching = true; setBusy();
    post({ type: 'newSession', draft: byId('messageInput').value });
  };
  byId('showContext').onclick = () => post({ type: 'showContext' });
  byId('undo').onclick = () => post({ type: 'undo' });
  byId('settingsForm').oninput = () => { settingsDirty = true; formRevision++; keyHint(); };
  byId('settingsForm').onsubmit = (event) => { event.preventDefault(); formAction('saveSettings'); };
  byId('fetchModels').onclick = () => formAction('fetchModels');
  byId('testConnection').onclick = () => formAction('testConnection');
  function send() {
    if (state.busy) { post({ type: 'stop' }); return; }
    if (sending || switching || !state.sessionId) return;
    if (!state.configured) { setView('settings'); return; }
    const text = byId('messageInput').value.trim();
    if (!text) return;
    persistDraft(); sending = true; setBusy(); post({ type: 'send', text });
  }
  byId('sendMessage').onclick = send;
  byId('messageInput').oninput = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 250);
    drafts[state.sessionId] = byId('messageInput').value;
    api.setState({ drafts });
  };
  byId('messageInput').onkeydown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.busy) send(); }
  };
  document.querySelectorAll('[data-prompt]').forEach((button) => {
    button.onclick = () => { byId('messageInput').value = button.dataset.prompt; persistDraft(); byId('messageInput').focus(); };
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && byId('agent').dataset.view !== 'chat') { setView('chat'); byId('messageInput').focus(); }
    const reference = event.target.closest?.('[data-ref]');
    if (reference && event.key === 'Enter') post({ type: 'openFile', ref: reference.dataset.ref });
  });
  byId('messages').onclick = (event) => {
    const reference = event.target.closest('[data-ref]');
    if (reference) post({ type: 'openFile', ref: reference.dataset.ref });
    const link = event.target.closest('a');
    if (link) { event.preventDefault(); post({ type: 'openExternal', url: link.getAttribute('href') }); }
  };
  window.addEventListener('message', (event) => receive(event.data || {}));
  post({ type: 'ready' });
})();
