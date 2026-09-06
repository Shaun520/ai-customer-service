import type { TenantContext } from '@aics/shared';

/** Hono 泛型环境：中间件与路由共享的上下文变量 */
export interface GatewayEnv {
  Variables: {
    tenant: TenantContext;
    rateLimits: { rpm: number; tpm: number };
  };
}
