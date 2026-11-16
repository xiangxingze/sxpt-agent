import * as vscode from 'vscode';
import * as path from 'path';
import { readConfig, AgentConfig, APPROVAL_MODE_LABELS, isModelConfigured } from './config';
import { SecretStore } from './secrets';
import { collectContext, contextToPrompt } from './contextCollector';
import { PiAgent } from './agent/piAgent';
import { SessionStore } from './agent/session';
import { AgentHost, AgentMessage, AgentSettings, ApprovalDecision, ApprovalRequest } from './agent/types';
import { toFriendlyError } from './modelCheck';
import { ChangeTracker } from './changeTracker';
import { DiffPreview } from './diffPreview';
import { SettingsController } from './settingsController';
import { isInsideRoots } from './agent/policy';
import { PlatformClient, courseContextToPrompt } from './platform/client';
import { getProjectOutline } from './project/outline';
import { runCommand, isDangerous, isWhitelisted, detectTestCommand } from './tools/commandRunner';
import { compactDiff } from './ui/diffLines';

export type QuickAction = 'explain' | 'problem' | 'fix' | 'tests' | 'project' | 'refactor' | 'runTests';

const QUICK_PROMPTS: Record<Exclude<QuickAction, 'runTests'>, { prompt: string; needsSelection?: boolean }> = {
  explain: {
    prompt: '解释我当前选中的代码：它做什么、执行流程是什么、涉及哪些关键知识点。只讲解，不要修改文件。',
    needsSelection: true
  },
  problem: {
    prompt: '用 get_diagnostics 查看当前的错误和警告，说明每个问题的原因。先只分析，不要修改文件。'
  },
  fix: {
    prompt:
      '检查当前工作区的错误和警告（get_diagnostics）；如果项目有测试或构建命令，运行它们。' +
      '然后定位根因并修复，修复后重新验证，最后总结改了什么、为什么。'
  },
  tests: {
    prompt:
      '为我当前选中的代码编写单元测试：先看项目里已有的测试框架和风格，把测试写到合适的位置，' +
      '再运行测试确认通过，最后说明如何运行。',
    needsSelection: true
  },
  project: {
    prompt: '概述当前项目的目录结构和主要模块职责，指出入口文件和核心依赖。只查看，不要修改文件。'
  },
  refactor: {
    prompt:
      '分析我当前选中的代码，指出可读性、结构和健壮性问题。给出重构方案，并先说明思路；' +
      '然后用 edit 工具做出修改，改完检查诊断并总结。',
    needsSelection: true
  }
};

const PROJECT_INTENT = /项目|结构|架构|目录|模块|入口|依赖|技术栈|工程|仓库|代码库/i;

interface PendingApproval {
  request: ApprovalRequest;
  finish: (decision: ApprovalDecision) => void;
}

/**
 * 对话界面（由 ChatTerminal 实现）。控制器只依赖这个接口，不关心界面如何绘制。
 *
 * 约定：界面发出 `ready` 时，控制器会在同一次调用里同步回送 `state` 和 `history`，
 * 界面据此把「打开前收到的消息」排在历史记录之后。
 */
export interface ChatSurface {
  /** 界面当前能否直接完成审批；不能时控制器改用原生弹窗 */
  readonly canApprove: boolean;
  post(message: unknown): void;
  reveal(preserveFocus?: boolean): Promise<void>;
  /** 打开文件 / Diff 时使用的编辑器列，避免盖住对话窗口 */
  docColumn(): vscode.ViewColumn | undefined;
  draft?(): string | undefined;
}

/**
 * Agent 的 VS Code 宿主：负责一次任务的完整流程（上下文、运行、审批、撤销快照、汇总），
 * 并把过程以消息的形式广播给对话界面和侧栏树视图。
 */
export class ChatController {
  private surface?: ChatSurface;
  private readonly observers: Array<(message: any) => void> = [];
  private busy = false;
  private abort?: AbortController;
  private readonly agent: PiAgent;
  private readonly session: SessionStore;
  /** 学生手动运行的命令输出，随下一条消息附带一次后清空 */
  private pendingContexts: string[] = [];
  private readonly settings: SettingsController;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private runCompletion?: Promise<void>;
  private switching = false;
  private runMessages: any[] = [];
  private runHistory?: AgentMessage[];

