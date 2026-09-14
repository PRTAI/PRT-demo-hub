import React, {useEffect,useState} from 'react';
import {api} from './api';
import {ErrorBox,date} from './components';
const labels={submit:'待审核提醒',withdraw:'撤回通知',reject:'返修通知',publish:'发布通知',unpublish:'下架通知',restore:'恢复发布通知',set_default:'默认版本通知'};
export function NotificationStatus() {
  const [items,setItems]=useState([]),[error,setError]=useState('');
  async function load(){try{setItems(await api('/admin/notifications'));setError('');}catch(e){setError(e.message);}}
  useEffect(()=>{load();},[]);
  async function retry(id){try{await api(`/admin/notifications/${id}/retry`,{method:'POST'});await load();}catch(e){setError(e.message);}}
  return <section className="settings-card"><h2>飞书通知</h2><p className="muted">审核流转通知员工与主管；发布、下架等状态变更同步归属人和产品经理。</p><button className="button" onClick={load}>刷新发送记录</button><ErrorBox>{error}</ErrorBox>{!items.length&&<p>暂无通知记录</p>}{items.map(n=><div className="file-row" key={n.id}><div><strong>{labels[n.kind]||n.kind} · {n.recipient||'未配置接收人'}</strong><small>{({pending:'等待发送 / 重试',sent:'发送成功',failed:'发送失败',skipped:'已取消'})[n.status]} · {date(n.created_at)}</small>{n.error&&<small>{n.error}</small>}</div>{n.status==='failed'&&<button className="button" onClick={()=>retry(n.id)}>重试</button>}</div>)}</section>;
}
