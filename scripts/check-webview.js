/** 用 jsdom 驱动侧栏前端 media/chat.js：Markdown 渲染、消息顺序、审批交互、设置页、转义。 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const { JSDOM } = require('jsdom');

const PROJECT = path.join(__dirname, '..');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: { Uri: { joinPath: (b, ...p) => ({ fsPath: p.join('/') }) } }
};
const { getChatHtml } = require(path.join(PROJECT, 'out', 'webviewHtml.js'));
const html = getChatHtml({ asWebviewUri: (u) => u.fsPath, cspSource: 'x' }, { fsPath: PROJECT }).replace(
  /<script[\s\S]*?<\/script>/,
  ''
);

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

function boot() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  window.eval(fs.readFileSync(path.join(PROJECT, 'media', 'chat.js'), 'utf8'));
  const doc = window.document;
  return {
    window,
    doc,
    sent,
    messages: doc.getElementById('messages'),
    post: (data) => window.dispatchEvent(new window.MessageEvent('message', { data })),
    $: (id) => doc.getElementById(id)
  };
}

/** 把 Markdown 当作一段助手文本推给前端，返回渲染出的容器 */
function renderMd(ui, text) {
  ui.post({ type: 'assistantStart', id: 'x' });
  ui.post({ type: 'textDelta', text });
  const segs = ui.messages.querySelectorAll('.msg.assistant');
  return segs[segs.length - 1];
}

