/**
 * 终端输入框的行编辑器（纯逻辑）：光标移动、多行输入、历史记录、按显示宽度排版。
 * 中文等宽字符占两列，排版与光标定位都按显示宽度计算。
 */
import { charWidth, sanitize } from './ansi';

export interface EditorLayout {
  /** 每个可视行的文本（不含提示符） */
  rows: string[];
  cursorRow: number;
  /** 光标所在列（按显示宽度，从 0 起） */
  cursorCol: number;
}

interface VisualRow {
  start: number;
  end: number;
}

const MAX_HISTORY = 50;

export class LineEditor {
  private chars: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private width = 80;

  get text(): string {
    return this.chars.join('');
  }

  get isEmpty(): boolean {
    return this.chars.length === 0;
  }

  set(text: string): void {
    this.chars = Array.from(sanitize(text));
    this.cursor = this.chars.length;
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
    this.historyIndex = -1;
  }

  insert(text: string): void {
    const add = Array.from(sanitize(text));
    if (add.length === 0) {
      return;
    }
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
  }

  backspace(): void {
    if (this.cursor > 0) {
      this.chars.splice(this.cursor - 1, 1);
      this.cursor--;
    }
  }

  del(): void {
    if (this.cursor < this.chars.length) {
      this.chars.splice(this.cursor, 1);
    }
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.chars.length, this.cursor + 1);
  }

  private lineStart(): number {
    let i = this.cursor;
    while (i > 0 && this.chars[i - 1] !== '\n') {
      i--;
    }
    return i;
  }

  private lineEnd(): number {
    let i = this.cursor;
    while (i < this.chars.length && this.chars[i] !== '\n') {
      i++;
    }
    return i;
  }

  home(): void {
    this.cursor = this.lineStart();
  }

  end(): void {
    this.cursor = this.lineEnd();
  }

  /** Ctrl+U：删除到行首 */
  killToStart(): void {
    const start = this.lineStart();
    this.chars.splice(start, this.cursor - start);
    this.cursor = start;
  }

  /** Ctrl+K：删除到行尾 */
  killToEnd(): void {
    this.chars.splice(this.cursor, this.lineEnd() - this.cursor);
  }

  /** Ctrl+W：删除前一个词 */
  deleteWord(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.chars[i - 1])) {
      i--;
    }
    while (i > 0 && !/\s/.test(this.chars[i - 1])) {
      i--;
    }
    this.chars.splice(i, this.cursor - i);
    this.cursor = i;
  }

  /** 提交：返回文本并清空输入框，非空内容进入历史 */
  submit(): string {
    const text = this.text;
    if (text.trim()) {
      if (this.history[this.history.length - 1] !== text) {
        this.history.push(text);
        if (this.history.length > MAX_HISTORY) {
          this.history.shift();
        }
      }
    }
    this.clear();
    return text;
  }

  private visualRows(width: number): VisualRow[] {
    const rows: VisualRow[] = [];
    let start = 0;
    let used = 0;
    for (let i = 0; i < this.chars.length; i++) {
      const ch = this.chars[i];
      if (ch === '\n') {
        rows.push({ start, end: i });
        start = i + 1;
        used = 0;
        continue;
      }
      const w = charWidth(ch.codePointAt(0) as number);
      if (used + w > width && i > start) {
        rows.push({ start, end: i });
        start = i;
        used = 0;
      }
      used += w;
    }
    rows.push({ start, end: this.chars.length });
    return rows;
  }

  private cursorRowIndex(rows: VisualRow[]): number {
    for (let r = rows.length - 1; r >= 0; r--) {
      if (this.cursor >= rows[r].start) {
        return r;
      }
    }
    return 0;
  }

  private colOf(row: VisualRow, index: number): number {
    let col = 0;
    for (let i = row.start; i < index && i < row.end; i++) {
      col += charWidth(this.chars[i].codePointAt(0) as number);
    }
    return col;
  }

  private indexAtCol(row: VisualRow, col: number): number {
    let used = 0;
    for (let i = row.start; i < row.end; i++) {
      const w = charWidth(this.chars[i].codePointAt(0) as number);
      if (used + w > col) {
        return i;
      }
      used += w;
    }
    return row.end;
  }

  /** ↑：多行输入时在行间移动；已在首行则翻看更早的历史 */
  up(): void {
    const rows = this.visualRows(this.width);
    const r = this.cursorRowIndex(rows);
    if (r > 0) {
      this.cursor = this.indexAtCol(rows[r - 1], this.colOf(rows[r], this.cursor));
      return;
    }
    if (this.history.length === 0) {
      return;
    }
    if (this.historyIndex === -1) {
      this.draft = this.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.set(this.history[this.historyIndex]);
  }

  /** ↓：多行输入时在行间移动；已在末行则翻看更新的历史 */
  down(): void {
    const rows = this.visualRows(this.width);
    const r = this.cursorRowIndex(rows);
    if (r < rows.length - 1) {
      this.cursor = this.indexAtCol(rows[r + 1], this.colOf(rows[r], this.cursor));
      return;
    }
    if (this.historyIndex === -1) {
      return;
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.set(this.history[this.historyIndex]);
    } else {
      this.historyIndex = -1;
      this.set(this.draft);
    }
  }

  /** 按给定宽度排版；超过 maxRows 时只显示光标附近的窗口 */
  layout(width: number, maxRows = 8): EditorLayout {
    this.width = Math.max(4, width);
    const rows = this.visualRows(this.width);
    const cursorRow = this.cursorRowIndex(rows);
    const cursorCol = this.colOf(rows[cursorRow], this.cursor);
    let from = 0;
    if (rows.length > maxRows) {
      from = Math.min(Math.max(0, cursorRow - maxRows + 1), rows.length - maxRows);
    }
    const visible = rows.slice(from, from + maxRows);
    return {
      rows: visible.map((r) => this.chars.slice(r.start, r.end).join('')),
      cursorRow: cursorRow - from,
      cursorCol
    };
  }
}
