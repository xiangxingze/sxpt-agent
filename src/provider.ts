import { AgentConfig } from './config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamHandlers {
  onDelta(text: string): void;
  onReasoningDelta?(text: string): void;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

function authHeaders(config: AgentConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream'
  };
  if (config.provider === 'ollama') {
    return headers;
  }
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function streamChat(
  config: AgentConfig,
  apiKey: string | undefined,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  token?: { isCancellationRequested: boolean }
): Promise<string> {
  const controller = new AbortController();
  const cancelWatcher = setInterval(() => {
    if (token?.isCancellationRequested) {
      controller.abort();
    }
  }, 120);

  const url = `${config.baseUrl}/chat/completions`;
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    stream: true
  };

  let answer = '';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(config, apiKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      const detail = await safeReadText(response);
      throw new ProviderError(
        `模型接口返回 ${response.status}${detail ? `：${detail.slice(0, 500)}` : ''}`,
        response.status
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta ?? {};
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            handlers.onReasoningDelta?.(delta.reasoning_content);
          }
          if (typeof delta.content === 'string' && delta.content) {
            answer += delta.content;
            handlers.onDelta(delta.content);
          }
        } catch {
          // 忽略非 JSON 心跳行
        }
      }
    }

    if (!answer.trim()) {
      throw new ProviderError('模型返回内容为空，请检查模型名称与接口地址是否正确');
    }
    return answer;
  } catch (err) {
    if (err instanceof ProviderError) {
      throw err;
    }
    if ((err as Error).name === 'AbortError') {
      throw new ProviderError('请求已取消');
    }
    throw new ProviderError(`无法连接模型接口：${(err as Error).message}`);
  } finally {
    clearInterval(cancelWatcher);
  }
}

export async function testConnection(
  config: AgentConfig,
  apiKey: string | undefined
): Promise<{ ok: boolean; message: string }> {
  const url = `${config.baseUrl}/chat/completions`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(config, apiKey),
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false
      })
    });
    if (!response.ok) {
      const detail = await safeReadText(response);
      return {
        ok: false,
        message: `HTTP ${response.status}${detail ? ` · ${detail.slice(0, 300)}` : ''}`
      };
    }
    await response.text();
    return { ok: true, message: `连接成功：${config.model}` };
  } catch (err) {
    return { ok: false, message: `连接失败：${(err as Error).message}` };
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
