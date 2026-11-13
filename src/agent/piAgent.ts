import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  AgentEvents,
  AgentHost,
  AgentMessage,
  AgentResult,
  AgentRunRequest,
  AgentSettings,
  ApprovalRequest,
  PlanStep
} from './types';
import {
  READ_TOOLS,
  isInsideRoots,
  isProtectedPath,
  isSensitiveFile,
  previewEdits,
  resolveInWorkspace
} from './policy';
import { classifyCommand } from '../tools/commandRunner';
import { clipHead, clipTail, describeTool, extractToolText } from './toolLabels';
import { buildPromptAppendix, buildSystemPrompt } from '../prompts';

/**
 * 原生 ESM 动态 import。
 * TS 在 CommonJS 输出中会把 import() 降级成 require()，无法加载 ESM 包，
 * 因此用 Function 构造器保留真正的动态 import。
 */
const dynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<any>;

const SDK_PACKAGE = '@earendil-works/pi-coding-agent';
const MAX_TURNS = 40;

let sdkCache: { sdk: any | undefined; error?: string } | undefined;

async function loadSdk(): Promise<any | undefined> {
  if (sdkCache) {
    return sdkCache.sdk;
  }
  try {
    sdkCache = { sdk: await dynamicImport(SDK_PACKAGE) };
  } catch (err) {
    sdkCache = { sdk: undefined, error: `未找到内置 Pi SDK（${(err as Error).message}）` };
  }
  return sdkCache.sdk;
}

export function piSdkLoadError(): string | undefined {
  return sdkCache?.error;
}

export interface PiProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

/** 探测内置 Pi SDK 是否可用（不创建会话、不消耗额度） */
export async function probePiSdk(): Promise<PiProbeResult> {
  const sdk = await loadSdk();
  if (!sdk) {
    return { ok: false, error: sdkCache?.error ?? '未安装内置 Pi SDK' };
  }
  let version: string | undefined;
  try {
    const pkg: any = await dynamicImport(`${SDK_PACKAGE}/package.json`);
    version = pkg?.default?.version ?? pkg?.version;
  } catch {
    version = undefined;
  }
  return { ok: true, version };
}

/** 扩展专属的 Provider ID：接口地址、模型、Key 全部来自学生在设置页填写的内容 */
const PROVIDER_ID = 'ptn-custom';

