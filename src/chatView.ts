import * as vscode from 'vscode';
import { readConfig, readPiSettings, AgentBackend } from './config';
import { SecretStore } from './secrets';
import { collectContext, contextToPrompt } from './contextCollector';
import { buildSystemPrompt } from './prompts';
import { parsePatches, parseNewFiles, parseRunCommands, stripPatchBlocks } from './patch';
import { PatchReviewService } from './patchReview';
import { getChatHtml } from './webviewHtml';
import { NativeAdapter, toFriendlyError } from './agent/nativeAdapter';
import { PiAdapter } from './agent/piAdapter';
import { AgentAdapter, AgentMessage } from './agent/types';
import { SessionStore } from './agent/session';
import { PlatformClient, CourseContext, courseContextToPrompt } from './platform/client';
import { getProjectOutline } from './project/outline';
import {
  runCommand,
  isDangerous,
  isWhitelisted,
  detectTestCommand
} from './tools/commandRunner';

export type QuickAction = 'explain' | 'problem' | 'tests' | 'project' | 'refactor' | 'runTests';

const QUICK_PROMPTS: Record<Exclude<QuickAction, 'runTests'>, { prompt: string; needsSelection?: boolean }> = {
  explain: {
    prompt: '解释我当前选中的代码：它做什么、执行流程是什么、涉及哪些关键知识点。',
    needsSelection: true
  },
  problem: {
    prompt: '分析当前文件中的错误和警告，说明原因，并给出可执行的修复建议。'
  },
  tests: {
    prompt: '为当前选中的代码生成单元测试，使用项目已有的测试框架风格，并说明如何运行。',
    needsSelection: true
  },
  project: {
    prompt: '概述当前项目的目录结构和主要模块职责，指出入口文件和核心依赖。'
  },
  refactor: {
    prompt: '分析当前选中的代码，指出可读性、结构和健壮性问题，给出重构方案。',
    needsSelection: true
  }
};

