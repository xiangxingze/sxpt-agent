/**
 * 终端对话界面自检（不依赖 vscode）：
 *  - 基础：显示宽度、折行、清洗、Markdown → 终端文本、精简 Diff、行编辑器、文件引用识别
 *  - ChatTui（按 V4 原型绘制）：用一个最小的 VT 终端模拟器接收它的输出，检查屏幕上最终看到的内容——
 *    欢迎页与贴底的输入框、消息气泡、流式输出不留残影、确认卡片按钮、斜杠命令、多行输入与粘贴、
 *    窗口缩放、打开前的消息重放、可点击的标题行操作。
 */
require('./source-loader');
const Module = require('module');
const path = require('path');

// chatTerminal.ts 只在类型上依赖 vscode；这里给一个空桩以便单独测试其中的纯函数
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: {} };

const out = (name) => path.join(__dirname, '..', 'out', 'ui', name);
const { style, stripAnsi, sanitize, charWidth, textWidth, padEnd, truncate, wrapAnsi, RESET } = require(out('ansi.js'));
const { renderInline, renderMarkdown, MarkdownStream } = require(out('markdownAnsi.js'));
const { compactDiff } = require(out('diffLines.js'));
const { LineEditor } = require(out('lineEditor.js'));
const { ChatTui, findActionLinks } = require(out('chatTui.js'));
const { findFileRefs } = require(out('chatTerminal.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

// ---------------------------------------------------------------------------
// 最小 VT 终端模拟器：只实现 ChatTui 用到的控制序列
// ---------------------------------------------------------------------------
class Term {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.lines = [[]];
    this.x = 0;
    this.y = 0;
    /** 自动折行次数：界面每一行都应当自己控制宽度，正常情况下为 0 */
    this.wraps = 0;
    this.cursorVisible = true;
    this.raw = '';
  }

  top() {
    return Math.max(0, this.lines.length - this.rows);
  }

  line(y) {
    while (this.lines.length <= y) this.lines.push([]);
    return this.lines[y];
  }

  put(ch) {
    const w = charWidth(ch.codePointAt(0));
    if (w === 0) return;
    if (this.x + w > this.cols) {
      this.wraps++;
      this.x = 0;
      this.y++;
    }
    const line = this.line(this.y);
    while (line.length < this.x) line.push(' ');
    line[this.x] = ch;
    if (w === 2) line[this.x + 1] = '';
    this.x += w;
  }

  csi(params, final) {
    const n = parseInt(params, 10) || 1;
    switch (final) {
      case 'A':
        this.y = Math.max(this.top(), this.y - n);
        break;
      case 'B':
        this.y += n;
        this.line(this.y);
        break;
      case 'C':
        this.x = Math.min(this.cols - 1, this.x + n);
        break;
      case 'D':
        this.x = Math.max(0, this.x - n);
        break;
      case 'H':
        this.y = this.top();
        this.x = 0;
        this.line(this.y);
        break;
      case 'K':
        this.line(this.y).length = Math.min(this.line(this.y).length, this.x);
        break;
      case 'J':
        if (params === '3') {
          const removed = this.top();
          this.lines = this.lines.slice(removed);
          this.y = Math.max(0, this.y - removed);
        } else if (params === '2') {
          for (let i = this.top(); i < this.lines.length; i++) this.lines[i] = [];
        } else {
          this.line(this.y).length = Math.min(this.line(this.y).length, this.x);
          for (let i = this.y + 1; i < this.lines.length; i++) this.lines[i] = [];
        }
        break;
      case 'h':
      case 'l':
        if (params === '?25') this.cursorVisible = final === 'h';
        break;
      default:
        break;
    }
  }

  write(data) {
    this.raw += data;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(i, i + 32));
        if (m) {
          this.csi(m[1], m[2]);
          i += m[0].length;
        } else {
          i++;
        }
        continue;
      }
      if (ch === '\r') {
        this.x = 0;
        i++;
        continue;
      }
      if (ch === '\n') {
        this.y++;
        this.line(this.y);
        i++;
        continue;
      }
      const cp = data.codePointAt(i);
      const s = String.fromCodePoint(cp);
      this.put(s);
      i += s.length;
    }
  }

  /** 变窄时像 xterm 一样把过长的行折成多行 */
  resize(cols, rows) {
    if (cols < this.cols) {
      const next = [];
      let y = 0;
      this.lines.forEach((cells, i) => {
        const parts = [];
        const count = Math.max(1, Math.ceil(cells.length / cols));
        for (let k = 0; k < count; k++) parts.push(cells.slice(k * cols, (k + 1) * cols));
        if (i === this.y) y = next.length + Math.min(parts.length - 1, Math.floor(this.x / cols));
        next.push(...parts);
      });
      this.lines = next;
      this.y = y;
      this.x = this.x % cols;
    }
    this.cols = cols;
    this.rows = rows;
  }

  rowsText() {
    const rows = this.lines.map((cells) => cells.map((c) => (c === undefined ? ' ' : c)).join('').replace(/\s+$/, ''));
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    return rows;
  }

  text() {
    return this.rowsText().join('\n');
  }

  count(needle) {
    return this.text().split(needle).length - 1;
  }

  /** 光标所在行的文本 */
  cursorLine() {
    return (this.lines[this.y] || []).map((c) => (c === undefined ? ' ' : c)).join('');
  }
}

function mk(options) {
  const o = options || {};
  const term = new Term(o.cols || 80, o.rows || 30);
  const emitted = [];
  const tui = new ChatTui({
    write: (data) => term.write(data),
    emit: (message) => {
      emitted.push(message);
      if (o.onEmit) o.onEmit(message, tui);
    },
    cwd: o.cwd,
    sync: true,
    approvalGuardMs: o.guard === undefined ? 0 : o.guard
  });
  if (!o.closed) {
    tui.open(term.cols, term.rows);
    if (!o.unconfigured) tui.receive({ type: 'state', configured: true, model: 'test-model', mode: 'ask', busy: false });
  }
  return { term, tui, emitted, last: () => emitted[emitted.length - 1], key: (data) => tui.handleInput(data) };
}

const ENTER = '\r';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';

