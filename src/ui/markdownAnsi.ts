/**
 * Markdown → 终端文本的流式渲染（纯逻辑，不依赖 vscode）。
 *
 * 模型输出是一小段一小段到达的：已经收到换行的整行会被渲染成「定稿行」，
 * 还没收完的半行（以及尚未结束的表格）作为「活动行」每次重新渲染，
 * 由界面层在屏幕底部原地重绘，从而实现逐字输出的效果。
 */
import { padEnd, sanitize, style, textWidth, wrapAnsi } from './ansi';

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```+|~~~+)\s*([^\s`]*)\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** 行内标记：代码、粗体、斜体、删除线、链接 */
export function renderInline(raw: string): string {
  const codes: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(style.cyan(code));
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) =>
    label === url ? style.underline(url) : `${style.underline(label)} ${style.dim(`(${url})`)}`
  );
  text = text.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => style.bold(t));
  text = text.replace(/__([^_\n]+)__/g, (_m, t: string) => style.bold(t));
  text = text.replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, (_m, pre: string, t: string) => pre + style.italic(t));
  text = text.replace(/~~([^~\n]+)~~/g, (_m, t: string) => style.strike(t));
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) {
    row = row.slice(1);
  }
  if (row.endsWith('|')) {
    row = row.slice(0, -1);
  }
  return row.split('|').map((c) => c.trim());
}

function looksLikeTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

/** 把表格渲染成对齐的文本表；过宽时按比例压缩列宽并在单元格内折行 */
export function renderTable(lines: string[], width: number): string[] {
  const head = splitRow(lines[0]).map(renderInline);
  const body = lines.slice(2).map((l) => splitRow(l).map(renderInline));
  const cols = head.length;
  const widths = head.map((h) => Math.max(3, textWidth(h)));
  for (const row of body) {
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c], textWidth(row[c] ?? ''));
    }
  }
  const frame = cols * 3 + 1;
  const room = Math.max(cols * 4, width - frame);
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 4) {
      break;
    }
    widths[widest]--;
    total--;
  }

  const bar = (l: string, m: string, r: string) =>
    style.dim(l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const line = (cells: string[], bold: boolean) => {
    const wrapped = widths.map((w, c) => wrapAnsi(cells[c] ?? '', w));
    const height = Math.max(...wrapped.map((w) => w.length));
    const out: string[] = [];
    for (let r = 0; r < height; r++) {
      out.push(
        style.dim('│') +
          widths
            .map((w, c) => {
              const cell = padEnd(wrapped[c][r] ?? '', w);
              return ` ${bold ? style.bold(cell) : cell} `;
            })
            .join(style.dim('│')) +
          style.dim('│')
      );
    }
    return out;
  };

  const rows: string[] = [bar('┌', '┬', '┐'), ...line(head, true), bar('├', '┼', '┤')];
  for (const r of body) {
    rows.push(...line(r, false));
  }
  rows.push(bar('└', '┴', '┘'));
  return rows;
}

export class MarkdownStream {
  private partial = '';
  private out: string[] = [];
  private inCode = false;
  private fenceMark = '';
  private table: string[] = [];
  /** 活动区域里已经被界面层提前定稿的行数（活动行超过屏幕高度时） */
  private frozen = 0;
  private lastBlank = true;

  constructor(private readonly width: () => number) {}

  push(delta: string): void {
    this.partial += sanitize(delta);
    let nl = this.partial.indexOf('\n');
    while (nl >= 0) {
      const line = this.partial.slice(0, nl);
      this.partial = this.partial.slice(nl + 1);
      this.consume(line);
      nl = this.partial.indexOf('\n');
    }
  }

  /** 取走新产生的定稿行，并返回当前的活动行 */
  take(): { rows: string[]; live: string[] } {
    const rows = this.out;
    this.out = [];
    const live = this.liveRows();
    return { rows, live: live.slice(Math.min(this.frozen, live.length)) };
  }

  /** 界面层把活动区域最前面的 n 行提前定稿（之后不再重绘它们） */
  freeze(n: number): void {
    this.frozen += Math.max(0, n);
  }

  /** 结束这一段文本：把所有未完成的内容定稿并返回 */
  end(): string[] {
    if (this.partial) {
      const rest = this.partial;
      this.partial = '';
      this.consume(rest);
    }
    this.flushTable();
    this.inCode = false;
    this.frozen = 0;
    const rows = this.out;
    this.out = [];
    while (rows.length && rows[rows.length - 1] === '') {
      rows.pop();
    }
    return rows;
  }

  /** 丢弃尚未定稿的内容（模型请求重试时） */
  discard(): void {
    this.partial = '';
    this.table = [];
    this.inCode = false;
    this.frozen = 0;
    this.out = [];
  }

  private emit(rows: string[]): void {
    const skip = Math.min(this.frozen, rows.length);
    this.frozen -= skip;
    for (const row of rows.slice(skip)) {
      const blank = row === '';
      if (blank && this.lastBlank) {
        continue;
      }
      this.out.push(row);
      this.lastBlank = blank;
    }
  }

