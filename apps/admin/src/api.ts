// Admin 端 API 层：管理接口、知识库、审核、追踪。认证用 X-Admin-Token。
// /v1 相对路径由 Vite proxy 转发到网关 :8787。
import { request, DEFAULT_ADMIN_TOKEN } from '@aics/shared/web';

export { DEFAULT_ADMIN_TOKEN };

export const admin = {
  createTenant: (body: { slug: string; name: string; industry: string; systemPrompt?: string }) =>
    request<{ id: number; slug: string; industry: string }>('/admin/tenants', { method: 'POST', body, auth: 'admin' }),
  listTenants: () => request<{ tenants: Array<Record<string, unknown>> }>('/admin/tenants', { auth: 'admin' }),
  createApiKey: (body: { tenantSlug: string; name: string; rpm?: number; tpm?: number }) =>
    request<{ api_key: string; id: number; prefix: string; tenant: string }>('/admin/api-keys', { method: 'POST', body, auth: 'admin' }),
  getRulePack: (industry: string) => request<Record<string, unknown>>(`/admin/rule-packs/${industry}`, { auth: 'admin' }),
  updateRulePack: (industry: string, body: Record<string, unknown>) =>
    request<Record<string, unknown>>(`/admin/rule-packs/${industry}`, { method: 'PUT', body, auth: 'admin' }),
};

export const knowledge = {
  ingest: (body: { name: string; text: string }, apiKey: string) =>
    request<{ document_id: number; chunks: number }>('/knowledge/documents', { method: 'POST', body, auth: 'bearer', token: apiKey }),
};

export const reviews = {
  list: (status = 'pending') =>
    request<{ reviews: Array<Record<string, unknown>>; count: number }>(`/reviews?status=${status}`, { auth: 'admin' }),
  approve: (id: number, body: { reviewerId: string; comment?: string }) =>
    request<Record<string, unknown>>(`/reviews/${id}/approve`, { method: 'POST', body, auth: 'admin' }),
  reject: (id: number, body: { reviewerId: string; comment?: string; revisedDraft?: string }) =>
    request<Record<string, unknown>>(`/reviews/${id}/reject`, { method: 'POST', body, auth: 'admin' }),
};

export const trace = {
  get: (traceId: string) =>
    request<Record<string, unknown>>(`/trace/${encodeURIComponent(traceId)}`, { auth: 'admin' }),
};