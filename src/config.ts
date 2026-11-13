import * as vscode from 'vscode';

export type ProviderKind = 'deepseek' | 'openai-compatible' | 'ollama';

/**
 * 审批模式：
 * - ask：每次修改文件、执行命令都需要学生确认（默认）
 * - autoEdit：工作区内的文件修改自动应用（可一键撤销），命令仍需确认
 * - readOnly：只读，Agent 只能查看代码和诊断，不能修改文件或执行命令
 */
export type ApprovalMode = 'ask' | 'autoEdit' | 'readOnly';

export interface AgentConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  maxContextLines: number;
  autoContext: boolean;
  approvalMode: ApprovalMode;
  platformUrl: string;
  systemPromptExtra: string;
  includeProjectContext: boolean;
  allowedCommands: string[];
  commandTimeoutMs: number;
  runTimeoutMs: number;
}

const PROVIDER_DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' }
};

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: '逐项确认',
  autoEdit: '自动应用修改',
  readOnly: '只读'
};

export function readConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('ptnAgent');
  const provider = (cfg.get<ProviderKind>('provider') ?? 'deepseek') as ProviderKind;
  const defaults = PROVIDER_DEFAULTS[provider];
  const mode = cfg.get<ApprovalMode>('approvalMode');
  return {
    provider,
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl') || defaults.baseUrl),
    model: cfg.get<string>('model') || defaults.model,
    contextWindow: positive(cfg.get<number>('contextWindow'), 128_000),
    maxOutputTokens: positive(cfg.get<number>('maxOutputTokens'), 8192),
    maxContextLines: cfg.get<number>('maxContextLines') ?? 400,
    autoContext: cfg.get<boolean>('autoContext') ?? true,
    approvalMode: mode === 'autoEdit' || mode === 'readOnly' ? mode : 'ask',
    platformUrl: (cfg.get<string>('platformUrl') || '').trim(),
    systemPromptExtra: cfg.get<string>('systemPromptExtra') || '',
    includeProjectContext: cfg.get<boolean>('includeProjectContext') ?? true,
    allowedCommands: (cfg.get<string[]>('allowedCommands') || []).filter((c) => c.trim().length > 0),
    commandTimeoutMs: positive(cfg.get<number>('commandTimeoutMs'), 120_000),
    runTimeoutMs: positive(cfg.get<number>('runTimeoutMs'), 600_000)
  };
}

export function providerDefaults(provider: ProviderKind) {
  return PROVIDER_DEFAULTS[provider];
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export const CONFIG_SECTION = 'ptnAgent';
