import { useEffect, useState } from 'react';
import { Icon } from '@aics/shared/web';
import {
  admin, knowledge, reviews, trace as traceApi, models as modelsApi, files as filesApi,
  GATEWAY_KEY_STORAGE, DEFAULT_GATEWAY_KEY,
  type UsageResponse, type KbPreviewHit, type ModelProviderRow, type ModelProviderInput, type ManagedFile,
} from './api';

type Tab = 'usage' | 'kb' | 'reviews' | 'trace' | 'models';

const DEFAULT_ADMIN_TOKEN = 'change-me-admin-token';

interface KbDoc { id: number; name: string; chunk_count: number; created_at?: string }
interface ReviewRow {
  id: number; originalQuery?: string; draftResponse?: string; riskLevel?: string;
  status?: string; traceId?: string; createdAt?: string;
}

const NAV: Array<{ key: Tab; icon: string; label: string }> = [
  { key: 'usage', icon: 'chart', label: '用量统计' },
  { key: 'kb', icon: 'book', label: '知识库' },
  { key: 'models', icon: 'database', label: '模型配置' },
  { key: 'reviews', icon: 'clipboard', label: '人工审核' },
  { key: 'trace', icon: 'search', label: '全链路追踪' },
];

export default function AdminPage({ goChat }: { goChat: () => void }) {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('aics_admin_token') ?? DEFAULT_ADMIN_TOKEN);
  const [draftToken, setDraftToken] = useState(adminToken);
  const [tab, setTab] = useState<Tab>('usage');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);

  const notify = (kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    if (kind === 'ok') setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 3000);
  };

  const saveToken = () => {
    const t = draftToken.trim();
    setAdminToken(t);
    localStorage.setItem('aics_admin_token', t);
    notify('ok', 'Admin Token 已保存');
  };

  useEffect(() => {
    reviews.list('pending').then((r) => setReviewCount(r.count ?? (r.reviews as unknown[]).length)).catch(() => setReviewCount(null));
  }, [tab]);

  const pageTitle = NAV.find((n) => n.key === tab)!.label;

  return (
    <div className="admin-shell">
      <aside className="admin-side">
        <div className="brand">
          <div className="logo"><Icon name="settings" size={15} /></div>
          <span>AICS 管理台</span>
          <span className="role-tag">Admin</span>
        </div>
        <nav className="admin-nav">
          {NAV.map((n) => (
            <button key={n.key} className={tab === n.key ? 'on' : ''} onClick={() => setTab(n.key)}>
              <Icon name={n.icon} size={16} />
              <span className="label">{n.label}</span>
              {n.key === 'reviews' && (reviewCount ?? 0) > 0 && <span className="count">{reviewCount}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <label style={{ color: '#9aa0bd' }}>Admin Token</label>
          <input
            value={draftToken}
            onChange={(e) => setDraftToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveToken()}
            className="mono"
            style={{ background: 'rgba(255,255,255,0.06)', borderColor: 'rgba(255,255,255,0.12)', color: '#e8e9f5', fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button style={{ flex: 1, padding: '7px 0', fontSize: 13 }} onClick={saveToken}>保存</button>
          </div>
          <a onClick={goChat} style={{ marginTop: 10, cursor: 'pointer' }}><Icon name="arrow-left" size={14} /> 返回用户对话</a>
        </div>
      </aside>

      <main className="admin-main">
        <div className="admin-main-inner">
          <div className="admin-page-head">
            <div className="h2">{pageTitle}</div>
          </div>

          {notice && <div className={`notice-banner ${notice.kind === 'err' ? 'error' : ''}`}>{notice.text}</div>}

          {tab === 'usage' && <UsageTab />}
          {tab === 'kb' && <KbTab notify={notify} />}
          {tab === 'models' && <ModelsTab notify={notify} />}
          {tab === 'reviews' && <ReviewsTab notify={notify} />}
          {tab === 'trace' && <TraceTab notify={notify} />}
        </div>
      </main>
    </div>
  );
}

type Notify = (kind: 'ok' | 'err', text: string) => void;

function UsageTab() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr(''); setBusy(true);
    try {
      setData(await admin.usage(days));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setData(null); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const nf = (n: number | undefined) => (n || 0).toLocaleString('en-US');
  const t = data?.totals;
  const daily = data?.daily ?? [];
  const cacheRate = t && t.requests ? Math.round((t.cachedRequests / t.requests) * 100) : 0;

  const metrics: Array<{ icon: string; label: string; value: string; foot: string; accent?: 'ok' }> = [
    { icon: 'activity', label: '请求总数', value: nf(t?.requests), foot: `${days} 天累计请求` },
    { icon: 'log-in', label: '输入 Tokens', value: nf(t?.promptTokens), foot: 'Prompt tokens' },
    { icon: 'log-out', label: '输出 Tokens', value: nf(t?.completionTokens), foot: 'Completion tokens' },
    { icon: 'zap', label: '缓存命中率', value: `${cacheRate}%`, foot: `${nf(t?.cachedRequests)} / ${nf(t?.requests)} 次`, accent: 'ok' },
    { icon: 'gauge', label: '平均延迟', value: `${Math.round(t?.avgLatencyMs ?? 0)} ms`, foot: '含模型推理耗时' },
  ];

  // —— 每日请求量 → Stacked SVG 柱状图（绿 = 缓存命中，蓝 = 未命中）——
  const W = 760, H = 240, padL = 44, padR = 12, padT = 18, padB = 32;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const rawMax = Math.max(1, ...daily.map((d) => d.requests));
  const exp = Math.pow(10, Math.floor(Math.log10(rawMax)));
  const yMax = Math.max(rawMax, Math.ceil(rawMax / exp) * exp);
  const n = daily.length;
  const slotW = n ? chartW / n : 0;
  const barW = Math.min(46, slotW * 0.6);
  const gridLines = [0, 1, 2, 3, 4].map((k) => ({ y: padT + chartH - (k * chartH) / 4, v: Math.round((k * yMax) / 4) }));

  const renderChart = () => {
    if (n === 0) return <div className="muted">该区间内暂无请求数据。</div>;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="usage-chart" preserveAspectRatio="xMidYMid meet" role="img" aria-label="每日请求量与缓存命中分布">
        {gridLines.map((g) => (
          <g key={g.v}>
            <line x1={padL} x2={W - padR} y1={g.y} y2={g.y} className="usage-gridline" />
            <text x={padL - 8} y={g.y + 4} className="usage-ylabel">{nf(g.v)}</text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = padL + i * slotW + (slotW - barW) / 2;
          const barH = (d.requests / yMax) * chartH;
          const cachedH = (Math.min(d.cachedRequests, d.requests) / yMax) * chartH;
          return (
            <g key={d.day}>
              <title>{`${d.day}
请求 ${d.requests} 次（缓存命中 ${d.cachedRequests}）
Prompt ${d.promptTokens} · Completion ${d.completionTokens}`}</title>
              <rect x={x} y={padT + chartH - barH} width={barW} height={barH - cachedH} rx={barW / 2} className="usage-uncached" />
              {cachedH > 0 && (
                <rect x={x} y={padT + chartH - cachedH} width={barW} height={cachedH} rx={barW / 2} className="usage-cached" />
              )}
              {(n <= 10 || i % Math.ceil(n / 10) === 0) && (
                <text x={x + barW / 2} y={H - 10} textAnchor="middle" className="usage-xlabel">{d.day.slice(5)}</text>
              )}
            </g>
          );
        })}
      </svg>
    );
  };

  return (
    <>
      {data && (
        <div className="metric-grid">
          {metrics.map((m) => (
            <div key={m.label} className={`metric-card${m.accent ? ' ok' : ''}`}>
              <div className={`metric-icon${m.accent ? ' ok' : ''}`}><Icon name={m.icon} size={18} /></div>
              <div className="metric-body">
                <div className="metric-label">{m.label}</div>
                <div className="metric-value">{m.value}</div>
                <div className="metric-foot">{m.foot}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="row">
          <div style={{ flex: '0 0 180px' }}>
            <label>时间范围</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>近 1 天</option>
              <option value={7}>近 7 天</option>
              <option value={30}>近 30 天</option>
            </select>
          </div>
          <div style={{ flex: '0 0 auto', paddingBottom: 1 }}>
            <button className="ghost" onClick={load} disabled={busy}>{busy ? '加载中…' : '刷新'}</button>
          </div>
        </div>
        {err && <div className="err">{err}</div>}
      </div>

      {data && (
        <div className="card">
          <div className="chart-head">
            <div className="h2">每日请求量</div>
            <div className="chart-legend">
              <span><i className="dot uncached" />未命中</span>
              <span><i className="dot cached" />缓存命中</span>
            </div>
          </div>
          <p className="sub" style={{ marginTop: 6 }}>柱形按天展示请求次数，绿色为其中命中的 L1/L2 语义缓存请求。悬停查看明细。</p>
          {renderChart()}
        </div>
      )}
    </>
  );
}

function KbTab({ notify }: { notify: Notify }) {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(GATEWAY_KEY_STORAGE) ?? DEFAULT_GATEWAY_KEY);
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [query, setQuery] = useState<string>('');
  const [preview, setPreview] = useState<{ hits: KbPreviewHit[]; hint: string; doc: KbDoc } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // 文件上传（COS 私有桶留档 + 文本直读 txt/md 供入库）
  const [fileBusy, setFileBusy] = useState(false);
  const [lastUpload, setLastUpload] = useState<{ name: string; /* url is signed per-request */ size: number } | null>(null);
  // 已上传文件（upload_files 记录，可用于预览原始文件）
  const [files, setFiles] = useState<ManagedFile[]>([]);

  const loadFiles = async () => {
    try {
      const r = await filesApi.list();
      setFiles(r.files);
    } catch { /* 文件服务异常不阻塞文档区 */ }
  };
  useEffect(() => { loadFiles(); /* eslint-disable-next-line */ }, []);

  const viewFile = async (id: number) => {
    try {
      const r = await filesApi.view(id);
      window.open(r.url, '_blank'); // inline 签名 URL：网关生成，浏览器新标签预览而非下载
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  // 按入库文档名匹配已上传的原始文件（忽略扩展名差异），用于在线预览原文件
  const previewDoc = (doc: KbDoc) => {
    const match = files.find((f) => {
      const dot = f.name.lastIndexOf('.');
      const stem = dot > 0 ? f.name.slice(0, dot) : f.name;
      return stem === doc.name || f.name === doc.name;
    });
    if (match) { viewFile(match.id); return; }
    // 找不到原始文件则退化为文档内容预览（检索预览角度）
    setErr('未找到该文档的原始文件，已展开检索预览');
    toggleOpen(doc);
  };

  const handleFile = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    const ext = f.name.split('.').pop()?.toLowerCase();
    const texty = ['txt', 'md', 'markdown', 'csv', 'json'].includes(ext ?? '');
    // 所有文件都上传到 COS 私有桶，并写入 upload_files 元数据
    setFileBusy(true);
    try {
      const r = await filesApi.upload(f, texty ? 'kb/docs' : 'kb/files');
      setLastUpload({ name: r.file.name, size: r.file.size });
      await loadFiles();
      // 文本文件额外读取内容填入表单，便于提交入库（RAG）
      if (texty) {
        const content = await f.text();
        setName(f.name.replace(/\.(txt|md|markdown|csv|json)$/i, ''));
        setText(content);
        notify('ok', `「${r.file.name}」已上传至 COS 私有桶，内容已读取，可直接入库或编辑后提交`);
      } else {
        notify('ok', `「${r.file.name}」已上传至 COS 私有桶并记录`);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setFileBusy(false); }
  };

  const loadDocs = async () => {
    if (!apiKey.trim()) { setErr('请填写网关 API Key'); return; }
    setErr(''); setBusy(true);
    try {
      localStorage.setItem(GATEWAY_KEY_STORAGE, apiKey.trim());
      setDocs(((await knowledge.list(apiKey.trim())).documents ?? []));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const toggleOpen = (doc: KbDoc) => {
    if (open === doc.id) { setOpen(null); setPreview(null); return; }
    setOpen(doc.id); setQuery(''); setPreview(null);
    knowledge.detail(doc.id, apiKey.trim())
      .then((r) => setPreview({ hits: [], hint: r.hint ?? '', doc: r.document }))
      .catch(() => setPreview({ hits: [], hint: '加载文档信息失败', doc }));
  };

  const previewSearch = async () => {
    if (open == null) return;
    if (query.trim().length < 2) { setErr('检索词至少 2 个字'); return; }
    setErr(''); setPreviewBusy(true); setPreview(null);
    try {
      const r = await knowledge.detail(open, apiKey.trim(), query.trim());
      setPreview({ hits: r.preview ?? [], hint: r.hint ?? '', doc: r.document });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setPreviewBusy(false); }
  };

  const remove = async (doc: KbDoc) => {
    if (!window.confirm(`确认删除文档「${doc.name}」？其 ${doc.chunk_count} 个切片将从向量库与数据库一并移除。`)) return;
    setErr('');
    try {
      await knowledge.remove(doc.id, apiKey.trim());
      notify('ok', `文档「${doc.name}」已删除`);
      if (open === doc.id) { setOpen(null); setPreview(null); }
      await loadDocs();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const upload = async () => {
    if (!apiKey.trim() || !name.trim() || !text.trim()) {
      setErr('请填写网关 API Key、文档名与内容'); return;
    }
    setErr(''); setBusy(true);
    try {
      const r = await knowledge.ingest({ name: name.trim(), text: text.trim() }, apiKey.trim());
      notify('ok', `文档「${name.trim()}」上传成功，切分为 ${r.chunks} 个片段`);
      setName(''); setText('');
      await loadDocs();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="card">
        <div className="h2">上传文档</div>
        <label>网关 API Key（统一 Key，所有接入端共用）</label>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="GATEWAY_API_KEY" className="mono" />
        <input
          type="file"
          disabled={fileBusy}
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        {fileBusy && <div className="muted" style={{ marginTop: 8 }}>正在上传到 COS 私有桶…</div>}
        {lastUpload && (
          <div className="muted" style={{ marginTop: 8 }}>
            已上传：{lastUpload.name}（{(lastUpload.size / 1024).toFixed(1)} KB）—— 见下方「已上传文件」列表，可在线预览。
          </div>
        )}
        <label>文档名</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="门诊须知" />
        <label>文档内容</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="门店信息 / 商品规则 / 产品文档……" style={{ minHeight: 140 }} />
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="ghost" onClick={loadDocs} disabled={busy}>刷新文档列表</button>
          <button onClick={upload} disabled={busy}>{busy ? '上传中…' : '上传并入库'}</button>
        </div>
      </div>

      <div className="card">
        <div className="h2">已入库文档（{docs.length}）</div>
        {docs.length === 0 && <div className="muted">暂无文档，上传或点【刷新文档列表】加载</div>}
        {docs.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>ID</th><th>名称</th><th>切片数</th><th className="actions">操作</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{d.id}</td><td>{d.name}</td><td>{d.chunk_count}</td>
                        <td className="actions">
                            <button className="ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => previewDoc(d)} title="下载该文档的原始上传文件">下载</button>
                            <button className="ghost" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => toggleOpen(d)}>
                                {open === d.id ? '收起' : '检索预览'}
                            </button>
                            <button className="ghost" style={{ padding: '4px 12px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.3)' }} onClick={() => remove(d)}>
                                <Icon name="trash" size={13} /> 删除
                            </button>
                        </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}

        {open != null && (
          <div className="kb-preview card" style={{ marginTop: 14, border: '1px solid var(--brand)' }}>
            <div className="h2">检索预览</div>
            <p className="sub">输入一个问题，验证该文档能否被检索命中、命中哪些切片（对全库混合检索后按本文档过滤）。</p>
            <div className="row">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="例如：你们的营业时间是？"
                onKeyDown={(e) => e.key === 'Enter' && previewSearch()}
              />
              <button onClick={previewSearch} disabled={previewBusy} style={{ flex: '0 0 auto' }}>
                {previewBusy ? '检索中…' : '检索'}
              </button>
            </div>
            {preview?.hint && !preview.hits.length && <div className="muted" style={{ marginTop: 12 }}>{preview.hint}</div>}
            {preview && preview.hits.length > 0 && (
              <div className="kb-hits">
                {preview.hits.map((h) => (
                  <div key={h.id} className="kb-hit">
                    <div className="kb-hit-meta">
                      <span className="badge meta">Chunk #{h.chunkIndex}</span>
                      <span className="badge meta">score {h.score.toFixed(3)}</span>
                    </div>
                    <pre className="kb-hit-text mono">{h.text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </>
  );
}

function ModelsTab({ notify }: { notify: Notify }) {
  // 表单状态：editing=null 表示新增；否则为编辑对象的备份
  const [rows, setRows] = useState<ModelProviderRow[]>([]);
  const [edit, setEdit] = useState<ModelProviderRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState<ModelProviderInput>({
    name: '', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat',
    enabled: true, isDefault: false, task: 'default',
  });

  const load = async () => {
    setErr('');
    try { setRows(((await modelsApi.list()).providers ?? [])); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const startCreate = () => {
    setEdit(null);
    setForm({ name: '', baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', enabled: true, isDefault: !rows.some((r) => r.isDefault), task: 'default' });
  };
  const startEdit = (r: ModelProviderRow) => {
    if (r.source === 'env') { setErr('环境变量来源的提供商不支持编辑，请先新增一条 DB 配置'); return; }
    setErr('');
    setEdit(r);
    setForm({ name: r.name, baseUrl: r.baseUrl, apiKey: '', model: r.model, enabled: r.enabled, isDefault: r.isDefault, task: r.task });
  };

  const patch = (k: keyof ModelProviderInput, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!form.name.trim() || !form.baseUrl.trim() || !form.model.trim()) {
      setErr('请填写名称、Base URL 与模型'); return;
    }
    if (!edit && !form.apiKey.trim()) { setErr('新增时请填写 API Key'); return; }
    setErr(''); setBusy(true);
    try {
      const payload = {
        ...form,
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        // 保留原 apiKey：编辑时输入框留空表示不改动
        apiKey: form.apiKey.trim() || (edit?.apiKey ?? ''),
      };
      if (edit) {
        await modelsApi.update(edit.id, payload);
        notify('ok', `提供商「${payload.name}」已更新并实时生效`);
      } else {
        await modelsApi.create(payload);
        notify('ok', `提供商「${payload.name}」已新增并实时生效`);
      }
      setEdit(null); startCreate();
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const toggleEnabled = async (r: ModelProviderRow) => {
    setErr('');
    try {
      await modelsApi.update(r.id, {
        name: r.name, baseUrl: r.baseUrl, model: r.model,
        apiKey: r.apiKey, enabled: !r.enabled, isDefault: r.isDefault, task: r.task,
      });
      notify('ok', `${r.name} 已${r.enabled ? '停用' : '启用'}`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const setDefault = async (r: ModelProviderRow) => {
    setErr('');
    try {
      await modelsApi.update(r.id, {
        name: r.name, baseUrl: r.baseUrl, model: r.model,
        apiKey: r.apiKey, enabled: r.enabled, isDefault: true, task: r.task,
      });
      notify('ok', `${r.name} 已设为默认模型`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (r: ModelProviderRow) => {
    if (r.source === 'env') { setErr('环境变量来源的提供商无法删除'); return; }
    if (!window.confirm(`确认删除模型提供商「${r.name}」？网关将立即停止使用该配置。`)) return;
    setErr('');
    try {
      await modelsApi.remove(r.id);
      notify('ok', `提供商「${r.name}」已删除`);
      if (edit?.id === r.id) { setEdit(null); startCreate(); }
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <>
      <div className="card">
        <div className="h2">{edit ? `编辑提供商：${edit.name}` : '新增对话模型提供商'}</div>
        <p className="sub">配置网关实际调用的对话模型。DB 配置优先，保存后立即生效（无需重启网关）；未配置时自动回退到环境变量 LLM_UPSTREAMS。</p>
        <div className="models-grid">
          <div>
            <label>名称（唯一，如 deepseek）</label>
            <input value={form.name} onChange={(e) => patch('name', e.target.value)} placeholder="deepseek" disabled={!!edit} />
          </div>
          <div>
            <label>模型</label>
            <input value={form.model} onChange={(e) => patch('model', e.target.value)} placeholder="deepseek-chat" />
          </div>
          <div className="models-span">
            <label>Base URL</label>
            <input value={form.baseUrl} onChange={(e) => patch('baseUrl', e.target.value)} placeholder="https://api.deepseek.com/v1" className="mono" />
          </div>
          <div className="models-span">
            <label>API Key {edit && <span className="muted">（留空则保持不变）</span>}</label>
            <input type="password" value={form.apiKey} onChange={(e) => patch('apiKey', e.target.value)} placeholder={edit ? '•••••••（保持不变）' : 'sk-…'} className="mono" />
          </div>
          <div>
            <label>路由任务</label>
            <select value={form.task} onChange={(e) => patch('task', e.target.value)}>
              <option value="default">default（通用）</option>
              <option value="review">review（审核）</option>
            </select>
          </div>
        </div>
        <div className="models-checks">
          <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => patch('enabled', e.target.checked)} /> 启用</label>
          <label className="check"><input type="checkbox" checked={form.isDefault} onChange={(e) => patch('isDefault', e.target.checked)} /> 设为默认（无路由匹配时兜底）</label>
        </div>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="ghost" onClick={() => { setEdit(null); startCreate(); }}>重置</button>
          <button onClick={submit} disabled={busy}>{busy ? '保存中…' : (edit ? '保存修改' : '新增提供商')}</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="h2">已配置提供商（{rows.length}）</div>
          <button className="ghost" onClick={load} disabled={busy}>{busy ? '刷新中…' : '刷新'}</button>
        </div>
        {rows.length === 0 && !busy && <div className="muted">暂无配置，回退到环境变量 LLM_UPSTREAMS 运行。</div>}
        {rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr>
              <th>名称</th><th>模型</th><th>Base URL</th><th>API Key</th>
              <th>任务</th><th>状态</th><th className="actions">操作</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.isDefault && <span className="badge meta" style={{ marginLeft: 6 }}>默认</span>}
                    {r.source === 'env' && <span className="badge meta" style={{ marginLeft: 6, opacity: 0.6 }}>env</span>}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.model}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.baseUrl}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.apiKey}</td>
                  <td>{r.task}</td>
                  <td>{r.enabled ? <span className="badge ok" style={{ color: 'var(--ok)' }}>启用</span> : <span className="badge" style={{ color: 'var(--muted)' }}>停用</span>}</td>
                  <td className="actions">
                    {r.source === 'db' && !r.isDefault && (
                      <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setDefault(r)}>设默认</button>
                    )}
                    <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => toggleEnabled(r)}>
                      {r.enabled ? '停用' : '启用'}
                    </button>
                    <button className="ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => startEdit(r)}>编辑</button>
                    <button className="ghost" style={{ padding: '4px 10px', fontSize: 12, color: 'var(--danger)', borderColor: 'rgba(220,38,38,0.3)' }} onClick={() => remove(r)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </>
  );
}

function ReviewsTab({ notify }: { notify: Notify }) {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [expand, setExpand] = useState<number | null>(null);
  const [rejectText, setRejectText] = useState<Record<number, string>>({});

  const load = async () => {
    setErr(''); setBusy(true);
    try { setRows(((await reviews.list('pending')).reviews as unknown as ReviewRow[]) ?? []); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const act = async (id: number, mode: 'approve' | 'reject') => {
    setErr('');
    try {
      if (mode === 'approve') {
        await reviews.approve(id, { reviewerId: 'admin-console' });
        notify('ok', `工单 #${id} 已通过`);
      } else {
        await reviews.reject(id, { reviewerId: 'admin-console', revisedDraft: rejectText[id]?.trim() || undefined });
        notify('ok', `工单 #${id} 已驳回`);
      }
      setExpand(null);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="h2">待审核工单（{rows.length}）</div>
          <p className="sub" style={{ margin: 0 }}>confirm 级问题会生成冻结草稿进入此队列，审核通过后才会回复用户</p>
        </div>
        <button className="ghost" onClick={load} disabled={busy}>{busy ? '刷新中…' : '刷新'}</button>
      </div>
      {rows.length === 0 && !busy && <div className="muted">没有待审核工单 🎉</div>}
      {rows.map((r) => (
        <div key={r.id} className="review-item">
          <div className="head" onClick={() => setExpand(expand === r.id ? null : r.id)}>
            <span style={{ fontWeight: 600 }}>工单 #{r.id}</span>
            <span className={`badge ${r.riskLevel ?? ''}`}>{r.riskLevel ?? '?'}</span>
            <span className="head q">{r.originalQuery}</span>
            <span className="muted">{expand === r.id ? '收起 ▲' : '展开 ▼'}</span>
          </div>
          {expand === r.id && (
            <div>
              <div className="muted" style={{ marginTop: 10 }}>用户原问题</div>
              <div className="draft">{r.originalQuery}</div>
              <div className="muted" style={{ marginTop: 10 }}>冻结草稿（AI 拟回复）</div>
              <div className="draft">{r.draftResponse}</div>
              <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
                <div>
                  <label>驳回时可填写改写文本（可选）</label>
                  <input
                    value={rejectText[r.id] ?? ''}
                    onChange={(e) => setRejectText((p) => ({ ...p, [r.id]: e.target.value }))}
                    placeholder="改写后的回复内容…"
                  />
                </div>
                <div style={{ flex: '0 0 auto', display: 'flex', gap: 8, paddingBottom: 1 }}>
                  <button onClick={() => act(r.id, 'approve')}>通过</button>
                  <button className="danger" onClick={() => act(r.id, 'reject')}>驳回</button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function TraceTab({ notify }: { notify: Notify }) {
  const [traceId, setTraceId] = useState('');
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const look = async () => {
    if (!traceId.trim()) return;
    setErr(''); setBusy(true); setData(null);
    try { setData(await traceApi.get(traceId.trim())); }
    catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      notify('err', '未找到该 trace_id 或查询失败');
    }
    finally { setBusy(false); }
  };

  return (
    <div className="card">
      <div className="h2">全链路追踪</div>
      <p className="sub">输入 trace_id 查看一次对话的完整链路（可在聊天页回复底部复制）</p>
      <div className="row">
        <input
          value={traceId}
          onChange={(e) => setTraceId(e.target.value)}
          placeholder="trace_id"
          className="mono"
          onKeyDown={(e) => e.key === 'Enter' && look()}
        />
        <button onClick={look} disabled={busy} style={{ flex: '0 0 auto' }}>{busy ? '查询中…' : '查询'}</button>
      </div>
      {data && (
        <pre className="mono" style={{ background: 'var(--panel-2)', borderRadius: 'var(--radius)', padding: 14, marginTop: 14, maxHeight: 480, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(data, null, 2)}</pre>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}