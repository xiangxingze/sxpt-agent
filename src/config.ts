import * as vscode from 'vscode';

export type ProviderKind = 'deepseek' | 'openai-compatible' | 'ollama';
export type AgentBackend = 'native' | 'pi';
export type PiTransport = 'sdk' | 'rpc';

export interface AgentConfig {
  provider: ProviderKind;
  agentBackend: AgentBackend;
  baseUrl: string;
  model: string;
  temperature: number;
  maxContextLines: number;
  autoContext: boolean;
  requireDiffApproval: boolean;
  platformUrl: string;
  systemPromptExtra: string;
  includeProjectContext: boolean;
  allowedCommands: string[];
  commandTimeoutMs: number;
}

export interface PiSettings {
  provider: ProviderKind;
  baseUrl: string;
  transport: PiTransport;
  model: string;
  apiKey?: string;
  cwd: string;
  rpcCommand: string;
  extraArgs: string[];
  timeoutMs: number;
}

const PROVIDER_DEFAULTS: Record<ProviderKind, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  'openai-compatible': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' }
};

export function readConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('ptnAgent');
  const provider = (cfg.get<ProviderKind>('provider') ?? 'deepseek') as ProviderKind;
  const defaults = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    agentBackend: (cfg.get<AgentBackend>('agentBackend') ?? 'native') as AgentBackend,
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl') || defaults.baseUrl),
    model: cfg.get<string>('model') || defaults.model,
    temperature: cfg.get<number>('temperature') ?? 0.2,
    maxContextLines: cfg.get<number>('maxContextLines') ?? 400,
    autoContext: cfg.get<boolean>('autoContext') ?? true,
    requireDiffApproval: cfg.get<boolean>('requireDiffApproval') ?? true,
    platformUrl: (cfg.get<string>('platformUrl') || '').trim(),
    systemPromptExtra: cfg.get<string>('systemPromptExtra') || '',
    includeProjectContext: cfg.get<boolean>('includeProjectContext') ?? true,
    allowedCommands: (cfg.get<string[]>('allowedCommands') || []).filter((c) => c.trim().length > 0),
    commandTimeoutMs: cfg.get<number>('commandTimeoutMs') ?? 120_000
  };
}

export function providerDefaults(provider: ProviderKind) {
  return PROVIDER_DEFAULTS[provider];
}

export function readPiSettings(cwd: string): PiSettings {
  const cfg = vscode.workspace.getConfiguration('ptnAgent');
  const provider = (cfg.get<ProviderKind>('provider') ?? 'deepseek') as ProviderKind;
  return {
    provider,
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl') || PROVIDER_DEFAULTS[provider].baseUrl),
    transport: (cfg.get<PiTransport>('piTransport') ?? 'sdk') as PiTransport,
    model: cfg.get<string>('model') || PROVIDER_DEFAULTS[provider].model,
    cwd,
    rpcCommand: (cfg.get<string>('piCommand') || 'pi').trim(),
    extraArgs: (cfg.get<string[]>('piExtraArgs') || []).filter((a) => typeof a === 'string'),
    timeoutMs: cfg.get<number>('piTimeoutMs') ?? 180_000
  };
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export const CONFIG_SECTION = 'ptnAgent';