// =====================================================================
// 1. 首次使用：未配置时的引导
// =====================================================================
{
  const ui = boot();
  expect('启动时发送 ready', ui.sent.some((m) => m.type === 'ready'));
  expect('未配置时欢迎页引导去设置', ui.messages.textContent.includes('先连接一个模型服务') && !!ui.messages.querySelector('button.wide'));
  expect('未配置时没有任务建议卡片', !ui.messages.querySelector('.suggest'));
  ui.messages.querySelector('button.wide').click();
  expect('点击「前往设置」切到设置页', !ui.$('settingsView').classList.contains('hidden') && ui.$('chatView').classList.contains('hidden'));
  expect('进入设置页会请求当前设置', ui.sent.some((m) => m.type === 'settingsOpen'));

  ui.post({
    type: 'settingsData',
    values: { baseUrl: '', model: '', approvalMode: 'ask', allowedCommands: '', contextWindow: 128000, maxOutputTokens: 8192, autoContext: true, systemPromptExtra: '' },
    hasKey: false,
    configured: false,
    models: []
  });
  expect('未配置时显示引导横幅', !ui.$('setupBanner').classList.contains('hidden'));
  expect('设置页只有模型服务/Agent 行为/高级三块，没有平台与供应商', !/实训平台|平台地址|供应商|DeepSeek|Ollama/.test(ui.$('settingsView').textContent), ui.$('settingsView').textContent.replace(/\s+/g, ' ').slice(0, 200));
  expect('默认审批模式为逐项确认', ui.doc.querySelector('input[name="approvalMode"]:checked').value === 'ask');

  // 填写地址 → 自动获取模型（有防抖）
  ui.$('setBaseUrl').value = 'https://api.example.com/v1';
  ui.$('setApiKey').value = 'sk-test';
  ui.sent.length = 0;
  ui.$('btnFetch').click();
  const fetchMsg = ui.sent.find((m) => m.type === 'fetchModels');
  expect('点击「获取模型」按填写的地址和 Key 请求', fetchMsg && fetchMsg.baseUrl === 'https://api.example.com/v1' && fetchMsg.apiKey === 'sk-test', JSON.stringify(fetchMsg));
  expect('请求期间按钮禁用并提示', ui.$('btnFetch').disabled && /正在获取/.test(ui.$('modelHint').textContent));

  ui.post({ type: 'models', ok: true, baseUrl: 'https://api.example.com/v1', models: ['m-a', 'm-b'] });
  expect('返回后按钮恢复，模型进入下拉候选', !ui.$('btnFetch').disabled && ui.$('modelList').children.length === 2);
  expect('自动选中第一个模型', ui.$('setModel').value === 'm-a');
  expect('提示已获取数量', /已获取 2 个模型/.test(ui.$('modelHint').textContent));

  // 地址非法时不发请求
  ui.$('setBaseUrl').value = 'api.example.com';
  ui.sent.length = 0;
  ui.$('btnFetch').click();
  expect('非法地址不会发出请求并提示', !ui.sent.some((m) => m.type === 'fetchModels') && ui.$('modelHint').classList.contains('bad'));
  ui.$('setBaseUrl').value = 'https://api.example.com/v1';

  // 获取失败：给出原因，仍可手动输入
  ui.post({ type: 'models', ok: false, baseUrl: 'https://api.example.com/v1', models: [], message: '该接口不提供模型列表，请手动输入模型名称。' });
  expect('获取失败显示原因', /手动输入/.test(ui.$('modelHint').textContent) && ui.$('modelHint').classList.contains('bad'));
  expect('获取失败不清空已填模型', ui.$('setModel').value === 'm-a');

  // 测试连接
  ui.sent.length = 0;
  ui.$('btnTest').click();
  const t = ui.sent.find((m) => m.type === 'testConnection');
  expect('测试连接携带表单当前值', t && t.model === 'm-a' && t.apiKey === 'sk-test');
  ui.post({ type: 'testResult', ok: true, message: '连接成功：m-a' });
  expect('测试成功显示 ✓', ui.$('testResult').textContent.startsWith('✓') && ui.$('testResult').classList.contains('ok'));
  ui.post({ type: 'testResult', ok: false, message: '鉴权失败' });
  expect('测试失败显示 ✗', ui.$('testResult').textContent.startsWith('✗') && ui.$('testResult').classList.contains('bad'));

  // 保存
  ui.$('setAllowed').value = 'npm test';
  ui.doc.querySelector('input[name="approvalMode"][value="autoEdit"]').checked = true;
  ui.sent.length = 0;
  ui.$('btnSave').click();
  const save = ui.sent.find((m) => m.type === 'settingsSave');
  expect('保存一次提交全部设置', save && save.values.baseUrl === 'https://api.example.com/v1' && save.values.model === 'm-a' && save.values.approvalMode === 'autoEdit' && save.values.allowedCommands === 'npm test' && save.apiKey === 'sk-test', JSON.stringify(save));
  ui.post({ type: 'settingsError', field: 'model', message: '请填写或选择一个模型。' });
  expect('校验错误显示在对应字段下', ui.$('err-model').textContent === '请填写或选择一个模型。');
  ui.post({ type: 'settingsError', field: 'contextWindow', message: '越界' });
  expect('高级项出错时自动展开「高级」', ui.doc.querySelector('details.adv').open === true);
  ui.post({ type: 'settingsSaved', configured: true });
  expect('保存成功返回对话并出现任务建议', !ui.$('chatView').classList.contains('hidden') && !!ui.messages.querySelector('.suggest'));

  // 已保存 Key 的展示与清除
  ui.post({ type: 'showSettings' });
  ui.post({
    type: 'settingsData',
    values: { baseUrl: 'https://api.example.com/v1', model: 'm-a', approvalMode: 'ask', allowedCommands: '', contextWindow: 64000, maxOutputTokens: 4096, autoContext: false, systemPromptExtra: 'x' },
    hasKey: true,
    configured: true,
    models: ['m-a', 'm-b']
  });
  expect('已保存 Key 时输入框为空并提示「已保存」', ui.$('setApiKey').value === '' && /已保存/.test(ui.$('keyState').textContent) && !ui.$('btnClearKey').classList.contains('hidden'));
  expect('回填保存的值', ui.$('setContextWindow').value === '64000' && ui.$('setAutoContext').checked === false && ui.$('setExtra').value === 'x');
  expect('已配置时不再显示横幅', ui.$('setupBanner').classList.contains('hidden'));
  ui.$('btnClearKey').click();
  ui.sent.length = 0;
  ui.$('btnSave').click();
  expect('点击清除后保存会携带 clearKey', ui.sent.find((m) => m.type === 'settingsSave').clearKey === true);
  ui.$('btnCancel').click();
  expect('取消返回对话', !ui.$('chatView').classList.contains('hidden'));
}

