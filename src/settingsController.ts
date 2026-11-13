import * as vscode from 'vscode';
import {
  ApprovalMode,
  CONFIG_SECTION,
  isModelConfigured,
  isValidBaseUrl,
  normalizeBaseUrl,
  readConfig
} from './config';
import { SecretStore } from './secrets';
import { fetchModels, testConnection } from './modelCheck';

/** 按 API 地址分别缓存，避免学生在设置页试填别的地址时冲掉当前地址的模型列表 */
type ModelCache = Record<string, { models: string[]; at: number }>;

const CACHE_KEY = 'ptnAgent.modelCache.v2';
const MAX_CACHED_URLS = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MODES: ApprovalMode[] = ['ask', 'autoEdit', 'readOnly'];

interface SettingsValues {
  baseUrl?: string;
  model?: string;
  approvalMode?: string;
  allowedCommands?: string;
  contextWindow?: number | string;
  maxOutputTokens?: number | string;
  autoContext?: boolean;
  systemPromptExtra?: string;
}

/**
 * 设置页后端：一个页面搜集全部设置，一次保存。
 * 模型列表来自学生所填 API 地址的 `/models` 接口，不使用任何预设供应商。
 * 已保存的 API Key 不会发送给前端，前端只知道「是否已保存」。
 */
export class SettingsController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: SecretStore,
    private readonly output: vscode.OutputChannel,
    private readonly post: (message: unknown) => void,
    private readonly onChanged: () => Promise<void>
  ) {}

  /** 当前接口地址对应的已缓存模型列表（不论是否过期） */
  cachedModels(): string[] {
    const cache = this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {};
    return cache[readConfig().baseUrl]?.models ?? [];
  }

  private storeModels(baseUrl: string, models: string[]): void {
    const cache: ModelCache = { ...(this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {}) };
    cache[baseUrl] = { models, at: Date.now() };
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const old of keys.slice(MAX_CACHED_URLS)) {
      delete cache[old];
    }
    void this.context.globalState.update(CACHE_KEY, cache);
  }

  /** 后台刷新：已配置接口且缓存缺失/过期时拉取一次，失败时静默（不打扰学生） */
  async refreshModelsIfNeeded(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.baseUrl) {
      return;
    }
    const entry = (this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {})[cfg.baseUrl];
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
      return;
    }
    const result = await fetchModels(cfg.baseUrl, await this.secrets.getApiKey());
    if (result.ok) {
      this.storeModels(cfg.baseUrl, result.models);
      this.post({ type: 'models', ok: true, baseUrl: cfg.baseUrl, models: result.models, silent: true });
    } else {
      this.output.appendLine(`[models] ${result.message}`);
    }
  }

  async handle(msg: any): Promise<boolean> {
    switch (msg?.type) {
      case 'settingsOpen':
        await this.sendSettings();
        void this.refreshModelsIfNeeded();
        return true;
      case 'settingsSave':
        await this.save(msg.values ?? {}, msg.apiKey, !!msg.clearKey);
        return true;
      case 'fetchModels':
        await this.fetch(String(msg.baseUrl ?? ''), msg.apiKey);
        return true;
      case 'testConnection':
        await this.test(String(msg.baseUrl ?? ''), String(msg.model ?? ''), msg.apiKey);
        return true;
      case 'setModel':
        await this.update('model', String(msg.model ?? '').trim());
        await this.onChanged();
        return true;
      case 'setMode':
        if (MODES.includes(msg.mode)) {
          await this.update('approvalMode', msg.mode);
          await this.onChanged();
        }
        return true;
      default:
        return false;
    }
  }

  private update(key: string, value: unknown): Thenable<void> {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  async sendSettings(): Promise<void> {
    const cfg = readConfig();
    this.post({
      type: 'settingsData',
      values: {
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        approvalMode: cfg.approvalMode,
        allowedCommands: cfg.allowedCommands.join('\n'),
        contextWindow: cfg.contextWindow,
        maxOutputTokens: cfg.maxOutputTokens,
        autoContext: cfg.autoContext,
        systemPromptExtra: cfg.systemPromptExtra
      },
      hasKey: await this.secrets.hasApiKey(),
      configured: isModelConfigured(cfg),
      models: this.cachedModels()
    });
  }

  private fail(field: string, message: string): void {
    this.post({ type: 'settingsError', field, message });
  }

  private async save(values: SettingsValues, apiKey: unknown, clearKey: boolean): Promise<void> {
    const baseUrl = normalizeBaseUrl(String(values.baseUrl ?? ''));
    const model = String(values.model ?? '').trim();
    if (baseUrl && !isValidBaseUrl(baseUrl)) {
      this.fail('baseUrl', 'API 地址需要以 http:// 或 https:// 开头。');
      return;
    }
    if (baseUrl && !model) {
      this.fail('model', '请填写或选择一个模型。');
      return;
    }
    const contextWindow = Number(values.contextWindow);
    if (!Number.isFinite(contextWindow) || contextWindow < 2048 || contextWindow > 4_000_000) {
      this.fail('contextWindow', '上下文窗口需要在 2048 到 4000000 之间。');
      return;
    }
    const maxOutputTokens = Number(values.maxOutputTokens);
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 1_000_000) {
      this.fail('maxOutputTokens', '最大输出需要在 256 到 1000000 之间。');
      return;
    }
    const mode = MODES.includes(values.approvalMode as ApprovalMode)
      ? (values.approvalMode as ApprovalMode)
      : 'ask';
    const allowedCommands = String(values.allowedCommands ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    await this.update('baseUrl', baseUrl);
    await this.update('model', model);
    await this.update('approvalMode', mode);
    await this.update('allowedCommands', allowedCommands);
    await this.update('contextWindow', Math.round(contextWindow));
    await this.update('maxOutputTokens', Math.round(maxOutputTokens));
    await this.update('autoContext', values.autoContext !== false);
    await this.update('systemPromptExtra', String(values.systemPromptExtra ?? ''));

    const typedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (clearKey) {
      await this.secrets.setApiKey('');
    } else if (typedKey) {
      await this.secrets.setApiKey(typedKey);
    }

    this.post({ type: 'settingsSaved', configured: baseUrl.length > 0 && model.length > 0 });
    await this.onChanged();
    void this.refreshModelsIfNeeded();
  }

  /** 用表单里当前填写的地址/Key 拉取（尚未保存也可以）；Key 留空则使用已保存的 */
  private async fetch(baseUrlRaw: string, apiKey: unknown): Promise<void> {
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    if (!baseUrl || !isValidBaseUrl(baseUrl)) {
      this.post({ type: 'models', ok: false, baseUrl, models: [], message: '请先填写正确的 API 地址（以 http:// 或 https:// 开头）。' });
      return;
    }
    const key = (typeof apiKey === 'string' && apiKey.trim()) || (await this.secrets.getApiKey());
    const result = await fetchModels(baseUrl, key || undefined);
    if (result.ok) {
      this.storeModels(baseUrl, result.models);
    }
    this.post({ type: 'models', ok: result.ok, baseUrl, models: result.models, message: result.message });
  }

  private async test(baseUrlRaw: string, model: string, apiKey: unknown): Promise<void> {
    const baseUrl = normalizeBaseUrl(baseUrlRaw);
    const key = (typeof apiKey === 'string' && apiKey.trim()) || (await this.secrets.getApiKey());
    const result = await testConnection(baseUrl, model.trim(), key || undefined);
    this.post({ type: 'testResult', ok: result.ok, message: result.message });
  }
}
