import * as vscode from 'vscode';
import { streamChat, ProviderError } from '../provider';
import { AgentAdapter, AgentRequest, AgentResult, AgentStreamHandlers } from './types';

/** 直连 OpenAI 兼容接口的默认实现 */
export class NativeAdapter implements AgentAdapter {
  readonly id = 'native';
  readonly label = '直连模型接口';

  async run(
    request: AgentRequest,
    handlers: AgentStreamHandlers,
    token: vscode.CancellationToken
  ): Promise<AgentResult> {
    const startedAt = Date.now();
    const text = await streamChat(
      request.config,
      request.apiKey,
      request.messages,
      { onDelta: handlers.onDelta, onReasoningDelta: handlers.onReasoning },
      { isCancellationRequested: token.isCancellationRequested }
    );
    return {
      text,
      model: request.config.model,
      elapsedMs: Date.now() - startedAt
    };
  }

  dispose(): void {
    // 无持久连接
  }
}

export function toFriendlyError(err: unknown): string {
  if (err instanceof ProviderError) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return '鉴权失败：API Key 无效或没有该模型的权限。请检查 Key 与模型名称。';
    }
    if (status === 404) {
      return '接口地址或模型不存在：请检查 Base URL 是否需要包含 /v1，以及模型名称是否正确。';
    }
    if (status === 429) {
      return '请求频率或额度受限：请稍后重试，或检查账户余额。';
    }
    if (status && status >= 500) {
      return `模型服务端异常（${status}）：请稍后重试。`;
    }
    return err.message;
  }
  if (err instanceof Error) {
    if (/ENOTFOUND|EAI_AGAIN/.test(err.message)) {
      return '域名解析失败：请检查 Base URL 与网络代理设置。';
    }
    if (/ECONNREFUSED/.test(err.message)) {
      return '连接被拒绝：目标地址不可达，本地模型请确认服务已启动。';
    }
    if (/certificate|self signed/i.test(err.message)) {
      return '证书校验失败：请检查代理或自签名证书配置。';
    }
    return err.message;
  }
  return String(err);
}