// =====================================================================
// 2. 输入框下方的模型 / 模式选择
// =====================================================================
{
  const ui = boot();
  ui.post({ type: 'state', configured: true, model: 'beta', models: ['alpha', 'beta', 'gamma'], mode: 'readOnly', busy: false, contextLabel: 'index.html · L31' });
  const opts = [...ui.$('modelSelect').options].map((o) => o.value);
  expect('模型下拉：当前模型 + 接口返回的列表 + 管理入口', opts.join() === 'beta,alpha,gamma,__settings', opts.join());
  expect('当前模型被选中', ui.$('modelSelect').value === 'beta');
  expect('审批模式同步', ui.$('modeSelect').value === 'readOnly');
  expect('有任务建议卡片', ui.messages.querySelectorAll('.suggest-btn').length === 6);

  ui.sent.length = 0;
  ui.$('modelSelect').value = 'gamma';
  ui.$('modelSelect').dispatchEvent(new ui.window.Event('change'));
  expect('切换模型发出 setModel', ui.sent.some((m) => m.type === 'setModel' && m.model === 'gamma'));
  ui.$('modeSelect').value = 'autoEdit';
  ui.$('modeSelect').dispatchEvent(new ui.window.Event('change'));
  expect('切换模式发出 setMode', ui.sent.some((m) => m.type === 'setMode' && m.mode === 'autoEdit'));
  ui.$('modelSelect').value = '__settings';
  ui.$('modelSelect').dispatchEvent(new ui.window.Event('change'));
  expect('「管理模型…」打开设置页并还原选择', !ui.$('settingsView').classList.contains('hidden') && ui.$('modelSelect').value === 'gamma');

  // 未获取到列表时仍显示当前模型
  ui.post({ type: 'state', model: 'only-one', models: [] });
  expect('没有列表时仍能显示当前模型', [...ui.$('modelSelect').options].map((o) => o.value).join() === 'only-one,__settings');

  // 任务建议点击
  ui.post({ type: 'showSettings' });
  ui.$('btnCancel').click();
  ui.sent.length = 0;
  ui.messages.querySelector('.suggest-btn[data-action="fix"]').click();
  expect('点击建议卡片触发快捷操作', ui.sent.some((m) => m.type === 'quickAction' && m.action === 'fix'));
  expect('上下文行显示当前文件', ui.$('ctxText').textContent === 'index.html · L31');
}

