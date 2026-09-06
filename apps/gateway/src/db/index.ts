import '../env.js'; // 必须最先求值：保证 DATABASE_URL 已加载
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const connectionString = process.env.DATABASE_URL ?? 'postgres://aics:aics@localhost:5432/aics';

// 迁移/脚本场景需要关闭 prepare 缓存（postgres-js 对 pgbouncer 兼容）
export const queryClient = postgres(connectionString, { prepare: false, max: 10 });
export const db = drizzle(queryClient, { schema });
export { schema };
