// @aics/shared/web —— 前端共享请求封装（仅 web/admin 使用，不与网关共用，保持纯类型主入口不受影响）
// 所有请求走相对路径 /v1，由 Vite proxy 转发到网关 :8787
// 认证：管理接口用 X-Admin-Token；聊天接口用 Authorization: Bearer <api_key>

export const DEFAULT_ADMIN_TOKEN = 'change-me-admin-token';

export async function request<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: 'admin' | 'bearer'; token?: string } = {},
): Promise<T> {
  const { method = 'GET', body, auth, token } = options;
  // FormData 时由浏览器自动设置 multipart 边界，不手动加 Content-Type，也不 JSON.stringify
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = {};
  if (!isForm) headers['Content-Type'] = 'application/json';
  if (auth === 'admin') headers['X-Admin-Token'] = token ?? localStorage.getItem('aics_admin_token') ?? DEFAULT_ADMIN_TOKEN;
  if (auth === 'bearer' && token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/v1${path}`, {
    method,
    headers,
    body: isForm ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}