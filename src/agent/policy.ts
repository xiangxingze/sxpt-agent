/**
 * Agent 工具调用策略（纯逻辑，不依赖 vscode，可在 Node 中直接单测）。
 *
 * 负责：工作区路径围栏、受保护路径、敏感文件、edit 工具的 Diff 预览计算。
 */
import * as path from 'path';
import * as fs from 'fs';

const BOM = String.fromCharCode(0xfeff);

export interface EditPair {
  oldText: string;
  newText: string;
}

export type EditPreview =
  | { ok: true; original: string; proposed: string; added: number; removed: number }
  | { ok: false; error: string };

/** 去掉 Pi 工具偶尔带的 `@` 前缀与首尾空白 */
export function normalizeToolPath(input: unknown): string {
  if (typeof input !== 'string') {
    return '.';
  }
  let p = input.trim();
  if (p.startsWith('@')) {
    p = p.slice(1);
  }
  return p || '.';
}

function samePathPrefix(root: string, target: string): boolean {
  const normRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const normTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  if (normTarget === normRoot) {
    return true;
  }
  const withSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
  return normTarget.startsWith(withSep);
}

export function resolveInWorkspace(cwd: string, input: unknown): string {
  const p = normalizeToolPath(input);
  return path.resolve(cwd, p);
}

/** 解析符号链接后再判断是否位于工作区内，防止通过 symlink 逃逸。 */
export function realPathOrSelf(target: string): string {
  let current = target;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}

export function isInsideRoots(roots: string[], absPath: string): boolean {
  // 两边都解析符号链接后再比较；不能再做词法前缀判断，否则工作区内的链接可以指向工作区外
  const real = realPathOrSelf(absPath);
  return roots.some((root) => samePathPrefix(realPathOrSelf(path.resolve(root)), real));
}

/** 不允许 Agent 写入的位置：.git 目录内部 */
export function isProtectedPath(absPath: string): boolean {
  return absPath.split(/[\\/]/).includes('.git');
}

const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i
];
const SENSITIVE_SAFE = /^\.env\.(example|sample|template|dist)$/i;

/** 读取这类文件会把密钥发给模型，默认拒绝 */
export function isSensitiveFile(absPath: string): boolean {
  const name = path.basename(absPath);
  if (SENSITIVE_SAFE.test(name)) {
    return false;
  }
  return SENSITIVE_NAMES.some((re) => re.test(name));
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split('\n').length;
}

/**
 * 复现 edit 工具的语义，计算修改后的文件内容用于 Diff 预览：
 * 每个 oldText 必须在原文件中唯一匹配，且各处修改互不重叠。
 * 换行符与 BOM 会保持原样。
 */
export function previewEdits(originalRaw: string, edits: EditPair[]): EditPreview {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'edits 不能为空' };
  }
  const hasBom = originalRaw.charCodeAt(0) === 0xfeff;
  const body = hasBom ? originalRaw.slice(1) : originalRaw;
  const crlf = body.includes('\r\n');
  const original = crlf ? body.replace(/\r\n/g, '\n') : body;

  const spans: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') {
      return { ok: false, error: `第 ${i + 1} 处修改格式不正确` };
    }
    const oldText = edit.oldText.replace(/\r\n/g, '\n');
    const newText = edit.newText.replace(/\r\n/g, '\n');
    if (!oldText) {
      return { ok: false, error: `第 ${i + 1} 处修改的 oldText 为空` };
    }
    const first = original.indexOf(oldText);
    if (first < 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 处修改的 oldText 在文件中找不到（需与文件内容逐字一致，含缩进）。请先重新读取文件。`
      };
    }
    if (original.indexOf(oldText, first + 1) >= 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 处修改的 oldText 在文件中出现多次，无法唯一定位。请带上更多上下文行。`
      };
    }
    spans.push({ start: first, end: first + oldText.length, text: newText });
  }

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      return { ok: false, error: '多处修改的范围相互重叠，请合并为一处。' };
    }
  }

  let out = '';
  let cursor = 0;
  let added = 0;
  let removed = 0;
  for (const span of spans) {
    out += original.slice(cursor, span.start) + span.text;
    removed += countLines(original.slice(span.start, span.end));
    added += countLines(span.text);
    cursor = span.end;
  }
  out += original.slice(cursor);

  const restore = (text: string) => (crlf ? text.replace(/\n/g, '\r\n') : text);
  return {
    ok: true,
    original: originalRaw,
    proposed: (hasBom ? BOM : '') + restore(out),
    added,
    removed
  };
}

/** 统计 write 覆盖前后的行数变化（粗略） */
export function lineStat(original: string | undefined, proposed: string): { added: number; removed: number } {
  return {
    added: countLines(proposed),
    removed: original === undefined ? 0 : countLines(original)
  };
}

export const READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
export const WRITE_TOOLS = ['edit', 'write'] as const;
