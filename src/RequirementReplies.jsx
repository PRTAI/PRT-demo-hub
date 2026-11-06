import React, { useEffect, useRef, useState } from 'react';
import { AtSign, CornerDownRight, MessageSquare, RefreshCw, Send, X } from 'lucide-react';
import { api } from './api';
import { Avatar, ErrorBox, Loading, date, roleLabels } from './components';
import { createRequestId } from './request-id.mjs';
import './requirement-replies.css';

const merge = (before, next) => [...new Map([...before, ...next].map(reply => [reply.id, reply])).values()].sort((left, right) => left.sequence - right.sequence);

export function RequirementReplies({ requirementId }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [loadingOlder, setLoadingOlder] = useState(false);
  const [content, setContent] = useState(''), [mentions, setMentions] = useState([]), [parent, setParent] = useState(null), [sending, setSending] = useState(false);
  const [picker, setPicker] = useState(null), [candidates, setCandidates] = useState([]), [peopleLoading, setPeopleLoading] = useState(false), [active, setActive] = useState(0);
  const textarea = useRef(null), latest = useRef(0), pending = useRef(null), fetching = useRef(false), alive = useRef(true);
  const endpoint = `/requirements/${requirementId}/replies`;
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  async function refresh(signal) {
    if (fetching.current) return;
    fetching.current = true;
    const cursor = latest.current;
    try {
      const result = await api(endpoint + (cursor ? '?' + new URLSearchParams({ after: cursor, limit: 100 }) : ''), { signal });
      if (!alive.current || signal?.aborted) return;
      latest.current = Math.max(latest.current, result.afterCursor || 0);
      setData(previous => previous ? { ...result, total: Math.max(previous.total, result.total), items: merge(previous.items, result.items),
        hasMore: cursor ? previous.hasMore : result.hasMore, beforeCursor: cursor ? previous.beforeCursor : result.beforeCursor } : result);
      setError('');
    } catch (error) {
      if (alive.current && !signal?.aborted) {
        setError(error.message);
        if ([401, 403, 404].includes(error.status)) setData(null);
      }
    } finally { fetching.current = false; }
  }
  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    const timer = setInterval(() => { if (!document.hidden) refresh(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [endpoint]);
  useEffect(() => {
    if (!picker) { setCandidates([]); return; }
    const controller = new AbortController(); setPeopleLoading(true); setCandidates([]); setActive(0);
    const timer = setTimeout(() => api(`/requirements/${requirementId}/reply-candidates?` + new URLSearchParams({ q: picker.query }), { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setCandidates(result.items); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setPeopleLoading(false); }), 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [requirementId, picker?.query, !!picker]);
  async function older() {
    setLoadingOlder(true);
    try {
      const result = await api(endpoint + '?' + new URLSearchParams({ before: data.beforeCursor }));
      if (alive.current) setData(previous => ({ ...previous, items: merge(result.items, previous.items), hasMore: result.hasMore, beforeCursor: result.beforeCursor || previous.beforeCursor }));
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setLoadingOlder(false); }
  }
  function changed(event) {
    const value = event.target.value, caret = event.target.selectionStart, match = value.slice(0, caret).match(/@([^\s@]{0,30})$/);
    setContent(value);
    setMentions(people => people.filter(person => value.includes('@' + person.name)));
    setPicker(match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null);
  }
  function pick(person) {
    if (!picker || sending) return;
    if (mentions.length >= 20 && !mentions.some(item => item.id === person.id)) { setError('每条回复最多 @ 20 人'); return; }
    const inserted = '@' + person.name + ' ', next = content.slice(0, picker.start) + inserted + content.slice(picker.end);
    if (next.length > 5000) { setError('回复最多 5000 字'); return; }
    const caret = picker.start + inserted.length;
    setContent(next); setMentions(people => [...people.filter(item => item.id !== person.id && next.includes('@' + item.name)), person]); setPicker(null);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(caret, caret); });
  }
  function keyboard(event) {
    if (!picker) return;
    if (event.key === 'Escape') { setPicker(null); event.preventDefault(); }
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && candidates.length) { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && candidates[active]) { event.preventDefault(); pick(candidates[active]); }
  }
  async function send(event) {
    event.preventDefault();
    if (sending || !content.trim()) return;
    const body = { content: content.trim(), parentId: parent?.id || null, mentionUserIds: mentions.map(person => person.id) };
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: createRequestId() };
    setSending(true); setError(''); setPicker(null);
    try {
      const reply = await api(endpoint, { method: 'POST', body: { ...body, requestId: pending.current.requestId } });
      if (!alive.current) return;
      // Keep the polling cursor until the intervening replies have been fetched.
      setData(previous => previous ? { ...previous, items: merge(previous.items, [reply]), total: previous.total + (previous.items.some(item => item.id === reply.id) ? 0 : 1) } : previous);
      setContent(''); setMentions([]); setParent(null); pending.current = null;
      await refresh();
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setSending(false); }
  }
  return <section className="requirement-replies" aria-label="需求回复">
    <div className="requirement-replies-heading"><h3><MessageSquare size={18}/>回复与进展{data && <span>{data.total}</span>}</h3><button type="button" className="button small" onClick={() => refresh()}><RefreshCw size={14}/>刷新回复</button></div>
    <ErrorBox>{error}</ErrorBox>
    {!data ? !error && <Loading/> : <>
      {data.hasMore && <button type="button" className="button small" disabled={loadingOlder} onClick={older}>{loadingOlder ? '加载中…' : '加载更早回复'}</button>}
      <div className="requirement-replies-list" aria-live="polite">{data.items.map(reply => <article className="requirement-reply" key={reply.id}>
        <Avatar user={reply.author} small/><div className="requirement-reply-main"><div className="requirement-reply-meta"><strong>{reply.author.name}</strong><time dateTime={reply.createdAt}>{date(reply.createdAt)}</time>{data.canReply && <button type="button" className="requirement-reply-action" disabled={sending} onClick={() => { setParent(reply); textarea.current?.focus(); }}><CornerDownRight size={13}/>回复</button>}</div>
          {reply.parent && <blockquote>回复 {reply.parent.authorName}：{reply.parent.content}</blockquote>}
          <p>{reply.content}</p>
          {!!reply.mentions.length && <div className="requirement-reply-mentions">{reply.mentions.map(person => <span key={person.id}>@{person.name}</span>)}</div>}
        </div>
      </article>)}{!data.items.length && <p className="muted">暂无回复，可以在这里反馈问题和交付进展。</p>}</div>
      {data.canReply ? <form className="requirement-reply-form" onSubmit={send}>
        {parent && <div className="requirement-reply-parent"><span>回复 {parent.author.name}：{parent.content}</span><button type="button" className="icon-button" aria-label="取消回复对象" disabled={sending} onClick={() => setParent(null)}><X size={14}/></button></div>}
        <label className="field">回复内容<textarea ref={textarea} aria-label="需求回复内容" rows={4} maxLength={5000} value={content} onChange={changed} onKeyDown={keyboard} disabled={sending} placeholder="反馈问题、补充说明或同步进展；输入 @ 可选择有权查看此需求的研发同学。"/></label>
        {picker && <div className="requirement-mention-picker"><div><AtSign size={14}/><span>选择提醒人员</span><button type="button" className="icon-button" aria-label="关闭人员选择" onClick={() => setPicker(null)}><X size={14}/></button></div><input aria-label="搜索回复提醒人员" placeholder="搜索研发人员姓名" value={picker.query} onChange={event => setPicker(value => ({ ...value, query: event.target.value }))}/><div className="requirement-mention-options">{peopleLoading ? <p>正在查找…</p> : candidates.map((person, index) => <button type="button" key={person.id} className={active === index ? 'active' : ''} onClick={() => pick(person)}><strong>{person.name}</strong><small>{person.roles.map(role => roleLabels[role] || role).join('、')}</small></button>)}{!peopleLoading && !candidates.length && <p>没有符合条件的研发人员；需先关联此需求，或具有独立查看权限。</p>}</div></div>}
        {!!mentions.length && <div className="requirement-reply-mentions">{mentions.map(person => <span key={person.id}>@{person.name}<button type="button" className="icon-button" aria-label={`取消提醒 ${person.name}`} disabled={sending} onClick={() => setMentions(people => people.filter(item => item.id !== person.id))}><X size={12}/></button></span>)}</div>}
        <div className="requirement-reply-toolbar"><button type="button" className="button small" disabled={sending} onClick={() => { const caret = textarea.current?.selectionStart ?? content.length; setPicker({ start: caret, end: caret, query: '' }); }}><AtSign size={15}/>提醒研发</button><small>选中的 @ 人员及被回复人将收到飞书提醒</small><span>{content.length}/5000</span><button type="submit" className="button primary small" disabled={sending || !content.trim()}><Send size={14}/>{sending ? '发送中…' : '发送回复'}</button></div>
      </form> : <p className="muted">当前为只读查看；项目经理、商务及直接关联人员可回复。</p>}
    </>}
  </section>;
}
