const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('btnSend');
const stopBtn = document.getElementById('btnStop');
const statusEl = document.getElementById('statusHint');
const modelChip = document.getElementById('modelChip');
const ctxText = document.getElementById('ctxText');
const ctxDot = document.getElementById('ctxDot');
const platformText = document.getElementById('platformText');
const platformDot = document.getElementById('platformDot');

let busy = false;
const nodes = new Map();

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(raw) {
  const blocks = [];
  let text = raw.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
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

function addMessage(kind, text) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.innerHTML = renderMarkdown(text);
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  stopBtn.classList.toggle('hidden', !value);
  sendBtn.classList.toggle('hidden', value);
  statusEl.textContent = value ? '正在生成…' : '就绪';
  inputEl.placeholder = value ? '正在生成，可点击停止…' : '询问 AI Coding Agent…（Enter 发送，Shift+Enter 换行）';
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

sendBtn.addEventListener('click', send);

stopBtn.addEventListener('click', function () {
  vscode.postMessage({ type: 'stop' });
});

inputEl.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.shiftKey) {
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

document.getElementById('quick').addEventListener('click', function (event) {
  const target = event.target;
  if (!target || target.tagName !== 'BUTTON') {
    return;
  }
  vscode.postMessage({ type: 'quickAction', action: target.dataset.action });
});

window.addEventListener('message', function (event) {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
    case 'state':
      if (msg.model) {
        modelChip.textContent = msg.model;
        modelChip.title = msg.provider + ' · 点击修改模型';
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
      addMessage('user', msg.text);
      break;
    case 'assistantStart': {
      const el = addMessage('assistant', '');
      el.dataset.id = msg.id;
      nodes.set(msg.id, { el: el, raw: '' });
      break;
    }
    case 'assistantDelta': {
      const node = nodes.get(msg.id);
      if (!node) {
        break;
      }
      node.raw += msg.text;
      node.el.innerHTML = renderMarkdown(node.raw);
      scrollBottom();
      break;
    }
    case 'assistantEnd': {
      const node = nodes.get(msg.id);
      if (node) {
        node.el.innerHTML = renderMarkdown(msg.text || node.raw);
        if (msg.meta) {
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = msg.meta;
          node.el.appendChild(meta);
        }
        nodes.delete(msg.id);
      }
      scrollBottom();
      break;
    }
    case 'error':
      addMessage('error', msg.message);
      break;
    case 'notice':
      addMessage('notice', msg.text);
      break;
    case 'info':
      statusEl.textContent = msg.message;
      break;
    case 'cleared':
      messagesEl.innerHTML = '';
      nodes.clear();
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.id = 'emptyState';
      empty.innerHTML =
        '<p class="empty-title">AI Coding Agent</p>' +
        '<p class="empty-sub">选中代码后提问，或直接从下方快捷操作开始。</p>' +
        '<ul class="empty-list">' +
        '<li><kbd>Ctrl+Alt+I</kbd> 打开对话</li>' +
        '<li><kbd>Ctrl+Alt+E</kbd> 解释选中代码</li>' +
        '<li>代码修改会先打开 Diff，确认后写入</li>' +
        '</ul>';
      messagesEl.appendChild(empty);
      break;
    default:
      break;
  }
});

vscode.postMessage({ type: 'ready' });
