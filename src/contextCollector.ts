import * as vscode from 'vscode';
import { readConfig } from './config';

export interface EditorContext {
  workspaceName?: string;
  relativePath?: string;
  fileName?: string;
  languageId?: string;
  lineCount?: number;
  cursorLine?: number;
  selectionStartLine?: number;
  selectionEndLine?: number;
  selectionText?: string;
  fileSnippet?: string;
  snippetTruncated?: boolean;
  diagnostics: string[];
  gitBranch?: string;
  terminalTail?: string;
}

const SENSITIVE_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9_\-\.]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redactSensitive(text: string): string {
  let result = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const sep = match.includes('=') ? '=' : ':';
      const head = match.split(sep)[0];
      return `${head}${sep} ***`;
    });
  }
  return result;
}

export async function collectContext(): Promise<EditorContext> {
  const cfg = readConfig();
  const editor = vscode.window.activeTextEditor;
  const ctx: EditorContext = { diagnostics: [] };

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    ctx.workspaceName = folder.name;
  }

  if (editor && editor.document.uri.scheme === 'file') {
    const doc = editor.document;
    ctx.fileName = doc.fileName.split(/[\\/]/).pop();
    ctx.relativePath = vscode.workspace.asRelativePath(doc.uri, false);
    ctx.languageId = doc.languageId;
    ctx.lineCount = doc.lineCount;
    ctx.cursorLine = editor.selection.active.line + 1;

    const selection = editor.selection;
    if (!selection.isEmpty) {
      ctx.selectionStartLine = selection.start.line + 1;
      ctx.selectionEndLine = selection.end.line + 1;
      ctx.selectionText = redactSensitive(doc.getText(selection));
    }

    const maxLines = Math.max(40, cfg.maxContextLines);
    const fullText = doc.getText();
    const lines = fullText.split(/\r?\n/);
    if (lines.length > maxLines) {
      const anchor = (ctx.selectionStartLine ?? ctx.cursorLine ?? 1) - 1;
      const half = Math.floor(maxLines / 2);
      const start = Math.max(0, Math.min(anchor - half, lines.length - maxLines));
      ctx.fileSnippet = redactSensitive(lines.slice(start, start + maxLines).join('\n'));
      ctx.snippetTruncated = true;
    } else {
      ctx.fileSnippet = redactSensitive(fullText);
      ctx.snippetTruncated = false;
    }

    const diags = vscode.languages.getDiagnostics(doc.uri);
    ctx.diagnostics = diags.slice(0, 20).map((d) => {
      const line = d.range.start.line + 1;
      return `${line}:${d.range.start.character + 1} [${severityLabel(d.severity)}] ${d.message}`;
    });
  }

  ctx.gitBranch = await readGitBranch();
  ctx.terminalTail = readTerminalTail();
  return ctx;
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

async function readGitBranch(): Promise<string | undefined> {
  try {
    const gitExt = vscode.extensions.getExtension<any>('vscode.git');
    if (!gitExt) {
      return undefined;
    }
    const api = gitExt.isActive ? gitExt.exports : await gitExt.activate();
    const repo = api?.getAPI?.(1)?.repositories?.[0];
    return repo?.state?.HEAD?.name;
  } catch {
    return undefined;
  }
}

function readTerminalTail(): string | undefined {
  const terminal = vscode.window.activeTerminal as any;
  const buffer = terminal?.state?.shellIntegration?.read?.();
  if (typeof buffer === 'string' && buffer.length > 0) {
    return redactSensitive(buffer.slice(-2000));
  }
  return undefined;
}

export function contextToPrompt(ctx: EditorContext): string {
  const parts: string[] = [];
  if (ctx.workspaceName) parts.push(`工作区：${ctx.workspaceName}`);
  if (ctx.gitBranch) parts.push(`Git 分支：${ctx.gitBranch}`);
  if (ctx.relativePath) {
    parts.push(`当前文件：${ctx.relativePath}（${ctx.languageId ?? 'unknown'}，${ctx.lineCount ?? 0} 行）`);
  }
  if (ctx.cursorLine) parts.push(`光标位置：第 ${ctx.cursorLine} 行`);
  if (ctx.selectionStartLine) {
    parts.push(`选中范围：第 ${ctx.selectionStartLine}-${ctx.selectionEndLine} 行`);
  }

  if (ctx.selectionText) {
    parts.push(['选中代码：', '```', ctx.selectionText, '```'].join('\n'));
  } else if (ctx.fileSnippet) {
    const note = ctx.snippetTruncated ? '（已截断）' : '';
    parts.push([`当前文件内容${note}：`, '```', ctx.fileSnippet, '```'].join('\n'));
  }

  if (ctx.diagnostics.length > 0) {
    parts.push(['当前文件诊断：', ...ctx.diagnostics.map((d) => `- ${d}`)].join('\n'));
  }
  if (ctx.terminalTail) {
    parts.push(['最近终端输出：', '```', ctx.terminalTail, '```'].join('\n'));
  }

  return parts.join('\n\n');
}