  constructor(
    private readonly secrets: SecretStore,
    private readonly tracker: ChangeTracker,
    private readonly diffs: DiffPreview,
    private readonly platform: PlatformClient,
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext
  ) {
    this.session = new SessionStore(context);
    this.settings = new SettingsController(context, secrets, output, () => this.pushState());
    this.agent = new PiAgent(this.createHost(), (line) => this.output.appendLine(line), context.globalStorageUri?.fsPath);
  }

  // ---------------- 界面 ----------------

  attachSurface(surface: ChatSurface): void {
    this.surface = surface;
  }

  /** 订阅全部界面消息（侧栏树视图用）；订阅时立即补发当前状态和历史对话 */
  addObserver(observer: (message: any) => void): void {
    this.observers.push(observer);
    observer(this.stateMessage());
    observer(this.historyMessage());
  }

  private post(message: any): void {
    if (this.busy && ['user', 'assistantStart', 'textDelta', 'textReset', 'toolStart', 'toolEnd', 'plan', 'info'].includes(message.type)) {
      const last = this.runMessages[this.runMessages.length - 1];
      if (message.type === 'textDelta' && last?.type === 'textDelta') last.text += message.text;
      else this.runMessages.push({ ...message });
    }
    this.surface?.post(message);
    for (const observer of this.observers) {
      try {
        observer(message);
      } catch (err) {
        this.output.appendLine(`[ui] ${(err as Error).message}`);
      }
    }
  }

  private notify(text: string, level: 'info' | 'warn' = 'info'): void {
    this.post({ type: 'notice', text, level });
  }

  async reveal(preserveFocus = false): Promise<void> {
    await this.surface?.reveal(preserveFocus);
  }

