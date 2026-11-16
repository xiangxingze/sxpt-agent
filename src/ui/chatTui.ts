/**
 * 终端里的对话界面（纯逻辑，不依赖 vscode，可在 Node 中直接测试）。
 *
 * 屏幕分成两部分：
 *  - 已定稿的内容：用户消息、助手文本、工具调用、计划、汇总，写出后不再改动，随终端滚动；
 *  - 底部的动态区域：正在流式输出的半行文本、进行中的工具、输入框 / 审批卡片、状态栏，
 *    每次变化时整体擦除重画（光标上移 → 清到屏幕末尾 → 重新输出）。
 *
 * 与宿主（ChatController）之间沿用一套消息协议：receive() 接收宿主事件，emit() 发出用户操作。
 */
import { RESET, padEnd, sanitize, stripAnsi, style, textWidth, truncate, wrapAnsi } from './ansi';
import { LineEditor } from './lineEditor';
import { MarkdownStream, renderMarkdown } from './markdownAnsi';
import type { DiffLine } from './diffLines';

export interface TuiOptions {
  write(data: string): void;
  emit(message: any): void;
  /** 显示在欢迎框里的工作目录 */
  cwd?: string;
  /** 测试用：立即重绘、关闭动画 */
  sync?: boolean;
  /** 审批卡片出现后的防误触时间（毫秒） */
  approvalGuardMs?: number;
}

interface ApprovalView {
  id: string;
  kind: 'edit' | 'write' | 'bash';
  title: string;
  command?: string;
  cwd?: string;
  isNewFile?: boolean;
  added?: number;
  removed?: number;
  diff?: DiffLine[];
  shownAt: number;
  selected: number;
  responded: boolean;
}

interface SlashCommand {
  name: string;
  hint: string;
  message?: any;
  /** 任务运行中也可以使用 */
  whileBusy?: boolean;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/new', hint: '新建对话', message: { type: 'newSession' } },
  { name: '/history', hint: '选择历史会话', message: { type: 'openHistory' }, whileBusy: true },
  { name: '/model', hint: '切换模型', message: { type: 'pickModel' } },
  { name: '/mode', hint: '切换审批模式', message: { type: 'pickMode' } },
  { name: '/settings', hint: '模型服务与 Agent 设置', message: { type: 'openSettings' } },
  { name: '/undo', hint: '撤销上一次任务的文件修改', message: { type: 'undo' } },
  { name: '/context', hint: '查看将随消息发送的上下文', message: { type: 'showContext' }, whileBusy: true },
  { name: '/explain', hint: '解释选中的代码', message: { type: 'quickAction', action: 'explain' } },
  { name: '/problems', hint: '分析当前的错误和警告', message: { type: 'quickAction', action: 'problem' } },
  { name: '/fix', hint: '修复问题并验证', message: { type: 'quickAction', action: 'fix' } },
  { name: '/tests', hint: '为选中的代码生成测试', message: { type: 'quickAction', action: 'tests' } },
  { name: '/refactor', hint: '重构选中的代码', message: { type: 'quickAction', action: 'refactor' } },
  { name: '/project', hint: '理解项目结构', message: { type: 'quickAction', action: 'project' } },
  { name: '/run', hint: '运行测试或构建命令', message: { type: 'quickAction', action: 'runTests' } },
  { name: '/stop', hint: '停止当前任务', message: { type: 'stop' }, whileBusy: true },
  { name: '/help', hint: '查看命令与快捷键', whileBusy: true }
];

const MODE_LABELS: Record<string, string> = {
  ask: '逐项确认',
  autoEdit: '自动应用修改',
  readOnly: '只读'
};

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const PLACEHOLDER = '描述你的任务，或输入 / 查看命令';
const MAX_SUGGESTIONS = 8;

export class ChatTui {
  private cols = 80;
  private rows = 24;
  private opened = false;

  /** 窗口打开之前收到的消息；打开后置为 undefined */
  private backlog: any[] | undefined = [];
  private replacePending = false;
  /** 等待写出的定稿行 */
  private queue: string[] = [];
  /** 最后一行定稿内容是否为空行（用于控制块之间的间距） */
  private atBlank = true;

  /** 屏幕上当前的动态区域：各行宽度与光标所在行 */
  private dynWidths: number[] = [];
  private dynCursorRow = 0;
  private dynCursorCol = 0;

  private readonly editor = new LineEditor();
  private md?: MarkdownStream;
  private segStarted = false;
  private readonly runningTools = new Map<string, { name: string; label: string }>();
  private approvals: ApprovalView[] = [];
  private pendingStat = '';
  private pendingDiff: DiffLine[] | undefined;
  private deniedPending = false;

  private configured = false;
  private model = '';
  private mode = 'ask';
  private autoEdits = false;
  private busy = false;
  private contextLabel = '';
  private status = '';
  private hint = '';
  private runStartedAt = 0;
  private frame = 0;
  private slashIndex = 0;
  private pasteBuf: string | undefined;

