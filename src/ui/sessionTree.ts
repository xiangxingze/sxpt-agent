import * as vscode from 'vscode';
import { APPROVAL_MODE_LABELS, ApprovalMode } from '../config';

/**
 * 侧栏的原生树视图：待确认的操作、任务计划、每一轮对话的工具步骤 / 回答 / 改动文件。
 * 会话为空时返回空列表，由 package.json 里的 viewsWelcome 显示原生欢迎页。
 *
 * 数据来自 ChatController 广播的同一套消息，与终端里的对话界面保持一致。
 */

interface StepNode {
  kind: 'step';
  id: string;
  name: string;
  label: string;
  state: 'running' | 'ok' | 'fail';
  summary: string;
}

interface TurnNode {
  kind: 'turn';
  id: number;
  prompt: string;
  steps: StepNode[];
  reply: string;
  meta: string;
  files: string[];
  error: string;
  running: boolean;
}

export interface ApprovalNode {
  kind: 'approval';
  id: string;
  approvalKind: 'edit' | 'write' | 'bash';
  title: string;
  detail: string;
}

interface PlanNode {
  kind: 'plan';
}

interface PlanStepNode {
  kind: 'planStep';
  step: string;
  status: string;
}

export interface ReplyNode {
  kind: 'reply';
  turn: TurnNode;
}

interface FileNode {
  kind: 'file';
  path: string;
}

interface ErrorNode {
  kind: 'error';
  message: string;
}

type Node = StepNode | TurnNode | ApprovalNode | PlanNode | PlanStepNode | ReplyNode | FileNode | ErrorNode;

const TOOL_ICONS: Record<string, string> = {
  read: 'file',
  grep: 'search',
  find: 'search',
  ls: 'folder',
  edit: 'edit',
  write: 'new-file',
  bash: 'terminal',
  get_diagnostics: 'pulse',
  update_plan: 'checklist'
};

const MAX_TURNS = 30;