  private flushTable(): void {
    if (this.table.length === 0) {
      return;
    }
    const lines = this.table;
    this.table = [];
    if (lines.length >= 2 && TABLE_SEP.test(lines[1])) {
      this.emit(renderTable(lines, this.width()));
    } else {
      for (const l of lines) {
        this.emit(this.renderLine(l));
      }
    }
  }

  private consume(line: string): void {
    if (this.inCode) {
      const close = FENCE.exec(line);
      if (close && close[1].startsWith(this.fenceMark) && !close[2]) {
        this.inCode = false;
        this.emit([style.dim('╰─')]);
      } else {
        this.emit(this.codeRows(line));
      }
      return;
    }

    if (this.table.length > 0) {
      const confirmed = this.table.length >= 2;
      if (!confirmed && TABLE_SEP.test(line)) {
        this.table.push(line);
        return;
      }
      if (confirmed && looksLikeTableRow(line)) {
        this.table.push(line);
        return;
      }
      this.flushTable();
    }

    const fence = FENCE.exec(line);
    if (fence) {
      this.inCode = true;
      this.fenceMark = fence[1].slice(0, 3);
      this.emit([style.dim(`╭─ ${fence[2] || 'code'}`)]);
      return;
    }
    if (looksLikeTableRow(line) && !LIST_ITEM.test(line)) {
      this.table.push(line);
      return;
    }
    this.emit(this.renderLine(line));
  }

  private codeRows(line: string): string[] {
    const width = Math.max(8, this.width() - 2);
    return wrapAnsi(line, width).map((r) => `${style.dim('│')} ${r}`);
  }

  /** 渲染一行非代码、非表格的 Markdown */
  private renderLine(line: string): string[] {
    const width = this.width();
    if (!line.trim()) {
      return [''];
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const text = renderInline(heading[2]);
      const styled = heading[1].length <= 2 ? style.bold(style.accent(text)) : style.bold(text);
      return ['', ...wrapAnsi(styled, width)];
    }
    if (HR.test(line)) {
      return [style.dim('─'.repeat(Math.min(width, 40)))];
    }
    if (/^\s*>/.test(line)) {
      const text = renderInline(line.replace(/^\s*>\s?/, ''));
      return wrapAnsi(style.italic(text), Math.max(8, width - 2)).map((r) => `${style.dim('│')} ${r}`);
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = ' '.repeat(Math.min(12, item[1].replace(/\t/g, '    ').length));
      let body = item[3];
      let marker = /\d/.test(item[2]) ? item[2].replace(')', '.') : '•';
      const task = /^\[( |x|X)\]\s+(.*)$/.exec(body);
      if (task) {
        marker = task[1] === ' ' ? '☐' : '☑';
        body = task[2];
      }
      const lead = `${indent}${marker} `;
      const hang = ' '.repeat(textWidth(lead));
      const rows = wrapAnsi(renderInline(body), Math.max(8, width - textWidth(lead)));
      return rows.map((r, i) => (i === 0 ? `${indent}${style.dim(marker)} ${r}` : hang + r));
    }
    const lead = /^(\s*)/.exec(line)?.[1] ?? '';
    // 列表项的续行保留缩进，普通段落去掉行首空白
    const indent = lead.length >= 2 ? ' '.repeat(Math.min(12, lead.length)) : '';
    return wrapAnsi(renderInline(line.trim()), Math.max(8, width - indent.length)).map((r) => indent + r);
  }

  private liveRows(): string[] {
    const rows: string[] = [];
    if (this.table.length > 0) {
      if (this.table.length >= 2) {
        const lines = this.partial && looksLikeTableRow(this.partial) ? [...this.table, this.partial] : this.table;
        rows.push(...renderTable(lines, this.width()));
        if (lines !== this.table) {
          return rows;
        }
      } else {
        rows.push(...this.renderLine(this.table[0]));
      }
    }
    if (!this.partial) {
      return rows;
    }
    if (this.inCode) {
      // 还没收完的行可能是结束围栏，先不显示反引号
      if (!/^\s*(`{1,}|~{1,})\s*$/.test(this.partial)) {
        rows.push(...this.codeRows(this.partial));
      }
      return rows;
    }
    if (/^\s*(`{1,3}|~{1,3})[^\s`]*$/.test(this.partial)) {
      return rows;
    }
    const rendered = this.renderLine(this.partial);
    // 段落之间的空行由定稿逻辑负责，活动行里不重复输出
    rows.push(...(rendered[0] === '' && this.lastBlank ? rendered.slice(1) : rendered));
    return rows;
  }
}

/** 一次性渲染整段 Markdown（恢复历史对话时使用） */
export function renderMarkdown(text: string, width: number): string[] {
  const stream = new MarkdownStream(() => width);
  stream.push(text);
  return stream.end();
}