  private redrawTimer: ReturnType<typeof setTimeout> | undefined;
  private spinTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: TuiOptions) {}

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  open(cols?: number, rows?: number): void {
    if (cols && rows) {
      this.cols = cols;
      this.rows = rows;
    }
    this.opened = true;
    this.dynWidths = [];
    this.opts.write('\x1b[?2004h');
    const backlog = this.backlog ?? [];
    this.backlog = undefined;
    this.banner();
    // 宿主在 ready 时补发历史与运行快照；快照已覆盖的对话事件不再重复播放。
    // 独立通知和错误仍保留，例如手动运行命令的结果。
    this.opts.emit({ type: 'ready' });
    for (const msg of backlog) {
      if (!this.replacePending || msg.type === 'notice' || msg.type === 'error') this.receive(msg);
    }
    this.render();
    this.syncSpinner();
  }

  close(): void {
    this.opened = false;
    this.stopTimers();
  }

  dispose(): void {
    this.close();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  get draft(): string {
    return this.editor.text;
  }

  setDimensions(cols: number, rows: number): void {
    if (!cols || !rows || (cols === this.cols && rows === this.rows)) {
      return;
    }
    // 终端变窄时 xterm 会把原来的长行折成多行：按新宽度估算动态区域光标上方的实际行数
    if (this.dynWidths.length > 0) {
      let above = 0;
      for (let i = 0; i < this.dynCursorRow; i++) {
        above += Math.max(1, Math.ceil(this.dynWidths[i] / cols));
      }
      above += Math.floor(this.dynCursorCol / cols);
      this.dynCursorRow = Math.min(above, Math.max(0, rows - 1));
    }
    this.cols = cols;
    this.rows = rows;
    this.render();
  }

  private stopTimers(): void {
    if (this.redrawTimer) {
      clearTimeout(this.redrawTimer);
      this.redrawTimer = undefined;
    }
    if (this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
  }

  private syncSpinner(): void {
    const want = this.busy && this.opened && !this.opts.sync;
    if (want && !this.spinTimer) {
      this.spinTimer = setInterval(() => {
        this.frame++;
        this.render();
      }, 160);
    } else if (!want && this.spinTimer) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
  }

  private schedule(): void {
    if (!this.opened) {
      return;
    }
    if (this.opts.sync) {
      this.render();
      return;
    }
    if (!this.redrawTimer) {
      this.redrawTimer = setTimeout(() => {
        this.redrawTimer = undefined;
        this.render();
      }, 20);
    }
  }

  // ------------------------------------------------------------------
  // 尺寸
  // ------------------------------------------------------------------

  /** 输入框、审批卡片的外框宽度 */
  private boxWidth(): number {
    return Math.max(24, Math.min(this.cols - 2, 110));
  }

  /** 正文宽度（不含行首 2 列缩进） */
  private textWidthLimit(): number {
    return Math.max(20, Math.min(this.cols - 4, 116));
  }

  // ------------------------------------------------------------------
  // 定稿内容
  // ------------------------------------------------------------------

  private commit(rows: string[]): void {
    for (const row of rows) {
      this.queue.push(row);
      this.atBlank = row === '';
    }
  }

  /** 输出一个独立的块：与上文之间保证有一个空行 */
  private block(rows: string[]): void {
    if (rows.length === 0) {
      return;
    }
    if (!this.atBlank) {
      this.commit(['']);
    }
    this.commit(rows);
  }

  private bulleted(text: string, bullet: string, width = this.textWidthLimit()): string[] {
    const rows: string[] = [];
    sanitize(text)
      .split('\n')
      .forEach((line) => rows.push(...wrapAnsi(line, width)));
    return rows.map((r, i) => (i === 0 ? `${bullet} ${r}` : `  ${r}`));
  }

  private banner(): void {
    const w = Math.max(24, Math.min(this.cols - 2, 72));
    const inner = w - 4;
    const line = (content: string) => `${style.dim('│')} ${padEnd(content, inner)} ${style.dim('│')}`;
    const rows = [style.dim(`╭${'─'.repeat(w - 2)}╮`), line(`${style.accent('✻')} ${style.bold('AI Coding Agent')}`), line('')];
    const intro = '描述一个目标，我会阅读代码、制定计划、修改文件并验证结果。每次修改都会先让你确认。';
    for (const r of wrapAnsi(intro, inner - 2)) {
      rows.push(line(`  ${style.dim(r)}`));
    }
    if (this.opts.cwd) {
      rows.push(line(''));
      rows.push(line(`  ${style.dim('工作目录')}  ${truncate(this.opts.cwd, Math.max(8, inner - 12))}`));
    }
    rows.push(style.dim(`╰${'─'.repeat(w - 2)}╯`));
    this.block(rows);
  }

  private userBlock(text: string): void {
    this.block(this.bulleted(text, style.dim('>')));
  }

  /** 把助手文本的定稿行写出：一段文本的第一行带 ● */
  private commitSeg(rows: string[]): void {
    for (const row of rows) {
      if (!this.segStarted) {
        if (row === '') {
          continue;
        }
        this.block([`● ${row}`]);
        this.segStarted = true;
      } else {
        this.commit([row === '' ? '' : `  ${row}`]);
      }
    }
  }

  private endSeg(): void {
    if (!this.md) {
      return;
    }
    this.commitSeg(this.md.end());
    this.md = undefined;
    this.segStarted = false;
  }

  private diffRows(lines: DiffLine[], width: number, limit: number): string[] {
    const rows: string[] = [];
    const shown = lines.slice(0, limit);
    for (const l of shown) {
      if (l.kind === 'gap') {
        rows.push(style.dim(truncate(`     ${l.text}`, width)));
        continue;
      }
      const no = String(l.no ?? '').padStart(4);
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const body = truncate(`${no} ${sign} ${sanitize(l.text)}`, width);
      rows.push(l.kind === 'add' ? style.green(body) : l.kind === 'del' ? style.red(body) : style.dim(body));
    }
    if (lines.length > shown.length) {
      rows.push(style.dim(truncate(`     ⋯ 还有 ${lines.length - shown.length} 行，完整修改见 Diff 编辑器`, width)));
    }
    return rows;
  }

  private toolBlock(msg: any): void {
    const running = this.runningTools.get(String(msg.id));
    this.runningTools.delete(String(msg.id));
    const name = String(msg.name ?? running?.name ?? '');
    if (name === 'update_plan') {
      return;
    }
    const ok = !!msg.ok;
    const label = running?.label ?? name;
    const rows = this.bulleted(label, ok ? style.green('●') : style.red('●'));
    const detail: string[] = [];
    const width = this.textWidthLimit() - 4;

    if (!ok) {
      const reason = this.deniedPending ? '已拒绝' : sanitize(String(msg.summary || '失败'));
      detail.push(...wrapAnsi(style.red(reason), width));
    } else if (name === 'edit' || name === 'write') {
      detail.push(`已写入${this.pendingStat ? `（${this.pendingStat}）` : ''}`);
      if (this.pendingDiff && this.pendingDiff.length > 0) {
        detail.push(...this.diffRows(this.pendingDiff, width, 12));
      }
    } else if (name === 'bash') {
      detail.push(String(msg.summary || '已完成'));
    }

    if (ok && msg.output && (name === 'bash' || name === 'get_diagnostics')) {
      const lines = sanitize(String(msg.output))
        .split('\n')
        .filter((l) => l.trim().length > 0);
      const max = 6;
      const shown = name === 'bash' ? lines.slice(-max) : lines.slice(0, max);
      detail.push(...shown.map((l) => style.dim(truncate(l, width))));
      if (lines.length > shown.length) {
        detail.push(style.dim(`⋯ 共 ${lines.length} 行`));
      }
    }

    detail.forEach((d, i) => rows.push(`${i === 0 ? `  ${style.dim('⎿')} ` : '    '}${d}`));
    this.pendingStat = '';
    this.pendingDiff = undefined;
    this.deniedPending = false;
    this.block(rows);
  }

  private planBlock(steps: Array<{ step: string; status: string }>): void {
    if (!steps.length) {
      return;
    }
    const rows = [`● ${style.bold('任务计划')}`];
    const width = this.textWidthLimit() - 6;
    steps.forEach((s, i) => {
      const text = truncate(sanitize(s.step).replace(/\n/g, ' '), width);
      const body =
        s.status === 'completed'
          ? `${style.green('☑')} ${style.dim(text)}`
          : s.status === 'in_progress'
            ? `${style.accent('▸')} ${style.bold(text)}`
            : `☐ ${text}`;
      rows.push(`${i === 0 ? `  ${style.dim('⎿')} ` : '    '}${body}`);
    });
    this.block(rows);
  }

  private helpBlock(): void {
    const rows = [`● ${style.bold('命令')}`];
    for (const c of SLASH_COMMANDS) {
      rows.push(`  ${style.accent(padEnd(c.name, 11))} ${style.dim(c.hint)}`);
    }
    rows.push('');
    rows.push(`  ${style.bold('按键')}`);
    const keys: Array<[string, string]> = [
      ['Enter', '发送'],
      ['Shift+Enter', '换行（也可用 Alt+Enter、Ctrl+J，或行尾输入 \\ 再回车）'],
      ['↑ / ↓', '翻看输入历史'],
      ['Esc', '停止正在运行的任务 / 拒绝审批'],
      ['Ctrl+C', '清空输入；任务运行中为停止'],
      ['Ctrl+U', '删除到行首'],
      ['d（审批时）', '重新打开 Diff']
    ];
    for (const [k, v] of keys) {
      rows.push(`  ${padEnd(k, 16)} ${style.dim(v)}`);
    }
    this.block(rows);
  }

  // ------------------------------------------------------------------
  // 宿主 → 界面
  // ------------------------------------------------------------------

  receive(msg: any): void {
    if (this.backlog && msg?.type !== 'state' && msg?.type !== 'context') {
      // 终端标签页还没真正打开（VS Code 异步回调 open）：先记下来，打开后按顺序重放
      if (this.backlog.length < 20000) {
        this.backlog.push(msg);
      }
      return;
    }
    switch (msg?.type) {
      case 'state':
        if (msg.configured !== undefined) {
          this.configured = !!msg.configured;
        }
        if (msg.model !== undefined) {
          this.model = String(msg.model || '');
        }
        if (msg.mode) {
          this.mode = String(msg.mode);
        }
        if (msg.autoEdits !== undefined) {
          this.autoEdits = !!msg.autoEdits;
        }
        if (msg.contextLabel) {
          this.contextLabel = String(msg.contextLabel);
        }
        if (msg.busy !== undefined && !!msg.busy !== this.busy) {
          this.busy = !!msg.busy;
          this.status = '';
          this.hint = '';
          if (this.busy) {
            this.runStartedAt = Date.now();
          }
          this.syncSpinner();
        }
        break;
      case 'context':
        // 编辑器里每次移动光标都会触发：内容没变就不重画
        if (this.contextLabel === String(msg.label ?? '')) {
          return;
        }
        this.contextLabel = String(msg.label ?? '');
        break;
      case 'history':
        this.replacePending = msg.replacePending === true;
        if (typeof msg.draft === 'string') {
          this.editor.clear();
          this.editor.set(msg.draft);
          this.slashIndex = 0;
          this.pasteBuf = undefined;
        }
        this.showHistory(Array.isArray(msg.messages) ? msg.messages : []);
        break;
      case 'user':
        this.endSeg();
        this.userBlock(String(msg.text ?? ''));
        break;
      case 'assistantStart':
        this.endSeg();
        this.status = '';
        break;
      case 'textDelta':
        if (!this.md) {
          this.md = new MarkdownStream(() => this.textWidthLimit());
          this.segStarted = false;
        }
        this.md.push(String(msg.text ?? ''));
        break;
      case 'textReset':
        if (this.md) {
          this.md.discard();
          this.md = undefined;
          if (this.segStarted) {
            this.commit([style.dim('  （请求中断，以上未完成的输出作废，正在重试）')]);
          }
          this.segStarted = false;
        }
        break;
      case 'toolStart':
        this.endSeg();
        this.runningTools.set(String(msg.id), { name: String(msg.name), label: String(msg.label ?? msg.name) });
        break;
      case 'toolEnd':
        this.endSeg();
        this.toolBlock(msg);
        break;
      case 'plan':
        this.endSeg();
        this.planBlock(Array.isArray(msg.steps) ? msg.steps : []);
        break;
      case 'approval': {
        this.endSeg();
        const r = msg.request ?? {};
        // 窗口打开时宿主会补发仍在等待的审批，可能与打开前收到的重复
        if (this.approvals.some((a) => a.id === String(r.id))) {
          return;
        }
        this.approvals.push({
          id: String(r.id),
          kind: r.kind,
          title: String(r.title ?? ''),
          command: r.command,
          cwd: r.cwd,
          isNewFile: r.isNewFile,
          added: r.added,
          removed: r.removed,
          diff: Array.isArray(r.diff) ? r.diff : undefined,
          shownAt: Date.now(),
          selected: 0,
          responded: false
        });
        break;
      }
      case 'approvalDone': {
        const done = this.approvals.find((a) => a.id === String(msg.id));
        this.approvals = this.approvals.filter((a) => a !== done);
        if (msg.decision === 'deny') {
          this.deniedPending = true;
          this.pendingStat = '';
          this.pendingDiff = undefined;
        } else if (done && done.kind !== 'bash') {
          this.pendingStat = this.statOf(done);
          this.pendingDiff = done.diff;
        }
        if (msg.decision === 'allowAllEdits') {
          this.block([style.dim('  本次会话后续的文件修改将自动允许，新建对话后恢复逐项确认。')]);
        }
        break;
      }
      case 'changes': {
        this.endSeg();
        const files: string[] = Array.isArray(msg.files) ? msg.files : [];
        const rows = [`● ${style.bold(`本次修改了 ${files.length} 个文件`)}`];
        files.slice(0, 12).forEach((f, i) => rows.push(`${i === 0 ? `  ${style.dim('⎿')} ` : '    '}${sanitize(f)}`));
        if (files.length > 12) {
          rows.push(style.dim(`    ⋯ 另有 ${files.length - 12} 个`));
        }
        rows.push(style.dim('    输入 /undo 可撤销本次修改'));
        this.block(rows);
        break;
      }
      case 'assistantEnd':
        this.endSeg();
        for (const t of this.runningTools.values()) {
          if (t.name !== 'update_plan') {
            this.block([...this.bulleted(t.label, style.red('●')), `  ${style.dim('⎿')} ${style.dim('已停止')}`]);
          }
        }
        this.runningTools.clear();
        this.pendingStat = '';
        this.pendingDiff = undefined;
        this.deniedPending = false;
        if (msg.meta) {
          this.block([style.dim(`  ${sanitize(String(msg.meta))}`)]);
        }
        break;
      case 'error':
        this.endSeg();
        this.block(this.bulleted(String(msg.message ?? ''), style.red('✗')).map((r) => style.red(r)));
        break;
      case 'notice': {
        this.endSeg();
        const rows = this.bulleted(String(msg.text ?? ''), msg.level === 'warn' ? style.yellow('●') : style.dim('●'));
        this.block(rows.length > 40 ? [...rows.slice(0, 40), style.dim(`  ⋯ 共 ${rows.length} 行`)] : rows);
        break;
      }
      case 'info':
        this.status = sanitize(String(msg.message ?? ''));
        break;
      case 'cleared':
        this.editor.clear();
        this.slashIndex = 0;
        this.pasteBuf = undefined;
        this.md = undefined;
        this.segStarted = false;
        this.runningTools.clear();
        this.approvals = [];
        this.pendingStat = '';
        this.pendingDiff = undefined;
        this.deniedPending = false;
        this.queue = [];
        this.atBlank = true;
        this.status = '';
        this.hint = '';
        if (this.opened) {
          this.opts.write('\x1b[2J\x1b[3J\x1b[H');
          this.dynWidths = [];
        }
        this.banner();
        break;
      default:
        return;
    }
    this.schedule();
  }

  private showHistory(messages: Array<{ role: string; content: string }>): void {
    const recent = messages.filter((m) => m && (m.role === 'user' || m.role === 'assistant')).slice(-8);
    if (recent.length === 0) {
      return;
    }
    this.block([style.dim(`── 之前的对话（最近 ${recent.length} 条）──`)]);
    for (const m of recent) {
      if (m.role === 'user') {
        this.userBlock(m.content);
      } else {
        const rows = renderMarkdown(m.content, this.textWidthLimit());
        this.segStarted = false;
        this.commitSeg(rows);
        this.segStarted = false;
      }
    }
    this.block([style.dim('── 以上为历史，可以继续提问 ──')]);
  }

  private statOf(a: ApprovalView): string {
    return a.isNewFile ? `新文件 · ${a.added ?? 0} 行` : `+${a.added ?? 0} −${a.removed ?? 0}`;
  }

  // ------------------------------------------------------------------
  // 动态区域
  // ------------------------------------------------------------------

  private suggestions(): SlashCommand[] {
    const text = this.editor.text;
    if (!/^\/\S*$/.test(text)) {
      return [];
    }
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(text.toLowerCase())).slice(0, MAX_SUGGESTIONS);
  }

  private approvalRows(a: ApprovalView): string[] {
    const w = this.boxWidth();
    const inner = w - 4;
    const edge = (s: string) => style.yellow(s);
    const stat = a.kind === 'bash' ? '' : this.statOf(a);
    let title = truncate(sanitize(a.title), Math.max(6, w - 8 - textWidth(stat)));
    title = stat ? `${title} · ${stat}` : title;
    const fill = Math.max(0, w - 5 - textWidth(title));
    const rows = [edge(`╭─ `) + style.bold(title) + edge(` ${'─'.repeat(fill)}╮`)];
    const line = (content: string) => `${edge('│')} ${padEnd(content, inner)} ${edge('│')}`;

    if (a.kind === 'bash') {
      for (const r of wrapAnsi(sanitize(a.command ?? ''), inner).slice(0, 8)) {
        rows.push(line(r));
      }
      if (a.cwd) {
        rows.push(line(style.dim(truncate(`工作目录：${a.cwd}`, inner))));
      }
    } else if (a.diff && a.diff.length > 0) {
      const limit = Math.max(3, Math.min(16, this.rows - 14));
      for (const r of this.diffRows(a.diff, inner, limit)) {
        rows.push(line(r));
      }
    } else {
      rows.push(line(style.dim('修改内容已在 Diff 编辑器中打开')));
    }
    rows.push(edge(`╰${'─'.repeat(w - 2)}╯`));

    const question = a.kind === 'bash' ? '要运行这条命令吗？' : '要应用这次修改吗？';
    rows.push(` ${style.bold(question)}${a.kind === 'bash' ? '' : style.dim('  完整 Diff 已在编辑器中打开，确认后才会写入')}`);
    this.approvalOptions(a).forEach((opt, i) => {
      const selected = i === a.selected;
      rows.push(` ${selected ? style.accent('❯') : ' '} ${selected ? style.bold(`${i + 1}. ${opt.label}`) : `${i + 1}. ${opt.label}`}`);
    });
    rows.push(style.dim(` ↑↓ 选择 · Enter 确认 · Esc 拒绝${a.kind === 'bash' ? '' : ' · d 重新打开 Diff'}`));
    return rows;
  }

  private approvalOptions(a: ApprovalView): Array<{ label: string; decision: string }> {
    if (a.kind === 'bash') {
      return [
        { label: '允许', decision: 'allow' },
        { label: '拒绝', decision: 'deny' }
      ];
    }
    return [
      { label: '允许', decision: 'allow' },
      { label: '允许，并且本次会话不再询问文件修改', decision: 'allowAllEdits' },
      { label: '拒绝', decision: 'deny' }
    ];
  }

  private footer(): { rows: string[]; cursorRow: number; cursorCol: number; showCursor: boolean } {
    const approval = this.approvals[0];
    if (approval) {
      const rows = this.approvalRows(approval);
      return { rows, cursorRow: rows.length - 1, cursorCol: 0, showCursor: false };
    }

    const rows: string[] = [];
    if (this.busy) {
      const seconds = Math.max(0, Math.round((Date.now() - this.runStartedAt) / 1000));
      const status = this.status || (this.runningTools.size > 0 ? '正在执行…' : '正在思考…');
      rows.push(
        `${style.accent(SPINNER[this.frame % SPINNER.length])} ${truncate(status, Math.max(10, this.cols - 26))} ${style.dim(`(${seconds}s · Esc 停止)`)}`
      );
    }

    const w = this.boxWidth();
    const inner = w - 6;
    const layout = this.editor.layout(inner - 1);
    rows.push(style.dim(`╭${'─'.repeat(w - 2)}╮`));
    const boxTop = rows.length;
    layout.rows.forEach((text, i) => {
      const content = this.editor.isEmpty ? style.dim(truncate(PLACEHOLDER, inner)) : text;
      rows.push(`${style.dim('│')} ${i === 0 ? '> ' : '  '}${padEnd(content, inner)} ${style.dim('│')}`);
    });
    rows.push(style.dim(`╰${'─'.repeat(w - 2)}╯`));

    const suggestions = this.suggestions();
    // 有提示语（例如「任务运行中不能使用这个命令」）时先显示提示，下一次按键后恢复命令列表
    if (suggestions.length > 0 && !this.hint) {
      this.slashIndex = Math.min(this.slashIndex, suggestions.length - 1);
      suggestions.forEach((c, i) => {
        const selected = i === this.slashIndex;
        const name = padEnd(c.name, 11);
        rows.push(
          selected
            ? `  ${style.accent(`❯ ${name}`)} ${c.hint}`
            : `    ${name} ${style.dim(c.hint)}`
        );
      });
    } else {
      rows.push(this.statusRow(w));
    }

    return {
      rows,
      cursorRow: boxTop + layout.cursorRow,
      cursorCol: 4 + layout.cursorCol,
      showCursor: true
    };
  }

  private statusRow(w: number): string {
    let left = this.hint;
    if (!left) {
      left = !this.configured
        ? '尚未配置模型服务：直接回车，或输入 /settings 开始配置'
        : this.busy
          ? 'Esc 停止'
          : '/ 命令 · Shift+Enter 换行';
    }
    const modeLabel = MODE_LABELS[this.mode] ?? this.mode;
    const parts = [this.contextLabel, this.model || '未配置模型', this.autoEdits ? `${modeLabel}（本次会话自动允许修改）` : modeLabel];
    let right = parts.filter(Boolean).join(' · ');
    const room = w - 4;
    if (textWidth(left) + textWidth(right) + 2 > room) {
      right = parts.slice(1).filter(Boolean).join(' · ');
    }
    if (textWidth(left) + textWidth(right) + 2 > room) {
      right = truncate(right, Math.max(0, room - textWidth(left) - 2));
      if (textWidth(right) < 6) {
        right = '';
        left = truncate(left, room);
      }
    }
    const gap = Math.max(2, room - textWidth(left) - textWidth(right));
    const leftStyled = this.hint || !this.configured ? style.yellow(left) : style.dim(left);
    return `  ${leftStyled}${' '.repeat(gap)}${style.dim(right)}`;
  }

  private render(): void {
    if (!this.opened) {
      return;
    }
    let out = '\x1b[?25l';
    if (this.dynWidths.length > 0) {
      if (this.dynCursorRow > 0) {
        out += `\x1b[${this.dynCursorRow}A`;
      }
      out += '\r\x1b[J';
    }

    let live: string[] = [];
    if (this.md) {
      const taken = this.md.take();
      this.commitSeg(taken.rows);
      live = taken.live;
    }
    const footer = this.footer();
    const toolRows: string[] = [];
    for (const t of this.runningTools.values()) {
      if (t.name !== 'update_plan') {
        toolRows.push(`${style.accent('●')} ${truncate(sanitize(t.label).replace(/\n/g, ' '), Math.max(10, this.cols - 6))}${style.dim(' …')}`);
      }
    }

    // 动态区域不能超过屏幕高度：活动文本太长时把最前面的行提前定稿
    const room = Math.max(1, this.rows - footer.rows.length - toolRows.length - 4);
    if (this.md && live.length > room) {
      const n = live.length - room;
      this.commitSeg(live.slice(0, n));
      this.md.freeze(n);
      live = live.slice(n);
    }

    const dyn: string[] = [];
    if (live.length > 0) {
      if (!this.segStarted && !this.atBlank) {
        dyn.push('');
      }
      live.forEach((r, i) => dyn.push(!this.segStarted && i === 0 ? `● ${r}` : r === '' ? '' : `  ${r}`));
    }
    if (toolRows.length > 0) {
      if (dyn.length > 0 || !this.atBlank) {
        dyn.push('');
      }
      dyn.push(...toolRows);
    }
    if (dyn.length > 0 || !this.atBlank) {
      dyn.push('');
    }
    const footerStart = dyn.length;
    dyn.push(...footer.rows);
    // 动态区域的每一行都不能超过终端宽度，否则自动折行会打乱下一次重绘
    for (let i = 0; i < dyn.length; i++) {
      if (textWidth(dyn[i]) > this.cols - 1) {
        dyn[i] = truncate(stripAnsi(dyn[i]), this.cols - 1);
      }
    }

    for (const row of this.queue) {
      out += `${row}${RESET}\r\n`;
    }
    this.queue = [];
    out += dyn.map((r) => `${r}${RESET}`).join('\r\n');

    const cursorRow = footerStart + footer.cursorRow;
    const up = dyn.length - 1 - cursorRow;
    if (up > 0) {
      out += `\x1b[${up}A`;
    }
    out += '\r';
    if (footer.cursorCol > 0) {
      out += `\x1b[${footer.cursorCol}C`;
    }
    if (footer.showCursor) {
      out += '\x1b[?25h';
    }
    this.dynWidths = dyn.map((r) => textWidth(r));
    this.dynCursorRow = cursorRow;
    this.dynCursorCol = footer.cursorCol;
    this.opts.write(out);
  }

  // ------------------------------------------------------------------
  // 键盘输入
  // ------------------------------------------------------------------

  handleInput(data: string): void {
    let i = 0;
    if (this.pasteBuf !== undefined) {
      const end = data.indexOf('\x1b[201~');
      if (end < 0) {
        this.pasteBuf += data;
        return;
      }
      this.onPaste(this.pasteBuf + data.slice(0, end));
      this.pasteBuf = undefined;
      i = end + 6;
    }
    while (i < data.length) {
      if (data.startsWith('\x1b[200~', i)) {
        const end = data.indexOf('\x1b[201~', i + 6);
        if (end < 0) {
          this.pasteBuf = data.slice(i + 6);
          break;
        }
        this.onPaste(data.slice(i + 6, end));
        i = end + 6;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') {
        const m = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|\r|\n|\x7f|\b)/.exec(data.slice(i));
        if (m) {
          this.onKey(m[0]);
          i += m[0].length;
        } else {
          this.onKey('\x1b');
          i++;
        }
        continue;
      }
      if (ch < ' ' || ch === '\x7f') {
        this.onKey(ch);
        i++;
        continue;
      }
      let j = i;
      while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f' && data[j] !== '\x1b') {
        j++;
      }
      this.onText(data.slice(i, j));
      i = j;
    }
    this.schedule();
  }

  private onPaste(text: string): void {
    if (this.approvals.length > 0) {
      return;
    }
    this.hint = '';
    this.editor.insert(text.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
  }

  private onText(text: string): void {
    const approval = this.approvals[0];
    if (approval) {
      for (const ch of text) {
        this.approvalKey(approval, ch);
      }
      return;
    }
    this.hint = '';
    this.slashIndex = 0;
    this.editor.insert(text);
  }

  private respond(a: ApprovalView, decision: string): void {
    if (a.responded) {
      return;
    }
    a.responded = true;
    this.opts.emit({ type: 'approvalResponse', id: a.id, decision });
  }

  private approvalKey(a: ApprovalView, key: string): void {
    if (a.responded || Date.now() - a.shownAt < (this.opts.approvalGuardMs ?? 400)) {
      return;
    }
    const options = this.approvalOptions(a);
    if (key === '\x1b[A') {
      a.selected = (a.selected + options.length - 1) % options.length;
    } else if (key === '\x1b[B' || key === '\t') {
      a.selected = (a.selected + 1) % options.length;
    } else if (key === '\r') {
      this.respond(a, options[a.selected].decision);
    } else if (key === '\x1b' || key === 'n' || key === 'N') {
      this.respond(a, 'deny');
    } else if (key === 'y' || key === 'Y') {
      this.respond(a, 'allow');
    } else if (key === 'd' || key === 'D') {
      if (a.kind !== 'bash') {
        this.opts.emit({ type: 'openDiff', id: a.id });
      }
    } else if (/^[1-9]$/.test(key)) {
      const opt = options[Number(key) - 1];
      if (opt) {
        this.respond(a, opt.decision);
      }
    }
  }

  private onKey(key: string): void {
    if (key === '\x03') {
      // Ctrl+C
      if (this.busy) {
        this.opts.emit({ type: 'stop' });
        this.hint = '正在停止…';
      } else if (!this.editor.isEmpty) {
        this.editor.clear();
        this.hint = '';
      } else {
        this.hint = '关闭这个标签页即可结束对话；对话记录会保留';
      }
      return;
    }

    const approval = this.approvals[0];
    if (approval) {
      this.approvalKey(approval, key);
      return;
    }

    const suggestions = this.suggestions();
    this.hint = '';
    switch (key) {
      case '\r':
        this.onEnter(suggestions);
        return;
      case '\n':
      case '\x1b\r':
      case '\x1b\n':
        this.editor.insert('\n');
        break;
      case '\x7f':
      case '\b':
        this.editor.backspace();
        this.slashIndex = 0;
        break;
      case '\x1b\x7f':
      case '\x1b\b':
      case '\x17':
        this.editor.deleteWord();
        break;
      case '\x1b[3~':
        this.editor.del();
        break;
      case '\x1b[D':
      case '\x1bOD':
      case '\x02':
        this.editor.left();
        break;
      case '\x1b[C':
      case '\x1bOC':
      case '\x06':
        this.editor.right();
        break;
      case '\x1b[A':
      case '\x1bOA':
        if (suggestions.length > 0) {
          this.slashIndex = (this.slashIndex + suggestions.length - 1) % suggestions.length;
        } else {
          this.editor.up();
        }
        break;
      case '\x1b[B':
      case '\x1bOB':
        if (suggestions.length > 0) {
          this.slashIndex = (this.slashIndex + 1) % suggestions.length;
        } else {
          this.editor.down();
        }
        break;
      case '\x1b[H':
      case '\x1bOH':
      case '\x1b[1~':
      case '\x1b[7~':
      case '\x01':
        this.editor.home();
        break;
      case '\x1b[F':
      case '\x1bOF':
      case '\x1b[4~':
      case '\x1b[8~':
      case '\x05':
        this.editor.end();
        break;
      case '\x15':
        this.editor.killToStart();
        break;
      case '\x0b':
        this.editor.killToEnd();
        break;
      case '\t':
        if (suggestions.length > 0) {
          this.editor.set(suggestions[this.slashIndex].name);
          this.slashIndex = 0;
        }
        break;
      case '\x1b':
        if (this.busy) {
          this.opts.emit({ type: 'stop' });
          this.hint = '正在停止…';
        } else if (suggestions.length > 0) {
          this.editor.clear();
        }
        break;
      case '\x0c':
        // Ctrl+L：整屏重画
        this.opts.write('\x1b[2J\x1b[H');
        this.dynWidths = [];
        break;
      default:
        if (/^\x1b\[1;[0-9][CD]$/.test(key)) {
          // Ctrl/Alt + ←→：按词移动简化为移动到行首 / 行尾
          if (key.endsWith('D')) {
            this.editor.home();
          } else {
            this.editor.end();
          }
        }
        break;
    }
  }

  private onEnter(suggestions: SlashCommand[]): void {
    const raw = this.editor.text;
    // 行尾的反斜杠 + 回车 = 换行
    if (raw.endsWith('\\')) {
      this.editor.backspace();
      this.editor.insert('\n');
      return;
    }
    const text = raw.trim();
    if (!text) {
      if (!this.configured) {
        this.opts.emit({ type: 'openSettings' });
      }
      return;
    }
    if (text.startsWith('/')) {
      const word = text.split(/\s+/)[0].toLowerCase();
      const command =
        SLASH_COMMANDS.find((c) => c.name === word) ??
        (word === '/clear' ? SLASH_COMMANDS[0] : undefined) ??
        (suggestions.length > 0 ? suggestions[this.slashIndex] : undefined);
      if (!command) {
        this.hint = `未知命令 ${word}，输入 /help 查看可用命令`;
        return;
      }
      if (this.busy && !command.whileBusy) {
        this.hint = '任务运行中，先按 Esc 停止再使用这个命令';
        return;
      }
      this.editor.clear();
      this.slashIndex = 0;
      this.hint = '';
      if (command.name === '/help') {
        this.helpBlock();
      } else {
        this.opts.emit(command.message);
      }
      return;
    }
    if (this.busy) {
      this.hint = 'Agent 正在运行，按 Esc 停止后再发送';
      return;
    }
    this.hint = '';
    this.opts.emit({ type: 'send', text: this.editor.submit() });
  }
}
