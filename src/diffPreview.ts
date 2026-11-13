import * as vscode from 'vscode';
import * as path from 'path';
import { ApprovalRequest } from './agent/types';

/**
 * 在 VS Code 原生 Diff 编辑器中预览 Agent 的修改建议。
 * 修改后的内容放在只读虚拟文档里，不会写入磁盘。
 */
export class DiffPreview implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'ptn-preview';
  private readonly docs = new Map<string, string>();

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DiffPreview.scheme, this)
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.split('/').filter(Boolean)[0];
    return this.docs.get(id) ?? '';
  }

  private virtualUri(id: string, content: string, fileName: string): vscode.Uri {
    this.docs.set(id, content);
    return vscode.Uri.parse(`${DiffPreview.scheme}:/${id}/${encodeURIComponent(fileName)}`);
  }

  /** 打开 Diff，不抢焦点，使用预览标签页 */
  async show(request: ApprovalRequest): Promise<void> {
    if (!request.absPath || request.proposed === undefined) {
      return;
    }
    const fileName = path.basename(request.absPath);
    const right = this.virtualUri(`${request.id}-new`, request.proposed, fileName);
    const left =
      request.isNewFile || request.original === undefined
        ? this.virtualUri(`${request.id}-old`, '', fileName)
        : vscode.Uri.file(request.absPath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${fileName} ↔ AI 修改建议`,
      { preview: true, preserveFocus: true }
    );
  }

  /** 审批结束后关闭对应的 Diff 标签并释放内存 */
  async close(requestId: string): Promise<void> {
    this.docs.delete(`${requestId}-new`);
    this.docs.delete(`${requestId}-old`);
    try {
      const wanted = `/${requestId}-`;
      const tabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => {
          const input = tab.input;
          if (!(input instanceof vscode.TabInputTextDiff)) {
            return false;
          }
          return (
            input.modified.scheme === DiffPreview.scheme && input.modified.path.startsWith(wanted)
          );
        });
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs);
      }
    } catch {
      // 关闭失败不影响主流程
    }
  }
}
