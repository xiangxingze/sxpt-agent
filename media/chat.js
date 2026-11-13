const vscode = acquireVsCodeApi();

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('btnSend');
const stopBtn = $('btnStop');
const statusEl = $('statusHint');
const modelSelect = $('modelSelect');
const modeSelect = $('modeSelect');
const chatView = $('chatView');
const settingsView = $('settingsView');

let busy = false;
let configured = false;
let currentModel = '';
let currentModels = [];
let autoEdits = false;
/** 当前正在流式输出的文本段；遇到工具调用、审批卡片后置空，后续文本另起一段，保持时间顺序 */
let currentSeg = null;
let planEl = null;
let emptyEl = null;
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

const SUGGESTIONS = [
  { action: 'explain', label: '解释选中代码', hint: '先选中一段代码' },
  { action: 'problem', label: '分析错误', hint: '读取问题面板并说明原因' },
  { action: 'fix', label: '修复问题', hint: '定位、修改并运行验证' },
  { action: 'tests', label: '生成测试', hint: '为选中代码编写并运行测试' },
  { action: 'project', label: '理解项目结构', hint: '概述目录与模块' },
  { action: 'refactor', label: '重构选中代码', hint: '给出方案并修改' }
];

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmpty() {
  if (emptyEl && emptyEl.parentNode) {
    emptyEl.remove();
  }
  emptyEl = null;
}

/* ------------------------------------------------------------------ */
/* Markdown 渲染（先整体转义，再生成标签，输入中的 HTML 一律当文本）        */
/* ------------------------------------------------------------------ */

const FILE_REF = /^[\w@.\\/-]+\.[A-Za-z0-9]{1,8}(:\d+(:\d+)?)?$/;

function renderInline(raw) {
  const codes = [];
  let text = escapeHtml(raw).replace(/`([^`\n]+)`/g, function (_, code) {
    const decoded = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const isRef = FILE_REF.test(decoded) && decoded.indexOf('//') < 0;
    const html = isRef
      ? '<code class="fileref" data-ref="' + code + '" title="在编辑器中打开">' + code + '</code>'
      : '<code>' + code + '</code>';
    codes.push(html);
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  return text.replace(/\u0000C(\d+)\u0000/g, function (_, i) {
    return codes[Number(i)];
  });
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function buildList(items) {
  let html = '';
  const stack = [];
  items.forEach(function (it) {
    const tag = it.ordered ? 'ol' : 'ul';
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      html += '<' + tag + '>';
      stack.push({ indent: it.indent, tag: tag });
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        html += '</li></' + stack.pop().tag + '>';
      }
      html += '</li>';
    }
    html += '<li>' + renderInline(it.text).replace(/\n/g, '<br>');
  });
  while (stack.length) {
    html += '</li></' + stack.pop().tag + '>';
  }
  return html;
}

function splitRow(line) {
  let row = line.trim();
  if (row.charAt(0) === '|') {
    row = row.slice(1);
  }
  if (row.charAt(row.length - 1) === '|') {
    row = row.slice(0, -1);
  }
  return row.split('|').map(function (c) {
    return c.trim();
  });
}

function codeBlockHtml(lang, code) {
  return (
    '<div class="code"><div class="code-head"><span class="lang">' +
    escapeHtml(lang || 'code') +
    '</span><button class="copy" type="button">复制</button></div><pre><code>' +
    escapeHtml(code) +
    '</code></pre></div>'
  );
}

function isBlockStart(line, next) {
  return (
    /^\u0000CODE\d+\u0000$/.test(line.trim()) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line) ||
    /^\s*>/.test(line) ||
    LIST_ITEM.test(line) ||
    (line.indexOf('|') >= 0 && next !== undefined && TABLE_SEP.test(next))
  );
}

function renderMarkdown(src) {
  const blocks = [];
  // 围栏代码块；流式输出时尚未闭合的代码块也先按代码块展示
  const text = String(src).replace(
    /(^|\n)```([^\n`]*)\n([\s\S]*?)(\n```[ \t]*(?=\n|$)|$)/g,
    function (_, pre, lang, code) {
      blocks.push(codeBlockHtml(lang.trim(), code));
      return pre + '\u0000CODE' + (blocks.length - 1) + '\u0000';
    }
  );

  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const codeM = /^\u0000CODE(\d+)\u0000$/.exec(trimmed);
    if (codeM) {
      out.push(blocks[Number(codeM[1])]);
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 5);
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderInline(quote.join('\n')).replace(/\n/g, '<br>') + '</blockquote>');
      continue;
    }
    if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let html = '<div class="table-wrap"><table><thead><tr>';
      head.forEach(function (c) {
        html += '<th>' + renderInline(c) + '</th>';
      });
      html += '</tr></thead><tbody>';
      rows.forEach(function (r) {
        html += '<tr>';
        head.forEach(function (_, idx) {
          html += '<td>' + renderInline(r[idx] || '') + '</td>';
        });
        html += '</tr>';
      });
      out.push(html + '</tbody></table></div>');
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m) {
          break;
        }
        items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
          items[items.length - 1].text += '\n' + lines[i].trim();
          i++;
        }
      }
      out.push(buildList(items));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) {
      para.push(lines[i]);
      i++;
    }
    out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
  }
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