// ---------------------------------------------------------------------------
// 1. 基础：宽度、折行、清洗
// ---------------------------------------------------------------------------
{
  expect('中文占两列、组合字符占零列', textWidth('中文ab') === 6 && textWidth('e\u0301') === 1 && textWidth('😀') === 2, textWidth('中文ab'));
  expect('显示宽度忽略 ANSI 样式', textWidth(style.bold('粗体')) === 4);
  expect('padEnd 按显示宽度补齐', padEnd('中', 5) === '中   ' && padEnd('abcdef', 3) === 'abcdef');
  expect('truncate 按显示宽度截断并以 … 结尾', truncate('中文字符串', 7) === '中文字…' && textWidth(truncate('中文字符串', 7)) <= 7, truncate('中文字符串', 7));
  expect('truncate 不超宽时原样返回', truncate('abc', 3) === 'abc');

  const cleaned = sanitize('a\x1b[2Jb\x07c\r\nd\te\x9bf');
  expect('sanitize 去掉 ESC 等控制字符、统一换行、制表符转空格', cleaned === 'a[2Jbc\nd    ef', JSON.stringify(cleaned));

  const wrapped = wrapAnsi(style.bold('hello world foo bar baz'), 11);
  expect(
    '英文按词折行，每行不超宽',
    wrapped.every((r) => textWidth(r) <= 11) && wrapped.map((r) => stripAnsi(r)).join(' ') === 'hello world foo bar baz',
    JSON.stringify(wrapped.map((r) => stripAnsi(r)))
  );
  expect('折行处复位样式，下一行恢复样式', wrapped.length === 2 && wrapped[0].endsWith(RESET) && wrapped[1].startsWith('\x1b[1m'), JSON.stringify(wrapped));
  const cjk = wrapAnsi('这是一段没有空格的中文需要在任意位置折行', 10);
  expect('中文在任意字符处折行且不超宽', cjk.length === 4 && cjk.every((r) => textWidth(r) <= 10) && cjk.join('') === '这是一段没有空格的中文需要在任意位置折行', JSON.stringify(cjk));
  const longWord = wrapAnsi('x'.repeat(25), 10);
  expect('超长单词硬折行', longWord.length === 3 && longWord.join('') === 'x'.repeat(25));
}

// ---------------------------------------------------------------------------
// 2. Markdown → 终端文本
// ---------------------------------------------------------------------------
{
  const inline = renderInline('这是**粗体**、*斜体*、`a*b*c` 和 [文档](https://example.com/x)');
  const plain = stripAnsi(inline);
  expect('行内标记被渲染掉，代码里的星号保留', plain === '这是粗体、斜体、a*b*c 和 文档 (https://example.com/x)', plain);
  expect('粗体与行内代码带样式', inline.includes('\x1b[1m粗体') && inline.includes('\x1b[36ma*b*c'));
  expect('乘号不被当成斜体', stripAnsi(renderInline('2 * 3 * 4')) === '2 * 3 * 4');

  const md = [
    '# 标题',
    '',
    '第一段。',
    '',
    '',
    '- 列表一',
    '  - 子项',
    '1. 有序',
    '- [x] 已完成',
    '- [ ] 未完成',
    '',
    '> 引用',
    '',
    '```ts',
    'const a = **1**;',
    '```',
    '',
    '| 名称 | 说明 |',
    '|---|---|',
    '| a | 中文说明 |',
    '| bb | y |',
    '',
    '---'
  ].join('\n');
  const rows = renderMarkdown(md, 60).map(stripAnsi);
  expect('标题渲染为文本', rows.includes('标题'), JSON.stringify(rows));
  expect('连续空行被合并', !rows.some((r, i) => r === '' && rows[i + 1] === ''), JSON.stringify(rows));
  expect('列表、子项、有序列表、任务列表', rows.includes('• 列表一') && rows.includes('  • 子项') && rows.includes('1. 有序') && rows.includes('☑ 已完成') && rows.includes('☐ 未完成'), JSON.stringify(rows));
  expect('引用', rows.includes('│ 引用'));
  expect('代码块带边框且不解析行内标记', rows.includes('╭─ ts') && rows.includes('│ const a = **1**;') && rows.includes('╰─'), JSON.stringify(rows));
  const table = rows.filter((r) => /^[┌├└│]/.test(r) && r !== '│ 引用' && !r.startsWith('│ const'));
  expect(
    '表格画成对齐的文本表',
    table.length === 6 && new Set(table.map((r) => textWidth(r))).size === 1 && table[1].includes('名称') && table[3].includes('中文说明'),
    JSON.stringify(table)
  );
  expect('分隔线', rows[rows.length - 1].startsWith('───'));

  const wide = renderMarkdown('| 列 | 内容 |\n|---|---|\n| a | ' + '很长的内容'.repeat(20) + ' |', 40);
  expect('表格过宽时压缩列宽并在单元格内折行', wide.every((r) => textWidth(r) <= 40) && wide.length > 5, String(Math.max(...wide.map((r) => textWidth(r)))));

  const para = renderMarkdown('中文 and English words mixed 在一起的一段很长很长的话，需要按照显示宽度折行。'.repeat(3), 30);
  expect('段落按宽度折行', para.length > 3 && para.every((r) => textWidth(r) <= 30));

  // 流式：半行是活动行，收到换行后定稿
  const stream = new MarkdownStream(() => 40);
  stream.push('第一行\n第二');
  let taken = stream.take();
  expect('流式：整行定稿、半行为活动行', taken.rows.join() === '第一行' && taken.live.join() === '第二', JSON.stringify(taken));
  stream.push('行\n| a | b |\n|---|---|\n| 1 |');
  taken = stream.take();
  expect(
    '流式：未结束的表格留在活动区域',
    taken.rows.join() === '第二行' && taken.live.length >= 4 && stripAnsi(taken.live[1]).includes('a'),
    JSON.stringify(taken.live.map(stripAnsi))
  );
  stream.push(' 2 |\n\n完\n');
  taken = stream.take();
  expect('流式：表格结束后整体定稿', taken.rows.map(stripAnsi).some((r) => /│ 1\s+│ 2\s+│/.test(r)) && taken.live.length === 0, JSON.stringify(taken.rows.map(stripAnsi)));
  stream.push('```js\nlet x');
  taken = stream.take();
  expect('流式：代码块里的半行', taken.live.map(stripAnsi).join() === '│ let x', JSON.stringify(taken));
  stream.push('\n``');
  taken = stream.take();
  expect('流式：还没收完的结束围栏不显示', taken.live.length === 0, JSON.stringify(taken.live));
  stream.push('`\n');
  expect('流式：end() 返回剩余定稿行', stream.end().map(stripAnsi).join() === '╰─');
}

