import * as vscode from 'vscode';

interface SnapshotEntry {
  filePath: string;
  content: string | undefined;
  existedBefore: boolean;
  /** 文件过大未保存快照，无法撤销 */
  skipped?: boolean;
}

interface SnapshotBatch {
  id: string;
  createdAt: number;
  entries: SnapshotEntry[];
}

const SNAPSHOT_KEY = 'ptnAgent.undo.v2';
const MAX_BATCHES = 10;
const MAX_FILE_BYTES = 1_000_000;

/**
 * 撤销快照：Agent 每次任务（run）对应一个批次，记录被改动文件修改前的内容。
 * 只有通过 edit / write 工具写入的文件会被记录；bash 命令造成的改动无法撤销。
 */
export class ChangeTracker {
  private batch?: SnapshotBatch;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  beginRun(): void {
    this.batch = { id: `b${Date.now()}`, createdAt: Date.now(), entries: [] };
  }

  /** 写入前保存原内容；同一批次内同一文件只保存第一次的内容 */
  async snapshot(filePath: string): Promise<void> {
    const batch = this.batch;
    if (!batch || batch.entries.some((e) => e.filePath === filePath)) {
      return;
    }
    const uri = vscode.Uri.file(filePath);
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      if (raw.byteLength > MAX_FILE_BYTES) {
        batch.entries.push({ filePath, content: undefined, existedBefore: true, skipped: true });
        return;
      }
      batch.entries.push({
        filePath,
        content: Buffer.from(raw).toString('utf8'),
        existedBefore: true
      });
    } catch {
      batch.entries.push({ filePath, content: undefined, existedBefore: false });
    }
  }

  /** 结束一次任务，返回本次改动的文件路径；没有改动则不入栈 */
  commitRun(): string[] {
    const batch = this.batch;
    this.batch = undefined;
    if (!batch || batch.entries.length === 0) {
      return [];
    }
    const batches = this.readBatches();
    batches.push(batch);
    while (batches.length > MAX_BATCHES) {
      batches.shift();
    }
    void this.context.workspaceState.update(SNAPSHOT_KEY, batches);
    return batch.entries.map((e) => e.filePath);
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
    let skipped = 0;
    for (const entry of batch.entries) {
      const uri = vscode.Uri.file(entry.filePath);
      try {
        if (entry.skipped) {
          skipped++;
        } else if (entry.existedBefore && typeof entry.content === 'string') {
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
    void vscode.window.showInformationMessage(
      `已撤销 ${restored} 个文件的 AI 修改。` +
        (skipped > 0 ? `另有 ${skipped} 个文件过大，未保存快照，无法自动撤销。` : '')
    );
    return true;
  }
}