  private historyMessage(): Record<string, unknown> {
    return {
      type: 'history',
      replacePending: true,
      sessionId: this.session.currentId,
      draft: this.session.currentDraft,
      messages: (this.runHistory ?? this.session.all)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }))
    };
  }

  private postSessions(): void {
    this.post({ type: 'sessions', activeId: this.session.currentId, sessions: this.session.history });
  }

  async openHistory(): Promise<void> {
    const sessions = this.session.history;
    if (!sessions.length) {
      void vscode.window.showInformationMessage('还没有历史会话，开始对话后会自动保存。');
      return;
    }
    const selected = await vscode.window.showQuickPick(sessions.map((session) => ({
      label: session.title, id: session.id,
      description: session.id === this.session.currentId ? '当前会话' : new Date(session.updatedAt).toLocaleString()
    })), { title: '历史会话', placeHolder: '选择要继续的会话，Esc 返回当前对话', matchOnDescription: true });
    if (selected) await this.changeSession(selected.id);
  }

  // ---------------- Agent 宿主能力 ----------------

  private createHost(): AgentHost {
    return {
      requestApproval: (request, signal) => this.requestApproval(request, signal),
      beforeWrite: (absPath) => this.tracker.snapshot(absPath),
      isDirty: (absPath) => this.isDirty(absPath),
      getDiagnostics: (p) => this.collectDiagnostics(p),
      onPlan: (steps) => this.post({ type: 'plan', steps })
    };
  }

  private isDirty(absPath: string): boolean {
    const target = normalizeFsPath(absPath);
    return vscode.workspace.textDocuments.some(
      (doc) => doc.uri.scheme === 'file' && doc.isDirty && normalizeFsPath(doc.uri.fsPath) === target
    );
  }

  private async collectDiagnostics(p: string | undefined): Promise<string> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) {
      return '当前没有打开工作区。';
    }
    const filterPath = p && p.trim() ? path.resolve(roots[0], p.trim().replace(/^@/, '')) : undefined;
    const lines: string[] = [];
    let total = 0;
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') {
        continue;
      }
      const fsPath = uri.fsPath;
      if (!roots.some((r) => normalizeFsPath(fsPath).startsWith(normalizeFsPath(r)))) {
        continue;
      }
      if (filterPath && normalizeFsPath(fsPath) !== normalizeFsPath(filterPath)) {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(uri, false);
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) {
          continue;
        }
        total++;
        if (lines.length < 60) {
          const label = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          const source = d.source ? ` (${d.source})` : '';
          lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${label}] ${d.message.split('\n')[0]}${source}`);
        }
      }
    }
    if (total === 0) {
      return '没有错误或警告。（仅包含语言服务已分析的文件，未打开过的文件可能不在其中。）';
    }
    const more = total > lines.length ? `\n……另有 ${total - lines.length} 条未显示` : '';
    return `共 ${total} 条错误/警告：\n${lines.join('\n')}${more}`;
  }

  // ---------------- 审批 ----------------

  /** 发给界面的审批信息：不含文件全文，只带精简的行级 Diff */
  private approvalView(request: ApprovalRequest): Record<string, unknown> {
    return {
      id: request.id,
      kind: request.kind,
      title: request.title,
      relPath: request.relPath,
      command: request.command,
      cwd: request.cwd,
      isNewFile: request.isNewFile,
      added: request.added,
      removed: request.removed,
      canDiff: request.kind !== 'bash',
      diff:
        request.kind !== 'bash' && request.proposed !== undefined
          ? compactDiff(request.original ?? '', request.proposed)
          : undefined
    };
  }

  private showDiff(request: ApprovalRequest): void {
    if (request.kind === 'bash') {
      return;
    }
    void this.diffs
      .show(request, this.surface?.docColumn())
      .catch((err) => this.output.appendLine(`[diff] ${(err as Error).message}`));
  }

  private requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) {
          return;
        }
        settled = true;
        this.pendingApprovals.delete(request.id);
        signal.removeEventListener('abort', onAbort);
        this.post({ type: 'approvalDone', id: request.id, decision });
        this.updateStatusBar();
        void this.diffs.close(request.id);
        resolve(decision);
      };
      const onAbort = () => finish('deny');
      if (signal.aborted) {
        finish('deny');
        return;
      }
      signal.addEventListener('abort', onAbort);
      this.pendingApprovals.set(request.id, { request, finish });
      this.updateStatusBar();

      // 对话窗口和侧栏树视图都会显示这条待确认的操作
      this.post({ type: 'approval', request: this.approvalView(request) });
      if (this.surface?.canApprove) {
        // 把对话窗口带到前面，但不抢走编辑器的焦点
        void this.surface.reveal(true);
        this.showDiff(request);
      } else {
        // 对话窗口已关闭时改用原生弹窗，避免 Agent 卡在等待审批
        void this.nativeApproval(request).then(finish);
      }
    });
  }

  private async nativeApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.showDiff(request);
    const detail =
      request.kind === 'bash'
        ? `命令：${request.command}\n工作目录：${request.cwd}`
        : `${request.title}（+${request.added ?? 0} −${request.removed ?? 0}）`;
    const buttons = request.kind === 'bash' ? ['允许'] : ['允许', '本次会话全部允许'];
    const choice = await vscode.window.showWarningMessage(`Agent 请求：${detail}`, { modal: true }, ...buttons);
    if (choice === '允许') {
      return 'allow';
    }
    if (choice === '本次会话全部允许') {
      return 'allowAllEdits';
    }
    return 'deny';
  }

  private cancelPendingApprovals(): void {
    for (const pending of [...this.pendingApprovals.values()]) {
      pending.finish('deny');
    }
  }

  private findApproval(id: string | undefined): PendingApproval | undefined {
    return id ? this.pendingApprovals.get(id) : this.pendingApprovals.values().next().value;
  }

  /** 侧栏树视图上的「允许 / 拒绝」按钮 */
  resolveApproval(id: string | undefined, decision: ApprovalDecision): void {
    this.findApproval(id)?.finish(decision);
  }

  /** 重新打开某个待确认修改的 Diff */
  async openDiff(id: string | undefined): Promise<void> {
    const pending = this.findApproval(id);
    if (pending && pending.request.kind !== 'bash') {
      await this.diffs.show(pending.request, this.surface?.docColumn());
    }
  }

  // ---------------- 会话 ----------------

  async newSession(): Promise<void> {
    await this.changeSession();
  }

  private async changeSession(id?: string): Promise<void> {
    if (this.switching) return;
    if (id && id === this.session.currentId) return;
    if (id && !this.session.history.some((session) => session.id === id)) {
      this.notify('找不到这条会话记录，请重新选择。', 'warn');
      this.postSessions();
      return;
    }
    const draft = this.surface?.draft?.();
    if (typeof draft === 'string') this.session.saveDraft(draft);
    this.switching = true;
    try {
      this.abort?.abort();
      this.cancelPendingApprovals();
      await this.runCompletion?.catch(() => undefined);
      await this.agent.reset();
      if (id) this.session.select(id);
      else this.session.reset();
      this.pendingContexts = [];
      this.runMessages = [];
      this.post({ type: 'cleared' });
      this.post(this.historyMessage());
      this.postSessions();
      await this.reveal();
      await this.pushState();
    } finally {
      this.switching = false;
    }
  }

  stop(): void {
    this.abort?.abort();
  }

  dispose(): void {
    this.abort?.abort();
    this.cancelPendingApprovals();
    this.agent.dispose();
  }

  /** 用原生输入框发起一次任务（侧栏欢迎页、命令面板） */
  async ask(): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('Agent 正在运行，请等它完成或先停止。');
      await this.reveal();
      return;
    }
    if (!isModelConfigured(readConfig())) {
      await this.openSettings();
      return;
    }
    const text = await vscode.window.showInputBox({
      title: 'AI Agent',
      prompt: '描述一个目标，我会阅读代码、制定计划、修改文件并验证结果',
      placeHolder: '例如：修复登录页的报错并运行测试',
      ignoreFocusOut: true
    });
    if (!text || !text.trim()) {
      return;
    }
    await this.reveal();
    await this.handleUserText(text);
  }

  /** 对话界面发来的用户操作 */
  async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // 同步回送状态与历史（见 ChatSurface 的约定），随后补发仍在等待的审批
        this.surface?.post(this.stateMessage());
        this.surface?.post(this.historyMessage());
        for (const message of this.runMessages) this.surface?.post({ ...message, replay: true });
        this.postSessions();
        for (const pending of this.pendingApprovals.values()) {
          this.surface?.post({ type: 'approval', request: this.approvalView(pending.request) });
        }
        this.updateStatusBar();
        void this.settings.refreshModelsIfNeeded();
        break;
      case 'closed':
        // 对话窗口被关闭：仍在等待的审批改用原生弹窗，避免任务卡住
        for (const pending of [...this.pendingApprovals.values()]) {
          void this.nativeApproval(pending.request).then(pending.finish);
        }
        break;
      case 'send':
        await this.handleUserText(String(msg.text ?? ''));
        break;
      case 'stop':
        this.stop();
        break;
      case 'openHistory':
        await this.openHistory();
        break;
      case 'newSession':
        if (typeof msg.draft === 'string') this.session.saveDraft(msg.draft);
        await this.newSession();
        break;
      case 'listSessions':
        this.postSessions();
        break;
      case 'selectSession':
        if (typeof msg.draft === 'string') this.session.saveDraft(msg.draft);
        await this.changeSession(String(msg.id ?? ''));
        break;
      case 'saveDraft':
        if (msg.sessionId === this.session.currentId && typeof msg.text === 'string') this.session.saveDraft(msg.text);
        break;
      case 'showContext':
        await vscode.commands.executeCommand('ptnAgent.showContext');
        break;
      case 'quickAction':
        await this.runQuickAction(msg.action as QuickAction);
        break;
      case 'approvalResponse':
        this.pendingApprovals.get(String(msg.id))?.finish(
          msg.decision === 'allow' || msg.decision === 'allowAllEdits' ? msg.decision : 'deny'
        );
        break;
      case 'openDiff':
        await this.openDiff(String(msg.id));
        break;
      case 'undo':
        await this.undo();
        break;
      case 'openFile':
        await this.openFileRef(String(msg.ref ?? ''));
        break;
      case 'openSettings':
        await this.openSettings();
        break;
      case 'pickModel':
        await this.pickModel();
        break;
      case 'pickMode':
        await this.pickApprovalMode();
        break;
      default:
        break;
    }
  }

  async undo(): Promise<void> {
    if (this.busy) {
      void vscode.window.showInformationMessage('Agent 正在运行，请等它完成或先停止后再撤销。');
      return;
    }
    await this.tracker.undoLast();
    await this.pushState();
  }

  // ---------------- 设置（原生 QuickPick / InputBox） ----------------

  async openSettings(): Promise<void> {
    const wasConfigured = isModelConfigured(readConfig());
    await this.settings.open();
    // 首次配置完成后直接打开对话窗口
    if (!wasConfigured && isModelConfigured(readConfig())) {
      await this.reveal();
    }
  }

  async pickModel(): Promise<void> {
    await this.settings.pickModel();
  }

  async pickApprovalMode(): Promise<void> {
    await this.settings.pickMode();
  }

  // ---------------- 打开文件 / 回答 ----------------

  /** 点击对话里的「文件:行号」引用，在编辑器中打开 */
  async openFileRef(ref: string): Promise<void> {
    const match = /^(.+?)(?::(\d+))?(?::\d+)?$/.exec(ref.trim());
    if (!match) {
      return;
    }
    const relPath = match[1].replace(/^@/, '');
    const line = match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    let target: vscode.Uri | undefined;
    for (const root of roots) {
      const abs = path.resolve(root, relPath);
      if (isInsideRoots(roots, abs) && (await exists(abs))) {
        target = vscode.Uri.file(abs);
        break;
      }
    }
    if (!target && !path.isAbsolute(relPath) && !relPath.includes('..')) {
      const found = await vscode.workspace.findFiles(`**/${relPath}`, '**/node_modules/**', 1);
      target = found[0];
    }
    if (!target) {
      void vscode.window.showInformationMessage(`没有在工作区中找到 ${relPath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(target);
    const position = new vscode.Position(Math.min(line, Math.max(0, doc.lineCount - 1)), 0);
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(position, position),
      preview: true,
      viewColumn: this.surface?.docColumn()
    });
  }

  /** 把一条回答作为 Markdown 文档在编辑器中打开，便于完整阅读、复制 */
  async openReply(text: string): Promise<void> {
    if (!text || !text.trim()) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: this.surface?.docColumn() });
  }

  // ---------------- 状态 ----------------

  private stateMessage(): Record<string, unknown> {
    const cfg = readConfig();
    const label = this.describeContext();
    return {
      type: 'state',
      configured: isModelConfigured(cfg),
      model: cfg.model,
      models: this.settings.cachedModels(),
      mode: cfg.approvalMode,
      autoEdits: this.agent.autoEditsEnabled,
      busy: this.busy,
      contextLabel: label,
      contextWarn: label.indexOf('未打开') >= 0,
      sessionCount: this.session.count,
      sessionId: this.session.currentId,
      undoCount: this.tracker.undoCount
    };
  }

  async pushState(): Promise<void> {
    this.post(this.stateMessage());
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const cfg = readConfig();
    let background: vscode.ThemeColor | undefined;
    if (!isModelConfigured(cfg)) {
      this.statusBar.text = '$(sparkle) 未配置模型';
      this.statusBar.tooltip = '点击打开 AI Agent，并配置模型服务';
    } else if (this.pendingApprovals.size > 0) {
      this.statusBar.text = '$(warning) AI Agent 等待确认';
      this.statusBar.tooltip = '有操作正在等待你的确认，点击打开对话窗口';
      background = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.statusBar.text = this.busy ? `$(sync~spin) ${cfg.model}` : `$(sparkle) ${cfg.model}`;
      this.statusBar.tooltip = `AI Agent · ${APPROVAL_MODE_LABELS[cfg.approvalMode]} · ${cfg.baseUrl}`;
    }
    this.statusBar.backgroundColor = background;
    this.statusBar.show();
  }

  private describeContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return '未打开文件';
    }
    const name = editor.document.fileName.split(/[\\/]/).pop() ?? '';
    const sel = editor.selection;
    if (!sel.isEmpty) {
      return `${name} · L${sel.start.line + 1}-${sel.end.line + 1}`;
    }
    return `${name} · L${sel.active.line + 1}`;
  }

  async refreshContext(): Promise<void> {
    const label = this.describeContext();
    this.surface?.post({ type: 'context', label, warn: label.indexOf('未打开') >= 0 });
  }

  async runQuickAction(action: QuickAction): Promise<void> {
    if (action === 'runTests') {
      await this.runTests();
      return;
    }
    const item = QUICK_PROMPTS[action];
    if (!item) {
      return;
    }
    if (item.needsSelection) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('请先在编辑器中选中代码。');
        return;
      }
    }
    await this.reveal();
    await this.handleUserText(item.prompt, action === 'project');
  }

  // ---------------- 一次 Agent 任务 ----------------

  private buildSettings(cfg: AgentConfig, apiKey: string | undefined): AgentSettings | undefined {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (roots.length === 0) {
      return undefined;
    }
    return {
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      apiKey,
      cwd: roots[0],
      roots,
      approvalMode: cfg.approvalMode,
      allowedCommands: cfg.allowedCommands,
      commandTimeoutMs: cfg.commandTimeoutMs,
      runTimeoutMs: cfg.runTimeoutMs,
      contextWindow: cfg.contextWindow,
      maxOutputTokens: cfg.maxOutputTokens,
      systemPromptExtra: cfg.systemPromptExtra
    };
  }

  async handleUserText(text: string, forceProjectContext = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy || this.switching) {
      return;
    }
    this.busy = true;
    this.runMessages = [];
    const controller = new AbortController();
    this.abort = controller;
    const completion = this.runUserText(trimmed, forceProjectContext, controller);
    this.runCompletion = completion;
    try {
      await completion;
    } catch (error) {
      const friendly = controller.signal.aborted ? '已停止。' : toFriendlyError(error);
      if (this.session.all.at(-1)?.role === 'user') this.session.addAssistant(friendly);
      this.post({ type: 'error', message: friendly });
    } finally {
      this.runCompletion = undefined;
      this.runMessages = [];
      this.runHistory = undefined;
      this.abort = undefined;
      this.busy = false;
      this.postSessions();
      await this.pushState();
    }
  }

  private async runUserText(trimmed: string, forceProjectContext: boolean, controller: AbortController): Promise<void> {
    const cfg = readConfig();
    if (!isModelConfigured(cfg)) {
      await this.openSettings();
      return;
    }
    const apiKey = await this.secrets.getApiKey();
    if (controller.signal.aborted) return;
    const settings = this.buildSettings(cfg, apiKey);
    if (!settings) {
      const open = await vscode.window.showWarningMessage(
        'Agent 需要在一个工作区文件夹中工作。请先打开一个文件夹。',
        '打开文件夹'
      );
      if (open === '打开文件夹') {
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
      }
      return;
    }

    this.updateStatusBar();
    const previousHistory = [...this.session.all];
    this.runHistory = previousHistory;
    this.session.saveDraft('');
    this.post({ type: 'user', text: trimmed });
    this.post({ type: 'state', busy: true });

    this.tracker.beginRun();
    const id = `a${Date.now()}`;
    let changedFiles: string[] = [];
    let replyText = '';
    this.session.addUser(trimmed);

    try {
      const contextBlock = await this.buildContextBlock(cfg, trimmed, forceProjectContext);
      const prompt = contextBlock ? `${contextBlock}\n\n【我的请求】\n${trimmed}` : trimmed;

      this.post({ type: 'assistantStart', id });
      try {
        if (controller.signal.aborted) throw new Error('已停止');
        const result = await this.agent.run(
          { prompt, history: previousHistory, settings, signal: controller.signal },
          {
            onTextDelta: (delta) => { replyText += delta; this.post({ type: 'textDelta', text: delta }); },
            onTextReset: () => { replyText = ''; this.post({ type: 'textReset' }); },
            onToolStart: (info) => this.post({ type: 'toolStart', ...info }),
            onToolEnd: (info) => this.post({ type: 'toolEnd', ...info }),
            onStatus: (status) => this.post({ type: 'info', message: status })
          }
        );

        changedFiles = this.tracker.commitRun();
        const changeNote =
          changedFiles.length > 0
            ? `\n\n（本次修改了：${changedFiles.map((f) => this.rel(f)).join('、')}）`
            : '';
        const finalText = result.text || replyText || (result.aborted ? '已停止。' : '（已完成操作）');
        this.session.addAssistant(finalText + changeNote);

        const seconds = (result.elapsedMs / 1000).toFixed(1);
        this.post({
          type: 'assistantEnd',
          id,
          aborted: result.aborted,
          text: finalText,
          meta: `${result.model} · ${seconds}s${result.toolCalls ? ` · ${result.toolCalls} 次工具调用` : ''}${result.aborted ? ' · 已停止' : ''}`
        });
      } catch (err) {
        changedFiles = this.tracker.commitRun();
        const friendly = controller.signal.aborted ? '已停止。' : toFriendlyError(err);
        this.session.addAssistant([replyText, friendly].filter(Boolean).join('\n\n'));
        this.post({ type: 'assistantEnd', id, aborted: true, meta: '' });
        this.post({ type: 'error', message: friendly });
        this.output.appendLine(`[agent] ${friendly}`);
      }

      if (changedFiles.length > 0) {
        this.post({
          type: 'changes',
          files: changedFiles.map((f) => this.rel(f))
        });
      }
    } finally {
      // 出现异常路径时保证批次被收尾，避免快照泄漏到下一次任务
      this.tracker.commitRun();
      this.cancelPendingApprovals();
      this.abort = undefined;
    }
  }

  private rel(absPath: string): string {
    return vscode.workspace.asRelativePath(vscode.Uri.file(absPath), false);
  }

  private async buildContextBlock(cfg: AgentConfig, question: string, forceProject: boolean): Promise<string> {
    const blocks: string[] = [];

    if (cfg.platformUrl) {
      const prompt = courseContextToPrompt(await this.platform.getContext(cfg.platformUrl));
      if (prompt) {
        blocks.push(prompt);
      } else if (this.platform.lastErrorMessage) {
        // 平台上下文属于管理员配置，不可用时不打扰学生，仅记录日志
        this.output.appendLine(`[platform] 不可用：${this.platform.lastErrorMessage}，已按本地模式继续`);
      }
    }

    if (cfg.autoContext) {
      try {
        const ctx = await collectContext();
        const body = contextToPrompt(ctx);
        if (body) {
          blocks.push(`【当前 IDE 上下文】\n${body}`);
        }
      } catch (err) {
        this.output.appendLine(`[context] 采集失败：${(err as Error).message}`);
      }
    }

    const wantsProject = forceProject || PROJECT_INTENT.test(question);
    if (cfg.includeProjectContext && wantsProject) {
      const outline = await getProjectOutline();
      if (outline) {
        blocks.push(`【项目结构摘要】\n${outline.summary}`);
      }
    }

    if (this.pendingContexts.length > 0) {
      blocks.push(this.pendingContexts.join('\n\n'));
      this.pendingContexts = [];
    }

    return blocks.join('\n\n');
  }

  // ---------------- 学生手动运行命令（独立于 Agent） ----------------

  private async confirmAndRun(command: string, cfg: AgentConfig): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.notify('未打开工作区，无法执行命令。', 'warn');
      return;
    }
    if (isDangerous(command)) {
      this.notify(`已拦截高危命令：${command}`, 'warn');
      return;
    }

    const trusted = isWhitelisted(command, cfg.allowedCommands);
    const choice = await vscode.window.showWarningMessage(
      `即将执行命令：\n\n${command}\n\n工作目录：${root}`,
      { modal: true },
      '执行',
      '取消'
    );
    if (choice !== '执行') {
      this.notify(`已取消命令：${command}`);
      return;
    }

    this.notify(`正在执行${trusted ? '' : '（未在白名单）'}：${command}`);
    const result = await runCommand(command, root, cfg.commandTimeoutMs);
    const outputTail = result.output.slice(-3000);
    this.notify(
      `命令${result.ok ? '完成' : '失败'}（退出码 ${result.exitCode}，${(result.durationMs / 1000).toFixed(1)}s）\n\n${outputTail}`,
      result.ok ? 'info' : 'warn'
    );
    this.output.appendLine(`[cmd] ${command} -> ${result.exitCode}`);

    this.pendingContexts.push(
      [`【上一次命令输出】`, `命令：${command}`, `退出码：${result.exitCode}`, '```', outputTail, '```'].join('\n')
    );
  }

  async runTests(): Promise<void> {
    const outline = await getProjectOutline();
    const candidates = detectTestCommand(outline?.techStack ?? []);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage('未识别到可用的测试命令，请手动指定（命令面板：AI Agent: 运行命令）。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: c.label, command: c.command })),
      { title: '选择要运行的测试或构建命令' }
    );
    if (!picked) {
      return;
    }
    await this.reveal();
    await this.confirmAndRun(picked.command, readConfig());
  }

  /** 供命令 ptnAgent.runCommand 调用 */
  async promptRunCommand(): Promise<void> {
    const outline = await getProjectOutline();
    const suggestions = detectTestCommand(outline?.techStack ?? []).map((c) => c.command);
    const command = await vscode.window.showInputBox({
      title: '运行命令',
      prompt: '命令将在当前工作区根目录执行，需要确认后才会运行',
      placeHolder: suggestions[0] ?? 'npm test',
      ignoreFocusOut: true
    });
    if (!command || !command.trim()) {
      return;
    }
    await this.reveal();
    await this.confirmAndRun(command.trim(), readConfig());
  }

  get sessionMessageCount(): number {
    return this.session.count;
  }
}

function normalizeFsPath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function exists(p: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return true;
  } catch {
    return false;
  }
}