function addMessage(kind, text) {
  hideEmpty();
  const node = el('div', 'msg ' + kind);
  if (kind === 'user') {
    node.textContent = text;
  } else {
    node.innerHTML = renderMarkdown(text);
  }
  messagesEl.appendChild(node);
  scrollBottom();
  return node;
}

function newSeg() {
  hideEmpty();
  const node = el('div', 'msg assistant md');
  messagesEl.appendChild(node);
  currentSeg = { el: node, raw: '' };
  return currentSeg;
}

function renderEmpty() {
  hideEmpty();
  const box = el('div', 'empty');
  if (!configured) {
    box.appendChild(el('p', 'empty-title', '先连接一个模型服务'));
    box.appendChild(
      el('p', 'empty-sub', '填写 API 地址、API Key，并从接口返回的列表里选择模型，就可以开始使用。')
    );
    const go = el('button', 'primary wide', '前往设置');
    go.addEventListener('click', openSettings);
    box.appendChild(go);
  } else {
    box.appendChild(el('p', 'empty-title', '有什么可以帮你？'));
    box.appendChild(
      el('p', 'empty-sub', '描述你的任务，我会自己查看代码、修改文件、运行命令并验证。每次修改都先经你确认。')
    );
    const grid = el('div', 'suggest');
    SUGGESTIONS.forEach(function (s) {
      const b = el('button', 'suggest-btn');
      b.dataset.action = s.action;
      b.appendChild(el('span', 'suggest-label', s.label));
      b.appendChild(el('span', 'suggest-hint', s.hint));
      grid.appendChild(b);
    });
    box.appendChild(grid);
  }
  messagesEl.appendChild(box);
  emptyEl = box;
}

function setBusy(value) {
  busy = value;
  stopBtn.classList.toggle('hidden', !value);
  sendBtn.classList.toggle('hidden', value);
  refreshStatus();
}

function refreshStatus() {
  if (busy) {
    return;
  }
  statusEl.textContent = autoEdits ? '就绪 · 本次会话自动允许文件修改' : '就绪';
}

function send() {
  const text = inputEl.value.trim();
  if (!text || busy) {
    return;
  }
  vscode.postMessage({ type: 'send', text: text });
  inputEl.value = '';
  autoGrow();
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}

/* ------------------------------------------------------------------ */
/* 模型 / 模式选择                                                      */
/* ------------------------------------------------------------------ */

function fillModelSelect() {
  modelSelect.innerHTML = '';
  const list = [];
  if (currentModel) {
    list.push(currentModel);
  }
  currentModels.forEach(function (m) {
    if (list.indexOf(m) < 0) {
      list.push(m);
    }
  });
  if (list.length === 0) {
    const none = el('option', '', '未配置模型');
    none.value = '';
    modelSelect.appendChild(none);
  }
  list.forEach(function (m) {
    const o = el('option', '', m);
    o.value = m;
    modelSelect.appendChild(o);
  });
  const manage = el('option', '', '管理模型…');
  manage.value = '__settings';
  modelSelect.appendChild(manage);
  modelSelect.value = currentModel || '';
}

modelSelect.addEventListener('change', function () {
  if (modelSelect.value === '__settings' || modelSelect.value === '') {
    modelSelect.value = currentModel || '';
    openSettings();
    return;
  }
  currentModel = modelSelect.value;
  vscode.postMessage({ type: 'setModel', model: currentModel });
});

modeSelect.addEventListener('change', function () {
  vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
});

/* ------------------------------------------------------------------ */
/* 工具调用 / 计划 / 审批 / 汇总                                          */
/* ------------------------------------------------------------------ */

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
  addAction(actions, '允许', 'primary', function () {
    respond(r.id, 'allow');
  });
  addAction(actions, '拒绝', 'secondary', function () {
    respond(r.id, 'deny');
  });
  if (r.canDiff) {
    addAction(actions, '查看 Diff', 'link', function () {
      vscode.postMessage({ type: 'openDiff', id: r.id });
    });
  }
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

/* ------------------------------------------------------------------ */
/* 设置页                                                              */
/* ------------------------------------------------------------------ */

