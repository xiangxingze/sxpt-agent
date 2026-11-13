import * as vscode from 'vscode';
import { AgentMessage } from './types';

const STORAGE_KEY = 'ptnAgent.session.v1';
const MAX_TURNS = 20;
const MAX_CHARS = 60000;

export interface SessionSnapshot {
  messages: AgentMessage[];
  startedAt: number;
}

/**
 * 会话存储：保留多轮上下文，做字符预算裁剪，并持久化到 workspaceState。
 * 持久化只保存对话文本，不保存 API Key、不保存完整文件内容。
 */
export class SessionStore {
  private messages: AgentMessage[] = [];
  private startedAt = Date.now();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.restore();
  }

  get all(): AgentMessage[] {
    return this.messages;
  }

  get count(): number {
    return this.messages.filter((m) => m.role !== 'system').length;
  }

  get sessionStartedAt(): number {
    return this.startedAt;
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
    this.trim();
    this.persist();
  }

  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.trim();
    this.persist();
  }

  popLastIf(role: AgentMessage['role']): void {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role) {
      this.messages.pop();
      this.persist();
    }
  }

  reset(): void {
    this.messages = [];
    this.startedAt = Date.now();
    this.persist();
  }

  /** 估算字符数，用于上下文预算 */
  totalChars(): number {
    return this.messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  private trim(): void {
    while (this.messages.length > MAX_TURNS * 2) {
      this.messages.shift();
    }
    while (this.totalChars() > MAX_CHARS && this.messages.length > 2) {
      this.messages.shift();
    }
  }

  private persist(): void {
    void this.context.workspaceState.update(STORAGE_KEY, {
      messages: this.messages,
      startedAt: this.startedAt
    } as SessionSnapshot);
  }

  private restore(): void {
    const saved = this.context.workspaceState.get<SessionSnapshot>(STORAGE_KEY);
    if (!saved || !Array.isArray(saved.messages)) {
      return;
    }
    this.messages = saved.messages.filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );
    this.startedAt = typeof saved.startedAt === 'number' ? saved.startedAt : Date.now();
  }
}
