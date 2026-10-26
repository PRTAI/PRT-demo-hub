import React, {useEffect,useState} from 'react';
import {api} from './api';
import {ErrorBox,date} from './components';
const labels={submit:'待审核提醒',withdraw:'撤回通知',reject:'返修通知',publish:'发布通知',unpublish:'下架通知',restore:'恢复发布通知',set_default:'默认版本通知',requirement_publish:'新需求发布通知',requirement_calendar:'需求日程卡片',description_generated:'AI 数据说明完成通知'};
export function NotificationStatus() {
  const [items,setItems]=useState([]),[error,setError]=useState('');
  async function load(){try{setItems(await api('/admin/notifications'));setError('');}catch(e){setError(e.message);}}
  useEffect(()=>{load();},[]);
  async function retry(id){try{await api(`/admin/notifications/${id}/retry`,{method:'POST'});await load();}catch(e){setError(e.message);}}
  return <><section className="settings-card"><h2>飞书通知</h2><p className="muted">新需求发布时通知全部负责人和发布人，重复人员只通知一次；Demo 审核和发布通知继续按原规则发送。</p><button className="button" onClick={load}>刷新发送记录</button><ErrorBox>{error}</ErrorBox>{!items.length&&<p>暂无通知记录</p>}{items.map(n=><div className="file-row" key={n.id}><div><strong>{labels[n.kind]||n.kind} · {n.recipient||'未配置接收人'}</strong><small>{({pending:'等待发送 / 重试',sent:'发送成功',failed:'发送失败',skipped:'已取消'})[n.status]} · {date(n.created_at)}</small>{n.error&&<small>{n.error}</small>}</div>{n.status==='failed'&&<button className="button" onClick={()=>retry(n.id)}>重试</button>}</div>)}</section><RequirementCalendarStatus/><RequirementWikiStatus/></>;
}

function RequirementWikiStatus() {
  const [items, setItems] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try { setItems(await api('/admin/requirement-wiki')); setError(''); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);
  async function retry(id) {
    setBusy(true);
    try { await api(`/admin/requirement-wiki/${id}/retry`, { method: 'POST' }); await load(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <section className="settings-card"><h2>需求飞书文档同步</h2>
    <p className="muted">发布需求时在 sample 同目录新建文档，保存需求简述、需求文档下载链接，并为负责人和发布人授予编辑权限。以下展示最近 100 条记录，失败时请检查知识库、文档和协作者权限。</p>
    <button type="button" className="button" disabled={busy} onClick={load}>刷新文档记录</button><ErrorBox>{error}</ErrorBox>
    {!items.length && <p>暂无需求飞书文档记录</p>}
    {items.map(item => <div className="file-row" key={item.requirement_id}><div><strong>{item.title}</strong><small>{({ pending: '等待同步 / 重试', synced: '同步成功', failed: '同步失败' })[item.status]}{item.syncedAt ? ` · ${date(item.syncedAt)}` : ''}</small>{item.error && <small>{item.error}</small>}{item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">打开飞书文档</a>}</div>{item.status !== 'pending' && <button type="button" className="button" disabled={busy} onClick={() => retry(item.requirement_id)}>重新同步</button>}</div>)}
  </section>;
}

function RequirementCalendarStatus() {
  const [items, setItems] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try { setItems(await api('/admin/requirement-calendar')); setError(''); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  useEffect(() => { load(); }, []);
  async function retry(id) {
    setBusy(true);
    try { await api(`/admin/requirement-calendar/${id}/retry`, { method: 'POST' }); await load(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <section className="settings-card"><h2>需求日历同步</h2>
    <p className="muted">每条需求对应一个飞书日程，负责人、日期、标题和状态变化会更新同一日程。邀请成功后另发日程卡片，卡片发送结果在上方“飞书通知”查看。以下展示最近 100 条日历记录；连续失败 5 次后，可在检查飞书权限后重试。</p>
    <button type="button" className="button" disabled={busy} onClick={load}>刷新同步记录</button><ErrorBox>{error}</ErrorBox>
    {!items.length && <p>暂无需求日历记录</p>}
    {items.map(item => <div className="file-row" key={item.requirement_id}><div><strong>{item.title}</strong><small>{({ pending: '等待同步 / 重试', synced: '同步成功', failed: '同步失败' })[item.status]} · {date(item.synced_at || item.updated_at)}</small>{item.error && <small>{item.error}</small>}{item.app_link && <a href={item.app_link} target="_blank" rel="noopener noreferrer">打开飞书日程</a>}</div>{item.status === 'failed' && <button type="button" className="button" disabled={busy} onClick={() => retry(item.requirement_id)}>重试同步</button>}</div>)}
  </section>;
}