const F = {
  baseUrl: $('setBaseUrl'),
  apiKey: $('setApiKey'),
  model: $('setModel'),
  allowed: $('setAllowed'),
  contextWindow: $('setContextWindow'),
  maxOutput: $('setMaxOutput'),
  autoContext: $('setAutoContext'),
  extra: $('setExtra')
};
let hasKey = false;
let clearKey = false;
/** 已保存的 API 地址：只有与它一致的模型列表才会进入输入框下方的模型选择 */
let savedBaseUrl = '';
let fetchTimer = null;

function showView(name) {
  chatView.classList.toggle('hidden', name !== 'chat');
  settingsView.classList.toggle('hidden', name !== 'settings');
}

function openSettings() {
  showView('settings');
  clearErrors();
  $('saveMsg').textContent = '';
  vscode.postMessage({ type: 'settingsOpen' });
}

function closeSettings() {
  showView('chat');
  inputEl.focus();
}

function clearErrors() {
  document.querySelectorAll('.err').forEach(function (e) {
    e.textContent = '';
  });
}

function fillDatalist(models) {
  const list = $('modelList');
  list.innerHTML = '';
  models.forEach(function (m) {
    const o = document.createElement('option');
    o.value = m;
    list.appendChild(o);
  });
}

function updateKeyState() {
  $('keyState').textContent = clearKey ? '（保存后将清除）' : hasKey ? '（已保存，留空表示不修改）' : '';
  $('btnClearKey').classList.toggle('hidden', !hasKey || clearKey);
}

function setHint(text, isError) {
  const hint = $('modelHint');
  hint.textContent = text || '';
  hint.classList.toggle('bad', !!isError);
}

function validBaseUrl(v) {
  return /^https?:\/\/[^\s/]+/i.test(v.trim());
}

function requestModels() {
  const baseUrl = F.baseUrl.value.trim();
  if (!validBaseUrl(baseUrl)) {
    setHint('请先填写正确的 API 地址（以 http:// 或 https:// 开头）。', true);
    return;
  }
  $('btnFetch').disabled = true;
  setHint('正在获取模型列表…', false);
  vscode.postMessage({ type: 'fetchModels', baseUrl: baseUrl, apiKey: F.apiKey.value });
}

/** 地址或 Key 改动后稍作等待，自动拉取一次模型列表 */
function scheduleAutoFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(function () {
    if (validBaseUrl(F.baseUrl.value) && (F.apiKey.value.trim() || hasKey || /localhost|127\.0\.0\.1/.test(F.baseUrl.value))) {
      requestModels();
    }
  }, 700);
}

function onSettingsData(msg) {
  const v = msg.values || {};
  F.baseUrl.value = v.baseUrl || '';
  savedBaseUrl = v.baseUrl || '';
  F.apiKey.value = '';
  F.model.value = v.model || '';
  F.allowed.value = v.allowedCommands || '';
  F.contextWindow.value = v.contextWindow || 128000;
  F.maxOutput.value = v.maxOutputTokens || 8192;
  F.autoContext.checked = v.autoContext !== false;
  F.extra.value = v.systemPromptExtra || '';
  document.querySelectorAll('input[name="approvalMode"]').forEach(function (r) {
    r.checked = r.value === (v.approvalMode || 'ask');
  });
  hasKey = !!msg.hasKey;
  clearKey = false;
  updateKeyState();
  fillDatalist(msg.models || []);
  $('setupBanner').classList.toggle('hidden', !!msg.configured);
  setHint((msg.models || []).length ? '已获取 ' + msg.models.length + ' 个模型，点击输入框选择，也可以手动输入。' : '', false);
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
}

function onModels(msg) {
  $('btnFetch').disabled = false;
  if (msg.ok) {
    if (msg.silent || msg.baseUrl === savedBaseUrl) {
      currentModels = msg.models;
      fillModelSelect();
    }
    if (msg.baseUrl === F.baseUrl.value.trim().replace(/\/+$/, '')) {
      fillDatalist(msg.models);
      setHint('已获取 ' + msg.models.length + ' 个模型，点击输入框选择，也可以手动输入。', false);
      if (!F.model.value.trim() && msg.models.length) {
        F.model.value = msg.models[0];
      }
    }
  } else if (!msg.silent) {
    setHint(msg.message || '获取模型列表失败，请手动输入模型名称。', true);
  }
}

function collectValues() {
  const mode = document.querySelector('input[name="approvalMode"]:checked');
  return {
    baseUrl: F.baseUrl.value.trim(),
    model: F.model.value.trim(),
    approvalMode: mode ? mode.value : 'ask',
    allowedCommands: F.allowed.value,
    contextWindow: F.contextWindow.value,
    maxOutputTokens: F.maxOutput.value,
    autoContext: F.autoContext.checked,
    systemPromptExtra: F.extra.value
  };
}

