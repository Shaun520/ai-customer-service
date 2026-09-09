/**
 * 上游 LLM / Embedding 客户端（OpenAI 兼容协议）
 * - 多上游按任务路由（draft 用便宜模型，review 用强模型）
 * - 重试 + 逐级 Fallback（主模型宕机自动切换）
 * - 内置 mock 提供者：无外部 Key 时可离线跑通全链路
 */
import { config, isMockUpstream, type LlmUpstream } from '../config.js';
import { pickProvider } from '../llm-store.js';
import { createHmac } from 'node:crypto';

export interface ChatResult {
  content: string;
  model: string;
  upstream: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export class LlmError extends Error {
  constructor(message: string, public readonly upstream: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * 智谱旧版 "id.secret" 格式密钥 → JWT 签名（HS256, sign_type=SIGN）。
 * 新版密钥（无点号或平台已声明直接可用）原样透传 Bearer。
 */
const jwtCache = new Map<string, { token: string; exp: number }>();

export function upstreamAuthHeader(upstream: LlmUpstream): string {
  const key = upstream.apiKey.trim();
  // 智谱格式：32位hex + '.' + 16位字母数字
  if (!/^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/.test(key)) {
    return `Bearer ${key}`;
  }
  const cached = jwtCache.get(key);
  if (cached && Date.now() < cached.exp) return `Bearer ${cached.token}`;
  const [id, secret] = key.split('.');
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Date.now();
  const header = b64({ alg: 'HS256', sign_type: 'SIGN' });
  const payload = b64({ api_key: id, exp: now + 3600_000, timestamp: now });
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const token = `${header}.${payload}.${sig}`;
  jwtCache.set(key, { token, exp: now + 55 * 60_000 });
  return `Bearer ${token}`;
}

/** 按任务名选上游：优先运行时 store（DB 配置），其次 LLM_MODEL_ROUTING 路由，缺省进入 store 兜底 */
export function pickUpstream(task = 'default'): LlmUpstream {
  const routed = config.modelRouting[task];
  if (routed) {
    const p = pickProvider(task);
    // store 已按 task 匹配，若路由名一致则直接采用；否则仍以 store 结果为准
    if (p.name === routed) return p;
  }
  return pickProvider(task);
}

// ---------------- mock 提供者 ----------------

function mockChat(messages: Array<{ role: string; content: string }>): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser?.content.slice(0, 120) ?? '';
  // 若提示词中注入了检索上下文，mock 会引用第一条上下文，便于验证 RAG 链路
  const ctxMatch = messages[0]?.content.match(/【(\d+)】/);
  const cited = ctxMatch ? `（依据【${ctxMatch[1]}】）` : '';
  return `[mock-reply] 已收到您的问题：“${question}”。${cited} 这是网关内置 mock 模型的回复，用于离线验证 RAG 与网关链路。`;
}

/** 确定性哈希 embedding（开发用）：32 维 seed → 扩展到 dim */
function mockEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.split(/\s+|[,,。;;:!?？!]/).filter(Boolean);
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    vec[Math.abs(h) % dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

// ---------------- OpenAI 兼容调用 ----------------

async function chatOnce(
  upstream: LlmUpstream,
  messages: Array<{ role: string; content: string }>,
  opts: { temperature?: number; max_tokens?: number },
): Promise<ChatResult> {
  const started = Date.now();
  if (isMockUpstream(upstream)) {
    const content = mockChat(messages);
    return {
      content,
      model: upstream.model,
      upstream: upstream.name,
      promptTokens: Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4),
      completionTokens: Math.ceil(content.length / 4),
      latencyMs: Date.now() - started,
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: upstreamAuthHeader(upstream),
      },
      body: JSON.stringify({
        model: upstream.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`upstream ${upstream.name} HTTP ${res.status}: ${body.slice(0, 300)}`, upstream.name);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      content,
      model: json.model ?? upstream.model,
      upstream: upstream.name,
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 非流式对话补全：主上游重试 2 次后逐级 fallback 到后续上游。
 */
export async function chat(
  task: string,
  messages: Array<{ role: string; content: string }>,
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<ChatResult & { fallbackChain: string[] }> {
  const primary = pickUpstream(task);
  const chain: LlmUpstream[] = [
    primary,
    ...config.llmUpstreams.filter((u) => u !== primary),
  ];
  const tried: string[] = [];
  let lastErr: unknown;
  for (const upstream of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await chatOnce(upstream, messages, opts);
        return { ...result, fallbackChain: tried };
      } catch (err) {
        lastErr = err;
        tried.push(`${upstream.name}#${attempt + 1}`);
        console.warn(`[llm] ${upstream.name} attempt ${attempt + 1} failed:`, (err as Error).message);
      }
    }
  }
  throw new LlmError(
    `all upstreams failed; last error: ${(lastErr as Error)?.message ?? 'unknown'}`,
    chain.map((u) => u.name).join(','),
  );
}

/** 流式对话补全：返回上游 SSE 的 ReadableStream（mock 提供者逐词生成） */
export async function chatStream(
  task: string,
  messages: Array<{ role: string; content: string }>,
  opts: { temperature?: number; max_tokens?: number } = {},
): Promise<{ stream: ReadableStream<Uint8Array>; upstream: LlmUpstream }> {
  const upstream = pickUpstream(task);
  if (isMockUpstream(upstream)) {
    const full = mockChat(messages);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const words = full.match(/[\u4e00-\u9fa5]{1,2}|\S+\s*/g) ?? [full];
        for (const w of words) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                id: 'mock-stream',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: w }, finish_reason: null }],
              })}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, 15));
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: 'mock-stream',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return { stream, upstream };
  }

  const res = await fetch(`${upstream.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: upstreamAuthHeader(upstream),
    },
    body: JSON.stringify({
      model: upstream.model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`upstream ${upstream.name} HTTP ${res.status}: ${body.slice(0, 300)}`, upstream.name);
  }
  return { stream: res.body, upstream };
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { baseUrl, apiKey, model, dim } = config.embedding;
  if (baseUrl && apiKey && model) {
    try {
      return await embedRemote(texts, { baseUrl, apiKey, model, dim });
    } catch (err) {
      // 降级保护：真实 embedding 失败（Key 失效/网络）时回落 mock 向量，
      // 保证 RAG 链路可用；生产环境应尽快修复（npm run check:models 定位）
      console.error(`[embedding] remote embedding failed, falling back to mock vectors: ${(err as Error).message}`);
    }
  }
  return texts.map((t) => mockEmbedding(t, dim));
}

async function embedRemote(
  texts: string[],
  cfg: { baseUrl: string; apiKey: string; model: string; dim: number },
): Promise<number[][]> {
  const { baseUrl, apiKey, model, dim } = cfg;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: upstreamAuthHeader({ name: 'embedding', baseUrl, apiKey, model }),
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmError(`embedding HTTP ${res.status}: ${body.slice(0, 300)}`, 'embedding');
    }
    const json = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
    const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length) {
      throw new LlmError(`embedding count mismatch: ${data.length} != ${texts.length}`, 'embedding');
    }
    const vectors = data.map((d) => d.embedding);
    if (vectors[0]?.length !== dim) {
      throw new LlmError(
        `embedding dim mismatch: got ${vectors[0]?.length}, EMBEDDING_DIM=${dim}（请修改 .env 中 EMBEDDING_DIM）`,
        'embedding',
      );
    }
    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
