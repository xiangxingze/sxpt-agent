import * as vscode from 'vscode';
import { AgentMessage } from './types';
import { randomUUID } from 'crypto';

const STORAGE_KEY = 'ptnAgent.session.v1';
const MAX_TURNS = 20;
const MAX_CHARS = 60000;
const HISTORY_KEY = 'ptnAgent.sessions.v2';
const MAX_SESSIONS = 20;

export interface SessionSnapshot {
  messages: AgentMessage[];
  startedAt: number;
}

interface StoredSession extends SessionSnapshot {
  id: string;
  title: string;
  updatedAt: number;
  draft: string;
}

/**
 * 会话存储：保留多轮上下文，做字符预算裁剪，并持久化到 workspaceState。
 * 持久化只保存对话文本，不保存 API Key、不保存完整文件内容。
 */
export class SessionStore {
  private messages: AgentMessage[] = [];
  private startedAt = Date.now();
  private id: string = randomUUID();
  private title = '';
  private updatedAt = Date.now();
  private draft = '';
  private sessions: StoredSession[] = [];

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

  get currentId(): string {
    return this.id;
  }

  get currentDraft(): string {
    return this.draft;
  }

  get history(): Array<Omit<StoredSession, 'messages' | 'draft'>> {
    return this.sessions
      .filter((session) => session.messages.length > 0 || session.draft.trim())
      .map(({ messages, draft, ...summary }) => summary)
      .sort((first, second) => second.updatedAt - first.updatedAt);
  }

  saveDraft(draft: string): void {
    this.draft = draft.slice(0, MAX_CHARS);
    this.persist();
  }

  addUser(content: string): void {
    if (!this.title) this.title = content.replace(/\s+/g, ' ').slice(0, 60);
    this.updatedAt = Date.now();
    this.messages.push({ role: 'user', content });
    this.trim();
    this.persist();
  }

  addAssistant(content: string): void {
    this.updatedAt = Date.now();
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
    this.persist();
    this.messages = [];
    this.startedAt = Date.now();
    this.updatedAt = this.startedAt;
    this.id = randomUUID();
    this.title = '';
    this.draft = '';
    this.persist();
  }

  select(id: string): boolean {
    if (id === this.id) return true;
    const target = this.sessions.find((session) => session.id === id);
    if (!target) return false;
    this.persist();
    this.id = target.id;
    this.title = target.messages.length ? target.title : '';
    this.startedAt = target.startedAt;
    this.updatedAt = target.updatedAt;
    this.messages = target.messages;
    this.draft = target.draft;
    this.persist();
    return true;
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
    const current: StoredSession = {
      id: this.id, title: this.title || '新会话', messages: this.messages,
      startedAt: this.startedAt, updatedAt: this.updatedAt, draft: this.draft
    };
    this.sessions = [current, ...this.sessions.filter((session) => session.id !== this.id && (session.messages.length || session.draft.trim()))]
      .slice(0, MAX_SESSIONS);
    void this.context.workspaceState.update(HISTORY_KEY, { activeId: this.id, sessions: this.sessions });
    void this.context.workspaceState.update(STORAGE_KEY, {
      messages: this.messages,
      startedAt: this.startedAt
    } as SessionSnapshot);
  }

  private restore(): void {
    const history = this.context.workspaceState.get<{ activeId: string; sessions: StoredSession[] }>(HISTORY_KEY);
    if (Array.isArray(history?.sessions)) {
      this.sessions = history.sessions.filter((session) => session && typeof session.id === 'string' && Array.isArray(session.messages))
        .slice(0, MAX_SESSIONS).map((session) => ({
          ...session,
          title: typeof session.title === 'string' ? session.title : '新会话',
          draft: typeof session.draft === 'string' ? session.draft.slice(0, MAX_CHARS) : '',
          startedAt: typeof session.startedAt === 'number' ? session.startedAt : Date.now(),
          updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
          messages: session.messages.filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
        }));
      const active = this.sessions.find((session) => session.id === history.activeId);
      if (active) {
        this.id = active.id;
        this.title = active.messages.length ? active.title : '';
        this.draft = active.draft;
        this.messages = active.messages;
        this.startedAt = active.startedAt;
        this.updatedAt = active.updatedAt;
        this.trim();
        return;
      }
    }
    const saved = this.context.workspaceState.get<SessionSnapshot>(STORAGE_KEY);
    if (!saved || !Array.isArray(saved.messages)) {
      return;
    }
    this.messages = saved.messages.filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    );
    this.startedAt = typeof saved.startedAt === 'number' ? saved.startedAt : Date.now();
    this.title = this.messages.find((message) => message.role === 'user')?.content.replace(/\s+/g, ' ').slice(0, 60) || '';
    this.updatedAt = this.startedAt;
    this.trim();
    this.persist();
  }
}