// =====================================================================
// 3. Markdown 渲染（对应截图里的问题：### 标题、代码块空白）
// =====================================================================
{
  const ui = boot();
  ui.post({ type: 'state', configured: true, model: 'm', models: [], mode: 'ask' });

  let seg = renderMd(ui, '这份 `index.html` 是入口。\n\n### 1. 文档声明与语言\n\n```html\n<!doctype html>\n<html lang="zh-CN">\n```\n\n- `<!doctype html>`：声明 HTML5\n- `lang="zh-CN"`：简体中文');
  expect('### 渲染为标题而不是原样文字', !!seg.querySelector('h4') && seg.querySelector('h4').textContent === '1. 文档声明与语言' && !seg.textContent.includes('###'));
  expect('代码块带语言标签与复制按钮', seg.querySelector('.code .lang').textContent === 'html' && !!seg.querySelector('.code .copy'));
  expect('代码块内容不被多余空行包围', seg.querySelector('.code pre code').textContent === '<!doctype html>\n<html lang="zh-CN">', JSON.stringify(seg.querySelector('.code pre code').textContent));
  expect('代码块里的 HTML 被转义，不会生成真实标签', !seg.querySelector('.code html') && seg.querySelector('.code pre code').textContent.includes('<html'));
  expect('无序列表渲染', seg.querySelectorAll('ul li').length === 2);
  expect('列表项里的行内代码', seg.querySelectorAll('ul li code').length === 2);
  expect('段落之间没有多余 <br> 空行', !seg.innerHTML.includes('<br><br>'));

  seg = renderMd(ui, '步骤：\n\n1. 打开文件\n2. 修改配置\n   - 子项 A\n   - 子项 B\n3. 保存');
  expect('有序列表与嵌套列表', seg.querySelectorAll('ol > li').length === 3 && seg.querySelectorAll('ol ul li').length === 2, seg.innerHTML);

  seg = renderMd(ui, '| 名称 | 说明 |\n| --- | --- |\n| a | 第一项 |\n| b | 第二项 |');
  expect('表格渲染', seg.querySelectorAll('th').length === 2 && seg.querySelectorAll('tbody tr').length === 2, seg.innerHTML);

  seg = renderMd(ui, '**加粗** 和 *斜体* 以及 ~~删除~~，[链接](https://example.com/a?b=1&c=2)，> 不是引用');
  expect('行内格式', !!seg.querySelector('strong') && !!seg.querySelector('em') && !!seg.querySelector('del'));
  expect('http 链接可点击', seg.querySelector('a') && seg.querySelector('a').getAttribute('href') === 'https://example.com/a?b=1&amp;c=2'.replace('&amp;', '&'), seg.querySelector('a') && seg.querySelector('a').outerHTML);

  seg = renderMd(ui, '> 引用内容\n\n---\n\n后续');
  expect('引用与分隔线', !!seg.querySelector('blockquote') && !!seg.querySelector('hr'));

  // 安全：HTML、危险链接、事件属性一律不生效
  seg = renderMd(ui, '<img src=x onerror="alert(1)"> <script>alert(2)</script> [点我](javascript:alert(3)) **<b>x</b>**');
  expect('HTML 标签被当作文本', !seg.querySelector('img') && !seg.querySelector('script') && !seg.querySelector('b'));
  expect('javascript: 链接不会变成可点击链接', !seg.querySelector('a'), seg.innerHTML);

  // 流式输出：未闭合的代码块也按代码块展示，闭合后不抖动
  ui.post({ type: 'assistantStart', id: 'y' });
  ui.post({ type: 'textDelta', text: '先看：\n```js\nconst a = 1;' });
  let streaming = ui.messages.querySelectorAll('.msg.assistant');
  streaming = streaming[streaming.length - 1];
  expect('未闭合代码块流式显示为代码块', !!streaming.querySelector('.code pre code') && streaming.querySelector('.code pre code').textContent === 'const a = 1;', streaming.innerHTML);
  ui.post({ type: 'textDelta', text: '\n```\n完成。' });
  expect('闭合后代码块与后续文本分开', streaming.querySelectorAll('.code').length === 1 && streaming.textContent.includes('完成。'));

  // 文件引用可点击
  seg = renderMd(ui, '见 `src/UserService.cs:42` 和 `npm test`，不是引用的 `a b.c`');
  const refs = seg.querySelectorAll('code.fileref');
  expect('「文件:行号」渲染为可点击引用，命令不是', refs.length === 1 && refs[0].dataset.ref === 'src/UserService.cs:42', seg.innerHTML);
  ui.sent.length = 0;
  refs[0].click();
  expect('点击引用请求打开文件', ui.sent.some((m) => m.type === 'openFile' && m.ref === 'src/UserService.cs:42'));

  // 复制按钮
  seg = renderMd(ui, '```python\nprint("hi")\n```');
  ui.sent.length = 0;
  seg.querySelector('.copy').click();
  expect('点击复制发出代码内容', ui.sent.some((m) => m.type === 'copy' && m.text === 'print("hi")'), JSON.stringify(ui.sent));
  expect('复制后按钮短暂提示', seg.querySelector('.copy').textContent === '已复制');

  // 用户消息按纯文本显示
  ui.post({ type: 'user', text: '<b>我</b>想要 **这样**' });
  const userMsg = ui.messages.querySelector('.msg.user:last-of-type');
  expect('用户消息按纯文本显示', userMsg.textContent === '<b>我</b>想要 **这样**' && !userMsg.querySelector('b'));
}

