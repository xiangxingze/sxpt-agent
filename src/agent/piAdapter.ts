import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { AgentAdapter, AgentRequest, AgentResult, AgentStreamHandlers } from './types';
import { PiSettings } from '../config';

/**
 * 原生 ESM 动态 import。
 * TS 在 CommonJS 输出中会把 import() 降级成 require()，无法加载 ESM 包，
 * 因此用 Function 构造器保留真正的动态 import。
 */
const dynamicImport = new Function('specifier', 'return import(specifier);') as (
  specifier: string
) => Promise<any>;

const SDK_PACKAGE = '@earendil-works/pi-coding-agent';

type PiSdk = {
  createAgentSession: (options: Record<string, unknown>) => Promise<{ session: any }>;
  ModelRuntime: { create: (options?: Record<string, unknown>) => Promise<any> };
  SessionManager: { inMemory: (cwd?: string) => unknown };
};

let sdkCache: { sdk: PiSdk | undefined; error?: string } | undefined;

async function loadSdk(): Promise<PiSdk | undefined> {
  if (sdkCache) {
    return sdkCache.sdk;
  }
  try {
    const mod: any = await dynamicImport(SDK_PACKAGE);
    sdkCache = { sdk: mod as PiSdk };
  } catch (err) {
    sdkCache = {
      sdk: undefined,
      error: `未找到内置 Pi SDK（${(err as Error).message}）`
    };
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

function providerIdFor(settings: PiSettings): string {
  // 使用扩展专属 Provider，避免覆盖学生其它 Pi 配置；Base URL/模型完全来自扩展设置。
  return `ptn-${settings.provider}`;
}

function piApiFor(settings: PiSettings): string {
  return settings.provider === 'openai-compatible' || settings.provider === 'deepseek' || settings.provider === 'ollama'
    ? 'openai-completions'
    : 'openai-completions';
}

function piModelsConfig(settings: PiSettings): Record<string, unknown> {
  const provider = providerIdFor(settings);
  return {
    $schema: 'https://pi.dev/schemas/models.schema.json',
    providers: {
      [provider]: {
        name: `PTN ${settings.provider}`,
        baseUrl: settings.baseUrl,
        api: piApiFor(settings),
        apiKey: '$PTN_AGENT_RUNTIME_KEY',
        authHeader: settings.provider !== 'ollama',
        models: [
          {
            id: settings.model,
            name: settings.model,
            reasoning: false,
            input: ['text'],
            contextWindow: 128000,
            maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      }
    }
  };
}

function readOnlyTools(): string[] {
  return ['read', 'grep', 'find', 'ls'];
}

/**
 * Pi Agent 适配器。
 *
 * 默认走内置 SDK（进程内，无额外安装）；
 * SDK 不可用时自动回退到 `pi --mode rpc` 子进程（JSONL 协议）。
 *
 * 安全设计：两种传输都强制只读工具集（read/grep/find/ls），
 * 因此 Pi 不能直接改文件或执行命令 —— 所有写操作仍走扩展的 Diff 审核流程。
 */
export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';

  private sdkSession: any;
  private sdkUnsub?: () => void;
  private sdkTurn = 0;
  private child?: ChildProcessWithoutNullStreams;
  private rpcBuffer = '';
  private rpcPending = new Map<
    string,
    { resolve: (value: any) => void; timer: NodeJS.Timeout; command: string }
  >();
  private rpcSeq = 0;
  private rpcTurn = 0;

  constructor(
    private readonly getSettings: () => PiSettings,
    private readonly output: vscode.OutputChannel,
    private readonly storagePath?: string
  ) {}

  get label(): string {
    const s = this.getSettings();
    return s.transport === 'rpc' ? 'Pi Agent (RPC)' : 'Pi Agent (内置 SDK)';
  }

  async run(
    request: AgentRequest,
    handlers: AgentStreamHandlers,
    token: vscode.CancellationToken
  ): Promise<AgentResult> {
    const settings = this.getSettings();
    const started = Date.now();
    handlers.onStatus?.(`Pi 运行中（${settings.transport === 'rpc' ? 'RPC' : 'SDK'}）`);

    const text =
      settings.transport === 'rpc'
        ? await this.runRpc(request, handlers, token, settings)
        : await this.runSdk(request, handlers, token, settings);

    return {
      text,
      model: `pi:${settings.model}`,
      elapsedMs: Date.now() - started
    };
  }

  // ---------------- SDK transport ----------------

  private async runSdk(
    request: AgentRequest,
    handlers: AgentStreamHandlers,
    token: vscode.CancellationToken,
    settings: PiSettings
  ): Promise<string> {
    const sdk = await loadSdk();
    if (!sdk) {
      this.output.appendLine('[pi] SDK 不可用，回退 RPC');
      return this.runRpc(request, handlers, token, settings);
    }

    const session = await this.ensureSdkSession(sdk, settings);
    const prompt = this.buildPrompt(request, this.sdkTurn === 0);

    let answer = '';
    const unsubscribe = session.subscribe((event: any) => {
      if (event?.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          // 以 agent_end 的权威消息为准，避免 Pi 自动重试/多内容块造成重复增量。
          answer += delta.delta;
        } else if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string') {
          handlers.onReasoning?.(delta.delta);
        }
      } else if (event?.type === 'tool_execution_start') {
        handlers.onStatus?.(`Pi 调用工具：${event.toolName ?? 'unknown'}`);
      } else if (event?.type === 'auto_retry_start') {
        handlers.onStatus?.('Pi 请求失败，正在重试…');
      }
    });

    const cancelListener = token.onCancellationRequested(() => {
      void session.abort().catch(() => undefined);
    });

    try {
      await session.prompt(prompt, { streamingBehavior: 'steer' }).catch(async (err: Error) => {
        // 未在流式时传 streamingBehavior 会报错，退回普通调用
        if (/streaming/i.test(err.message)) {
          await session.prompt(prompt);
          return;
        }
        throw err;
      });
      this.sdkTurn++;
      // agent_end/session state 是最终权威内容，覆盖可能包含重试片段的增量缓存。
      answer = this.collectFinalText(session) ?? answer;
      if (!answer.trim()) {
        throw new Error('Pi 返回内容为空');
      }
      // SDK 模式以最终权威消息一次性推送，避免自动重试时出现重复文本。
      handlers.onDelta(answer);
      return answer;
    } finally {
      cancelListener.dispose();
      unsubscribe();
    }
  }

  private async ensureSdkSession(sdk: PiSdk, settings: PiSettings): Promise<any> {
    if (this.sdkSession) {
      return this.sdkSession;
    }
    const cwd = settings.cwd;
    const providerId = providerIdFor(settings);
    const modelsPath = this.storagePath
      ? path.join(this.storagePath, 'pi-models.json')
      : undefined;
    if (modelsPath) {
      await fs.mkdir(path.dirname(modelsPath), { recursive: true });
      await fs.writeFile(modelsPath, JSON.stringify(piModelsConfig(settings), null, 2), 'utf8');
    }
    const modelRuntime = await sdk.ModelRuntime.create({
      modelsPath: modelsPath ?? null,
      refreshOnCreate: false
    });

    if (typeof modelRuntime.setRuntimeApiKey === 'function') {
      await modelRuntime.setRuntimeApiKey(providerId, settings.apiKey ?? 'ollama');
    }

    let model: any;
    if (typeof modelRuntime.getModel === 'function') {
      model = modelRuntime.getModel(providerId, settings.model);
    }
    if (!model) {
      const available: any[] = (await modelRuntime.getAvailable?.()) ?? [];
      model = available.find(
        (m: any) => m?.id === settings.model || m?.name === settings.model
      );
    }
    if (!model) {
      throw new Error(
        `Pi 无法识别模型 ${providerId}/${settings.model}。请在 Pi 中登录该供应商，或改用「直连模型接口」（native）。`
      );
    }

    const { session } = await sdk.createAgentSession({
      cwd,
      modelRuntime,
      model,
      tools: readOnlyTools(),
      sessionManager: sdk.SessionManager.inMemory(cwd)
    });

    this.sdkSession = session;
    this.output.appendLine(`[pi] SDK 会话已创建 model=${providerId}/${settings.model} cwd=${cwd}`);
    return session;
  }

  private collectFinalText(session: any): string | undefined {
    try {
      const messages = session?.agent?.state?.messages ?? session?.messages;
      if (!Array.isArray(messages)) {
        return undefined;
      }
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'assistant') {
          continue;
        }
        if (typeof m.content === 'string') {
          return m.content;
        }
        if (Array.isArray(m.content)) {
          const text = m.content
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text)
            .join('');
          if (text) {
            return text;
          }
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  // ---------------- RPC transport ----------------

  private async runRpc(
    request: AgentRequest,
    handlers: AgentStreamHandlers,
    token: vscode.CancellationToken,
    settings: PiSettings
  ): Promise<string> {
    if (!settings.rpcCommand) {
      throw new Error('未配置 Pi 可执行文件路径（ptnAgent.piCommand）');
    }
    this.ensureRpcChild(settings);

    const prompt = this.buildPrompt(request, this.rpcTurn === 0);
    const id = `p${Date.now()}${this.rpcSeq++}`;
    let answer = '';
    let settled!: (v?: void) => void;
    const settledPromise = new Promise<void>((resolve) => (settled = resolve));

    const onRecord = (record: any) => {
      if (record?.type === 'message_update') {
        const delta = record.assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          answer += delta.delta;
          handlers.onDelta(delta.delta);
        } else if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string') {
          handlers.onReasoning?.(delta.delta);
        }
      } else if (record?.type === 'tool_execution_start') {
        handlers.onStatus?.(`Pi 调用工具：${record.toolName ?? 'unknown'}`);
      } else if (record?.type === 'agent_settled') {
        settled();
      }
    };
    this.rpcRecordListeners.add(onRecord);

    const cancelListener = token.onCancellationRequested(() => {
      this.sendRpc({ type: 'abort' }).catch(() => undefined);
      settled();
    });

    try {
      const response = await this.sendRpc({ id, type: 'prompt', message: prompt }, 30_000);
      if (!response.success) {
        throw new Error(response.error ?? 'Pi 拒绝了该请求');
      }
      if (response.data?.disposition === 'handled') {
        settled();
      }
      await this.raceWithTimeout(settledPromise, settings.timeoutMs);
      this.rpcTurn++;
      if (!answer.trim()) {
        throw new Error('Pi 返回内容为空');
      }
      return answer;
    } finally {
      cancelListener.dispose();
      this.rpcRecordListeners.delete(onRecord);
    }
  }

  /** 与超时竞争，超时定时器在正常结束时清理，避免未处理拒绝 */
  private raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let handle: NodeJS.Timeout | undefined;
    const timer = new Promise<never>((_, reject) => {
      handle = setTimeout(
        () => reject(new Error(`Pi 运行超时（${Math.round(ms / 1000)}s）`)),
        ms
      );
    });
    return Promise.race([promise, timer]).finally(() => {
      if (handle) {
        clearTimeout(handle);
      }
    });
  }

  private rpcRecordListeners = new Set<(record: any) => void>();

  private ensureRpcChild(settings: PiSettings): void {
    if (this.child && !this.child.killed) {
      return;
    }
    // extraArgs 放在最前，便于把 rpcCommand 配成解释器（如 node <fake-pi.js> / bun <cli.ts>）
    const args = [
      ...settings.extraArgs,
      '--mode',
      'rpc',
      '--no-session',
      '--model',
      settings.model,
      '--tools',
      readOnlyTools().join(',')
    ];
    if (settings.provider === 'deepseek') {
      args.push('--provider', 'deepseek');
    }
    if (settings.apiKey) {
      args.push('--api-key', settings.apiKey);
    }

    const useShell = process.platform === 'win32';
    const child = spawn(settings.rpcCommand as string, useShell ? args.map(quoteArg) : args, {
      cwd: settings.cwd || undefined,
      shell: useShell,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleRpcChunk(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        this.output.appendLine(`[pi:stderr] ${text}`);
      }
    });

    child.on('error', (err) => {
      this.output.appendLine(`[pi] 启动失败：${err.message}`);
      this.failAllPending(`无法启动 Pi：${err.message}`);
    });

    child.on('exit', (code, signal) => {
      this.output.appendLine(`[pi] 进程退出 code=${code} signal=${signal}`);
      this.failAllPending(`Pi 进程已退出（code=${code}）`);
      this.child = undefined;
      this.rpcBuffer = '';
    });

    this.child = child;
    this.output.appendLine(`[pi] 已启动 ${settings.rpcCommand} ${args.join(' ')}`);
  }

  /**
   * 严格按 LF 切分（不按 U+2028/U+2029），与 Pi RPC 的 JSONL 约定一致。
   */
  private handleRpcChunk(chunk: string): void {
    this.rpcBuffer += chunk;
    let index = this.rpcBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.rpcBuffer.slice(0, index).replace(/\r$/, '');
      this.rpcBuffer = this.rpcBuffer.slice(index + 1);
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          if (record?.type === 'response' && record.id) {
            const pending = this.rpcPending.get(record.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.rpcPending.delete(record.id);
              pending.resolve(record);
            }
          }
          for (const listener of [...this.rpcRecordListeners]) {
            listener(record);
          }
        } catch (err) {
          this.output.appendLine(`[pi] 非 JSON 输出：${line.slice(0, 200)}`);
        }
      }
      index = this.rpcBuffer.indexOf('\n');
    }
  }

  /**
   * 发送 RPC 命令。
   * 失败一律以 `{success:false}` 响应返回，不用 reject —— 避免进程退出、
   * 超时等场景产生无人处理的 Promise 拒绝。
   */
  private sendRpc(command: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    const type = String(command.type ?? 'unknown');
    return new Promise((resolve) => {
      if (!this.child || this.child.killed) {
        resolve({ type: 'response', command: type, success: false, error: 'Pi 进程不可用' });
        return;
      }
      const id = (command.id as string) ?? `c${Date.now()}${this.rpcSeq++}`;
      const payload = { ...command, id };
      const timer = setTimeout(() => {
        this.rpcPending.delete(id);
        resolve({
          type: 'response',
          command: type,
          success: false,
          error: `Pi 命令超时：${type}`
        });
      }, timeoutMs);
      this.rpcPending.set(id, { resolve, timer, command: type });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private failAllPending(message: string): void {
    for (const [id, pending] of this.rpcPending) {
      clearTimeout(pending.timer);
      pending.resolve({
        type: 'response',
        command: pending.command,
        success: false,
        error: message
      });
      this.rpcPending.delete(id);
    }
  }

  // ---------------- shared ----------------

  private buildPrompt(request: AgentRequest, freshSession: boolean): string {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const current = lastUser?.content ?? '';
    if (!freshSession) {
      return current;
    }
    // 新会话：把此前的对话作为背景补一次，避免 Pi 丢失上下文
    const history = request.messages.filter((m) => m.role !== 'system');
    if (history.length <= 1) {
      return current;
    }
    const transcript = history
      .slice(0, -1)
      .map((m) => `${m.role === 'user' ? '学生' : '助手'}：${m.content}`)
      .join('\n\n');
    return `【此前对话】\n${transcript}\n\n【当前问题】\n${current}`;
  }

  async reset(): Promise<void> {
    if (this.sdkSession) {
      try {
        this.sdkUnsub?.();
        this.sdkSession.dispose?.();
      } catch {
        // 忽略销毁异常
      }
      this.sdkSession = undefined;
      this.sdkUnsub = undefined;
    }
    this.sdkTurn = 0;

    if (this.child) {
      try {
        await this.sendRpc({ type: 'new_session' }, 5000).catch(() => undefined);
      } finally {
        this.rpcTurn = 0;
      }
    }
  }

  dispose(): void {
    try {
      this.sdkUnsub?.();
      this.sdkSession?.dispose?.();
    } catch {
      // 忽略
    }
    this.sdkSession = undefined;

    if (this.child) {
      const child = this.child;
      this.child = undefined;
      try {
        child.stdin.end();
      } catch {
        // 忽略
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
      }, 1500).unref?.();
    }
    this.failAllPending('适配器已释放');
  }
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export function resolvePiCommand(configured: string, extensionPath: string): string {
  if (configured && configured.trim()) {
    return configured.trim();
  }
  // 允许直接指向随扩展分发的 CLI（若存在）
  return path.join(extensionPath, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');
}