const PROJECT_INTENT = /项目|结构|架构|目录|模块|入口|依赖|技术栈|工程|仓库|代码库/i;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'ptnAgent.chatView';

  private view?: vscode.WebviewView;
  private busy = false;
  private cts?: vscode.CancellationTokenSource;
  private readonly nativeAdapter: AgentAdapter = new NativeAdapter();
  private piAdapter?: PiAdapter;
  private currentApiKey?: string;
  private readonly session: SessionStore;
  /** 命令输出等临时上下文，随下一条消息附带一次后清空 */
  private pendingContexts: string[] = [];
  private lastCourse?: CourseContext;

  private readonly extensionStoragePath?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: SecretStore,
    private readonly patches: PatchReviewService,
    private readonly platform: PlatformClient,
    private readonly output: vscode.OutputChannel,
    private readonly statusBar: vscode.StatusBarItem,
    context: vscode.ExtensionContext
  ) {
    this.session = new SessionStore(context);
    this.extensionStoragePath = context.globalStorageUri?.fsPath;
  }

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
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('ptnAgent.chatView.focus');
  }

  async newSession(): Promise<void> {
    const backend = readConfig().agentBackend;
    try {
      await this.selectAdapter(backend).reset?.();
    } catch {
      // 重置失败不阻塞 UI
    }
    this.session.reset();
    this.pendingContexts = [];
    this.post({ type: 'cleared' });
    await this.reveal();
    await this.pushState();
  }

  /** 根据配置选择 Agent 基座；Pi 适配器惰性创建并复用同一个进程/会话 */
  private selectAdapter(backend: AgentBackend): AgentAdapter {
    if (backend !== 'pi') {
      return this.nativeAdapter;
    }
    if (!this.piAdapter) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      this.piAdapter = new PiAdapter(
        () => ({ ...readPiSettings(cwd), apiKey: this.currentApiKey }),
        this.output,
        this.extensionStoragePath
      );
    }
    return this.piAdapter;
  }

  dispose(): void {
    this.nativeAdapter.dispose();
    this.piAdapter?.dispose();
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
        break;
      case 'send':
        await this.handleUserText(String(msg.text ?? ''));
        break;
      case 'stop':
        this.cts?.cancel();
        break;
      case 'newSession':
      case 'clearSession':
        await this.newSession();
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('ptnAgent.settings');
        break;
      case 'showContext':
        await vscode.commands.executeCommand('ptnAgent.showContext');
        break;
      case 'quickAction':
        await this.runQuickAction(msg.action as QuickAction);
        break;
      case 'refreshPlatform':
        await vscode.commands.executeCommand('ptnAgent.refreshPlatform');
        break;
      default:
        break;
    }
  }

  async pushState(): Promise<void> {
    const cfg = readConfig();
    const label = this.describeContext();
    this.post({
      type: 'state',
      model: cfg.model,
      provider: cfg.provider,
      backend: cfg.agentBackend,
      backendLabel: cfg.agentBackend === 'pi' ? 'Pi Agent' : '直连模型',
      busy: this.busy,
      contextLabel: label,
      contextWarn: label.indexOf('未打开') >= 0,
      sessionCount: this.session.count,
      undoCount: this.patches.undoCount,
      platformStatus: this.platformStatusText(cfg.platformUrl)
    });
    this.updateStatusBar();
  }

  private platformStatusText(platformUrl: string): string {
    if (!platformUrl) {
      return '平台未配置';
    }
    if (!this.lastCourse) {
      return '平台未连接';
    }
    return this.lastCourse.fromCache
      ? `平台缓存 · ${this.lastCourse.courseTitle ?? this.lastCourse.projectName ?? '课程'}`
      : `平台已连接 · ${this.lastCourse.courseTitle ?? this.lastCourse.projectName ?? '课程'}`;
  }

  private updateStatusBar(): void {
    const cfg = readConfig();
    const suffix = cfg.agentBackend === 'pi' ? ' · Pi' : '';
    this.statusBar.text = this.busy
      ? `$(sync~spin) ${cfg.model}${suffix}`
      : `$(comment-discussion) ${cfg.model}${suffix}`;
    this.statusBar.tooltip = `PTN AI Coding Agent · ${
      cfg.agentBackend === 'pi' ? 'Pi 基座' : '直连模型'
    } · ${cfg.provider} · ${cfg.baseUrl}`;
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

  async handleUserText(text: string, forceProjectContext = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.busy) {
      return;
    }

    const cfg = readConfig();
    const apiKey = await this.secrets.getApiKey();
    if (cfg.provider !== 'ollama' && !apiKey && cfg.agentBackend !== 'pi') {
      const set = await vscode.window.showWarningMessage(
        '尚未配置 API Key，无法调用模型。',
        '去配置'
      );
      if (set === '去配置') {
        await vscode.commands.executeCommand('ptnAgent.settings');
      }
      return;
    }
    this.currentApiKey = apiKey;

    this.busy = true;
    this.updateStatusBar();
    this.post({ type: 'user', text: trimmed });
    this.post({
      type: 'state',
      model: cfg.model,
      provider: cfg.provider,
      backend: cfg.agentBackend,
      busy: true
    });

    try {
      const contextBlock = await this.buildContextBlock(cfg, trimmed, forceProjectContext);
      const userContent = contextBlock ? `${contextBlock}\n\n【我的问题】\n${trimmed}` : trimmed;

      const messages: AgentMessage[] = [
        { role: 'system', content: buildSystemPrompt(cfg) },
        ...this.session.all,
        { role: 'user', content: userContent }
      ];

      const id = `a${Date.now()}`;
      this.post({ type: 'assistantStart', id });

      this.cts = new vscode.CancellationTokenSource();
      let full = '';
      try {
        const adapter = this.selectAdapter(cfg.agentBackend);
        this.post({ type: 'info', message: `${adapter.label} 运行中…` });
        const result = await adapter.run(
          { messages, config: cfg, apiKey },
          {
            onDelta: (delta) => this.post({ type: 'assistantDelta', id, text: delta }),
            onStatus: (status) => this.post({ type: 'info', message: status })
          },
          this.cts.token
        );
        full = result.text;

        this.session.addUser(userContent);
        this.session.addAssistant(full);

        const display = stripPatchBlocks(full);
        this.post({
          type: 'assistantEnd',
          id,
          text: display || '（已生成代码修改或命令建议）',
          meta: `${result.model} · ${(result.elapsedMs / 1000).toFixed(1)}s`
        });

        await this.handleProposals(full, cfg);
      } catch (err) {
        this.post({ type: 'error', message: toFriendlyError(err) });
        this.output.appendLine(`[agent] ${toFriendlyError(err)}`);
      } finally {
        this.cts?.dispose();
        this.cts = undefined;
      }
    } finally {
      this.busy = false;
      this.updateStatusBar();
      await this.pushState();
    }
  }

  private async buildContextBlock(
    cfg: ReturnType<typeof readConfig>,
    question: string,
    forceProject: boolean
  ): Promise<string> {
    const blocks: string[] = [];

    if (cfg.platformUrl) {
      const course = await this.platform.getContext(cfg.platformUrl);
      this.lastCourse = course;
      const prompt = courseContextToPrompt(course);
      if (prompt) {
        blocks.push(prompt);
      } else if (this.platform.lastErrorMessage) {
        this.notify(`实训平台不可用：${this.platform.lastErrorMessage}，已按本地模式继续。`, 'warn');
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

  private async handleProposals(answer: string, cfg: ReturnType<typeof readConfig>): Promise<void> {
    const patches = parsePatches(answer);
    const newFiles = parseNewFiles(answer);
    const commands = parseRunCommands(answer);

    if (patches.length > 0 || newFiles.length > 0) {
      const summary = await this.patches.reviewBatch(patches, newFiles, {
        requireApproval: cfg.requireDiffApproval
      });
      this.notify(
        `修改处理完成：应用 ${summary.applied}，跳过 ${summary.skipped}，失败 ${summary.failed}。` +
          (summary.applied > 0 ? ' 可用命令「撤销上次 AI 修改」回退。' : ''),
        summary.failed > 0 ? 'warn' : 'info'
      );
    }

    for (const command of commands) {
      await this.confirmAndRun(command, cfg);
    }
  }

  private async confirmAndRun(command: string, cfg: ReturnType<typeof readConfig>): Promise<void> {
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
      `Agent 请求执行命令：\n\n${command}\n\n工作目录：${root}`,
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
      `命令${result.ok ? '完成' : '失败'}（退出码 ${result.exitCode}，${(
        result.durationMs / 1000
      ).toFixed(1)}s）\n\n${outputTail}`,
      result.ok ? 'info' : 'warn'
    );
    this.output.appendLine(`[cmd] ${command} -> ${result.exitCode}`);

    this.pendingContexts.push(
      [
        `【上一次命令输出】`,
        `命令：${command}`,
        `退出码：${result.exitCode}`,
        '```',
        outputTail,
        '```'
      ].join('\n')
    );
  }

  async runTests(): Promise<void> {
    const outline = await getProjectOutline();
    const candidates = detectTestCommand(outline?.techStack ?? []);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        '未识别到可用的测试命令，请手动指定（命令面板：AI Agent: 运行命令）。'
      );
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
