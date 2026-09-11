import { useEffect, useRef, useState } from 'react';
import { chatStream, type ChatMsg } from './api';
import { Icon } from '@aics/shared/web';
import { MarkdownContent } from './Markdown';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  meta?: {
    guardrail?: { verdict?: string; status?: string };
    status?: string;
    cached?: boolean;
    citations?: Array<{ documentName?: string; chunkIndex?: number; score?: number }>;
    trace_id?: string;
  };
  error?: boolean;
}

const SUGGESTIONS = ['诊所今天营业到几点？', '怎么预约挂号？', '退换货政策是什么？', '支持哪些支付方式？'];

const VERDICT_LABEL: Record<string, string> = { allow: '正常回答', confirm: '待人工确认', block: '已拦截' };

export default function ChatPage() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('aics_api_key') ?? '');
  const [disableCache, setDisableCache] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftKey, setDraftKey] = useState(apiKey);

  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  useEffect(() => {
    if (settingsOpen) setDraftKey(apiKey);
  }, [settingsOpen, apiKey]);

  const openSettings = () => {
    // 首次未配置 Key 时进入页面直接弹设置
    if (!localStorage.getItem('aics_api_key')) setSettingsOpen(true);
  };
  useEffect(openSettings, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveSettings = () => {
    const k = draftKey.trim();
    if (!k) {
      setErr('请填写统一网关 API Key（见网关配置 GATEWAY_API_KEY）');
      return;
    }
    setErr('');
    setApiKey(k);
    localStorage.setItem('aics_api_key', k);
    setSettingsOpen(false);
  };

  const send = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    const key = apiKey.trim();
    if ((!text && !overrideText) || busy) return;
    if (!key) {
      setErr('请先在右上角【设置】中填写 API Key');
      setSettingsOpen(true);
      return;
    }
    setErr('');
    if (!overrideText) setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    setMsgs((prev) => prev.concat({ role: 'user', content: text }, { role: 'assistant', content: '' }));
    setBusy(true);

    const history: ChatMsg[] = msgs.map((m) => ({ role: m.role, content: m.content })).concat({ role: 'user', content: text });

    try {
      let liveAcc = '';
      const res = await chatStream({ messages: history, apiKey: key, disableCache }, (delta) => {
        liveAcc += delta;
        setMsgs((prev) => {
          const copy = prev.slice();
          copy[copy.length - 1] = { role: 'assistant', content: liveAcc };
          return copy;
        });
      });
      setMsgs((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = { role: 'assistant', content: res.content, meta: res.meta };
        return copy;
      });
    } catch (e) {
      const em = e instanceof Error ? e.message : String(e);
      setMsgs((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = { role: 'assistant', content: '请求失败：' + em, error: true };
        return copy;
      });
    } finally {
      setBusy(false);
    }
  };

  const onTaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  };

  const showTyping = busy && msgs[msgs.length - 1]?.content === '';

  return (
    <div className="chat-app">
      <header className="chat-topbar">
        <div className="brand">
          <div className="logo"><Icon name="message" size={16} /></div>
          <span>AICS 智能客服</span>
        </div>
        <span className="status">在线</span>
        <div className="spacer">
          <button className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={16} /></button>
        </div>
      </header>

      <div className="chat-body">
        {msgs.length === 0 ? (
          <div className="welcome">
            <div className="big-logo"><Icon name="message" size={26} /></div>
            <h1>您好，请问有什么可以帮您？</h1>
            <p>我是 AI 客服助手，可以解答业务问题。您也可以从下面的问题开始：</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-thread">
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role} ${m.error ? 'error' : ''}`}>
                <div className="avatar"><Icon name={m.role === 'user' ? 'user' : 'bot'} size={16} /></div>
                <div className="bubble">
                  {m.role === 'assistant'
                    ? (m.content
                        ? <MarkdownContent text={m.content} />
                        : (showTyping && i === msgs.length - 1
                            ? <span className="typing"><i /><i /><i /></span>
                            : ''))
                    : (m.content || '')}
                  {m.role === 'assistant' && m.meta && m.content && (
                    <div className="bubble-meta">
                      {m.meta.guardrail?.verdict && (
                        <span className={`badge ${m.meta.guardrail.verdict}`}>{VERDICT_LABEL[m.meta.guardrail.verdict] ?? m.meta.guardrail.verdict}</span>
                      )}
                      {m.meta.status && <span className="badge meta">{m.meta.status}</span>}
                      {typeof m.meta.cached === 'boolean' && (
                        <span className="badge meta">{m.meta.cached ? '缓存' : '实时'}</span>
                      )}
                      {m.meta.citations?.map((c, ci) => (
                        <span key={ci} className="cite">
                          <Icon name="clip" size={12} /> {c.documentName ?? 'doc'}#{c.chunkIndex ?? '?'}
                          {typeof c.score === 'number' ? ' · ' + c.score.toFixed(3) : ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
            onKeyDown={onTaKeyDown}
            placeholder="输入您的问题，Enter 发送，Shift + Enter 换行"
            disabled={busy}
          />
          <button onClick={() => send()} disabled={busy || !input.trim()}>{busy ? '生成中…' : '发送'}</button>
        </div>
        <div className="composer-hint">内容由 AI 生成，仅供参考</div>
      </div>

      {err && !settingsOpen && (
        <div className="modal-mask" onClick={() => setErr('')}>
          <div className="notice-banner error" style={{ margin: 0 }}>{err}（点击任意处关闭）</div>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div className="h2">设置</div>
              <button className="icon-btn" aria-label="关闭" onClick={() => setSettingsOpen(false)}><Icon name="x" size={16} /></button>
            </div>
            <label>API Key（统一网关 Key，见网关配置 GATEWAY_API_KEY）</label>
            <input
              value={draftKey}
              onChange={(e) => setDraftKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveSettings()}
              placeholder="aics_xxxx_yyyy"
              className="mono"
              autoFocus
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 14 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={disableCache}
                onChange={(e) => setDisableCache(e.target.checked)}
              />
              禁用缓存（涉及实时价格 / 个人隐私时勾选）
            </label>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setSettingsOpen(false)}>取消</button>
              <button onClick={saveSettings}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
