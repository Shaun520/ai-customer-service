// Admin 端 API 层：用量、知识库、审核、追踪。认证：
//  - 管理接口用 X-Admin-Token
//  - 知识库/对话/追踪用统一网关 Key（Authorization: Bearer）
// /v1 相对路径由 Vite proxy 转发到网关 :8787。
import { request, DEFAULT_ADMIN_TOKEN } from '@aics/shared/web';

export { DEFAULT_ADMIN_TOKEN };

/** 统一网关 API Key 的本地存储键（单租户模式，所有接入端共用一把） */
export const GATEWAY_KEY_STORAGE = 'aics_gateway_key';
export const DEFAULT_GATEWAY_KEY = 'aics-local-gateway-key';

export interface UsageDaily {
  day: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedRequests: number;
  avgLatencyMs: number;
}
export interface UsageResponse {
  days: number;
  from: string;
  tenant: string | null;
  daily: UsageDaily[];
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    cachedRequests: number;
    avgLatencyMs: number;
  };
}

export const admin = {
  usage: (days = 7) => request<UsageResponse>(`/admin/usage?days=${days}`, { auth: 'admin' }),
};

export interface KbDoc {
  id: number;
  name: string;
  chunk_count: number;
  created_at?: string;
}
export interface KbPreviewHit {
  id: string;
  text: string;
  chunkIndex: number;
  score: number;
}

export const knowledge = {
  ingest: (body: { name: string; text: string }, apiKey: string) =>
    request<{ document_id: number; chunks: number }>('/knowledge/documents', { method: 'POST', body, auth: 'bearer', token: apiKey }),
  list: (apiKey: string) =>
    request<{ documents: KbDoc[] }>('/knowledge/documents', { auth: 'bearer', token: apiKey }),
  detail: (id: number, apiKey: string, query?: string) => {
    const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
    return request<{ document: KbDoc; preview: KbPreviewHit[] | null; hint: string | null }>(
      `/knowledge/documents/${id}${suffix}`,
      { auth: 'bearer', token: apiKey },
    );
  },
  remove: (id: number, apiKey: string) =>
    request<{ deleted: number }>(`/knowledge/documents/${id}`, { method: 'DELETE', auth: 'bearer', token: apiKey }),
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

// ---------- 对话模型提供商配置 ----------

export interface ModelProviderRow {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string; // 已脱敏（env 来源为明文 mock key）
  model: string;
  enabled: boolean;
  isDefault: boolean;
  task: string;
  source: 'env' | 'db';
}
export interface ModelProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  task: string;
}

export const models = {
  list: () => request<{ providers: ModelProviderRow[]; count: number }>('/admin/models', { auth: 'admin' }),
  create: (body: ModelProviderInput) =>
    request<{ provider: { id: number; name: string }; updated: boolean; note: string }>('/admin/models', {
      method: 'POST',
      body,
      auth: 'admin',
    }),
  update: (id: number, body: ModelProviderInput) =>
    request<{ provider: { id: number; name: string }; updated: boolean; note: string }>(`/admin/models/${id}`, {
      method: 'PUT',
      body,
      auth: 'admin',
    }),
  remove: (id: number) =>
    request<{ deleted: number; updated: boolean; note: string }>(`/admin/models/${id}`, {
      method: 'DELETE',
      auth: 'admin',
    }),
};

// ---------- 文件上传（网关中转 → 腾讯云 CloudBase）----------

export interface UploadResult {
  fileID: string;
  url: string;
  cloudPath: string;
  name: string;
  size: number;
  type?: string;
}

/** 上传文件到 CloudBase；dir 指定云存储目录前缀（默认 kb） */
export const upload = {
  file: (file: File, dir = 'kb') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('path', dir);
    return request<UploadResult>('/admin/upload', { method: 'POST', body: fd, auth: 'admin' });
  },
};

// ---------- 文件管理（COS 私有桶 + 签名 URL 预览）----------

export interface ManagedFile {
  id: number;
  name: string;
  objectKey: string;
  bucket: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
}

export interface FileViewResult {
  fileID: number;
  name: string;
  url: string; // 签名临时 URL（inline 预览）
  expiresAt: number;
}

export const files = {
  list: () => request<{ files: ManagedFile[] }>('/admin/files', { auth: 'admin' }),
  upload: (file: File, dir = 'files') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('dir', dir);
    return request<{ file: ManagedFile; note: string }>('/admin/files', { method: 'POST', body: fd, auth: 'admin' });
  },
  /** 获取某文件的签名预览 URL（点击时实时生成，有效期 2 小时） */
  view: (id: number) => request<FileViewResult>(`/admin/files/${id}/view`, { auth: 'admin' }),
  remove: (id: number) => request<{ deleted: number }>(`/admin/files/${id}`, { method: 'DELETE', auth: 'admin' }),
};