$('btnSave').addEventListener('click', function () {
  clearErrors();
  $('saveMsg').textContent = '';
  vscode.postMessage({
    type: 'settingsSave',
    values: collectValues(),
    apiKey: F.apiKey.value,
    clearKey: clearKey
  });
});
$('btnCancel').addEventListener('click', closeSettings);
$('btnBack').addEventListener('click', closeSettings);
$('btnFetch').addEventListener('click', requestModels);
$('btnClearKey').addEventListener('click', function () {
  clearKey = true;
  F.apiKey.value = '';
  updateKeyState();
});
$('btnTest').addEventListener('click', function () {
  const out = $('testResult');
  out.textContent = '测试中…';
  out.className = 'test-result';
  vscode.postMessage({
    type: 'testConnection',
    baseUrl: F.baseUrl.value.trim(),
    model: F.model.value.trim(),
    apiKey: F.apiKey.value
  });
});
F.baseUrl.addEventListener('input', scheduleAutoFetch);
F.apiKey.addEventListener('input', function () {
  clearKey = false;
  updateKeyState();
  scheduleAutoFetch();
});

/* ------------------------------------------------------------------ */
/* 通用事件                                                            */
/* ------------------------------------------------------------------ */

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
inputEl.addEventListener('input', autoGrow);

$('btnNew').addEventListener('click', function () {
  showView('chat');
  vscode.postMessage({ type: 'newSession' });
});
$('btnSettings').addEventListener('click', openSettings);
$('btnCtx').addEventListener('click', function () {
  vscode.postMessage({ type: 'showContext' });
});

messagesEl.addEventListener('click', function (event) {
  const target = event.target;
  if (!target || !target.closest) {
    return;
  }
  const suggest = target.closest('.suggest-btn');
  if (suggest) {
    vscode.postMessage({ type: 'quickAction', action: suggest.dataset.action });
    return;
  }
  const copy = target.closest('.copy');
  if (copy) {
    const pre = copy.closest('.code').querySelector('pre');
    vscode.postMessage({ type: 'copy', text: pre ? pre.textContent : '' });
    copy.textContent = '已复制';
    setTimeout(function () {
      copy.textContent = '复制';
    }, 1500);
    return;
  }
  const ref = target.closest('.fileref');
  if (ref) {
    vscode.postMessage({ type: 'openFile', ref: ref.dataset.ref });
  }
});

window.addEventListener('message', function (event) {
  const msg = event.data;
  switch (msg.type) {
    case 'state': {
      if (msg.configured !== undefined) {
        const changed = configured !== !!msg.configured;
        configured = !!msg.configured;
        if (changed && emptyEl) {
          renderEmpty();
        }
      }
      if (msg.model !== undefined) {
        currentModel = msg.model;
      }
      if (msg.models) {
        currentModels = msg.models;
      }
      if (msg.model !== undefined || msg.models) {
        fillModelSelect();
      }
      if (msg.mode) {
        modeSelect.value = msg.mode;
      }
      if (msg.autoEdits !== undefined) {
        autoEdits = !!msg.autoEdits;
      }
      if (msg.contextLabel) {
        $('ctxText').textContent = msg.contextLabel;
      }
      if (msg.contextWarn !== undefined) {
        $('ctxDot').classList.toggle('warn', !!msg.contextWarn);
      }
      if (msg.busy !== undefined) {
        setBusy(!!msg.busy);
      } else {
        refreshStatus();
      }
      break;
    }
    case 'context':
      $('ctxText').textContent = msg.label;
      $('ctxDot').classList.toggle('warn', !!msg.warn);
      break;
    case 'showSettings':
      openSettings();
      break;
    case 'settingsData':
      onSettingsData(msg);
      break;
    case 'settingsError': {
      const slot = $('err-' + msg.field);
      if (slot) {
        slot.textContent = msg.message;
      }
      $('saveMsg').textContent = '';
      if (msg.field === 'contextWindow' || msg.field === 'maxOutputTokens') {
        document.querySelector('details.adv').open = true;
      }
      break;
    }
    case 'settingsSaved':
      configured = !!msg.configured;
      closeSettings();
      if (emptyEl) {
        renderEmpty();
      }
      break;
    case 'models':
      onModels(msg);
      break;
    case 'testResult': {
      const out = $('testResult');
      out.textContent = (msg.ok ? '✓ ' : '✗ ') + msg.message;
      out.className = 'test-result ' + (msg.ok ? 'ok' : 'bad');
      break;
    }
    case 'user':
      showView('chat');
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
    case 'cleared':
      messagesEl.innerHTML = '';
      tools.clear();
      approvals.clear();
      currentSeg = null;
      planEl = null;
      renderEmpty();
      break;
    default:
      break;
  }
});

renderEmpty();
vscode.postMessage({ type: 'ready' });
