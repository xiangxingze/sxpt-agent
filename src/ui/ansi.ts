/**
 * 终端渲染基础：ANSI 样式、显示宽度、按宽度折行（纯逻辑，不依赖 vscode）。
 *
 * 对话界面跑在 VS Code 的原生终端（xterm.js）里，而不是 webview：
 * webview 依赖 Service Worker，在局域网的 http:// 地址（非安全上下文）下无法加载。
 */

const E = '\x1b[';

export const RESET = `${E}0m`;

/** Claude 风格的强调色（真彩色，在浅色与深色主题下都清晰） */
const ACCENT = `${E}38;2;217;119;87m`;
const FG_OFF = `${E}39m`;

function wrapWith(open: string, close: string): (text: string) => string {
  return (text) => (text ? `${open}${text}${close}` : '');
}

export const style = {
  bold: wrapWith(`${E}1m`, `${E}22m`),
  dim: wrapWith(`${E}2m`, `${E}22m`),
  italic: wrapWith(`${E}3m`, `${E}23m`),
  underline: wrapWith(`${E}4m`, `${E}24m`),
  inverse: wrapWith(`${E}7m`, `${E}27m`),
  strike: wrapWith(`${E}9m`, `${E}29m`),
  red: wrapWith(`${E}31m`, FG_OFF),
  green: wrapWith(`${E}32m`, FG_OFF),
  yellow: wrapWith(`${E}33m`, FG_OFF),
  blue: wrapWith(`${E}34m`, FG_OFF),
  magenta: wrapWith(`${E}35m`, FG_OFF),
  cyan: wrapWith(`${E}36m`, FG_OFF),
  gray: wrapWith(`${E}90m`, FG_OFF),
  accent: wrapWith(ACCENT, FG_OFF)
};

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 清洗要写进终端的外部文本（模型输出、工具输出、文件内容）：
 * 去掉 ESC 等控制字符，避免内容里的转义序列操纵终端；统一换行，制表符转空格。
 */
export function sanitize(text: string): string {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe3],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
];

const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef]
];

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) {
      hi = mid - 1;
    } else if (cp > ranges[mid][1]) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** 单个码点在终端里占的列数：中日韩与表情为 2，组合字符为 0，其余为 1 */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
    return 0;
  }
  if (cp < 0x300) {
    return 1;
  }
  if (inRanges(cp, ZERO)) {
    return 0;
  }
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** 字符串的显示宽度（忽略 ANSI 序列） */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    width += charWidth(ch.codePointAt(0) as number);
  }
  return width;
}

/** 右侧补空格到指定显示宽度 */
export function padEnd(text: string, width: number): string {
  const gap = width - textWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/** 截断到指定显示宽度，超出部分以 … 结尾（仅用于不含 ANSI 的纯文本） */
export function truncate(text: string, width: number): string {
  if (textWidth(text) <= width) {
    return text;
  }
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) as number);
    if (used + w > width - 1) {
      break;
    }
    out += ch;
    used += w;
  }
  return `${out}…`;
}

interface Token {
  /** ANSI 序列（宽度 0）或一个可见字符 */
  text: string;
  width: number;
  ansi: boolean;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  ANSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  const pushChars = (chunk: string) => {
    for (const ch of chunk) {
      tokens.push({ text: ch, width: charWidth(ch.codePointAt(0) as number), ansi: false });
    }
  };
  while ((m = ANSI_RE.exec(text)) !== null) {
    pushChars(text.slice(last, m.index));
    tokens.push({ text: m[0], width: 0, ansi: true });
    last = m.index + m[0].length;
  }
  pushChars(text.slice(last));
  return tokens;
}

const isAsciiWord = (ch: string) => /[A-Za-z0-9_\-./\\:@#$%&=+~'"`<>()\[\]{}|^*?!,;]/.test(ch);

/**
 * 按显示宽度把一行带 ANSI 样式的文本折成多行。
 * - 英文单词尽量整词换行，中文可在任意字符处断开；
 * - 折行处先复位样式，下一行开头再恢复，保证前缀（缩进、边框）不被染色。
 */
export function wrapAnsi(text: string, width: number): string[] {
  const limit = Math.max(4, width);
  const tokens = tokenize(text);
  const rows: string[] = [];
  let active: string[] = [];
  let row = '';
  let rowWidth = 0;
  /** 当前行里最近一个可断点（空格之后）的位置信息 */
  let breakAt = -1;
  let breakWidth = 0;
  let breakActive: string[] = [];

  const finishRow = (content: string) => {
    rows.push(active.length || /\x1b\[/.test(content) ? `${content}${RESET}` : content);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.ansi) {
      row += t.text;
      if (/^\x1b\[0?m$/.test(t.text)) {
        active = [];
      } else if (/m$/.test(t.text)) {
        active.push(t.text);
        if (active.length > 24) {
          active = active.slice(-12);
        }
      }
      continue;
    }
    if (rowWidth + t.width > limit && rowWidth > 0) {
      const midWord = isAsciiWord(t.text) && breakAt > 0 && rowWidth - breakWidth < limit * 0.6;
      if (midWord) {
        // 把最近一个空格之后的半个单词挪到下一行
        const head = row.slice(0, breakAt);
        const tail = row.slice(breakAt);
        const saved = active;
        active = breakActive;
        finishRow(head.replace(/ +$/, ''));
        active = saved;
        row = breakActive.join('') + tail;
        rowWidth = rowWidth - breakWidth;
      } else {
        finishRow(row);
        row = active.join('');
        rowWidth = 0;
        if (t.text === ' ') {
          breakAt = -1;
          continue;
        }
      }
      breakAt = -1;
    }
    row += t.text;
    rowWidth += t.width;
    if (t.text === ' ') {
      breakAt = row.length;
      breakWidth = rowWidth;
      breakActive = active.slice();
    }
  }
  finishRow(row);
  return rows;
}
