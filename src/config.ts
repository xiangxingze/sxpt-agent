import * as vscode from 'vscode';

/**
 * 审批模式：
 * - ask：每次修改文件、执行命令都需要学生确认（默认）
 * - autoEdit：工作区内的文件修改自动应用（可一键撤销），命令仍需确认
 * - readOnly：只读，Agent 只能查看代码和诊断，不能修改文件或执行命令
 */
export type ApprovalMode = 'ask' | 'autoEdit' | 'readOnly';

export interface AgentConfig {
  /** OpenAI 兼容接口地址，含版本路径，例如 https://api.example.com/v1 */
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

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: '逐项确认',
  autoEdit: '自动应用修改',
  readOnly: '只读'
};

export const APPROVAL_MODE_HINTS: Record<ApprovalMode, string> = {
  ask: '每次修改文件、运行命令都先让你确认（推荐）',
  autoEdit: '工作区内的文件修改直接应用，可一键撤销；运行命令仍需确认',
  readOnly: 'Agent 只能查看代码和诊断，不能修改文件或运行命令'
};

export function readConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('ptnAgent');
  const mode = cfg.get<ApprovalMode>('approvalMode');
  return {
    baseUrl: normalizeBaseUrl(cfg.get<string>('baseUrl') || ''),
    model: (cfg.get<string>('model') || '').trim(),
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

/** 模型服务是否已配置：地址和模型名都有才能调用（API Key 可选，本地模型不需要） */
export function isModelConfigured(cfg: Pick<AgentConfig, 'baseUrl' | 'model'>): boolean {
  return cfg.baseUrl.length > 0 && cfg.model.length > 0;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isValidBaseUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+/i.test(url.trim());
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export const CONFIG_SECTION = 'ptnAgent';