function firstLine(text: string, max = 80): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class SessionTree implements vscode.TreeDataProvider<Node> {
  public static readonly viewId = 'ptnAgent.sessionView';

  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private turns: TurnNode[] = [];
  private approvals: ApprovalNode[] = [];
  private plan: PlanStepNode[] = [];
  private current?: TurnNode;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private view?: vscode.TreeView<Node>;

  private model = '';
  private mode: ApprovalMode = 'ask';
  private configured = false;
  private busy = false;

  register(context: vscode.ExtensionContext): void {
    this.view = vscode.window.createTreeView(SessionTree.viewId, { treeDataProvider: this, showCollapseAll: true });
    context.subscriptions.push(this.view, this.changed, {
      dispose: () => {
        if (this.timer) {
          clearTimeout(this.timer);
        }
      }
    });
  }

  private refresh(delay = 120): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire();
      this.updateChrome();
    }, delay);
  }

  /** 视图标题旁的说明、徽标，以及欢迎页 / 标题栏按钮用到的上下文键 */
  private updateChrome(): void {
    if (this.view) {
      this.view.description = this.configured
        ? `${this.model} · ${APPROVAL_MODE_LABELS[this.mode] ?? this.mode}`
        : '未配置模型';
      this.view.badge =
        this.approvals.length > 0
          ? { value: this.approvals.length, tooltip: `${this.approvals.length} 项操作等待确认` }
          : undefined;
    }
    void vscode.commands.executeCommand('setContext', 'ptnAgent.configured', this.configured);
    void vscode.commands.executeCommand('setContext', 'ptnAgent.busy', this.busy);
  }

  private startTurn(prompt: string, running: boolean): TurnNode {
    const turn: TurnNode = {
      kind: 'turn',
      id: this.seq++,
      prompt,
      steps: [],
      reply: '',
      meta: '',
      files: [],
      error: '',
      running
    };
    this.turns.push(turn);
    while (this.turns.length > MAX_TURNS) {
      this.turns.shift();
    }
    return turn;
  }

  receive(msg: any): void {
    switch (msg?.type) {
      case 'state':
        if (msg.configured !== undefined) {
          this.configured = !!msg.configured;
        }
        if (msg.model !== undefined) {
          this.model = String(msg.model || '');
        }
        if (msg.mode) {
          this.mode = msg.mode;
        }
        if (msg.busy !== undefined) {
          this.busy = !!msg.busy;
          if (!this.busy && this.current) {
            this.current.running = false;
          }
        }
        break;
      case 'history': {
        const messages: Array<{ role: string; content: string }> = Array.isArray(msg.messages) ? msg.messages : [];
        this.turns = [];
        this.current = undefined;
        let turn: TurnNode | undefined;
        for (const m of messages) {
          if (m.role === 'user') {
            turn = this.startTurn(m.content, false);
          } else if (m.role === 'assistant' && turn) {
            turn.reply = m.content;
          }
        }
        break;
      }
      case 'user':
        this.plan = [];
        this.current = this.startTurn(String(msg.text ?? ''), true);
        break;
      case 'textDelta':
        if (this.current) {
          this.current.reply += String(msg.text ?? '');
        }
        this.refresh(400);
        return;
      case 'toolStart':
        if (this.current && msg.name !== 'update_plan') {
          this.current.steps.push({
            kind: 'step',
            id: String(msg.id),
            name: String(msg.name),
            label: String(msg.label ?? msg.name),
            state: 'running',
            summary: ''
          });
        }
        break;
      case 'toolEnd': {
        const step = this.current?.steps.find((s) => s.id === String(msg.id));
        if (step) {
          step.state = msg.ok ? 'ok' : 'fail';
          step.summary = String(msg.summary ?? '');
        }
        break;
      }
      case 'plan':
        this.plan = (Array.isArray(msg.steps) ? msg.steps : []).map((s: any) => ({
          kind: 'planStep' as const,
          step: String(s.step ?? ''),
          status: String(s.status ?? 'pending')
        }));
        break;
      case 'approval': {
        const r = msg.request ?? {};
        this.approvals.push({
          kind: 'approval',
          id: String(r.id),
          approvalKind: r.kind,
          title: String(r.title ?? ''),
          detail:
            r.kind === 'bash'
              ? String(r.command ?? '')
              : r.isNewFile
                ? `新文件 · ${r.added ?? 0} 行`
                : `+${r.added ?? 0} −${r.removed ?? 0}`
        });
        break;
      }
      case 'approvalDone':
        this.approvals = this.approvals.filter((a) => a.id !== String(msg.id));
        break;
      case 'changes':
        if (this.current) {
          this.current.files = Array.isArray(msg.files) ? msg.files.slice(0, 50) : [];
        }
        break;
      case 'assistantEnd':
        if (this.current) {
          this.current.meta = String(msg.meta ?? '');
          this.current.running = false;
          for (const s of this.current.steps) {
            if (s.state === 'running') {
              s.state = 'fail';
              s.summary = '已停止';
            }
          }
        }
        break;
      case 'error':
        if (this.current) {
          this.current.error = String(msg.message ?? '');
        }
        break;
      case 'cleared':
        this.turns = [];
        this.approvals = [];
        this.plan = [];
        this.current = undefined;
        break;
      default:
        return;
    }
    this.refresh();
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      const roots: Node[] = [...this.approvals];
      if (this.plan.length > 0) {
        roots.push({ kind: 'plan' });
      }
      // 最新的对话排在最上面
      roots.push(...[...this.turns].reverse());
      return roots;
    }
    if (element.kind === 'plan') {
      return this.plan;
    }
    if (element.kind === 'turn') {
      const children: Node[] = [...element.steps];
      if (element.reply.trim()) {
        children.push({ kind: 'reply', turn: element });
      }
      if (element.error) {
        children.push({ kind: 'error', message: element.error });
      }
      children.push(...element.files.map((path) => ({ kind: 'file' as const, path })));
      return children;
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'approval': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
        item.description = `等待确认 · ${node.detail}`;
        item.tooltip = `${node.title}\n${node.detail}\n\n在对话窗口中按 1 / 2 / 3 选择，或使用右侧的按钮。`;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
        item.contextValue = node.approvalKind === 'bash' ? 'approvalCommand' : 'approvalEdit';
        item.command = { command: 'ptnAgent.openChat', title: '打开对话' };
        return item;
      }
      case 'plan': {
        const done = this.plan.filter((s) => s.status === 'completed').length;
        const item = new vscode.TreeItem('任务计划', vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${done}/${this.plan.length}`;
        item.iconPath = new vscode.ThemeIcon('checklist');
        return item;
      }
      case 'planStep': {
        const item = new vscode.TreeItem(node.step, vscode.TreeItemCollapsibleState.None);
        item.iconPath =
          node.status === 'completed'
            ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
            : node.status === 'in_progress'
              ? new vscode.ThemeIcon('sync~spin')
              : new vscode.ThemeIcon('circle-large-outline');
        item.tooltip = node.step;
        return item;
      }
      case 'turn': {
        const isLatest = this.turns[this.turns.length - 1] === node;
        const hasChildren = node.steps.length > 0 || !!node.reply.trim() || !!node.error || node.files.length > 0;
        const item = new vscode.TreeItem(
          firstLine(node.prompt, 60) || '（空消息）',
          hasChildren
            ? isLatest
              ? vscode.TreeItemCollapsibleState.Expanded
              : vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        // 展开状态按节点记忆：最新一轮与历史轮次使用不同的 id，新一轮开始后旧的自动折叠
        item.id = `turn-${node.id}-${isLatest ? 'latest' : 'past'}`;
        item.description = node.running ? '进行中…' : node.meta;
        item.iconPath = new vscode.ThemeIcon(node.running ? 'sync~spin' : node.error ? 'error' : 'comment');
        item.tooltip = node.prompt;
        return item;
      }
      case 'step': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.state === 'running' ? '进行中…' : node.state === 'fail' ? node.summary || '失败' : node.summary;
        item.iconPath =
          node.state === 'running'
            ? new vscode.ThemeIcon('sync~spin')
            : node.state === 'fail'
              ? new vscode.ThemeIcon(TOOL_ICONS[node.name] ?? 'tools', new vscode.ThemeColor('errorForeground'))
              : new vscode.ThemeIcon(TOOL_ICONS[node.name] ?? 'tools');
        item.tooltip = node.summary ? `${node.label}\n${node.summary}` : node.label;
        return item;
      }
      case 'reply': {
        const item = new vscode.TreeItem(firstLine(node.turn.reply) || '回答', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('sparkle');
        item.description = node.turn.running ? '输出中…' : '';
        const preview = node.turn.reply.length > 4000 ? `${node.turn.reply.slice(0, 4000)}\n\n…` : node.turn.reply;
        // 悬停提示由 VS Code 原生渲染 Markdown；不信任其中的命令链接
        const tip = new vscode.MarkdownString(preview);
        tip.isTrusted = false;
        item.tooltip = tip;
        item.command = { command: 'ptnAgent.openReply', title: '在编辑器中查看回答', arguments: [node] };
        return item;
      }
      case 'file': {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const item = new vscode.TreeItem(node.path, vscode.TreeItemCollapsibleState.None);
        item.description = '已修改';
        if (root) {
          item.resourceUri = vscode.Uri.joinPath(root, node.path);
          item.command = { command: 'vscode.open', title: '打开文件', arguments: [item.resourceUri] };
        }
        item.iconPath = vscode.ThemeIcon.File;
        return item;
      }
      case 'error': {
        const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
        item.tooltip = node.message;
        return item;
      }
    }
  }
}
