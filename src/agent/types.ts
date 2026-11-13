import * as vscode from 'vscode';
import { AgentConfig } from '../config';

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AgentRequest {
  messages: AgentMessage[];
  config: AgentConfig;
  apiKey?: string;
}

export interface AgentStreamHandlers {
  onDelta(text: string): void;
  onReasoning?(text: string): void;
  /** 工具调用、重试等过程性状态，用于在 UI 上提示，不进入正文 */
  onStatus?(text: string): void;
}

export interface AgentResult {
  text: string;
  model: string;
  elapsedMs: number;
}

/**
 * Agent 基座统一接口。
 * 当前实现：NativeAdapter（直连 OpenAI 兼容接口）。
 * 预留实现：PiAdapter / OpenCodeAdapter，仅需实现本接口即可替换，不影响 UI 与平台层。
 */
export interface AgentAdapter {
  readonly id: string;
  readonly label: string;
  run(
    request: AgentRequest,
    handlers: AgentStreamHandlers,
    token: vscode.CancellationToken
  ): Promise<AgentResult>;
  /** 可选：重置底层会话（用于「新建会话」） */
  reset?(): Promise<void>;
  dispose(): void;
}