export function piModelsConfig(settings: AgentSettings): Record<string, unknown> {
  return {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [PROVIDER_ID]: {
        name: 'PTN custom',
        baseUrl: settings.baseUrl,
        api: 'openai-completions',
        apiKey: '$PTN_AGENT_RUNTIME_KEY',
        // 没有填写 Key（例如本地模型）时不发送 Authorization 头
        authHeader: !!settings.apiKey,
        models: [
          {
            id: settings.model,
            name: settings.model,
            reasoning: false,
            input: ['text'],
            contextWindow: settings.contextWindow,
            maxTokens: settings.maxOutputTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  };
}

const READ_ONLY_TOOLS = [...READ_TOOLS, 'get_diagnostics', 'update_plan'];
const FULL_TOOLS = [...READ_ONLY_TOOLS, 'edit', 'write', 'bash'];

function toolsFor(settings: AgentSettings): string[] {
  return settings.approvalMode === 'readOnly' ? READ_ONLY_TOOLS : FULL_TOOLS;
}

function sessionKey(settings: AgentSettings): string {
  const keyHash = crypto
    .createHash('sha256')
    .update(settings.apiKey ?? '')
    .digest('hex')
    .slice(0, 12);
  return JSON.stringify([
    settings.baseUrl,
    settings.model,
    keyHash,
    settings.cwd,
    settings.roots,
    settings.approvalMode === 'readOnly',
    settings.contextWindow,
    settings.maxOutputTokens,
    settings.systemPromptExtra
  ]);
}

function block(reason: string) {
  return { block: true as const, reason };
}

/**
 * Agent 核心：基于内置 Pi SDK 的多步工具循环。
 *
 * Pi 负责「模型 → 工具调用 → 结果 → 再次推理」的循环，并提供 read / grep / find / ls /
 * edit / write / bash。本类在 `tool_call` 拦截点接入教学场景的安全策略：
 *  - 所有路径限制在工作区内，拒绝读取密钥文件、写入 .git
 *  - edit / write 先计算 Diff 交给学生审批，通过后先存撤销快照再写入
 *  - bash 先做高危拦截，再按白名单/审批模式决定是否需要学生确认
 * 另外注册两个自定义工具：get_diagnostics（读 VS Code 问题面板）和 update_plan（任务计划）。
 */
export class PiAgent {
  private session: any;
  private key = '';
  private turns = 0;
  private current?: AgentSettings;
  private runSignal?: AbortSignal;
  private autoEditsThisSession = false;
  private approvalSeq = 0;
  private tmpStorage?: string;

  constructor(
    private readonly host: AgentHost,
    private readonly log: (line: string) => void,
    private readonly storagePath?: string
  ) {}

  async run(request: AgentRunRequest, events: AgentEvents): Promise<AgentResult> {
    const sdk = await loadSdk();
    if (!sdk) {
      throw new Error(piSdkLoadError() ?? '内置 Pi SDK 不可用，请重新安装扩展。');
    }
    const settings = request.settings;
    this.current = settings;
    this.runSignal = request.signal;

    const started = Date.now();
    const session = await this.ensureSession(sdk, settings);

    let toolCalls = 0;
    let turns = 0;
    let timedOut = false;
    let tooManyTurns = false;

    const unsubscribe = session.subscribe((event: any) => {
      switch (event?.type) {
        case 'turn_start':
          turns++;
          if (turns > MAX_TURNS && !tooManyTurns) {
            tooManyTurns = true;
            void session.abort().catch(() => undefined);
          }
          break;
        case 'message_update': {
          const delta = event.assistantMessageEvent;
          if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
            events.onTextDelta(delta.delta);
          }
          break;
        }
        case 'tool_execution_start':
          toolCalls++;
          events.onToolStart({
            id: String(event.toolCallId),
            name: String(event.toolName),
            label: describeTool(String(event.toolName), event.args, settings.cwd)
          });
          break;
        case 'tool_execution_end': {
          const text = extractToolText(event.result);
          const name = String(event.toolName);
          const ok = !event.isError;
          let summary = '';
          if (!ok) {
            summary = clipHead(text.replace(/\s+/g, ' ').trim(), 160) || '失败';
          } else if (name === 'edit' || name === 'write') {
            summary = '已写入';
          } else if (name === 'bash') {
            summary = '已完成';
          }
          events.onToolEnd({
            id: String(event.toolCallId),
            name,
            ok,
            summary,
            output: text ? (name === 'bash' ? clipTail(text, 1500) : clipHead(text, 800)) : undefined
          });
          break;
        }
        case 'auto_retry_start':
          events.onTextReset();
          events.onStatus(`模型请求失败，正在重试（${event.attempt}/${event.maxAttempts}）…`);
          break;
        case 'compaction_start':
          events.onStatus('对话较长，正在压缩历史上下文…');
          break;
        default:
          break;
      }
    });

    const onAbort = () => void session.abort().catch(() => undefined);
    request.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort().catch(() => undefined);
    }, settings.runTimeoutMs);

    try {
      const prompt = this.buildPrompt(request.prompt, request.history, this.turns === 0);
      await session.prompt(prompt);
      this.turns++;

      if (timedOut) {
        throw new Error(`Agent 运行超过 ${Math.round(settings.runTimeoutMs / 1000)} 秒，已自动停止。`);
      }
      if (tooManyTurns) {
        throw new Error(`Agent 在一次任务中执行了超过 ${MAX_TURNS} 轮推理，已自动停止。可以把任务拆小后再试。`);
      }

      const last = this.lastAssistant(session);
      if (request.signal.aborted) {
        return {
          text: this.textOf(last),
          model: settings.model,
          elapsedMs: Date.now() - started,
          toolCalls,
          aborted: true
        };
      }
      if (last?.stopReason === 'error') {
        throw new Error(last.errorMessage || '模型接口调用失败');
      }
      const text = this.textOf(last);
      if (!text.trim() && toolCalls === 0) {
        throw new Error('模型返回内容为空，请检查模型名称与接口地址是否正确');
      }
      return { text, model: settings.model, elapsedMs: Date.now() - started, toolCalls, aborted: false };
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      unsubscribe();
      this.runSignal = undefined;
    }
  }

  // ---------------- 会话与工具 ----------------

  private async ensureSession(sdk: any, settings: AgentSettings): Promise<any> {
    const key = sessionKey(settings);
    if (this.session && key === this.key) {
      return this.session;
    }
    if (this.session) {
      this.disposeSession();
    }

    const baseDir = await this.storageDir();
    const agentDir = path.join(baseDir, 'pi-agent');
    await fs.mkdir(agentDir, { recursive: true });
    const modelsPath = path.join(agentDir, 'models.json');
    await fs.writeFile(modelsPath, JSON.stringify(piModelsConfig(settings), null, 2), 'utf8');

    const providerId = PROVIDER_ID;
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, 'auth.json'),
      modelsPath,
      refreshOnCreate: false
    });
    if (typeof modelRuntime.setRuntimeApiKey === 'function') {
      await modelRuntime.setRuntimeApiKey(providerId, settings.apiKey ?? 'no-key');
    }
    let model = modelRuntime.getModel?.(providerId, settings.model);
    if (!model) {
      const available: any[] = (await modelRuntime.getAvailable?.()) ?? [];
      model = available.find((m: any) => m?.id === settings.model || m?.name === settings.model);
    }
    if (!model) {
      throw new Error(`Pi 无法识别模型 ${providerId}/${settings.model}，请检查模型名称与 Base URL。`);
    }

    // 全部使用内存设置：不读取、不写入学生 ~/.pi 下的任何配置，也不加载项目内的 .pi 资源
    const settingsManager = sdk.SettingsManager.inMemory(
      {
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
        enableInstallTelemetry: false
      },
      { projectTrusted: false }
    );

    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: settings.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: buildSystemPrompt(),
      appendSystemPrompt: buildPromptAppendix(settings.systemPromptExtra),
      extensionFactories: [{ name: 'ptn-gate', factory: (pi: any) => this.installGate(pi) }]
    });
    await resourceLoader.reload();

    const customTools = await this.buildCustomTools(sdk);
    const { session } = await sdk.createAgentSession({
      cwd: settings.cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: 'off',
      resourceLoader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(settings.cwd),
      tools: toolsFor(settings),
      customTools
    });

    // 串行执行工具：保证「审批 → 写入」按顺序发生，Diff 预览始终基于最新文件内容
    try {
      if (session.agent) {
        session.agent.toolExecution = 'sequential';
      }
    } catch {
      // 旧版本没有该属性时忽略
    }
    try {
      await session.bindExtensions({});
    } catch (err) {
      this.log(`[agent] bindExtensions 失败：${(err as Error).message}`);
    }

    this.session = session;
    this.key = key;
    this.turns = 0;
    this.log(
      `[agent] 会话已创建 model=${providerId}/${settings.model} cwd=${settings.cwd} mode=${settings.approvalMode}`
    );
    return session;
  }

  private async buildCustomTools(sdk: any): Promise<any[]> {
    const { Type } = await dynamicImport('typebox');
    const host = this.host;
    const planTool = sdk.defineTool({
      name: 'update_plan',
      label: '更新计划',
      description:
        '创建或更新任务计划。任务包含 3 步以上时，开始前先列出计划；之后每完成一步就更新状态。' +
        '每次调用都要传入完整的步骤列表。同一时刻最多一个步骤为 in_progress。',
      promptSnippet: 'Create or update the visible task plan for multi-step work',
      parameters: Type.Object({
        steps: Type.Array(
          Type.Object({
            step: Type.String({ description: '步骤描述，简短一句话' }),
            status: Type.Union(
              [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')],
              { description: '步骤状态' }
            )
          }),
          { description: '完整的步骤列表' }
        )
      }),
      async execute(_id: string, params: { steps: PlanStep[] }) {
        host.onPlan(params.steps.slice(0, 20));
        return { content: [{ type: 'text', text: '计划已更新。' }], details: {} };
      }
    });
    const diagTool = sdk.defineTool({
      name: 'get_diagnostics',
      label: '读取诊断',
      description:
        '读取 VS Code 问题面板中的错误和警告（来自语言服务、编译器、Linter）。' +
        '不传 path 返回整个工作区。修改代码后用它检查是否引入了新错误；语言服务更新可能有短暂延迟。',
      promptSnippet: 'Read errors and warnings from the VS Code Problems panel',
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: '相对工作区的文件路径，留空表示整个工作区' }))
      }),
      async execute(_id: string, params: { path?: string }) {
        const text = await host.getDiagnostics(params.path);
        return { content: [{ type: 'text', text }], details: {} };
      }
    });
    return [planTool, diagTool];
  }

  /** 安装 tool_call 拦截：路径围栏 + 审批 + 快照 */
  private installGate(pi: any): void {
    pi.on('tool_call', async (event: any) => {
      const settings = this.current;
      const signal = this.runSignal;
      if (!settings || !signal) {
        return block('当前没有进行中的 Agent 任务。');
      }
      try {
        return await this.gate(event, settings, signal);
      } catch (err) {
        // 审核过程本身出错时按拒绝处理，宁可不执行
        this.log(`[gate] ${(err as Error).message}`);
        return block(`工具调用审核失败：${(err as Error).message}`);
      }
    });
  }

  private async gate(event: any, s: AgentSettings, signal: AbortSignal) {
    const name = String(event.toolName);
    const input = event.input ?? {};

    if (name === 'get_diagnostics' || name === 'update_plan') {
      return undefined;
    }

    if ((READ_TOOLS as readonly string[]).includes(name)) {
      const abs = resolveInWorkspace(s.cwd, input.path);
      if (!isInsideRoots(s.roots, abs)) {
        return block(`路径 ${input.path ?? '.'} 在工作区之外，不允许访问。`);
      }
      if (name === 'read' && isSensitiveFile(abs)) {
        return block(`${path.basename(abs)} 可能包含密钥或凭据，不允许读取。`);
      }
      return undefined;
    }

    if (name === 'edit' || name === 'write') {
      if (s.approvalMode === 'readOnly') {
        return block('当前为只读模式，不能修改文件。');
      }
      const abs = resolveInWorkspace(s.cwd, input.path);
      const rel = path.relative(s.cwd, abs).replace(/\\/g, '/') || abs;
      if (!isInsideRoots(s.roots, abs)) {
        return block(`路径 ${input.path} 在工作区之外，不允许修改。`);
      }
      if (isProtectedPath(abs)) {
        return block('不允许修改 .git 目录。');
      }
      if (this.host.isDirty(abs)) {
        return block(`${rel} 在编辑器中有未保存的修改。请先告诉学生保存文件（Ctrl+S），再重新读取后修改。`);
      }

      let original: string | undefined;
      try {
        original = await fs.readFile(abs, 'utf8');
      } catch {
        original = undefined;
      }

      let request: ApprovalRequest;
      if (name === 'edit') {
        if (original === undefined) {
          return block(`文件 ${rel} 不存在。新建文件请使用 write。`);
        }
        const preview = previewEdits(original, input.edits);
        if (!preview.ok) {
          return block(preview.error);
        }
        request = {
          id: this.nextApprovalId(),
          kind: 'edit',
          title: `修改 ${rel}`,
          absPath: abs,
          relPath: rel,
          original: preview.original,
          proposed: preview.proposed,
          added: preview.added,
          removed: preview.removed
        };
      } else {
        const proposed = typeof input.content === 'string' ? input.content : '';
        if (original !== undefined && original === proposed) {
          return undefined;
        }
        request = {
          id: this.nextApprovalId(),
          kind: 'write',
          title: original === undefined ? `新建 ${rel}` : `覆盖 ${rel}`,
          absPath: abs,
          relPath: rel,
          isNewFile: original === undefined,
          original: original ?? '',
          proposed,
          added: proposed ? proposed.split('\n').length : 0,
          removed: original ? original.split('\n').length : 0
        };
      }

      if (s.approvalMode !== 'autoEdit' && !this.autoEditsThisSession) {
        const decision = await this.host.requestApproval(request, signal);
        if (decision === 'deny') {
          return block(
            '学生拒绝了这次修改。不要重复提交同样的修改；先说明你的思路并询问原因，或换一种方案。'
          );
        }
        if (decision === 'allowAllEdits') {
          this.autoEditsThisSession = true;
        }
      }
      await this.host.beforeWrite(abs);
      return undefined;
    }

    if (name === 'bash') {
      if (s.approvalMode === 'readOnly') {
        return block('当前为只读模式，不能执行命令。');
      }
      const command = typeof input.command === 'string' ? input.command : '';
      const risk = classifyCommand(command, s.allowedCommands);
      if (risk.level === 'blocked') {
        return block(`命令被拒绝：${risk.reason}。请换用更安全的方式，或让学生自己在终端执行。`);
      }
      if (risk.level === 'confirm') {
        const decision = await this.host.requestApproval(
          {
            id: this.nextApprovalId(),
            kind: 'bash',
            title: '运行命令',
            command,
            cwd: s.cwd
          },
          signal
        );
        if (decision === 'deny') {
          return block('学生拒绝执行该命令。不要重复运行同一条命令；先说明目的并询问原因，或换一种方式。');
        }
      }
      const maxSeconds = Math.max(1, Math.ceil(s.commandTimeoutMs / 1000));
      if (typeof input.timeout !== 'number' || !(input.timeout > 0) || input.timeout > maxSeconds) {
        input.timeout = maxSeconds;
      }
      return undefined;
    }

    return block(`不支持的工具：${name}`);
  }

  private nextApprovalId(): string {
    return `ap${Date.now()}_${this.approvalSeq++}`;
  }

  // ---------------- 辅助 ----------------

  private buildPrompt(current: string, history: AgentMessage[], freshSession: boolean): string {
    if (!freshSession || history.length === 0) {
      return current;
    }
    // 新建底层会话（重启 VS Code、切换模型后）时，把此前对话作为背景补一次
    const transcript = history
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role === 'user' ? '学生' : '助手'}：${m.content}`)
      .join('\n\n');
    return `【此前对话】\n${transcript}\n\n【当前请求】\n${current}`;
  }

  private lastAssistant(session: any): any {
    const messages = session?.agent?.state?.messages ?? session?.messages;
    if (!Array.isArray(messages)) {
      return undefined;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        return messages[i];
      }
    }
    return undefined;
  }

  private textOf(message: any): string {
    if (!message) {
      return '';
    }
    if (typeof message.content === 'string') {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('');
    }
    return '';
  }

  private async storageDir(): Promise<string> {
    if (this.storagePath) {
      return this.storagePath;
    }
    if (!this.tmpStorage) {
      this.tmpStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'ptn-agent-'));
    }
    return this.tmpStorage;
  }

  get autoEditsEnabled(): boolean {
    return this.autoEditsThisSession;
  }

  /** 新建会话：丢弃底层对话与「本次会话自动允许」状态 */
  async reset(): Promise<void> {
    this.disposeSession();
    this.autoEditsThisSession = false;
  }

  private disposeSession(): void {
    try {
      this.session?.dispose?.();
    } catch {
      // 忽略销毁异常
    }
    this.session = undefined;
    this.key = '';
    this.turns = 0;
  }

  dispose(): void {
    this.disposeSession();
  }
}
