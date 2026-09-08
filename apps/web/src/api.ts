// Web 端 API 层：仅保留聊天/流式相关；管理接口已迁移到 apps/admin。
// 需求 /v1 相对路径由 Vite proxy 转发到网关 :8787。

export interface ChatMsg {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatMeta {
  trace_id?: string;
  status?: string;
  cached?: boolean;
  cache?: string;
  guardrail?: { verdict?: string; riskLevel?: string; matchedRules?: string[]; reason?: string };
  citations?: Array<{ id?: string; text?: string; documentName?: string; chunkIndex?: number; score?: number }>;
  retrieval_audit_id?: number | null;
}

export interface StreamResult {
  content: string;
  meta: ChatMeta;
}

/** SSE 流式聊天：逐 chunk 回调 delta，解析非首块的 aics 元数据 */
export async function chatStream(
  { messages, apiKey, disableCache }: { messages: ChatMsg[]; apiKey: string; disableCache?: boolean },
  onDelta: (delta: string) => void,
): Promise<StreamResult> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'aics', messages, stream: true, disable_cache: disableCache ?? undefined }),
  });
  if (!res.ok || !res.body) {
    const err = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const meta: ChatMeta = {};

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const aics = j.aics as ChatMeta | undefined;
          if (aics) Object.assign(meta, aics); // 每个 chunk 都带完整 aics，覆盖取最新
          const delta = j.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) {
            content += delta;
            onDelta(delta);
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { content, meta };
}