// =====================================================================
// 4. 对话流：顺序、工具、计划、审批、汇总（沿用并更新）
// =====================================================================
{
  const ui = boot();
  const { messages, post, sent, doc } = ui;
  const kids = () => [...messages.children].map((c) => c.className.split(' ')[0] + (c.className.includes('assistant') ? '.assistant' : ''));
  post({ type: 'state', configured: true, model: 'deepseek-chat', models: ['deepseek-chat'], mode: 'ask', busy: false, undoCount: 2 });

  post({ type: 'user', text: '帮我改一下' });
  expect('发送后欢迎页消失', !messages.querySelector('.empty'));
  post({ type: 'assistantStart', id: 'a1' });
  post({ type: 'state', busy: true });
  expect('忙碌时显示停止按钮、隐藏发送按钮', !ui.$('btnStop').classList.contains('hidden') && ui.$('btnSend').classList.contains('hidden'));

  post({ type: 'textDelta', text: '我先看看' });
  post({ type: 'textDelta', text: '代码。**重点**' });
  expect('文本流式合并为一段', messages.querySelectorAll('.msg.assistant').length === 1 && messages.querySelector('.msg.assistant').textContent.includes('我先看看代码。重点') && !!messages.querySelector('strong'));

  post({ type: 'toolStart', id: 't1', name: 'read', label: '读取 src/a.ts' });
  expect('工具行进行中', messages.querySelector('.tool.running .tool-label').textContent === '读取 src/a.ts');
  post({ type: 'toolEnd', id: 't1', name: 'read', ok: true, summary: '' });
  expect('工具行完成', !!messages.querySelector('.tool.ok'));
  post({ type: 'textDelta', text: '读完了' });
  expect('工具之后的文本另起一段（保持时间顺序）', kids().join('|') === 'msg|msg.assistant|tool|msg.assistant', kids().join('|'));

  post({ type: 'plan', steps: [{ step: '读取', status: 'completed' }, { step: '修改', status: 'in_progress' }] });
  post({ type: 'plan', steps: [{ step: '读取', status: 'completed' }, { step: '修改', status: 'completed' }] });
  expect('计划卡片只有一张且原地更新', messages.querySelectorAll('.plan').length === 1 && messages.querySelectorAll('.plan-step.completed').length === 2);

  post({ type: 'toolStart', id: 't2', name: 'bash', label: '运行 npm test' });
  post({ type: 'toolEnd', id: 't2', name: 'bash', ok: true, summary: '已完成', output: 'PASS 3 tests' });
  expect('bash 输出可折叠查看', messages.querySelector('details.tool-out pre').textContent === 'PASS 3 tests');
  post({ type: 'toolStart', id: 't3', name: 'edit', label: '修改 x' });
  post({ type: 'toolEnd', id: 't3', name: 'edit', ok: false, summary: '学生拒绝了这次修改' });
  expect('失败的工具行显示原因', messages.querySelector('.tool.fail .tool-state').textContent.includes('学生拒绝'));
  post({ type: 'toolStart', id: 't4', name: 'bash', label: '运行 <img src=x onerror=alert(1)>' });
  expect('工具标签中的 HTML 被转义', !messages.querySelector('img'));

  post({ type: 'approval', request: { id: 'ap1', kind: 'edit', title: '修改 src/a.ts', relPath: 'src/a.ts', added: 3, removed: 1, canDiff: true } });
  let card = messages.querySelector('.approval');
  expect('审批卡片展示标题与增删统计', card.textContent.includes('修改 src/a.ts') && card.textContent.includes('+3 −1'));
  const labels = [...card.querySelectorAll('button')].map((b) => b.textContent);
  expect('「允许」「拒绝」在前，次要操作在后', labels.join() === '允许,拒绝,查看 Diff,本次会话全部允许', labels.join());
  [...card.querySelectorAll('button')].find((b) => b.textContent === '查看 Diff').click();
  expect('点击查看 Diff 发出消息', sent.some((m) => m.type === 'openDiff' && m.id === 'ap1'));
  [...card.querySelectorAll('button')].find((b) => b.textContent === '允许').click();
  expect('点击允许发出决议', sent.some((m) => m.type === 'approvalResponse' && m.id === 'ap1' && m.decision === 'allow'));
  expect('点击后按钮被禁用，防止重复提交', [...card.querySelectorAll('button')].every((b) => b.disabled));
  [...card.querySelectorAll('button')].find((b) => b.textContent === '拒绝').disabled = false;
  [...card.querySelectorAll('button')].find((b) => b.textContent === '拒绝').click();
  expect('重复点击不会再发送决议', sent.filter((m) => m.type === 'approvalResponse' && m.id === 'ap1').length === 1);
  post({ type: 'approvalDone', id: 'ap1', decision: 'allow' });
  expect('决议后卡片折叠为结果', card.querySelector('.ap-result.allow') && !card.querySelector('button') && card.classList.contains('decided'));

  post({ type: 'approval', request: { id: 'ap2', kind: 'bash', title: '运行命令', command: 'echo "<b>hi</b>"', cwd: '/ws', canDiff: false } });
  card = [...messages.querySelectorAll('.approval')][1];
  expect('命令审批展示命令与目录，HTML 不被解析', card.querySelector('.ap-cmd').textContent === 'echo "<b>hi</b>"' && !card.querySelector('b') && card.textContent.includes('/ws'));
  const bashBtns = [...card.querySelectorAll('button')].map((b) => b.textContent);
  expect('bash 审批没有 Diff 与「全部允许」', bashBtns.join() === '允许,拒绝', bashBtns.join());
  post({ type: 'approvalDone', id: 'ap2', decision: 'deny' });
  expect('拒绝结果展示', !!card.querySelector('.ap-result.deny'));

  post({ type: 'textDelta', text: '半截回答' });
  const before = messages.querySelectorAll('.msg.assistant').length;
  post({ type: 'textReset' });
  expect('textReset 丢弃未完成的文本段', messages.querySelectorAll('.msg.assistant').length === before - 1);

  post({ type: 'changes', files: ['src/a.ts', 'src/b.ts'] });
  const changes = messages.querySelector('.changes');
  expect('修改汇总列出文件', changes.querySelectorAll('li').length === 2);
  sent.length = 0;
  changes.querySelector('button').click();
  expect('点击撤销发出消息', sent.some((m) => m.type === 'undo'));

  post({ type: 'assistantEnd', id: 'a1', meta: 'deepseek-chat · 3.2s · 4 次工具调用' });
  expect('结束时挂起的工具行标记为已停止', [...messages.querySelectorAll('.tool.fail')].some((t) => t.textContent.includes('已停止')));
  expect('展示运行统计', messages.querySelector('.run-meta').textContent.includes('4 次工具调用'));
  post({ type: 'state', busy: false });
  expect('结束后恢复发送按钮', ui.$('btnStop').classList.contains('hidden') && !ui.$('btnSend').classList.contains('hidden'));

  const input = ui.$('input');
  input.value = '你好';
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  expect('Shift+Enter 不发送', !sent.some((m) => m.type === 'send'));
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  expect('输入法合成中的 Enter 不发送', !sent.some((m) => m.type === 'send'));
  input.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect('Enter 发送并清空输入框', sent.some((m) => m.type === 'send' && m.text === '你好') && input.value === '');

  sent.length = 0;
  ui.$('btnNew').click();
  expect('新建对话按钮', sent.some((m) => m.type === 'newSession'));
  post({ type: 'cleared' });
  expect('清空后回到欢迎页', messages.children.length === 1 && !!messages.querySelector('.suggest'));
  ui.$('btnSettings').click();
  expect('顶栏只有新建和设置两个入口', doc.querySelectorAll('header.top button').length === 2 && !ui.$('settingsView').classList.contains('hidden'));
}

if (fail > 0) {
  console.error(fail + ' check(s) failed');
  process.exit(1);
}
console.log('webview tests passed');