// ---------------------------------------------------------------------------
// 3. 精简 Diff
// ---------------------------------------------------------------------------
{
  const original = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n') + '\n';
  const diff = compactDiff(original, original.replace('l5', 'L5'));
  expect(
    '单行修改：前后各 2 行上下文',
    diff.map((d) => `${d.kind}${d.no}`).join() === 'ctx3,ctx4,del5,add5,ctx6,ctx7',
    JSON.stringify(diff)
  );
  const created = compactDiff('', 'a\nb\n');
  expect('新文件：全部为新增行', created.map((d) => `${d.kind}${d.no}:${d.text}`).join() === 'add1:a,add2:b', JSON.stringify(created));
  const far = compactDiff(original, original.replace('l1', 'A').replace('l9', 'Z'));
  expect('相距较远的改动之间有省略行', far.some((d) => d.kind === 'gap') && far.filter((d) => d.kind === 'add').length === 2, JSON.stringify(far));
  const big = compactDiff('', Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'));
  expect('超长 Diff 被截断并注明剩余行数', big.length === 81 && /另有 220 行改动/.test(big[80].text), big.length + ' ' + big[big.length - 1].text);
  expect('内容相同时没有 Diff 行', compactDiff('a\nb\n', 'a\r\nb\r\n').length === 0);
}

// ---------------------------------------------------------------------------
// 4. 行编辑器
// ---------------------------------------------------------------------------
{
  const e = new LineEditor();
  e.insert('你好ab');
  let l = e.layout(20);
  expect('输入中文后光标列按显示宽度计算', l.rows.join() === '你好ab' && l.cursorCol === 6, JSON.stringify(l));
  e.left();
  e.left();
  e.backspace();
  l = e.layout(20);
  expect('光标左移后退格删除的是中文字符', e.text === '你ab' && l.cursorCol === 2, e.text + ' ' + l.cursorCol);
  e.home();
  e.del();
  e.end();
  expect('Home / Delete / End', e.text === 'ab' && e.layout(20).cursorCol === 2);
  e.clear();
  e.insert('abcdefghijkl');
  l = e.layout(5);
  expect('超过宽度自动折成多行', l.rows.join() === 'abcde,fghij,kl' && l.cursorRow === 2 && l.cursorCol === 2, JSON.stringify(l));
  e.up();
  l = e.layout(5);
  expect('↑ 在可视行之间移动', l.cursorRow === 1 && l.cursorCol === 2);
  e.clear();
  e.insert('foo bar  baz');
  e.deleteWord();
  expect('Ctrl+W 删除前一个词', e.text === 'foo bar  ', JSON.stringify(e.text));
  e.insert('x\ny z');
  e.killToStart();
  expect('Ctrl+U 只删到当前行行首', e.text === 'foo bar  x\n', JSON.stringify(e.text));
  e.clear();
  e.insert('第一条');
  expect('submit 返回文本并清空', e.submit() === '第一条' && e.isEmpty);
  e.insert('第二条');
  e.submit();
  e.insert('草稿');
  e.layout(20);
  e.up();
  const h1 = e.text;
  e.up();
  const h2 = e.text;
  e.up();
  e.down();
  const h3 = e.text;
  e.down();
  expect('↑↓ 翻看历史并能回到草稿', h1 === '第二条' && h2 === '第一条' && h3 === '第二条' && e.text === '草稿', [h1, h2, h3, e.text].join());
  e.clear();
  e.insert('a\x1b[31mb\x07');
  expect('输入内容里的控制字符被去掉', e.text === 'a[31mb', JSON.stringify(e.text));
  e.clear();
  e.insert(Array.from({ length: 20 }, (_, i) => `行${i}`).join('\n'));
  l = e.layout(20, 8);
  expect('多行输入只显示光标附近的 8 行', l.rows.length === 8 && l.rows[7] === '行19' && l.cursorRow === 7, JSON.stringify(l));
}

// ---------------------------------------------------------------------------
// 5. 终端里可点击的文件引用
// ---------------------------------------------------------------------------
{
  const refs = (line) => findFileRefs(line).map((l) => l.ref);
  const line = '  见 src/ui/chatTui.ts:120 和 README.md，以及 a.txt:3:5';
  const found = findFileRefs(line);
  expect('识别「路径:行号」', found.map((l) => l.ref).join() === 'src/ui/chatTui.ts:120,README.md,a.txt:3:5', JSON.stringify(found));
  expect('链接位置与文本一致', found.every((l) => line.substr(l.startIndex, l.length) === l.ref));
  expect('网址不被当成文件', refs('打开 https://example.com/docs/a.html 查看').length === 0, JSON.stringify(refs('打开 https://example.com/docs/a.html 查看')));
  expect('版本号、缩写不被当成文件', refs('版本 1.2.3，e.g. 这样').length === 0, JSON.stringify(refs('版本 1.2.3，e.g. 这样')));
  expect('Windows 路径', refs('C:\\work\\a.py:7').join() === 'C:\\work\\a.py:7', JSON.stringify(refs('C:\\work\\a.py:7')));
}

// ---------------------------------------------------------------------------
// 6. ChatTui：欢迎页、输入框、发送
// ---------------------------------------------------------------------------
const PLACEHOLDER = '提问、修改代码，或描述你的想法…';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

/** 屏幕上当前反色显示（选中）的审批按钮 */
function selectedButton(t) {
  const all = [...t.term.raw.matchAll(/\x1b\[7m\x1b\[1m ([^\x1b]+) \x1b\[22m/g)];
  return all.length ? all[all.length - 1][1] : '';
}

{
  const t = mk({ unconfigured: true, cwd: '/home/student/demo' });
  expect('打开时启用括号粘贴模式并发出 ready', t.term.raw.startsWith('\x1b[?2004h') && t.emitted[0].type === 'ready');
  let rows = t.term.rowsText();
  expect('空会话：标题行在最上方，带新建 / 历史 / 设置', /^✦ AI Agent\s+\/new 新建 · \/history 历史 · \/settings 设置$/.test(rows[0]), rows[0]);
  expect('未配置时欢迎页引导配置', t.term.text().includes('先连接模型服务') && t.term.text().includes('按 Enter 开始配置') && t.term.text().includes('● 请先配置模型'), t.term.text());
  expect('输入框贴在屏幕底部', rows.length === 30 && rows[29].includes('尚未配置模型服务'), `${rows.length} ${rows[rows.length - 1]}`);
  t.key(ENTER);
  expect('未配置时直接回车打开设置', t.last().type === 'openSettings');
  t.key('先写好的问题');
  t.key(ENTER);
  expect('未配置时发送会打开设置并保留输入', t.last().type === 'openSettings' && t.tui.draft === '先写好的问题' && !t.emitted.some((m) => m.type === 'send'));
  t.key('\x03');

  t.tui.receive({ type: 'state', configured: true, model: 'qwen-coder', mode: 'autoEdit', contextLabel: 'main.py · L3' });
  let text = t.term.text();
  expect('已配置：欢迎语与两条建议', text.includes('有什么想一起完成的？') && text.includes('了解这个项目 ↗') && text.includes('分析当前报错 ↗') && !text.includes('先连接模型服务'), text);
  expect('输入框上方显示当前文件，框内显示模型', text.includes('▧ main.py · L3') && /│ ● qwen-coder\s+↑ │/.test(text), text);
  expect('提示随审批模式变化：自动修改', text.includes('运行命令前会请你确认') && !text.includes('尚未配置'), text);
  t.tui.receive({ type: 'state', mode: 'readOnly' });
  expect('提示随审批模式变化：只读', t.term.text().includes('当前为只读模式'));
  t.tui.receive({ type: 'state', mode: 'ask' });
  expect('提示随审批模式变化：逐项确认', t.term.text().includes('修改前会请你确认'));
  t.tui.receive({ type: 'state', autoEdits: true });
  expect('本次会话自动允许修改时的提示', t.term.text().includes('本次会话自动允许修改'));
  t.tui.receive({ type: 'state', autoEdits: false });
  expect('输入框带占位提示', t.term.count(PLACEHOLDER) === 1);

  t.key('\t');
  expect('空输入框按 Tab 填入第一条建议', t.tui.draft === '帮我理解这个项目的结构', t.tui.draft);
  t.key('\t');
  expect('再按 Tab 换下一条建议', t.tui.draft === '帮我分析当前的报错，先说明原因', t.tui.draft);
  t.key('\x03');
  t.tui.fillPrompt('点击建议\x1b[2J填入');
  expect('点击建议填入输入框（外部文本被清洗）', t.tui.draft === '点击建议[2J填入', JSON.stringify(t.tui.draft));
  t.key('\x03');

  t.key('你好');
  expect('输入的文字出现在输入框里', t.term.count('│ 你好') === 1 && t.term.count(PLACEHOLDER) === 0, t.term.text());
  expect('光标停在输入文字之后', t.term.cursorVisible && t.term.x === 6 && t.term.cursorLine().startsWith('│ 你好'), `${t.term.x} ${t.term.cursorLine()}`);
  t.key('\x7f');
  expect('退格', t.term.count('│ 你 ') === 1 && t.term.x === 4, t.term.cursorLine());
  t.key('好，帮我看看');
  t.key(ENTER);
  expect('回车发送', t.last().type === 'send' && t.last().text === '你好，帮我看看', JSON.stringify(t.last()));
  expect('发送后输入框清空', t.term.count(PLACEHOLDER) === 1);
  expect('没有出现自动折行', t.term.wraps === 0, String(t.term.wraps));
  rows = t.term.rowsText();
  expect('重画后屏幕仍然正好一屏', rows.length === 30, String(rows.length));
}

// 屏幕很矮时欢迎页自动精简，不超出屏幕
{
  const t = mk({ cols: 60, rows: 12 });
  const text = t.term.text();
  expect('矮屏幕：只保留欢迎标题', text.includes('有什么想一起完成的？') && !text.includes('Tab 填入建议') && t.term.rowsText().length <= 12, text);
  expect('矮屏幕：没有自动折行', t.term.wraps === 0);
}

// 可点击的操作（标题行、建议）
{
  const header = '✦ AI Agent           /new 新建 · /history 历史 · /settings 设置';
  const links = findActionLinks(header);
  expect(
    '标题行的 /new /history /settings 可点击',
    links.map((l) => l.action.type).join() === 'newSession,openHistory,openSettings' && links.every((l) => header.substr(l.startIndex, l.length).startsWith('/')),
    JSON.stringify(links)
  );
  const pill = findActionLinks('                      ( 了解这个项目 ↗ )');
  expect('欢迎页的建议可点击并填入输入框', pill.length === 1 && pill[0].action.type === 'fillPrompt' && pill[0].action.text === '帮我理解这个项目的结构', JSON.stringify(pill));
  expect('普通对话内容里的 /new 不会变成链接', findActionLinks('  输入 /new 可以新建对话，/settings 打开设置').length === 0);
}

// ---------------------------------------------------------------------------
// 7. ChatTui：一次完整的流式回答
// ---------------------------------------------------------------------------
const ANSWER = [
  '## 分析结果',
  '',
  '这是**粗体**和 `code`，文件在 src/app.ts:12。',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| 列A | 列B |',
  '|---|---|',
  '| 1 | 二 |',
  '',
  '最后一句没有换行'
].join('\n');

function runAnswer(t, chunks) {
  t.tui.receive({ type: 'user', text: '分析一下' });
  t.tui.receive({ type: 'state', busy: true });
  t.tui.receive({ type: 'assistantStart', id: 'a1' });
  for (const c of chunks) t.tui.receive({ type: 'textDelta', text: c });
}

{
  const t = mk();
  runAnswer(t, [ANSWER.slice(0, 30), ANSWER.slice(30, 31), ANSWER.slice(31, 90), ANSWER.slice(90)]);
  expect('运行中显示状态行与停止提示', /正在思考… \(\d+s · Esc 停止\)/.test(t.term.text()) && /│ ● test-model\s+■ │/.test(t.term.text()), t.term.text());
  expect('流式过程中未结束的最后一行也可见', t.term.count('最后一句没有换行') === 1);
  expect('有了对话内容后欢迎页消失', t.term.count('有什么想一起完成的？') === 0);
  t.tui.receive({ type: 'assistantEnd', id: 'a1', meta: 'test-model · 1.2s' });
  t.tui.receive({ type: 'state', busy: false });
  const text = t.term.text();
  const rows = t.term.rowsText();
  expect('标题行 + 会话标题', /^✦ AI Agent\s+\/new/.test(rows[0]) && rows[1] === '分析一下', `${rows[0]}\n${rows[1]}`);
  const bubble = rows.find((r) => r.includes('│ 分析一下 │'));
  expect('用户消息为右对齐的气泡', !!bubble && /^ +│ 分析一下 │$/.test(bubble) && textWidth(bubble) === 79 && rows.some((r) => /^ +╭─+╮$/.test(r)), text);
  expect('回答以「✦ AI Agent」开头，正文缩进', rows.includes('✦ AI Agent') && rows[rows.indexOf('✦ AI Agent') + 1] === '  分析结果' && rows.includes('  这是粗体和 code，文件在 src/app.ts:12。'), text);
  expect('列表、代码块、表格都渲染出来', rows.includes('  • 列表一') && rows.includes('  ╭─ js') && rows.includes('  │ const a = 1;') && rows.includes('  ╰─') && /│ 1\s+│ 二\s+│/.test(text), text);
  expect('Markdown 标记没有残留', !/\*\*|```|\|---/.test(text), text);
  expect(
    '重绘不留残影（每块内容只出现一次）',
    ['分析结果', '列表二', 'const a = 1;', '最后一句没有换行', '│ 分析一下 │', '列A'].every((s) => t.term.count(s) === 1),
    text
  );
  expect('结束后显示统计信息并恢复输入框', rows.includes('  test-model · 1.2s') && t.term.count(PLACEHOLDER) === 1 && !/正在思考/.test(text), text);
  expect('输入框在最下方且光标在其中', t.term.cursorLine().startsWith('│ ') && t.term.x === 2 && t.term.cursorVisible, t.term.cursorLine());
  expect('流式输出没有自动折行', t.term.wraps === 0, String(t.term.wraps));

  // 逐字到达与一次到达，最终屏幕完全一致
  const byChar = mk();
  runAnswer(byChar, Array.from(ANSWER));
  byChar.tui.receive({ type: 'assistantEnd', id: 'a1', meta: 'test-model · 1.2s' });
  byChar.tui.receive({ type: 'state', busy: false });
  const whole = mk();
  runAnswer(whole, [ANSWER]);
  whole.tui.receive({ type: 'assistantEnd', id: 'a1', meta: 'test-model · 1.2s' });
  whole.tui.receive({ type: 'state', busy: false });
  expect('逐字输出与一次输出的最终屏幕一致', byChar.term.text() === whole.term.text() && byChar.term.text() === text, `\n--- 逐字 ---\n${byChar.term.text()}\n--- 一次 ---\n${whole.term.text()}`);
  expect('逐字输出没有自动折行', byChar.term.wraps === 0, String(byChar.term.wraps));
}

// 很长的一段（没有换行）超过屏幕高度：前面的行提前定稿，内容不丢、不重复
{
  const t = mk({ cols: 60, rows: 12 });
  const long = Array.from({ length: 700 }, (_, i) => String.fromCharCode(0xac00 + i)).join('');
  const chunks = [];
  for (let i = 0; i < long.length; i += 7) chunks.push(long.slice(i, i + 7));
  runAnswer(t, chunks);
  t.tui.receive({ type: 'textDelta', text: '\n\n结束。' });
  t.tui.receive({ type: 'assistantEnd', id: 'a1', meta: '' });
  t.tui.receive({ type: 'state', busy: false });
  const got = (t.term.text().match(/[가-힣]/g) || []).join('');
  expect('超过屏幕高度的长段落完整显示且不重复', got === long, `${got.length} / ${long.length}`);
  expect('长段落之后的内容正常', t.term.count('结束。') === 1 && t.term.wraps === 0, String(t.term.wraps));
}

// 模型输出里的转义序列不能操纵终端
{
  const t = mk();
  const before = t.term.raw.length;
  runAnswer(t, ['危险\x1b[2J\x1b]0;evil\x07\x1b[31m内容\x9b5A\n']);
  t.tui.receive({ type: 'toolStart', id: 't1', name: 'bash', label: '运行 echo \x1b[2J' });
  t.tui.receive({ type: 'toolEnd', id: 't1', name: 'bash', ok: true, summary: '退出码 0', output: 'out\x1b[3J\x1b[H\nline2' });
  t.tui.receive({ type: 'error', message: '失败\x1b[2J' });
  t.tui.receive({ type: 'notice', text: '提示\x1b[2J' });
  t.tui.receive({ type: 'user', text: '气泡\x1b[2J里' });
  const written = t.term.raw.slice(before);
  expect('外部文本里的 ESC 序列被清洗', !/\x1b\[2J|\x1b\[3J|\x1b\]|\x1b\[H|\x9b|\x07/.test(written), JSON.stringify(written.match(/\x1b\[[23]J|\x1b\]|\x1b\[H/g)));
  expect('清洗后文字仍然显示', t.term.text().includes('危险[2J') && t.term.text().includes('内容') && t.term.text().includes('气泡[2J里'), t.term.text());
}

// 请求重试：未完成的半行作废
{
  const t = mk();
  runAnswer(t, ['半句话还没']);
  t.tui.receive({ type: 'textReset' });
  t.tui.receive({ type: 'textDelta', text: '重新回答。\n' });
  t.tui.receive({ type: 'assistantEnd', id: 'a1', meta: '' });
  expect('textReset 丢弃未定稿的文本', t.term.count('半句话还没') === 0 && t.term.count('重新回答。') === 1, t.term.text());
}

// 很长的用户消息在气泡里折行，多行消息保留换行
{
  const t = mk({ cols: 50 });
  t.tui.receive({ type: 'user', text: '第一行\n' + '很长的消息'.repeat(12) });
  const rows = t.term.rowsText().filter((r) => /^ +│/.test(r));
  expect(
    '长消息在气泡里折行且右边对齐',
    rows.length >= 4 && rows[0].includes('│ 第一行') && new Set(rows.map((r) => textWidth(r))).size === 1 && textWidth(rows[0]) === 49,
    t.term.text()
  );
  expect('气泡没有自动折行', t.term.wraps === 0);
}

// ---------------------------------------------------------------------------
// 8. ChatTui：工具、计划、审批
// ---------------------------------------------------------------------------
const EDIT_REQUEST = {
  id: 'p1',
  kind: 'edit',
  title: '修改 a.txt',
  added: 1,
  removed: 1,
  diff: [
    { kind: 'ctx', no: 1, text: 'alpha' },
    { kind: 'del', no: 2, text: 'beta' },
    { kind: 'add', no: 2, text: 'BETA' }
  ]
};

{
  const t = mk();
  runAnswer(t, ['我先看一下文件。\n']);
  t.tui.receive({ type: 'toolStart', id: 't1', name: 'read', label: '读取 a.txt' });
  expect('运行中的工具显示在动态区域', /● 读取 a\.txt …/.test(t.term.text()) && /正在执行…/.test(t.term.text()), t.term.text());
  t.tui.receive({ type: 'toolEnd', id: 't1', name: 'read', ok: true, summary: '2 行' });
  expect('工具结束后定稿且只出现一次', t.term.count('● 读取 a.txt') === 1 && !/读取 a\.txt …/.test(t.term.text()), t.term.text());

  t.tui.receive({
    type: 'plan',
    steps: [
      { step: '阅读代码', status: 'completed' },
      { step: '修改文件', status: 'in_progress' },
      { step: '运行测试', status: 'pending' }
    ]
  });
  t.tui.receive({ type: 'toolStart', id: 'tp', name: 'update_plan', label: '更新计划' });
  t.tui.receive({ type: 'toolEnd', id: 'tp', name: 'update_plan', ok: true, summary: '' });
  expect('任务计划', /● 任务计划\n\s+⎿ ☑ 阅读代码\n\s+▸ 修改文件\n\s+☐ 运行测试/.test(t.term.text()) && t.term.count('更新计划') === 0, t.term.text());

  // 修改文件的审批
  t.tui.receive({ type: 'toolStart', id: 't2', name: 'edit', label: '修改 a.txt' });
  t.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  t.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  let text = t.term.text();
  expect('确认卡片：标题「等待你确认」、修改说明与统计', /╭─ 等待你确认 ─+╮/.test(text) && /│ 修改 a\.txt · \+1 −1\s+│/.test(text), text);
  expect('确认卡片：Diff 行', /│\s+2 - beta\s+│/.test(text) && /│\s+2 \+ BETA\s+│/.test(text), text);
  expect('确认卡片：横排按钮', /查看修改 {4}允许修改 {4}本次会话都允许 {4}暂不修改/.test(text), text);
  expect('默认选中「允许修改」', selectedButton(t) === '允许修改', selectedButton(t));
  expect('重复的审批消息不会出现两张卡片', t.term.count('等待你确认') === 1);
  expect('审批时隐藏输入框与光标', t.term.count(PLACEHOLDER) === 0 && !t.term.cursorVisible);
  const n = t.emitted.length;
  t.key('随便打字');
  expect('审批时的普通按键不会进入输入框或触发决定', t.emitted.length === n);
  t.key('d');
  expect('d 查看修改', t.last().type === 'openDiff' && t.last().id === 'p1');
  t.key(LEFT);
  expect('← 移到「查看修改」', selectedButton(t) === '查看修改', selectedButton(t));
  const before = t.emitted.length;
  t.key(ENTER);
  expect('在「查看修改」上回车打开 Diff，卡片保留', t.emitted.length === before + 1 && t.last().type === 'openDiff' && t.term.count('等待你确认') === 1);
  t.key(RIGHT + RIGHT);
  expect('→ 移动选项', selectedButton(t) === '本次会话都允许', selectedButton(t));
  t.key(ENTER);
  expect('Enter 确认当前选项', t.last().type === 'approvalResponse' && t.last().decision === 'allowAllEdits' && t.last().id === 'p1', JSON.stringify(t.last()));
  const m = t.emitted.length;
  t.key('y');
  t.key(ENTER);
  expect('已回应后不会重复发送', t.emitted.length === m);
  t.tui.receive({ type: 'approvalDone', id: 'p1', decision: 'allowAllEdits' });
  t.tui.receive({ type: 'toolEnd', id: 't2', name: 'edit', ok: true, summary: '+1 −1' });
  text = t.term.text();
  expect('审批结束后卡片消失、输入框恢复', t.term.count('等待你确认') === 0 && t.term.count(PLACEHOLDER) === 1, text);
  expect('写入结果带统计与 Diff', /● 修改 a\.txt\n\s+⎿ ✓ 已修改（\+1 −1）\n\s+1 {3}alpha\n\s+2 - beta\n\s+2 \+ BETA/.test(text), text);
  expect('提示本次会话后续修改自动允许', text.includes('本次会话后续的文件修改将自动允许'));

  // 运行命令的审批：只有两个按钮
  t.tui.receive({ type: 'toolStart', id: 't3', name: 'bash', label: '运行 npm test' });
  t.tui.receive({ type: 'approval', request: { id: 'p2', kind: 'bash', title: '运行命令', command: 'npm test', cwd: '/ws' } });
  text = t.term.text();
  expect(
    '命令确认卡片',
    /允许运行 {4}暂不运行/.test(text) && /│ npm test\s+│/.test(text) && text.includes('工作目录：/ws') && !text.includes('本次会话都允许') && !text.includes('d 查看修改'),
    text
  );
  expect('命令确认默认选中「允许运行」', selectedButton(t) === '允许运行');
  t.key('3');
  expect('不存在的按钮编号被忽略', t.last().type !== 'approvalResponse' || t.last().id !== 'p2');
  t.key(ESC);
  expect('Esc 暂不运行', t.last().type === 'approvalResponse' && t.last().decision === 'deny' && t.last().id === 'p2', JSON.stringify(t.last()));
  t.tui.receive({ type: 'approvalDone', id: 'p2', decision: 'deny' });
  t.tui.receive({ type: 'toolEnd', id: 't3', name: 'bash', ok: false, summary: '用户拒绝' });
  expect('被拒绝的命令标为暂不运行', /● 运行 npm test\n\s+⎿ 你选择了暂不运行/.test(t.term.text()), t.term.text());

  // 命令输出预览
  t.tui.receive({ type: 'toolStart', id: 't4', name: 'bash', label: '运行 npm test' });
  t.tui.receive({
    type: 'toolEnd',
    id: 't4',
    name: 'bash',
    ok: true,
    summary: '退出码 0',
    output: Array.from({ length: 10 }, (_, i) => `输出 ${i}`).join('\n')
  });
  text = t.term.text();
  expect('命令输出只预览最后 6 行', /⎿ 退出码 0\n\s+输出 4\n/.test(text) && text.includes('输出 9') && !text.includes('输出 3') && text.includes('⋯ 共 10 行'), text);

  t.tui.receive({ type: 'assistantEnd', id: 'a1', meta: 'test-model · 3.0s · 4 次工具调用' });
  t.tui.receive({ type: 'changes', files: ['a.txt'] });
  t.tui.receive({ type: 'state', busy: false });
  text = t.term.text();
  expect('修改汇总与撤销提示', /● 本次修改了 1 个文件\n\s+⎿ a\.txt\n\s+输入 \/undo 可撤销本次修改/.test(text), text);
  expect('工具与审批流程没有自动折行', t.term.wraps === 0, String(t.term.wraps));

  // 被拒绝的文件修改
  const d = mk();
  d.tui.receive({ type: 'toolStart', id: 'x', name: 'edit', label: '修改 b.txt' });
  d.tui.receive({ type: 'approval', request: { ...EDIT_REQUEST, id: 'px' } });
  d.key('n');
  d.tui.receive({ type: 'approvalDone', id: 'px', decision: 'deny' });
  d.tui.receive({ type: 'toolEnd', id: 'x', name: 'edit', ok: false, summary: '用户拒绝' });
  expect('被拒绝的修改标为暂不修改', /● 修改 b\.txt\n\s+⎿ 你选择了暂不修改，文件没有改动/.test(d.term.text()), d.term.text());

  // 数字键、y / n、方向键
  for (const [keys, decision] of [['2', 'allow'], ['3', 'allowAllEdits'], ['4', 'deny'], ['y', 'allow'], ['n', 'deny'], [ESC, 'deny'], [ENTER, 'allow'], [RIGHT + ENTER, 'allowAllEdits'], ['\t\t' + ENTER, 'deny']]) {
    const a = mk();
    a.tui.receive({ type: 'approval', request: EDIT_REQUEST });
    a.key(keys);
    expect(`审批按键 ${JSON.stringify(keys)} → ${decision}`, a.last().type === 'approvalResponse' && a.last().decision === decision, JSON.stringify(a.last()));
  }
  const one = mk();
  one.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  one.key('1');
  expect('数字 1 是「查看修改」', one.last().type === 'openDiff' && one.term.count('等待你确认') === 1);

  // 防误触：卡片刚出现时的按键不生效
  const g = mk({ guard: 60000 });
  g.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  const count = g.emitted.length;
  g.key('y');
  g.key(ENTER);
  expect('卡片刚出现时的按键被忽略（防误触）', g.emitted.length === count);

  // 两个审批排队
  const q = mk();
  q.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  q.tui.receive({ type: 'approval', request: { id: 'p9', kind: 'bash', title: '运行命令', command: 'ls' } });
  q.key('2');
  q.tui.receive({ type: 'approvalDone', id: 'p1', decision: 'allow' });
  expect('前一个审批结束后显示下一个', q.term.text().includes('允许运行') && q.term.count('允许修改') === 0, q.term.text());
  q.key('1');
  expect('第二个审批独立回应', q.last().id === 'p9' && q.last().decision === 'allow');

  // 窄窗口：按钮折成两行，不超宽
  const narrow = mk({ cols: 36, rows: 30 });
  narrow.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  expect('窄窗口里按钮自动折行且不超宽', narrow.term.text().includes('暂不修改') && narrow.term.wraps === 0, narrow.term.text());
}

// 停止时仍在运行的工具
{
  const t = mk();
  runAnswer(t, []);
  t.tui.receive({ type: 'toolStart', id: 't1', name: 'bash', label: '运行 sleep 100' });
  t.key(ESC);
  expect('运行中按 Esc 停止', t.last().type === 'stop' && t.term.text().includes('正在停止…'), t.term.text());
  t.tui.receive({ type: 'assistantEnd', id: 'a1', aborted: true, meta: 'test-model · 0.5s · 已停止' });
  t.tui.receive({ type: 'state', busy: false });
  expect('停止后未完成的工具标为已停止', /● 运行 sleep 100\n\s+⎿ 已停止/.test(t.term.text()) && !t.term.text().includes('正在停止'), t.term.text());
  t.tui.receive({ type: 'error', message: '连接失败：ECONNREFUSED' });
  expect('错误信息', t.term.text().includes('✗ 连接失败：ECONNREFUSED'));
}

// ---------------------------------------------------------------------------
// 9. ChatTui：斜杠命令与按键
// ---------------------------------------------------------------------------
{
  const t = mk();
  t.key('/');
  let text = t.term.text();
  expect('输入 / 列出命令', /❯ \/new\s+新建对话/.test(text) && text.includes('/model') && text.includes('/settings'), text);
  t.key('mo');
  text = t.term.text();
  expect('继续输入会过滤命令', /❯ \/model\s+切换模型\n\s+\/mode\s+切换操作确认方式/.test(text) && !text.includes('/new 新建对话'), text);
  t.key(DOWN);
  expect('↓ 选择下一条命令', /❯ \/mode /.test(t.term.text()), t.term.text());
  t.key('\t');
  expect('Tab 补全', t.term.count('│ /mode ') === 1, t.term.text());
  t.key(ENTER);
  expect('回车执行命令', t.last().type === 'pickMode' && t.term.count(PLACEHOLDER) === 1, JSON.stringify(t.last()));

  const run = (input) => {
    t.key(input);
    t.key(ENTER);
    return t.last();
  };
  expect('/model', run('/model').type === 'pickModel');
  expect('/new', run('/new').type === 'newSession');
  expect('/history 打开原生历史选择器', run('/history').type === 'openHistory');
  expect('/clear 等同于 /new', run('/clear').type === 'newSession');
  expect('/settings', run('/settings').type === 'openSettings');
  expect('/undo', run('/undo').type === 'undo');
  expect('/context', run('/context').type === 'showContext');
  expect('/fix', run('/fix').type === 'quickAction' && t.last().action === 'fix');
  expect('/run', run('/run').type === 'quickAction' && t.last().action === 'runTests');
  expect('只输入前缀也能执行第一条匹配的命令', run('/expl').type === 'quickAction' && t.last().action === 'explain', JSON.stringify(t.last()));
  const n = t.emitted.length;
  t.key('/nope');
  t.key(ENTER);
  expect('未知命令给出提示且不发送', t.emitted.length === n && t.term.text().includes('未知命令 /nope'), t.term.text());
  t.key('\x03');
  expect('Ctrl+C 清空输入', t.term.count(PLACEHOLDER) === 1);
  t.key('\x03');
  expect('空输入时 Ctrl+C 给出提示', t.term.text().includes('关闭这个标签页即可结束对话'));
  t.key('/help');
  t.key(ENTER);
  expect('/help 显示命令与按键说明', t.term.text().includes('● 命令') && t.term.text().includes('Shift+Enter') && t.term.text().includes('等待确认时') && t.emitted.length === n, t.term.text());

  // 任务运行中
  t.tui.receive({ type: 'state', busy: true });
  const b = t.emitted.length;
  t.key('再发一条');
  t.key(ENTER);
  expect('运行中不能发送新消息，输入保留', t.emitted.length === b && t.term.text().includes('按 Esc 停止后再发送') && t.term.count('│ 再发一条') === 1, t.term.text());
  t.key('\x15');
  t.key('/new');
  t.key(ENTER);
  expect('运行中不能新建对话', t.emitted.length === b && t.term.text().includes('先按 Esc 停止'), t.term.text());
  t.key('\x15');
  t.key('/stop');
  t.key(ENTER);
  expect('运行中可以 /stop', t.last().type === 'stop');
  t.key('\x03');
  expect('运行中 Ctrl+C 停止', t.emitted.length === b + 2 && t.last().type === 'stop');
  expect('斜杠命令流程没有自动折行', t.term.wraps === 0, String(t.term.wraps));
}

// 多行输入、粘贴、历史
{
  const t = mk();
  t.key('第一行');
  t.key('\x1b\r');
  t.key('第二行');
  let text = t.term.text();
  expect('Shift+Enter（ESC CR）换行', /│ 第一行\s+│\n│ 第二行\s+│/.test(text), text);
  expect('光标在第二行末尾', t.term.x === 8 && t.term.cursorLine().includes('第二行'), `${t.term.x} ${t.term.cursorLine()}`);
  t.key(ENTER);
  expect('多行内容一起发送', t.last().type === 'send' && t.last().text === '第一行\n第二行', JSON.stringify(t.last()));

  const n = t.emitted.length;
  t.key('行尾反斜杠\\');
  t.key(ENTER);
  t.key('续行');
  expect('行尾 \\ 加回车换行而不发送', t.emitted.length === n && /│ 行尾反斜杠\s+│\n│ 续行/.test(t.term.text()), t.term.text());
  t.key(ENTER);
  expect('随后回车发送', t.last().text === '行尾反斜杠\n续行', JSON.stringify(t.last()));

  t.key('\x1b[200~粘贴一\r\n粘贴二\n\x1b[201~');
  expect('粘贴的多行文本不会被当成回车发送', t.last().text === '行尾反斜杠\n续行' && /│ 粘贴一\s+│\n│ 粘贴二/.test(t.term.text()), t.term.text());
  t.key('\x03');
  t.key('\x1b[200~分段');
  t.key('到达\nok');
  t.key('\x1b[201~!');
  t.key(ENTER);
  expect('分多次到达的粘贴内容', t.last().text === '分段到达\nok!', JSON.stringify(t.last()));

  t.key(UP);
  expect('↑ 取回上一条输入', /│ 分段到达/.test(t.term.text()), t.term.text());
  t.key('\x03');
  t.key('abc def');
  t.key('\x17');
  t.key('\x1b[D\x1b[D\x1b[D\x1b[D');
  t.key('X');
  t.key(ENTER);
  expect('Ctrl+W 与方向键编辑', t.last().text === 'Xabc ', JSON.stringify(t.last()));
  expect('多行输入流程没有自动折行', t.term.wraps === 0, String(t.term.wraps));
}

// ---------------------------------------------------------------------------
// 10. ChatTui：历史、清空、窗口缩放、打开前的消息
// ---------------------------------------------------------------------------
{
  const t = mk();
  t.key('当前会话草稿');
  expect('原生终端可以读取未发送草稿', t.tui.draft === '当前会话草稿');
  t.tui.receive({ type: 'cleared' });
  t.tui.receive({ type: 'history', messages: [], draft: '切回会话恢复的草稿' });
  expect('会话切换恢复输入且没有旧会话残留', t.tui.draft === '切回会话恢复的草稿' && !t.term.text().includes('当前会话草稿'));
  t.tui.receive({ type: 'cleared' });
  t.tui.receive({ type: 'history', messages: [], draft: '' });
  expect('新建会话输入为空', t.tui.draft === '');
}

{
  const t = mk({ closed: true, onEmit: (message, tui) => {
    if (message.type !== 'ready') return;
    tui.receive({ type: 'history', replacePending: true, messages: [], draft: '下一条草稿' });
    tui.receive({ type: 'user', text: '正在运行的请求', replay: true });
    tui.receive({ type: 'assistantStart', replay: true });
    tui.receive({ type: 'textDelta', text: '运行中的回复', replay: true });
  } });
  t.tui.receive({ type: 'user', text: '正在运行的请求' });
  t.tui.receive({ type: 'assistantStart' });
  t.tui.receive({ type: 'textDelta', text: '运行中的回复' });
  t.tui.receive({ type: 'notice', text: '手动命令已经完成' });
  t.tui.open(80, 30);
  expect('宿主补发运行快照后不会重复显示打开前的消息', t.term.count('│ 正在运行的请求 │') === 1 && t.term.count('运行中的回复') === 1 && t.tui.draft === '下一条草稿', t.term.text());
  expect('补发会话后仍保留打开前的独立操作通知', t.term.count('手动命令已经完成') === 1);
}

{
  const t = mk();
  t.tui.receive({
    type: 'history',
    messages: [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答，含**粗体**。' }
    ]
  });
  let text = t.term.text();
  let rows = t.term.rowsText();
  expect(
    '恢复之前的对话',
    rows[1] === '旧问题' && text.includes('│ 旧问题 │') && /✦ AI Agent\n  旧回答，含粗体。/.test(text) && text.includes('以上是之前的对话') && t.term.count('有什么想一起完成的？') === 0,
    text
  );

  runAnswer(t, ['新的回答。\n']);
  t.tui.receive({ type: 'assistantEnd', id: 'a1', meta: '' });
  t.tui.receive({ type: 'state', busy: false });
  expect('同一会话里只有一个标题行', t.term.count('/settings 设置') === 1, t.term.text());
  t.tui.receive({ type: 'cleared' });
  text = t.term.text();
  expect('新建对话后清屏并重新显示欢迎页', t.term.count('有什么想一起完成的？') === 1 && !text.includes('旧问题') && !text.includes('新的回答') && t.term.count(PLACEHOLDER) === 1, text);
  expect('清屏后标题行在最上方', t.term.rowsText()[0].startsWith('✦ AI Agent'), t.term.rowsText()[0]);

  // 变宽
  t.key('缩放前的输入');
  t.term.resize(120, 40);
  t.tui.setDimensions(120, 40);
  t.key('!');
  expect('窗口变宽后只有一个输入框', t.term.count('│ 缩放前的输入!') === 1 && t.term.count('╰') === 1 && t.term.count('/settings 设置') === 1, t.term.text());
  // 变窄：原来的长行被终端折成多行
  t.term.resize(40, 20);
  t.tui.setDimensions(40, 20);
  t.key('?');
  text = t.term.text();
  expect('窗口变窄后只有一个输入框', t.term.count('│ 缩放前的输入!?') === 1 && t.term.count('╰') === 1, text);
  expect('窗口变窄后输入框下方有提示行', /│ 缩放前的输入!\?\s+│\n(│.*│\n)+╰─+╯\n *\S/.test(text), text);
  expect('窗口变窄后的重绘每行都不超宽', t.term.wraps === 0, String(t.term.wraps));
  t.key(ENTER);
  expect('缩放后仍能发送', t.last().text === '缩放前的输入!?');
}

{
  // 终端标签页还没真正打开时收到的消息：打开后排在历史对话之后重放
  const t = mk({
    closed: true,
    onEmit: (m, tui) => {
      if (m.type === 'ready') {
        tui.receive({ type: 'state', configured: true, model: 'm1', mode: 'ask', busy: true });
        tui.receive({ type: 'history', messages: [{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '旧回答' }] });
        tui.receive({ type: 'approval', request: EDIT_REQUEST });
      }
    }
  });
  t.tui.receive({ type: 'state', configured: true, model: 'm1', mode: 'ask', busy: true });
  t.tui.receive({ type: 'user', text: '新问题' });
  t.tui.receive({ type: 'assistantStart', id: 'a1' });
  t.tui.receive({ type: 'textDelta', text: '新回答第一句。\n' });
  t.tui.receive({ type: 'toolStart', id: 't1', name: 'edit', label: '修改 a.txt' });
  t.tui.receive({ type: 'approval', request: EDIT_REQUEST });
  expect('打开之前不向终端写任何内容', t.term.raw === '' && t.emitted.length === 0);
  t.tui.open(80, 30);
  const text = t.term.text();
  const at = (s) => text.indexOf(s);
  expect(
    '打开后的顺序：标题行 → 历史 → 打开前的消息',
    at('✦ AI Agent') === 0 && at('│ 旧问题 │') > 0 && at('│ 旧问题 │') < at('旧回答') && at('旧回答') < at('│ 新问题 │') && at('│ 新问题 │') < at('新回答第一句。'),
    text
  );
  expect('打开前就在等待的审批只显示一张卡片', t.term.count('等待你确认') === 1, text);
  t.key('2');
  expect('重放后的审批可以回应', t.last().type === 'approvalResponse' && t.last().id === 'p1');
  t.tui.dispose();
  t.tui.receive({ type: 'notice', text: '关闭后的消息' });
  expect('关闭后不再写终端', !t.term.text().includes('关闭后的消息'));
}

if (fail > 0) {
  console.error(fail + ' check(s) failed');
  process.exit(1);
}
console.log('tui tests passed');
