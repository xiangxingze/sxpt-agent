import * as vscode from 'vscode';
import type { ChatController, ChatSurface } from '../chatController';

/**
 * 使用 VS Code 自带的 Chat 容器承载 Agent。
 *
 * 这里不创建 HTML、Webview 或 Terminal。消息区、底部输入框、滚动和会话
 * 工具栏都由宿主提供，扩展只把 Agent 的流式事件转换成原生 Chat 内容。
 */
export class NativeChatSurface implements ChatSurface {
  readonly canApprove = true;

  private response?: vscode.ChatResponseStream;
  private streamed = false;
  private configured = false;
  private baseUrl = '';
  private model = '';
  private mode = '';

  onHistory?: () => void;
  onSettings?: () => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  register(
    context: vscode.ExtensionContext,
    controller: ChatController
  ): boolean {
    const chatApi = (vscode as typeof vscode & {
      chat?: typeof vscode.chat;
    }).chat;
    if (!chatApi || typeof chatApi.createChatParticipant !== 'function') {
      return false;
    }

    const participant = chatApi.createChatParticipant(
      'sxpt-agent.ptnAgent',
      (request, chatContext, response, token) =>
        controller.handleChatRequest(request.prompt, request.command, chatContext, response, token)
    );
    participant.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'agent.svg');
    context.subscriptions.push(participant);
    return true;
  }

  beginResponse(response: vscode.ChatResponseStream): void {
    this.response = response;
    this.streamed = false;
  }

  endResponse(): void {
    this.response = undefined;
    this.streamed = false;
  }

  post(message: unknown): void {
    if (!message || typeof message !== 'object') return;

    const msg = message as Record<string, any>;
    if (msg.type === 'state') {
      this.configured = !!msg.configured;
      this.baseUrl = String(msg.baseUrl ?? '');
      this.model = String(msg.model ?? '');
      this.mode = String(msg.mode ?? '');
    }

    const response = this.response;
    if (!response) return;

    switch (msg.type) {
      case 'welcome':
        response.markdown(
          '### AI Agent\n\n描述你想完成的目标，我会阅读代码、制定计划、执行修改并验证结果。\n\n'
        );
        response.button({ command: 'ptnAgent.newSession', title: '新建会话' });
        response.button({ command: 'ptnAgent.history', title: '历史记录' });
        response.button({ command: 'ptnAgent.settings', title: '设置' });
        break;
      case 'textDelta': {
        const text = String(msg.text ?? '');
        if (text) {
          response.markdown(text);
          this.streamed = true;
        }
        break;
      }
      case 'assistantStart':
        response.progress('正在分析并执行任务…');
        break;
      case 'toolStart':
        response.progress(`正在${String(msg.label ?? msg.name ?? '执行操作')}…`);
        break;
      case 'toolEnd':
        if (msg.ok === false) response.markdown(`\n\n> 操作未完成：${String(msg.summary ?? '')}\n\n`);
        break;
      case 'info':
        response.progress(String(msg.message ?? ''));
        break;
      case 'plan':
        response.progress('已生成任务计划，正在按步骤执行…');
        break;
      case 'approval': {
        const request = msg.request ?? {};
        const id = String(request.id ?? '');
        const detail = request.kind === 'bash'
          ? `命令：\`${String(request.command ?? '')}\``
          : `${String(request.title ?? '')}（新增 ${request.added ?? 0} 行，删除 ${request.removed ?? 0} 行）`;
        response.markdown(`\n\n### 等待确认\n\n${detail}\n\n`);
        if (id) {
          response.button({ command: 'ptnAgent.approval.allow', title: '允许', arguments: [id] });
          response.button({ command: 'ptnAgent.approval.deny', title: '拒绝', arguments: [id] });
          if (request.canDiff) {
            response.button({ command: 'ptnAgent.approval.diff', title: '查看修改', arguments: [id] });
          }
        }
        break;
      }
      case 'changes': {
        const files = Array.isArray(msg.files) ? msg.files : [];
        if (files.length) response.markdown(`\n\n已修改：${files.map((file) => `\`${file}\``).join('、')}\n\n`);
        break;
      }
      case 'notice':
        response.markdown(`\n\n> ${String(msg.text ?? '')}\n\n`);
        break;
      case 'error':
        response.markdown(`\n\n**Agent 执行失败**\n\n${String(msg.message ?? '')}\n\n`);
        break;
      case 'assistantEnd':
        if (!this.streamed && typeof msg.text === 'string' && msg.text.trim()) response.markdown(msg.text);
        break;
      case 'history': {
        const messages = Array.isArray(msg.messages) ? msg.messages : [];
        if (!messages.length) {
          response.markdown('\n\n当前会话还没有消息。\n\n');
          break;
        }
        const transcript = messages
          .map((item: any) => `**${item.role === 'user' ? '你' : 'AI Agent'}**\n\n${String(item.content ?? '')}`)
          .join('\n\n---\n\n');
        response.markdown(`\n\n### 已切换到历史会话\n\n${transcript}\n\n`);
        break;
      }
      case 'settings':
        response.markdown(
          `\n\n### Agent 设置\n\n状态：${this.configured ? '已配置' : '未配置'}\n\nAPI 地址：${this.baseUrl || '未填写'}\n\n模型：${this.model || '未选择'}\n\n审批模式：${this.mode || 'ask'}\n\n`
        );
        response.button({ command: 'ptnAgent.editBaseUrl', title: 'API 地址' });
        response.button({ command: 'ptnAgent.editApiKey', title: 'API Key' });
        response.button({ command: 'ptnAgent.pickModel', title: '模型' });
        response.button({ command: 'ptnAgent.pickMode', title: '审批模式' });
        response.button({ command: 'ptnAgent.testConnection', title: '测试连接' });
        break;
      default:
        break;
    }
  }

  async reveal(): Promise<void> {
    // 当前正在处理 Chat 请求时，重新 reveal 会打断宿主的输入焦点。
    if (this.response) return;
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: '@ptn-agent ',
        isPartialQuery: true
      });
    } catch {
      // 旧版宿主可能没有带参数的 Chat 命令，至少尝试打开原生 Chat 容器。
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open');
      } catch {
        // 没有原生 Chat 命令时由外层兼容入口继续使用 TreeView。
      }
    }
  }

  showHistory(): void {
    if (this.response) {
      this.onHistory?.();
      return;
    }
    void this.openChatCommand('history').catch(() => this.onHistory?.());
  }

  showSettings(): void {
    this.onSettings?.();
  }

  showSettingsContent(): void {
    this.post({ type: 'settings' });
  }

  async newSessionView(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.newChat');
    } catch {
      // 旧版宿主没有原生新会话命令时，控制器的会话仍然已经重置。
    }
  }

  private async openChatCommand(command: 'history'): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: `@ptn-agent /${command}`,
      isPartialQuery: false
    });
  }

  docColumn(): vscode.ViewColumn {
    return vscode.ViewColumn.Beside;
  }

  draft(): string | undefined {
    return undefined;
  }
}
