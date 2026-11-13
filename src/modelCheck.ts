/** 把底层错误转换成面向学生的可操作提示 */
export function toFriendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b(401|403)\b|unauthorized|invalid api key|incorrect api key|authentication/i.test(message)) {
    return '鉴权失败：API Key 无效或没有该模型的权限。请在设置中检查 Key 与模型名称。';
  }
  if (/\b404\b|model.*not.*(found|exist)|does not exist/i.test(message)) {
    return '接口地址或模型不存在：请检查 API 地址是否需要包含 /v1，以及模型名称是否正确。';
  }
  if (/\b429\b|rate.?limit|quota|insufficient/i.test(message)) {
    return '请求频率或额度受限：请稍后重试，或检查账户余额。';
  }
  if (/\b5\d\d\b|overloaded|bad gateway|service unavailable/i.test(message)) {
    return `模型服务端异常：请稍后重试。（${message.slice(0, 120)}）`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return '域名解析失败：请检查 API 地址与网络代理设置。';
  }
  if (/ECONNREFUSED/.test(message)) {
    return '连接被拒绝：目标地址不可达，本地模型请确认服务已启动。';
  }
  if (/certificate|self signed/i.test(message)) {
    return '证书校验失败：请检查代理或自签名证书配置。';
  }
  if (/context.*(length|window)|maximum context|too many tokens/i.test(message)) {
    return '对话内容超过模型上下文上限：请新建会话，或在设置中调整上下文窗口。';
  }
  return message;
}

function headers(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`;
  }
  return h;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeNetworkError(err: unknown, timeoutSeconds: number): string {
  if ((err as Error)?.name === 'AbortError') {
    return `连接超时（${timeoutSeconds} 秒），请检查 API 地址和网络。`;
  }
  const cause = (err as any)?.cause;
  const detail = cause?.code ? `${cause.code}` : (err as Error)?.message ?? String(err);
  return toFriendlyError(new Error(detail)) === detail
    ? `无法连接：${detail}`
    : toFriendlyError(new Error(detail));
}

export interface ModelListResult {
  ok: boolean;
  models: string[];
  message?: string;
}

/** 不是对话模型的名称特征（嵌入、语音、绘图、审核、重排） */
const NON_CHAT = /embed|whisper|tts|dall-?e|moderation|rerank|stable-diffusion|transcrib|speech/i;

/** 从 OpenAI 兼容的 `/models` 响应中取出模型 ID（兼容 data / models / 纯数组三种形态） */
export function parseModelList(json: unknown): string[] {
  const root: any = json;
  const list: unknown[] = Array.isArray(root) ? root : root?.data ?? root?.models ?? [];
  if (!Array.isArray(list)) {
    return [];
  }
  const ids = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === 'string' ? item : (item as any)?.id ?? (item as any)?.name ?? (item as any)?.model;
    if (typeof id === 'string' && id.trim()) {
      ids.add(id.trim());
    }
  }
  const all = [...ids].sort((a, b) => a.localeCompare(b));
  const chat = all.filter((id) => !NON_CHAT.test(id));
  return chat.length > 0 ? chat : all;
}

/** 向学生配置的接口请求可用模型列表：GET {baseUrl}/models */
export async function fetchModels(baseUrl: string, apiKey: string | undefined): Promise<ModelListResult> {
  if (!baseUrl) {
    return { ok: false, models: [], message: '请先填写 API 地址。' };
  }
  try {
    const response = await fetchWithTimeout(`${baseUrl}/models`, { headers: headers(apiKey) }, 15_000);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, models: [], message: '鉴权失败：请检查 API Key。' };
      }
      if (response.status === 404 || response.status === 405) {
        return { ok: false, models: [], message: '该接口不提供模型列表，请手动输入模型名称。' };
      }
      return { ok: false, models: [], message: `获取模型列表失败：HTTP ${response.status}` };
    }
    const models = parseModelList(await response.json().catch(() => undefined));
    if (models.length === 0) {
      return { ok: false, models: [], message: '接口没有返回可用模型，请手动输入模型名称。' };
    }
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], message: describeNetworkError(err, 15) };
  }
}

/** 向模型接口发一个最小请求，验证 API 地址、模型名与 Key 是否可用 */
export async function testConnection(
  baseUrl: string,
  model: string,
  apiKey: string | undefined
): Promise<{ ok: boolean; message: string }> {
  if (!baseUrl || !model) {
    return { ok: false, message: '请先填写 API 地址和模型名称。' };
  }
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: headers(apiKey),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 8,
          stream: false
        })
      },
      20_000
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const friendly = toFriendlyError(new Error(`${response.status} ${detail}`));
      return {
        ok: false,
        message:
          friendly === `${response.status} ${detail}`
            ? `HTTP ${response.status}${detail ? ` · ${detail.slice(0, 200)}` : ''}`
            : friendly
      };
    }
    await response.text();
    return { ok: true, message: `连接成功：${model}` };
  } catch (err) {
    return { ok: false, message: describeNetworkError(err, 20) };
  }
}
