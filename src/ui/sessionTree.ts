import * as vscode from 'vscode';
import type { ChatSurface } from '../chatController';
import { APPROVAL_MODE_LABELS, ApprovalMode } from '../config';

/**
 * 原生 Agent 面板。
 *
 * 这是原生 Chat 不可用时的兼容视图，也作为状态镜像保留。
 * 它不创建 Terminal，也不依赖 Webview；支持在同一个 TreeView 内切换对话、历史和设置。
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

interface PageNode {
  kind: 'page';
  page: 'history' | 'settings';
}

interface SessionNode {
  kind: 'session';
  id: string;
  title: string;
  updatedAt: number;
  active: boolean;
}

interface SettingNode {
  kind: 'setting';
  id: string;
  label: string;
  description: string;
  command: string;
}

interface EmptyNode {
  kind: 'empty';
  label: string;
  description: string;
  command?: string;
}

interface NoticeNode {
  kind: 'notice';
  text: string;
  level: 'info' | 'warn';
}

type Node =
  | StepNode
  | TurnNode
  | ApprovalNode
  | PlanNode
  | PlanStepNode
  | ReplyNode
  | FileNode
  | ErrorNode
  | PageNode
  | SessionNode
  | SettingNode
  | EmptyNode
  | NoticeNode;

type PanelMode = 'chat' | 'history' | 'settings';

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
}

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

export class SessionTree implements vscode.TreeDataProvider<Node>, ChatSurface {
  public static readonly viewId = 'ptnAgent.sessionView';

  constructor(private readonly registeredViewId = SessionTree.viewId) {}

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
  private baseUrl = '';
  private contextLabel = '';
  private sessions: SessionSummary[] = [];
  private activeSessionId = '';
  private panelMode: PanelMode = 'chat';
  private notice?: NoticeNode;

  /** TreeView 内的审批项可直接使用右侧原生菜单完成审批。 */
  readonly canApprove = true;

  register(context: vscode.ExtensionContext, onVisible?: () => void): void {
    this.view = vscode.window.createTreeView(this.registeredViewId, {
      treeDataProvider: this,
      showCollapseAll: true
    });
    context.subscriptions.push(this.view, this.changed, {
      dispose: () => {
        if (this.timer) clearTimeout(this.timer);
      }
    });
    if (onVisible) {
      context.subscriptions.push(
        this.view.onDidChangeVisibility((event) => {
          if (event.visible) onVisible();
        })
      );
    }
    this.updateChrome();
  }

  /** ChatSurface：控制器发出的消息直接进入这个唯一面板。 */
  post(message: unknown): void {
    this.receive(message);
  }

  async reveal(): Promise<void> {
    this.panelMode = 'chat';
    this.refresh(0);
    // 打开活动栏中的 Agent 容器，不创建编辑器标签页或集成终端。
    await vscode.commands.executeCommand('workbench.view.extension.ptnAgent');
  }

  showHistory(): void {
    this.panelMode = 'history';
    this.refresh(0);
  }

  showSettings(): void {
    this.panelMode = 'settings';
    this.refresh(0);
  }

  docColumn(): vscode.ViewColumn {
    return vscode.ViewColumn.Beside;
  }

  draft(): string | undefined {
    // Native InputBox 不会在面板里留下未提交的草稿。
    return undefined;
  }

  private refresh(delay = 120): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.changed.fire();
      this.updateChrome();
    }, delay);
  }

  private updateChrome(): void {
    if (this.view) {
      const pageLabel = this.panelMode === 'history' ? '历史会话' : this.panelMode === 'settings' ? '设置' : '';
      this.view.description =
        pageLabel || (this.configured ? `${this.model} · ${APPROVAL_MODE_LABELS[this.mode] ?? this.mode}` : '未配置模型');
      this.view.message =
        this.panelMode !== 'chat'
          ? undefined
          : this.turns.length === 0
            ? this.configured
              ? '单击“输入任务…”开始对话，或使用右上角的新建、历史和设置。'
              : '请先打开设置连接模型服务。'
            : this.contextLabel
              ? `当前上下文：${this.contextLabel}`
              : undefined;
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
    while (this.turns.length > MAX_TURNS) this.turns.shift();
    return turn;
  }

  receive(msg: any): void {
    switch (msg?.type) {
      case 'state':
        if (msg.configured !== undefined) this.configured = !!msg.configured;
        if (msg.model !== undefined) this.model = String(msg.model || '');
        if (msg.mode) this.mode = msg.mode;
        if (msg.baseUrl !== undefined) this.baseUrl = String(msg.baseUrl || '');
        if (msg.contextLabel !== undefined) this.contextLabel = String(msg.contextLabel || '');
        if (msg.busy !== undefined) {
          this.busy = !!msg.busy;
          if (!this.busy && this.current) this.current.running = false;
        }
        break;
      case 'history': {
        const messages: Array<{ role: string; content: string }> = Array.isArray(msg.messages) ? msg.messages : [];
        this.turns = [];
        this.current = undefined;
        let turn: TurnNode | undefined;
        for (const m of messages) {
          if (m.role === 'user') turn = this.startTurn(m.content, false);
          else if (m.role === 'assistant' && turn) turn.reply = m.content;
        }
        break;
      }
      case 'sessions':
        this.activeSessionId = String(msg.activeId ?? '');
        this.sessions = (Array.isArray(msg.sessions) ? msg.sessions : []).map((session: any) => ({
          id: String(session.id ?? ''),
          title: String(session.title || '新会话'),
          updatedAt: Number(session.updatedAt) || 0
        }));
        break;
      case 'context':
        this.contextLabel = String(msg.label ?? '');
        break;
      case 'notice':
        this.notice = { kind: 'notice', text: String(msg.text ?? ''), level: msg.level === 'warn' ? 'warn' : 'info' };
        break;
      case 'user':
        this.notice = undefined;
        this.plan = [];
        this.current = this.startTurn(String(msg.text ?? ''), true);
        break;
      case 'textDelta':
        if (this.current) this.current.reply += String(msg.text ?? '');
        this.refresh(400);
        return;
      case 'textReset':
        if (this.current) this.current.reply = '';
        break;
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
        if (this.current) this.current.files = Array.isArray(msg.files) ? msg.files.slice(0, 50) : [];
        break;
      case 'assistantEnd':
        if (this.current) {
          if (typeof msg.text === 'string') this.current.reply = msg.text;
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
        if (this.current) this.current.error = String(msg.message ?? '');
        break;
      case 'cleared':
        this.panelMode = 'chat';
        this.notice = undefined;
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

  private settingsNodes(): SettingNode[] {
    if (!this.configured) {
      return [
        {
          kind: 'setting',
          id: 'setup',
          label: '连接模型服务',
          description: '配置 API 地址、API Key 和模型',
          command: 'ptnAgent.setup'
        }
      ];
    }
    return [
      { kind: 'setting', id: 'baseUrl', label: 'API 地址', description: this.baseUrl || '未填写', command: 'ptnAgent.editBaseUrl' },
      { kind: 'setting', id: 'apiKey', label: 'API Key', description: '使用 SecretStorage 安全保存', command: 'ptnAgent.editApiKey' },
      { kind: 'setting', id: 'model', label: '模型', description: this.model || '未选择', command: 'ptnAgent.pickModel' },
      {
        kind: 'setting',
        id: 'mode',
        label: '操作确认',
        description: APPROVAL_MODE_LABELS[this.mode] ?? this.mode,
        command: 'ptnAgent.pickMode'
      },
      { kind: 'setting', id: 'test', label: '测试连接', description: '使用当前地址、Key 和模型测试', command: 'ptnAgent.testConnection' },
      { kind: 'setting', id: 'more', label: '更多设置', description: '打开完整的原生设置菜单', command: 'ptnAgent.settingsMenu' }
    ];
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      if (this.panelMode === 'history') {
        return [
          { kind: 'page', page: 'history' },
          ...(this.sessions.length
            ? this.sessions.map((session) => ({
                kind: 'session' as const,
                id: session.id,
                title: session.title,
                updatedAt: session.updatedAt,
                active: session.id === this.activeSessionId
              }))
            : [{ kind: 'empty' as const, label: '暂无历史会话', description: '开始对话后会自动保存' }])
        ];
      }
      if (this.panelMode === 'settings') return [{ kind: 'page', page: 'settings' }, ...this.settingsNodes()];

      // 空会话交给 viewsWelcome 渲染，用户通过欢迎页或视图标题按钮打开原生 InputBox。
      const roots: Node[] = [...this.approvals];
      if (this.registeredViewId !== SessionTree.viewId) {
        roots.unshift({ kind: 'empty', label: '输入任务…', description: '使用当前配置的模型，无需 Copilot 登录', command: 'ptnAgent.ask' });
      }
      if (this.notice) roots.push(this.notice);
      if (this.plan.length > 0) roots.push({ kind: 'plan' });
      roots.push(...[...this.turns].reverse());
      return roots;
    }
    if (element.kind === 'plan') return this.plan;
    if (element.kind === 'turn') {
      const children: Node[] = [...element.steps];
      if (element.reply.trim()) children.push({ kind: 'reply', turn: element });
      if (element.error) children.push({ kind: 'error', message: element.error });
      children.push(...element.files.map((path) => ({ kind: 'file' as const, path })));
      return children;
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'page': {
        const item = new vscode.TreeItem(node.page === 'history' ? '‹ 返回当前会话' : '‹ 返回对话', vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('arrow-left');
        item.command = { command: 'ptnAgent.openChat', title: '返回当前会话' };
        return item;
      }
      case 'session': {
        const item = new vscode.TreeItem(node.title || '新会话', vscode.TreeItemCollapsibleState.None);
        item.description = node.active ? '当前会话' : node.updatedAt ? new Date(node.updatedAt).toLocaleString() : '';
        item.tooltip = node.title;
        item.iconPath = new vscode.ThemeIcon(node.active ? 'comment-discussion' : 'history');
        item.command = { command: 'ptnAgent.selectSession', title: '打开会话', arguments: [node.id] };
        return item;
      }
      case 'setting': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.tooltip = `${node.label}\n${node.description}`;
        item.iconPath = new vscode.ThemeIcon(
          node.id === 'model' ? 'sparkle' : node.id === 'mode' ? 'shield' : node.id === 'test' ? 'plug' : 'gear'
        );
        item.command = { command: node.command, title: node.label };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon(node.command === 'ptnAgent.ask' ? 'edit' : 'history');
        if (node.command) item.command = { command: node.command, title: node.label };
        return item;
      }
      case 'notice': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.level === 'warn' ? 'warning' : 'info');
        item.tooltip = node.text;
        return item;
      }
      case 'approval': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
        item.description = `等待确认 · ${node.detail}`;
        item.tooltip = `${node.title}\n${node.detail}\n\n使用右侧的允许或拒绝按钮。`;
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
