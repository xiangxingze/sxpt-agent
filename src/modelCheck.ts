import type { AgentConfig } from './config';

/** 把底层错误转换成面向学生的可操作提示 */
export function toFriendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(401|403)\b|unauthorized|invalid api key|incorrect api key|authentication/i.test(message)) {
    return '鉴权失败：API Key 无效或没有该模型的权限。请检查 Key 与模型名称。';
  }
  if (/\b404\b|model.*not.*(found|exist)|does not exist/i.test(message)) {
    return '接口地址或模型不存在：请检查 Base URL 是否需要包含 /v1，以及模型名称是否正确。';
  }
  if (/\b429\b|rate.?limit|quota|insufficient/i.test(message)) {
    return '请求频率或额度受限：请稍后重试，或检查账户余额。';
  }
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/i.test(message)) {
    return `模型服务端异常：请稍后重试。（${message.slice(0, 120)}）`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return '域名解析失败：请检查 Base URL 与网络代理设置。';
  }
  if (/ECONNREFUSED/.test(message)) {
    return '连接被拒绝：目标地址不可达，本地模型请确认服务已启动。';
  }
  if (/certificate|self signed/i.test(message)) {
    return '证书校验失败：请检查代理或自签名证书配置。';
  }
  if (/context.*(length|window)|maximum context|too many tokens/i.test(message)) {
    return '对话内容超过模型上下文上限：请新建会话，或在设置中调整 contextWindow。';
  }
  return message;
}

/** 向模型接口发一个最小请求，验证 Base URL、模型名与 Key 是否可用 */
export async function testConnection(
  config: AgentConfig,
  apiKey: string | undefined
): Promise<{ ok: boolean; message: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.provider !== 'ollama' && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        message: `HTTP ${response.status}${detail ? ` · ${detail.slice(0, 300)}` : ''}`
      };
    }
    await response.text();
    return { ok: true, message: `连接成功：${config.model}` };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return { ok: false, message: aborted ? '连接超时（20 秒）' : `连接失败：${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
