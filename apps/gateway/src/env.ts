/**
 * 环境变量加载（必须在任何读取 process.env 的模块之前求值）
 *
 * 问题背景：ESM 的 import 会按书写顺序求值，若 `db/index.ts` 先于 `config.ts`
 * 被求值，`dotenv` 尚未加载，`DATABASE_URL` 就会回退到内置默认值并连错库。
 * 因此抽一个独立模块，在 db / config 两侧都显式引入，与 import 顺序解耦。
 *
 * 优先级（dotenv 默认不覆盖已存在的变量，故先加载者优先）：
 *   真实环境变量 > cwd/.env > apps/gateway/.env > 仓库根 .env
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

// apps/gateway/.env（包内自带配置）
const packageEnv = path.resolve(here, '../.env');
// 仓库根 .env（monorepo 根执行 npm run dev / vitest 时兜底）
const repoRootEnv = path.resolve(here, '../../.env');

loadDotenv(); // cwd/.env（标准行为）
loadDotenv({ path: packageEnv });
loadDotenv({ path: repoRootEnv });
