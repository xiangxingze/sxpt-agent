import * as vscode from 'vscode';
import * as path from 'path';

export interface PatchBlock {
  file: string;
  search: string;
  replace: string;
}

export interface NewFileBlock {
  file: string;
  content: string;
}

const PATCH_FENCE = /```ptn-patch\s*\n([\s\S]*?)```/g;
const NEWFILE_FENCE = /```ptn-newfile\s*\n([\s\S]*?)```/g;
const RUN_FENCE = /```ptn-run\s*\n([\s\S]*?)```/g;

export function parsePatches(text: string): PatchBlock[] {
  const patches: PatchBlock[] = [];
  let match: RegExpExecArray | null;
  PATCH_FENCE.lastIndex = 0;
  while ((match = PATCH_FENCE.exec(text)) !== null) {
    const body = match[1];
    const fileLine = body.match(/^\s*file:\s*(.+)$/m);
    const file = fileLine?.[1]?.trim();
    if (!file) {
      continue;
    }
    const searchMatch = body.match(/<{7}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={7}\s*\r?\n([\s\S]*?)\r?\n>{7}\s*REPLACE/);
    if (!searchMatch) {
      continue;
    }
    patches.push({ file, search: searchMatch[1], replace: searchMatch[2] });
  }
  return patches;
}

export function parseNewFiles(text: string): NewFileBlock[] {
  const files: NewFileBlock[] = [];
  let match: RegExpExecArray | null;
  NEWFILE_FENCE.lastIndex = 0;
  while ((match = NEWFILE_FENCE.exec(text)) !== null) {
    const body = match[1];
    const fileLine = body.match(/^\s*file:\s*(.+)$/m);
    const file = fileLine?.[1]?.trim();
    if (!file) {
      continue;
    }
    const content = body.slice(body.indexOf('\n') + 1);
    files.push({ file, content });
  }
  return files;
}

export function parseRunCommands(text: string): string[] {
  const commands: string[] = [];
  let match: RegExpExecArray | null;
  RUN_FENCE.lastIndex = 0;
  while ((match = RUN_FENCE.exec(text)) !== null) {
    const command = match[1].trim();
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}

export function stripPatchBlocks(text: string): string {
  return text
    .replace(PATCH_FENCE, '\n\n（已生成代码修改，可在 Diff 中查看）\n\n')
    .replace(NEWFILE_FENCE, '\n\n（已生成新文件内容，可在 Diff 中查看）\n\n')
    .replace(RUN_FENCE, '\n\n（已提议执行命令，待确认）\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ResolvedPatch extends PatchBlock {
  absolutePath: string;
  startLine: number;
  endLine: number;
  originalText: string;
  proposedText: string;
}

export function resolvePatch(workspaceRoot: string, patch: PatchBlock): ResolvedPatch | undefined {
  const absolutePath = path.isAbsolute(patch.file)
    ? patch.file
    : path.join(workspaceRoot, patch.file);
  let originalText: string;
  try {
    const fs = require('fs') as typeof import('fs');
    originalText = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return undefined;
  }

  const exactIndex = originalText.indexOf(patch.search);
  let start = exactIndex;
  let matched = patch.search;

  if (exactIndex < 0) {
    const fuzzy = fuzzyLocate(originalText, patch.search);
    if (!fuzzy) {
      return undefined;
    }
    start = fuzzy.index;
    matched = fuzzy.text;
  }

  const before = originalText.slice(0, start);
  const startLine = before.split(/\r?\n/).length;
  const endLine = startLine + matched.split(/\r?\n/).length - 1;

  return {
    ...patch,
    absolutePath,
    startLine,
    endLine,
    originalText,
    proposedText: originalText.slice(0, start) + patch.replace + originalText.slice(start + matched.length)
  };
}

function fuzzyLocate(source: string, search: string): { index: number; text: string } | undefined {
  const searchLines = search.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (searchLines.length === 0) {
    return undefined;
  }
  const sourceLines = source.split(/\r?\n/);
  for (let i = 0; i <= sourceLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (sourceLines[i + j].trim() !== searchLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const text = sourceLines.slice(i, i + searchLines.length).join('\n');
      const index = sourceLines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
      return { index, text };
    }
  }
  return undefined;
}

export async function applyPatch(patch: ResolvedPatch): Promise<void> {
  const uri = vscode.Uri.file(patch.absolutePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();

  const current = document.getText();
  const located = current.indexOf(patch.search);
  let range: vscode.Range;

  if (located >= 0) {
    const start = document.positionAt(located);
    const end = document.positionAt(located + patch.search.length);
    range = new vscode.Range(start, end);
  } else {
    const lastLine = Math.max(0, document.lineCount - 1);
    const endLine = Math.min(Math.max(0, patch.endLine - 1), lastLine);
    range = new vscode.Range(
      Math.min(Math.max(0, patch.startLine - 1), lastLine),
      0,
      endLine,
      document.lineAt(endLine).text.length
    );
  }

  edit.replace(uri, range, patch.replace);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    throw new Error(`应用修改失败：${patch.file}`);
  }
  await document.save();
}

export async function createNewFile(workspaceRoot: string, block: NewFileBlock): Promise<vscode.Uri> {
  const target = path.isAbsolute(block.file) ? block.file : path.join(workspaceRoot, block.file);
  const uri = vscode.Uri.file(target);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(block.content, 'utf8'));
  return uri;
}
