import * as vscode from 'vscode';

export interface CourseContext {
  courseId?: string;
  courseTitle?: string;
  projectName?: string;
  stage?: string;
  goals?: string[];
  guidelines?: string[];
  knowledge?: string[];
  allowedCommands?: string[];
  fetchedAt: number;
  fromCache: boolean;
}

interface RawContext {
  courseId?: string;
  courseTitle?: string;
  projectName?: string;
  stage?: string;
  goals?: string[];
  guidelines?: string[];
  knowledge?: string[];
  allowedCommands?: string[];
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 实训平台上下文客户端。
 * 契约（可由平台侧调整，扩展侧做宽松解析）：
 *   GET {platformUrl}/api/agent/context?workspace=<name>
 *   Header: Authorization: Bearer <platformToken>（可选）
 *   200 -> { course?: {...}, project?: {...}, goals?: [], guidelines?: [], knowledge?: [], allowedCommands?: [] }
 */
export class PlatformClient {
  private cache?: CourseContext;
  private lastError?: string;

  constructor(
    /** 平台访问令牌由平台对接方注入；学生侧没有配置入口 */
    private readonly getToken: () => Promise<string | undefined>,
    private readonly output: vscode.OutputChannel
  ) {}

  get lastErrorMessage(): string | undefined {
    return this.lastError;
  }

  async getContext(platformUrl: string, force = false): Promise<CourseContext | undefined> {
    if (!platformUrl) {
      return undefined;
    }
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return { ...this.cache, fromCache: true };
    }

    const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? '';
    const url = `${platformUrl.replace(/\/+$/, '')}/api/agent/context?workspace=${encodeURIComponent(
      workspaceName
    )}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const token = await this.getToken();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        this.lastError = `平台接口返回 ${response.status}`;
        this.output.appendLine(`[platform] ${this.lastError} ${url}`);
        return this.cache ? { ...this.cache, fromCache: true } : undefined;
      }
      const json: any = await response.json();
      const raw: RawContext = json?.context ?? json?.data ?? json ?? {};
      const ctx: CourseContext = {
        courseId: raw.courseId ?? json?.course?.id,
        courseTitle: raw.courseTitle ?? json?.course?.title,
        projectName: raw.projectName ?? json?.project?.name,
        stage: raw.stage ?? json?.project?.stage,
        goals: pickStrings(raw.goals ?? json?.goals),
        guidelines: pickStrings(raw.guidelines ?? json?.guidelines),
        knowledge: pickStrings(raw.knowledge ?? json?.knowledge),
        allowedCommands: pickStrings(raw.allowedCommands ?? json?.allowedCommands),
        fetchedAt: Date.now(),
        fromCache: false
      };
      this.cache = ctx;
      this.lastError = undefined;
      return ctx;
    } catch (err) {
      this.lastError = (err as Error).name === 'AbortError' ? '平台接口超时' : (err as Error).message;
      this.output.appendLine(`[platform] 拉取失败：${this.lastError}，使用本地降级`);
      return this.cache ? { ...this.cache, fromCache: true } : undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  clear(): void {
    this.cache = undefined;
  }
}

function pickStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return items.length > 0 ? items.slice(0, 30) : undefined;
}

export function courseContextToPrompt(ctx: CourseContext | undefined): string {
  if (!ctx) {
    return '';
  }
  const parts: string[] = [];
  const header = [ctx.courseTitle, ctx.projectName].filter(Boolean).join(' · ');
  if (header) {
    parts.push(`课程/项目：${header}`);
  }
  if (ctx.stage) {
    parts.push(`当前阶段：${ctx.stage}`);
  }
  if (ctx.goals?.length) {
    parts.push(['学习目标：', ...ctx.goals.map((g) => `- ${g}`)].join('\n'));
  }
  if (ctx.guidelines?.length) {
    parts.push(['课程规范：', ...ctx.guidelines.map((g) => `- ${g}`)].join('\n'));
  }
  if (ctx.knowledge?.length) {
    parts.push(['课程资料摘要：', ...ctx.knowledge.map((k) => `- ${k}`)].join('\n'));
  }
  if (parts.length === 0) {
    return '';
  }
  return `【实训平台上下文】\n${parts.join('\n\n')}`;
}
