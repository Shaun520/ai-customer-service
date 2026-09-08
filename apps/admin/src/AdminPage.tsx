import { useEffect, useState } from 'react';
import { Icon } from '@aics/shared/web';
import { admin, knowledge, reviews, trace as traceApi } from './api';

type Tab = 'tenants' | 'kb' | 'reviews' | 'trace';

const INDUSTRIES = [
  { value: 'medical', label: '医疗 (medical)' },
  { value: 'ecommerce', label: '电商 (ecommerce)' },
  { value: 'tech', label: '科技 (tech)' },
  { value: 'general', label: '通用 (general)' },
];
const DEFAULT_ADMIN_TOKEN = 'change-me-admin-token';

interface TenantRow {
  id: number; slug: string; name: string; industry: string; systemPrompt?: string | null;
}
interface KbDoc { id: number; name: string; chunk_count: number; created_at?: string }
interface ReviewRow {
  id: number; originalQuery?: string; draftResponse?: string; riskLevel?: string;
  status?: string; traceId?: string; createdAt?: string;
}

const NAV: Array<{ key: Tab; icon: string; label: string }> = [
  { key: 'tenants', icon: 'building', label: '租户管理' },
  { key: 'kb', icon: 'book', label: '知识库' },
  { key: 'reviews', icon: 'clipboard', label: '人工审核' },
  { key: 'trace', icon: 'search', label: '全链路追踪' },
];

export default function AdminPage({ goChat }: { goChat: () => void }) {
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('aics_admin_token') ?? DEFAULT_ADMIN_TOKEN);
  const [draftToken, setDraftToken] = useState(adminToken);
  const [tab, setTab] = useState<Tab>('tenants');
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

          {tab === 'tenants' && <TenantsTab notify={notify} />}
          {tab === 'kb' && <KbTab notify={notify} />}
          {tab === 'reviews' && <ReviewsTab notify={notify} />}
          {tab === 'trace' && <TraceTab notify={notify} />}
        </div>
      </main>
    </div>
  );
}

type Notify = (kind: 'ok' | 'err', text: string) => void;

function TenantsTab({ notify }: { notify: Notify }) {
  const [list, setList] = useState<TenantRow[]>([]);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('medical');
  const [sysPrompt, setSysPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [keyFor, setKeyFor] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState<number | null>(null);

  const load = async () => {
    try { setList(((await admin.listTenants()).tenants as unknown as TenantRow[]) ?? []); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const create = async () => {
    if (!slug.trim() || !name.trim()) { setErr('请填写 slug 与名称'); return; }
    setBusy(true); setErr('');
    try {
      await admin.createTenant({ slug: slug.trim(), name: name.trim(), industry, systemPrompt: sysPrompt.trim() || undefined });
      notify('ok', '租户创建成功：' + slug.trim());
      setSlug(''); setName(''); setSysPrompt('');
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const issueKey = async (tenantSlug: string, tenantId: number) => {
    setErr('');
    try {
      const r = await admin.createApiKey({ tenantSlug, name: '前台客服' });
      setKeyFor((p) => ({ ...p, [tenantId]: r.api_key }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const copyKey = (tid: number, k: string) => {
    navigator.clipboard?.writeText(k);
    setCopied(tid);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <>
      <div className="card">
        <div className="h2">新建租户</div>
        <div className="row" style={{ marginTop: 6 }}>
          <div><label>slug（标识）</label><input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="demo-clinic" className="mono" /></div>
          <div><label>名称</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="康乐诊所" /></div>
          <div><label>行业</label>
            <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
              {INDUSTRIES.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </div>
        </div>
        <label>系统提示词（可选）</label>
        <textarea value={sysPrompt} onChange={(e) => setSysPrompt(e.target.value)} placeholder="客服话术风格 / 角色设定" />
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={create} disabled={busy}>{busy ? '创建中…' : '创建租户'}</button>
        </div>
      </div>

      <div className="card">
        <div className="h2">租户列表（{list.length}）</div>
        {list.length === 0 && <div className="muted">暂无租户，先在上方创建一个</div>}
        {list.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>ID</th><th>slug</th><th>名称</th><th>行业</th><th className="actions">操作</th></tr></thead>
            <tbody>
            {list.map((t) => (
                <tr key={t.id}>
                  <td>{t.id}</td><td className="mono">{t.slug}</td><td>{t.name}</td><td>{t.industry}</td>
                  <td className="actions"><button className="ghost" onClick={() => issueKey(t.slug, t.id)}>签发 API Key</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {Object.entries(keyFor).map(([tid, k]) => (
          <div key={tid} className="notice-banner" style={{ marginTop: 12 }}>
            租户 #{tid} 的新 Key（仅显示一次）：<span className="mono">{k}</span>{' '}
            <button className="ghost" style={{ padding: '2px 10px', fontSize: 12, marginLeft: 6 }} onClick={() => copyKey(Number(tid), k)}>
              <>{copied === Number(tid) && <Icon name="check" size={13} />}{copied === Number(tid) ? '已复制' : '复制'}</>
            </button>
            <div className="muted" style={{ marginTop: 4 }}>请妥善保存，填入对话页设置或知识库页使用。</div>
          </div>
        ))}
        {err && <div className="err">{err}</div>}
      </div>
    </>
  );
}

function KbTab({ notify }: { notify: Notify }) {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [slug, setSlug] = useState('');
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('aics_api_key') ?? '');
  const [docs, setDocs] = useState<KbDoc[]>([]);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    admin.listTenants().then((r) => {
      const rows = r.tenants as unknown as TenantRow[];
      setTenants(rows);
      if (rows[0]) setSlug(rows[0].slug);
    }).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const loadDocs = async () => {
    if (!apiKey.startsWith('aics_')) { setErr('请先填写该租户的 API Key（须 aics_ 开头）'); return; }
    setErr(''); setBusy(true);
    try {
      localStorage.setItem('aics_api_key', apiKey.trim());
      const res = await fetch('/v1/knowledge/documents', {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const r = (await res.json()) as { documents: KbDoc[] };
      setDocs(r.documents ?? []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const upload = async () => {
    if (!slug || !apiKey.startsWith('aics_') || !name.trim() || !text.trim()) {
      setErr('请填写租户对应 API Key、文档名与内容'); return;
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
        <div className="row">
          <div><label>租户</label>
            <select value={slug} onChange={(e) => setSlug(e.target.value)}>
              {tenants.map((t) => <option key={t.id} value={t.slug}>{t.name}（{t.slug}）</option>)}
            </select>
          </div>
          <div><label>该租户 API Key</label><input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="aics_xxxx_yyyy" className="mono" /></div>
        </div>
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
            <thead><tr><th>ID</th><th>名称</th><th>切片数</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}><td>{d.id}</td><td>{d.name}</td><td>{d.chunk_count}</td></tr>
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