const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('btnSend');
const stopBtn = document.getElementById('btnStop');
const statusEl = document.getElementById('statusHint');
const modelChip = document.getElementById('modelChip');
const modeChip = document.getElementById('modeChip');
const ctxText = document.getElementById('ctxText');
const ctxDot = document.getElementById('ctxDot');
const platformText = document.getElementById('platformText');
const platformDot = document.getElementById('platformDot');

let busy = false;
/** 当前正在流式输出的文本段；遇到工具调用、审批卡片后置空，后续文本另起一段，保持时间顺序 */
let currentSeg = null;
let planEl = null;
const tools = new Map();
const approvals = new Map();

const TOOL_ICONS = {
  read: '📄',
  grep: '🔍',
  find: '🔍',
  ls: '📁',
  edit: '✏️',
  write: '📝',
  bash: '▶',
  get_diagnostics: '🩺',
  update_plan: '📋'
};

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(raw) {
  const blocks = [];
  let text = raw.replace(/```(\w*)\n([\s\S]*?)(```|$)/g, function (_, lang, code) {
    const idx = blocks.length;
    blocks.push('<pre><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000BLOCK' + idx + '\u0000';
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');

  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, function (_, i) {
    return blocks[Number(i)];
  });
  return text;
}

function hideEmpty() {
  const node = document.getElementById('emptyState');
  if (node && node.parentNode) {
    node.remove();
  }
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function addMessage(kind, text) {
  hideEmpty();
  const node = el('div', 'msg ' + kind);
  node.innerHTML = renderMarkdown(text);
  messagesEl.appendChild(node);
  scrollBottom();
  return node;
}

function newSeg() {
  hideEmpty();
  const node = el('div', 'msg assistant');
  messagesEl.appendChild(node);
  currentSeg = { el: node, raw: '' };
  return currentSeg;
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  stopBtn.classList.toggle('hidden', !value);
  sendBtn.classList.toggle('hidden', value);
  statusEl.textContent = value ? 'Agent 工作中…' : '就绪';
  inputEl.placeholder = value
    ? 'Agent 工作中，可点击停止…'
    : '让 Agent 帮你理解、修改或调试代码…（Enter 发送，Shift+Enter 换行）';
}

function send() {
  const text = inputEl.value.trim();
  if (!text || busy) {
    return;
  }
  vscode.postMessage({ type: 'send', text });
  inputEl.value = '';
  inputEl.style.height = '';
}

// ---------------- 工具调用 ----------------

function onToolStart(msg) {
  currentSeg = null;
  hideEmpty();
  const row = el('div', 'tool running');
  const head = el('div', 'tool-head');
  head.appendChild(el('span', 'tool-icon', TOOL_ICONS[msg.name] || '⚙'));
  head.appendChild(el('span', 'tool-label', msg.label));
  const state = el('span', 'tool-state', '进行中…');
  head.appendChild(state);
  row.appendChild(head);
  messagesEl.appendChild(row);
  tools.set(msg.id, { row: row, state: state });
  scrollBottom();
}

function onToolEnd(msg) {
  const t = tools.get(msg.id);
  if (!t) {
    return;
  }
  t.row.classList.remove('running');
  t.row.classList.add(msg.ok ? 'ok' : 'fail');
  t.state.textContent = msg.ok ? '✓ ' + (msg.summary || '完成') : '✗ ' + (msg.summary || '失败');
  if (msg.ok && msg.output && (msg.name === 'bash' || msg.name === 'get_diagnostics')) {
    const details = el('details', 'tool-out');
    details.appendChild(el('summary', '', '查看输出'));
    details.appendChild(el('pre', '', msg.output));
    t.row.appendChild(details);
  }
  tools.delete(msg.id);
  scrollBottom();
}

// ---------------- 计划 ----------------

function renderPlan(steps) {
  if (!planEl || !planEl.isConnected) {
    currentSeg = null;
    hideEmpty();
    planEl = el('div', 'plan');
    messagesEl.appendChild(planEl);
  }
  planEl.innerHTML = '';
  planEl.appendChild(el('div', 'plan-title', '任务计划'));
  steps.forEach(function (s) {
    const icon = s.status === 'completed' ? '☑' : s.status === 'in_progress' ? '▶' : '☐';
    const row = el('div', 'plan-step ' + s.status);
    row.appendChild(el('span', 'plan-icon', icon));
    row.appendChild(el('span', '', s.step));
    planEl.appendChild(row);
  });
  scrollBottom();
}

// ---------------- 审批 ----------------

function respond(id, decision) {
  const a = approvals.get(id);
  if (!a || a.done) {
    return;
  }
  a.done = true;
  a.actions.querySelectorAll('button').forEach(function (b) {
    b.disabled = true;
  });
  vscode.postMessage({ type: 'approvalResponse', id: id, decision: decision });
}

function addAction(container, label, cls, handler) {
  const b = el('button', cls, label);
  b.addEventListener('click', handler);
  container.appendChild(b);
  return b;
}

function onApproval(msg) {
  currentSeg = null;
  hideEmpty();
  const r = msg.request;
  const card = el('div', 'approval');
  const icon = r.kind === 'bash' ? '▶' : r.kind === 'write' ? '📝' : '✏️';
  const title = el('div', 'ap-title');
  title.appendChild(el('span', 'tool-icon', icon));
  title.appendChild(el('span', '', ' ' + r.title));
  if (r.kind !== 'bash') {
    const stat = r.isNewFile
      ? '新文件 · ' + (r.added || 0) + ' 行'
      : '+' + (r.added || 0) + ' −' + (r.removed || 0);
    title.appendChild(el('span', 'ap-stat', stat));
  }
  card.appendChild(title);

  if (r.kind === 'bash') {
    card.appendChild(el('pre', 'ap-cmd', r.command || ''));
    card.appendChild(el('div', 'ap-cwd', '工作目录：' + (r.cwd || '')));
  } else {
    card.appendChild(el('div', 'ap-cwd', 'Diff 已在编辑器中打开，确认后才会写入文件。'));
  }

  const actions = el('div', 'ap-actions');
  if (r.canDiff) {
    addAction(actions, '查看 Diff', 'link', function () {
      vscode.postMessage({ type: 'openDiff', id: r.id });
    });
  }
  addAction(actions, '允许', 'primary', function () {
    respond(r.id, 'allow');
  });
  addAction(actions, '拒绝', 'secondary', function () {
    respond(r.id, 'deny');
  });
  if (r.kind !== 'bash') {
    addAction(actions, '本次会话全部允许', 'link', function () {
      respond(r.id, 'allowAllEdits');
    });
  }
  card.appendChild(actions);
  messagesEl.appendChild(card);
  approvals.set(r.id, { card: card, actions: actions, done: false });
  scrollBottom();
}

function onApprovalDone(msg) {
  const a = approvals.get(msg.id);
  if (!a) {
    return;
  }
  a.done = true;
  const label =
    msg.decision === 'allow'
      ? '✓ 已允许'
      : msg.decision === 'allowAllEdits'
        ? '✓ 已允许（本次会话后续修改自动允许）'
        : '✗ 已拒绝';
  a.actions.innerHTML = '';
  a.actions.appendChild(el('span', 'ap-result ' + (msg.decision === 'deny' ? 'deny' : 'allow'), label));
  a.card.classList.add('decided');
  approvals.delete(msg.id);
}

// ---------------- 修改汇总 ----------------

function onChanges(msg) {
  currentSeg = null;
  const card = el('div', 'changes');
  card.appendChild(el('div', 'ap-title', '本次修改了 ' + msg.files.length + ' 个文件'));
  const list = el('ul', 'changes-list');
  msg.files.slice(0, 12).forEach(function (f) {
    list.appendChild(el('li', '', f));
  });
  if (msg.files.length > 12) {
    list.appendChild(el('li', '', '…另有 ' + (msg.files.length - 12) + ' 个'));
  }
  card.appendChild(list);
  const actions = el('div', 'ap-actions');
  addAction(actions, '撤销本次修改', 'secondary', function (event) {
    event.target.disabled = true;
    vscode.postMessage({ type: 'undo' });
  });
  card.appendChild(actions);
  messagesEl.appendChild(card);
  scrollBottom();
}

// ---------------- 事件绑定 ----------------

sendBtn.addEventListener('click', send);
stopBtn.addEventListener('click', function () {
  vscode.postMessage({ type: 'stop' });
});

inputEl.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

inputEl.addEventListener('input', function () {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});

document.getElementById('btnNew').addEventListener('click', function () {
  vscode.postMessage({ type: 'newSession' });
});
document.getElementById('btnClear').addEventListener('click', function () {
  vscode.postMessage({ type: 'clearSession' });
});
document.getElementById('btnSettings').addEventListener('click', function () {
  vscode.postMessage({ type: 'openSettings' });
});
document.getElementById('btnCtx').addEventListener('click', function () {
  vscode.postMessage({ type: 'showContext' });
});
document.getElementById('btnPlatform').addEventListener('click', function () {
  vscode.postMessage({ type: 'refreshPlatform' });
});
modelChip.addEventListener('click', function () {
  vscode.postMessage({ type: 'openSettings' });
});
modeChip.addEventListener('click', function () {
  vscode.postMessage({ type: 'pickMode' });
});

document.getElementById('quick').addEventListener('click', function (event) {
  const target = event.target;
  if (!target || target.tagName !== 'BUTTON') {
    return;
  }
  vscode.postMessage({ type: 'quickAction', action: target.dataset.action });
});

function emptyStateHtml() {
  return (
    '<p class="empty-title">AI Coding Agent</p>' +
    '<p class="empty-sub">告诉我你想做什么：解释代码、修复错误、补充测试、实现功能。我会自己查看代码、修改文件并运行验证。</p>' +
    '<ul class="empty-list">' +
    '<li><kbd>Ctrl+Alt+I</kbd> 打开对话</li>' +
    '<li><kbd>Ctrl+Alt+E</kbd> 解释选中代码</li>' +
    '<li>每次修改都会先打开 Diff，由你确认后才写入</li>' +
    '<li>改错了可以点「撤销本次修改」</li>' +
    '</ul>'
  );
}

window.addEventListener('message', function (event) {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
    case 'state':
      if (msg.model) {
        modelChip.textContent = msg.model;
        modelChip.title = msg.provider + ' · 点击修改模型';
      }
      if (msg.modeLabel) {
        modeChip.textContent = msg.modeLabel;
        modeChip.dataset.mode = msg.mode || '';
      }
      if (msg.contextLabel) {
        ctxText.textContent = msg.contextLabel;
      }
      ctxDot.classList.toggle('warn', !!msg.contextWarn);
      if (msg.platformStatus) {
        platformText.textContent =
          msg.platformStatus +
          (msg.sessionCount ? ' · 会话 ' + msg.sessionCount + ' 条' : '') +
          (msg.undoCount ? ' · 可回退 ' + msg.undoCount + ' 次' : '');
        platformDot.classList.toggle(
          'warn',
          msg.platformStatus.indexOf('未配置') >= 0 || msg.platformStatus.indexOf('未连接') >= 0
        );
      }
      setBusy(!!msg.busy);
      break;
    case 'context':
      ctxText.textContent = msg.label;
      ctxDot.classList.toggle('warn', !!msg.warn);
      break;
    case 'user':
      currentSeg = null;
      planEl = null;
      addMessage('user', msg.text);
      break;
    case 'assistantStart':
      currentSeg = null;
      planEl = null;
      break;
    case 'textDelta': {
      const seg = currentSeg || newSeg();
      seg.raw += msg.text;
      seg.el.innerHTML = renderMarkdown(seg.raw);
      scrollBottom();
      break;
    }
    case 'textReset':
      if (currentSeg) {
        currentSeg.el.remove();
        currentSeg = null;
      }
      break;
    case 'toolStart':
      onToolStart(msg);
      break;
    case 'toolEnd':
      onToolEnd(msg);
      break;
    case 'plan':
      renderPlan(msg.steps || []);
      break;
    case 'approval':
      onApproval(msg);
      break;
    case 'approvalDone':
      onApprovalDone(msg);
      break;
    case 'changes':
      onChanges(msg);
      break;
    case 'assistantEnd':
      currentSeg = null;
      // 任务结束后，仍在进行中的工具行（被中止）标记为已停止
      tools.forEach(function (t) {
        t.row.classList.remove('running');
        t.row.classList.add('fail');
        t.state.textContent = '— 已停止';
      });
      tools.clear();
      if (msg.meta) {
        messagesEl.appendChild(el('div', 'run-meta', msg.meta));
      }
      scrollBottom();
      break;
    case 'error':
      addMessage('error', msg.message);
      break;
    case 'notice':
      addMessage('notice', msg.text);
      break;
    case 'info':
      statusEl.textContent = msg.message;
      break;
    case 'cleared': {
      messagesEl.innerHTML = '';
      tools.clear();
      approvals.clear();
      currentSeg = null;
      planEl = null;
      const empty = el('div', 'empty');
      empty.id = 'emptyState';
      empty.innerHTML = emptyStateHtml();
      messagesEl.appendChild(empty);
      break;
    }
    default:
      break;
  }
});

vscode.postMessage({ type: 'ready' });
