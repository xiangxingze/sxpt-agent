import type { ApprovalMode, ProviderKind } from '../config';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ApprovalKind = 'edit' | 'write' | 'bash';
export type ApprovalDecision = 'allow' | 'deny' | 'allowAllEdits';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  /** 卡片标题，例如「修改 src/a.ts」 */
  title: string;
  absPath?: string;
  relPath?: string;
  command?: string;
  cwd?: string;
  isNewFile?: boolean;
  added?: number;
  removed?: number;
  /** edit / write 的 Diff 预览内容 */
  original?: string;
  proposed?: string;
}

export interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Agent 核心需要宿主（VS Code 层）提供的能力。
 * 把它抽象出来，使 Agent 核心不依赖 vscode，可以在 Node 中端到端自测。
 */
export interface AgentHost {
  /** 请求学生审批；signal 触发（停止/新会话）时应当立即以 deny 结束。 */
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** 文件被修改前调用，用于保存撤销快照 */
  beforeWrite(absPath: string): Promise<void>;
  /** 文件在编辑器中是否有未保存修改 */
  isDirty(absPath: string): boolean;
  /** 读取 VS Code 问题面板；path 为空表示整个工作区 */
  getDiagnostics(path: string | undefined): Promise<string>;
  /** Agent 更新任务计划 */
  onPlan(steps: PlanStep[]): void;
}

export interface AgentSettings {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 工作区根目录（工具默认工作目录） */
  cwd: string;
  /** 允许访问的所有工作区根目录 */
  roots: string[];
  approvalMode: ApprovalMode;
  allowedCommands: string[];
  commandTimeoutMs: number;
  runTimeoutMs: number;
  contextWindow: number;
  maxOutputTokens: number;
  /** 课程规范等追加到系统提示词的内容 */
  systemPromptExtra: string;
}

export interface ToolStartInfo {
  id: string;
  name: string;
  label: string;
}

export interface ToolEndInfo {
  id: string;
  name: string;
  ok: boolean;
  /** 一行摘要，例如「+3 −1」「退出码 0」或失败原因 */
  summary: string;
  /** 工具输出（已截断），用于折叠展示 */
  output?: string;
}

export interface AgentEvents {
  onTextDelta(text: string): void;
  /** 模型请求失败并自动重试时，丢弃当前这一段未完成的文本 */
  onTextReset(): void;
  onToolStart(info: ToolStartInfo): void;
  onToolEnd(info: ToolEndInfo): void;
  onStatus(text: string): void;
}

export interface AgentRunRequest {
  /** 本轮用户输入（已附带 IDE 上下文） */
  prompt: string;
  /** 此前的对话文本，仅在需要新建底层会话时用于补全上下文 */
  history: AgentMessage[];
  settings: AgentSettings;
  signal: AbortSignal;
}

export interface AgentResult {
  text: string;
  model: string;
  elapsedMs: number;
  toolCalls: number;
  aborted: boolean;
}
