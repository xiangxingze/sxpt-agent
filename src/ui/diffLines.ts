/**
 * 精简行级 Diff（纯逻辑）：给终端里的审批卡片展示「改了哪几行」。
 * 完整的 Diff 仍在 VS Code 原生 Diff 编辑器中查看。
 */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'gap';
  /** 行号：删除行为原文件行号，其余为修改后的行号 */
  no?: number;
  text: string;
}

const MAX_CELLS = 400_000;

function splitLines(text: string): string[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

type Op = { kind: 'ctx' | 'add' | 'del'; oldNo: number; newNo: number; text: string };

/**
 * 计算两段文本的行级差异，只保留改动行及其前后 context 行，
 * 相距较远的改动之间用 gap 行隔开；总行数超过 maxLines 时截断。
 */
export function compactDiff(original: string, proposed: string, context = 2, maxLines = 80): DiffLine[] {
  const a = original ? splitLines(original) : [];
  const b = proposed ? splitLines(proposed) : [];

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: Op[] = [];
  for (let i = 0; i < head; i++) {
    ops.push({ kind: 'ctx', oldNo: i + 1, newNo: i + 1, text: a[i] });
  }

  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS || n === 0 || m === 0) {
    midA.forEach((text, i) => ops.push({ kind: 'del', oldNo: head + i + 1, newNo: 0, text }));
    midB.forEach((text, j) => ops.push({ kind: 'add', oldNo: 0, newNo: head + j + 1, text }));
  } else {
    // 最长公共子序列
    const w = m + 1;
    const table = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: 'ctx', oldNo: head + i + 1, newNo: head + j + 1, text: midA[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || table[(i + 1) * w + j] >= table[i * w + j + 1])) {
        ops.push({ kind: 'del', oldNo: head + i + 1, newNo: 0, text: midA[i] });
        i++;
      } else {
        ops.push({ kind: 'add', oldNo: 0, newNo: head + j + 1, text: midB[j] });
        j++;
      }
    }
  }

  for (let k = 0; k < tail; k++) {
    const oldIdx = a.length - tail + k;
    const newIdx = b.length - tail + k;
    ops.push({ kind: 'ctx', oldNo: oldIdx + 1, newNo: newIdx + 1, text: a[oldIdx] });
  }

  // 标出需要保留的行：改动行及其前后 context 行
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, idx) => {
    if (op.kind !== 'ctx') {
      for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
        keep[k] = 1;
      }
    }
  });

  const out: DiffLine[] = [];
  let skipped = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!keep[idx]) {
      skipped = true;
      continue;
    }
    if (skipped && out.length > 0) {
      out.push({ kind: 'gap', text: '⋯' });
    }
    skipped = false;
    const op = ops[idx];
    out.push({ kind: op.kind, no: op.kind === 'del' ? op.oldNo : op.newNo, text: op.text });
    if (out.length >= maxLines) {
      const rest = ops.slice(idx + 1).filter((o) => o.kind !== 'ctx').length;
      if (rest > 0) {
        out.push({ kind: 'gap', text: `⋯ 另有 ${rest} 行改动，请在 Diff 编辑器中查看` });
      }
      break;
    }
  }
  return out;
}
