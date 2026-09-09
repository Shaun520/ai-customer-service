/**
 * 对话 LLM 提供商运行时 store
 *
 * DB 优先、env 兜底：`model_providers` 表有数据则用 DB（Admin 可热更新）；
 * 为空则回退到 config.llmUpstreams（保证 mock / 现有 env 配置不破坏）。
 * 所有写操作由 admin 路由调用 reloadProviders() 实现即时生效。
 */
import { eq } from 'drizzle-orm';
import type { LlmUpstream } from './config.js';
import { config } from './config.js';
import { db } from './db/index.js';
import { modelProviders } from './db/schema.js';

export interface StoredProvider {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  task: string;
}

/** 进程内运行时提供商列表（loadProviders 填充） */
let providers: StoredProvider[] = [];

/** DB 为空时的 env 兜底映射 */
function envFallback(): StoredProvider[] {
  return config.llmUpstreams.map((u, i) => ({
    id: 0 - (i + 1), // 负 id 标记为 env 来源
    name: u.name,
    baseUrl: u.baseUrl,
    apiKey: u.apiKey,
    model: u.model,
    enabled: true,
    isDefault: i === 0,
    task: 'default',
  }));
}

/** 全量载入：DB 有行则用 DB；否则用 env 兜底 */
export async function loadProviders(): Promise<StoredProvider[]> {
  const rows = await db.select().from(modelProviders).orderBy(modelProviders.id);
  if (rows.length === 0) {
    providers = envFallback();
    return providers;
  }
  providers = rows.map((r) => ({
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    model: r.model,
    enabled: r.enabled,
    isDefault: r.isDefault,
    task: r.task,
  }));
  return providers;
}

/** 返回当前内存态（同步） */
export function getProviders(): StoredProvider[] {
  if (providers.length === 0) return envFallback();
  return providers;
}

/** 写操作后重新 hydrate，实现热更新 */
export async function reloadProviders(): Promise<StoredProvider[]> {
  return loadProviders();
}

/** 将 store 条目构造成下游可用的 LlmUpstream 形状 */
function toUpstream(p: StoredProvider): LlmUpstream {
  return { name: p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model };
}

/**
 * 按任务选取上游：task 精确匹配 → isDefault → 第一个 enabled → env 兜底。
 * 返回对象始终为 LlmUpstream 形状，保证 chatOnce/mockChat 等下游零改动。
 */
export function pickProvider(task = 'default'): LlmUpstream {
  const all = getProviders();
  const enabled = all.filter((p) => p.enabled);

  const byTask = enabled.find((p) => p.task === task);
  if (byTask) return toUpstream(byTask);

  const def = enabled.find((p) => p.isDefault);
  if (def) return toUpstream(def);

  if (enabled[0]) return toUpstream(enabled[0]);

  // 全部停用时回退到 env 配置
  return config.llmUpstreams[0];
}

/** 置唯一默认：更新前把同 task 的 isDefault 全清零 */
export async function clearDefaults(): Promise<void> {
  const all = getProviders().filter((p) => p.id > 0 && p.isDefault);
  for (const p of all) {
    await db.update(modelProviders).set({ isDefault: false }).where(eq(modelProviders.id, p.id));
  }
}