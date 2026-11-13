import * as vscode from 'vscode';
import * as path from 'path';
import {
  readConfig,
  AgentConfig,
  ApprovalMode,
  APPROVAL_MODE_LABELS,
  APPROVAL_MODE_HINTS,
  isModelConfigured
} from './config';
import { SecretStore } from './secrets';
import { collectContext, contextToPrompt } from './contextCollector';
import { getChatHtml } from './webviewHtml';
import { PiAgent } from './agent/piAgent';
import { SessionStore } from './agent/session';
import {
  AgentHost,
  AgentSettings,
  ApprovalDecision,
  ApprovalRequest
} from './agent/types';
import { toFriendlyError } from './modelCheck';
import { ChangeTracker } from './changeTracker';
import { DiffPreview } from './diffPreview';
import { SettingsController } from './settingsController';
import { isInsideRoots } from './agent/policy';
import { PlatformClient, courseContextToPrompt } from './platform/client';
import { getProjectOutline } from './project/outline';
import { runCommand, isDangerous, isWhitelisted, detectTestCommand } from './tools/commandRunner';

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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ptnAgent.chatView';

  private view?: vscode.WebviewView;
  private busy = false;
  private abort?: AbortController;
  private readonly agent: PiAgent;
  private readonly session: SessionStore;
  /** 学生手动运行的命令输出，随下一条消息附带一次后清空 */
  private pendingContexts: string[] = [];
  private readonly settings: SettingsController;
  private showSettingsOnReady = false;
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly tracker: ChangeTracker,
    private readonly diffs: DiffPreview,
    private readonly platform: PlatformClient,
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext
  ) {
    this.session = new SessionStore(context);
    this.settings = new SettingsController(
      context,
      secrets,
      output,
      (message) => this.post(message),
      () => this.pushState()
    );
    this.agent = new PiAgent(this.createHost(), (line) => this.output.appendLine(line), context.globalStorageUri?.fsPath);
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

      if (this.view?.visible) {
        this.post({
          type: 'approval',
          request: {
            id: request.id,
            kind: request.kind,
            title: request.title,
            relPath: request.relPath,
            command: request.command,
            cwd: request.cwd,
            isNewFile: request.isNewFile,
            added: request.added,
            removed: request.removed,
            canDiff: request.kind !== 'bash'
          }
        });
        if (request.kind !== 'bash') {
          void this.diffs.show(request).catch((err) => this.output.appendLine(`[diff] ${(err as Error).message}`));
        }
      } else {
        // 侧栏不可见时改用原生弹窗，避免 Agent 卡在等待审批
        void this.nativeApproval(request).then(finish);
      }
    });
  }

  private async nativeApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (request.kind !== 'bash') {
      void this.diffs.show(request).catch(() => undefined);
    }
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

  // ---------------- 视图 ----------------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = getChatHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refreshContext();
      }
    });
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('ptnAgent.chatView.focus');
  }

  async newSession(): Promise<void> {
    this.abort?.abort();
    this.cancelPendingApprovals();
    try {
      await this.agent.reset();
    } catch {
      // 重置失败不阻塞 UI
    }
    this.session.reset();
    this.pendingContexts = [];
    this.post({ type: 'cleared' });
    await this.reveal();
    await this.pushState();
  }

  dispose(): void {
    this.abort?.abort();
    this.cancelPendingApprovals();
    this.agent.dispose();
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private notify(text: string, level: 'info' | 'warn' = 'info'): void {
    this.post({ type: 'notice', text, level });
  }

  private async onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        await this.pushState();
        if (this.showSettingsOnReady) {
          this.showSettingsOnReady = false;
          this.post({ type: 'showSettings' });
        }
        void this.settings.refreshModelsIfNeeded();
        break;
      case 'send':
        await this.handleUserText(String(msg.text ?? ''));
        break;
      case 'stop':
        this.abort?.abort();
        break;
      case 'newSession':
        await this.newSession();
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
      case 'openDiff': {
        const pending = this.pendingApprovals.get(String(msg.id));
        if (pending) {
          await this.diffs.show(pending.request);
        }
        break;
      }
      case 'undo':
        await this.tracker.undoLast();
        await this.pushState();
        break;
      case 'copy':
        if (typeof msg.text === 'string' && msg.text.length < 1_000_000) {
          await vscode.env.clipboard.writeText(msg.text);
        }
        break;
      case 'openFile':
        await this.openFileRef(String(msg.ref ?? ''));
        break;
      default:
        await this.settings.handle(msg);
        break;
    }
  }

  /** 打开设置页（侧栏内的单页设置）。侧栏尚未创建时，等 ready 后再展示。 */
  async openSettings(): Promise<void> {
    if (this.view) {
      this.post({ type: 'showSettings' });
    } else {
      this.showSettingsOnReady = true;
    }
    await this.reveal();
  }

  /** 点击回答里的「文件:行号」引用，在编辑器中打开 */
  private async openFileRef(ref: string): Promise<void> {
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
      preview: true
    });
  }

  async pickApprovalMode(): Promise<void> {
    const current = readConfig().approvalMode;
    const items: Array<vscode.QuickPickItem & { value: ApprovalMode }> = [
      {
        label: '逐项确认',
        description: current === 'ask' ? '当前' : '',
        detail: APPROVAL_MODE_HINTS.ask,
        value: 'ask'
      },
      {
        label: '自动应用修改',
        description: current === 'autoEdit' ? '当前' : '',
        detail: APPROVAL_MODE_HINTS.autoEdit,
        value: 'autoEdit'
      },
      {
        label: '只读',
        description: current === 'readOnly' ? '当前' : '',
        detail: APPROVAL_MODE_HINTS.readOnly,
        value: 'readOnly'
      }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Agent 审批模式' });
    if (!picked) {
      return;
    }
    await vscode.workspace
      .getConfiguration('ptnAgent')
      .update('approvalMode', picked.value, vscode.ConfigurationTarget.Global);
    await this.pushState();
  }

  async pushState(): Promise<void> {
    const cfg = readConfig();
    const label = this.describeContext();
    this.post({
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
      undoCount: this.tracker.undoCount
    });
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const cfg = readConfig();
    if (!isModelConfigured(cfg)) {
      this.statusBar.text = '$(comment-discussion) 未配置模型';
      this.statusBar.tooltip = '点击打开 AI Agent，并在设置中配置模型服务';
    } else {
      this.statusBar.text = this.busy ? `$(sync~spin) ${cfg.model}` : `$(comment-discussion) ${cfg.model}`;
      this.statusBar.tooltip = `AI Agent · ${APPROVAL_MODE_LABELS[cfg.approvalMode]} · ${cfg.baseUrl}`;
    }
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
    this.post({ type: 'context', label, warn: label.indexOf('未打开') >= 0 });
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
    if (!trimmed || this.busy) {
      return;
    }

    const cfg = readConfig();
    if (!isModelConfigured(cfg)) {
      await this.openSettings();
      return;
    }
    const apiKey = await this.secrets.getApiKey();
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

    this.busy = true;
    this.updateStatusBar();
    this.post({ type: 'user', text: trimmed });
    this.post({ type: 'state', busy: true });

    this.tracker.beginRun();
    const controller = new AbortController();
    this.abort = controller;
    const id = `a${Date.now()}`;
    let changedFiles: string[] = [];

    try {
      const contextBlock = await this.buildContextBlock(cfg, trimmed, forceProjectContext);
      const prompt = contextBlock ? `${contextBlock}\n\n【我的请求】\n${trimmed}` : trimmed;

      this.post({ type: 'assistantStart', id });
      try {
        const result = await this.agent.run(
          { prompt, history: this.session.all, settings, signal: controller.signal },
          {
            onTextDelta: (delta) => this.post({ type: 'textDelta', text: delta }),
            onTextReset: () => this.post({ type: 'textReset' }),
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
        this.session.addUser(trimmed);
        this.session.addAssistant((result.text || '（已完成操作）') + changeNote);

        const seconds = (result.elapsedMs / 1000).toFixed(1);
        this.post({
          type: 'assistantEnd',
          id,
          aborted: result.aborted,
          meta: `${result.model} · ${seconds}s${result.toolCalls ? ` · ${result.toolCalls} 次工具调用` : ''}${result.aborted ? ' · 已停止' : ''}`
        });
      } catch (err) {
        changedFiles = this.tracker.commitRun();
        const friendly = toFriendlyError(err);
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
      this.busy = false;
      this.updateStatusBar();
      await this.pushState();
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
