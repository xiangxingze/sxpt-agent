import * as vscode from 'vscode';
import * as path from 'path';
import {
  PatchBlock,
  NewFileBlock,
  resolvePatch,
  applyPatch,
  createNewFile,
  ResolvedPatch
} from './patch';

interface PendingEntry {
  proposedText: string;
}

interface SnapshotEntry {
  filePath: string;
  content: string | undefined;
  existedBefore: boolean;
}

interface SnapshotBatch {
  id: string;
  createdAt: number;
  entries: SnapshotEntry[];
}

const SNAPSHOT_KEY = 'ptnAgent.undo.v1';
const MAX_BATCHES = 5;

export interface ApplySummary {
  applied: number;
  skipped: number;
  failed: number;
}

export class PatchReviewService implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'ptn-patch';
  private readonly pending = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext
  ) {}

  register(): void {
    this.context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PatchReviewService.scheme, this)
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.path.split('/').filter(Boolean)[0];
    return this.pending.get(id)?.proposedText ?? '';
  }

  private workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private virtualUri(proposed: string, fileName: string): vscode.Uri {
    const id = `v${Date.now()}${this.counter++}`;
    this.pending.set(id, { proposedText: proposed });
    return vscode.Uri.parse(
      `${PatchReviewService.scheme}:/${id}/${encodeURIComponent(fileName)}`
    );
  }

  async reviewBatch(
    patches: PatchBlock[],
    newFiles: NewFileBlock[],
    options: { requireApproval: boolean }
  ): Promise<ApplySummary> {
    const summary: ApplySummary = { applied: 0, skipped: 0, failed: 0 };
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage('未打开工作区，无法应用修改。');
      return { applied: 0, skipped: 0, failed: patches.length + newFiles.length };
    }

    const resolved: ResolvedPatch[] = [];
    for (const patch of patches) {
      const item = resolvePatch(root, patch);
      if (!item) {
        this.output.appendLine(`[patch] 定位失败：${patch.file}`);
        summary.failed++;
        continue;
      }
      resolved.push(item);
    }

    if (resolved.length === 0 && newFiles.length === 0) {
      if (summary.failed > 0) {
        void vscode.window.showWarningMessage(
          `有 ${summary.failed} 处修改无法定位到源码位置，请让 Agent 重新生成。`
        );
      }
      return summary;
    }

    const total = resolved.length + newFiles.length;
    if (options.requireApproval) {
      await this.preview(resolved, newFiles);
      const choice = await vscode.window.showInformationMessage(
        `AI 提出 ${total} 处修改，是否应用？`,
        { modal: true },
        '应用全部',
        '逐个确认'
      );
      if (!choice) {
        summary.skipped += total;
        return summary;
      }
      if (choice === '逐个确认') {
        return this.applyEach(resolved, newFiles, summary);
      }
    }

    return this.applyAll(resolved, newFiles, summary);
  }

  private async preview(
    resolved: ResolvedPatch[],
    newFiles: NewFileBlock[]
  ): Promise<void> {
    try {
      const resources: Array<[vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined]> = [];
      for (const item of resolved) {
        const originalUri = vscode.Uri.file(item.absolutePath);
        resources.push([
          originalUri,
          originalUri,
          this.virtualUri(item.proposedText, path.basename(item.absolutePath))
        ]);
      }
      const root = this.workspaceRoot() as string;
      for (const file of newFiles) {
        const target = vscode.Uri.file(
          path.isAbsolute(file.file) ? file.file : path.join(root, file.file)
        );
        resources.push([
          target,
          undefined,
          this.virtualUri(file.content, path.basename(target.fsPath))
        ]);
      }
      await vscode.commands.executeCommand(
        'vscode.changes',
        `${resolved.length + newFiles.length} 处 AI 修改建议`,
        resources
      );
    } catch (err) {
      this.output.appendLine(
        `[patch] 多文件预览不可用，请在逐个确认中查看：${(err as Error).message}`
      );
    }
  }

  private async applyAll(
    resolved: ResolvedPatch[],
    newFiles: NewFileBlock[],
    summary: ApplySummary
  ): Promise<ApplySummary> {
    const batch = this.beginBatch();
    for (const item of resolved) {
      try {
        await this.snapshot(batch, item.absolutePath);
        await applyPatch(item);
        summary.applied++;
        this.output.appendLine(
          `[patch] 已应用 ${item.file} 第 ${item.startLine}-${item.endLine} 行`
        );
      } catch (err) {
        summary.failed++;
        this.output.appendLine(`[patch] 应用失败 ${item.file}：${(err as Error).message}`);
      }
    }
    const root = this.workspaceRoot() as string;
    for (const file of newFiles) {
      try {
        const target = path.isAbsolute(file.file) ? file.file : path.join(root, file.file);
        await this.snapshot(batch, target);
        await createNewFile(root, file);
        summary.applied++;
      } catch (err) {
        summary.failed++;
        this.output.appendLine(`[patch] 创建失败 ${file.file}：${(err as Error).message}`);
      }
    }
    this.commitBatch(batch);
    this.report(summary);
    return summary;
  }

  private async applyEach(
    resolved: ResolvedPatch[],
    newFiles: NewFileBlock[],
    summary: ApplySummary
  ): Promise<ApplySummary> {
    const batch = this.beginBatch();
    for (let i = 0; i < resolved.length; i++) {
      const item = resolved[i];
      const originalUri = vscode.Uri.file(item.absolutePath);
      const virtualUri = this.virtualUri(item.proposedText, path.basename(item.absolutePath));
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        virtualUri,
        `${path.basename(item.absolutePath)} ↔ AI 修改建议`
      );
      const choice = await vscode.window.showInformationMessage(
        `应用对 ${item.file} 第 ${item.startLine}-${item.endLine} 行的修改？`,
        '应用',
        '跳过',
        '全部应用'
      );
      if (choice === '全部应用') {
        await this.applyAll(resolved.slice(i), newFiles, summary);
        this.commitBatch(batch);
        return summary;
      }
      if (choice !== '应用') {
        summary.skipped++;
        continue;
      }
      try {
        await this.snapshot(batch, item.absolutePath);
        await applyPatch(item);
        summary.applied++;
      } catch (err) {
        summary.failed++;
        this.output.appendLine(`[patch] 应用失败 ${item.file}：${(err as Error).message}`);
      }
    }

    const root = this.workspaceRoot() as string;
    for (const file of newFiles) {
      const target = path.isAbsolute(file.file) ? file.file : path.join(root, file.file);
      const choice = await vscode.window.showInformationMessage(
        `创建新文件 ${file.file}？`,
        '创建',
        '跳过'
      );
      if (choice !== '创建') {
        summary.skipped++;
        continue;
      }
      try {
        await this.snapshot(batch, target);
        await createNewFile(root, file);
        summary.applied++;
      } catch (err) {
        summary.failed++;
        this.output.appendLine(`[patch] 创建失败 ${file.file}：${(err as Error).message}`);
      }
    }

    this.commitBatch(batch);
    this.report(summary);
    return summary;
  }

  private report(summary: ApplySummary): void {
    const parts: string[] = [];
    if (summary.applied > 0) parts.push(`已应用 ${summary.applied} 处`);
    if (summary.skipped > 0) parts.push(`跳过 ${summary.skipped} 处`);
    if (summary.failed > 0) parts.push(`失败 ${summary.failed} 处`);
    const message = parts.join('，') || '没有修改被应用';
    if (summary.failed > 0) {
      void vscode.window.showWarningMessage(`${message}。可用「撤销上次 AI 修改」回退。`);
    } else if (summary.applied > 0) {
      void vscode.window.showInformationMessage(`${message}。`);
    }
  }

  private beginBatch(): SnapshotBatch {
    return { id: `b${Date.now()}`, createdAt: Date.now(), entries: [] };
  }

  private async snapshot(batch: SnapshotBatch, filePath: string): Promise<void> {
    if (batch.entries.some((e) => e.filePath === filePath)) {
      return;
    }
    const uri = vscode.Uri.file(filePath);
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      batch.entries.push({
        filePath,
        content: Buffer.from(raw).toString('utf8'),
        existedBefore: true
      });
    } catch {
      batch.entries.push({ filePath, content: undefined, existedBefore: false });
    }
  }

  private commitBatch(batch: SnapshotBatch): void {
    if (batch.entries.length === 0) {
      return;
    }
    const batches = this.readBatches();
    batches.push(batch);
    while (batches.length > MAX_BATCHES) {
      batches.shift();
    }
    void this.context.workspaceState.update(SNAPSHOT_KEY, batches);
  }

  private readBatches(): SnapshotBatch[] {
    return this.context.workspaceState.get<SnapshotBatch[]>(SNAPSHOT_KEY) ?? [];
  }

  get undoCount(): number {
    return this.readBatches().length;
  }

  async undoLast(): Promise<boolean> {
    const batches = this.readBatches();
    const batch = batches.pop();
    if (!batch) {
      void vscode.window.showInformationMessage('没有可撤销的 AI 修改记录。');
      return false;
    }
    let restored = 0;
    for (const entry of batch.entries) {
      const uri = vscode.Uri.file(entry.filePath);
      try {
        if (entry.existedBefore && typeof entry.content === 'string') {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(entry.content, 'utf8'));
          restored++;
        } else if (!entry.existedBefore) {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
          restored++;
        }
      } catch (err) {
        this.output.appendLine(`[undo] 恢复失败 ${entry.filePath}：${(err as Error).message}`);
      }
    }
    await this.context.workspaceState.update(SNAPSHOT_KEY, batches);
    void vscode.window.showInformationMessage(`已撤销 ${restored} 个文件的 AI 修改。`);
    return true;
  }
}
