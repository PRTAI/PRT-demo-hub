import React, { useEffect, useRef, useState } from 'react';
import { Bot, Plus, Send, Square, Download, RefreshCw, CheckCircle2, Clock3, Wrench } from 'lucide-react';
import { api, downloadFile } from './api';
import { ErrorBox, Loading, date } from './components';
import './ops.css';

const toolNames = { runtime_status: '检查运行状态', list_source: '查看源码目录', read_source: '读取源码', search_source: '搜索源码', write_source: '修改源码', delete_source: '移除源码文件', run_checks: '运行检查' };
const states = { pending: '等待午夜执行', running: '执行中', failed: '失败', complete: '已完成', superseded: '已合并到较新部署', cancelled: '已停止' };
function localTime(value) { return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '—'; }
export function OpsPage() {
  const [status, setStatus] = useState(null), [threads, setThreads] = useState([]), [selected, setSelected] = useState(null), [detail, setDetail] = useState(null), [input, setInput] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const bottom = useRef(null), selection = useRef(null); selection.current = selected;
  const run = detail?.runs?.[0], running = run?.status === 'running';
  async function loadStatus() { const [state, list] = await Promise.all([api('/ops/status'), api('/ops/threads')]); setStatus(state); setThreads(list); }
  async function loadThread(id) { const value = await api('/ops/threads/' + id); if (selection.current === id) setDetail(value); }
  useEffect(() => { loadStatus().catch(e => setError(e.message)); }, []);
  useEffect(() => { setDetail(null); if (selected) loadThread(selected).catch(e => setError(e.message)); }, [selected]);
  useEffect(() => {
    const timer = setInterval(() => { loadStatus().catch(e => setError(e.message)); if (selected) loadThread(selected).catch(e => setError(e.message)); }, running ? 1800 : 15000);
    return () => clearInterval(timer);
  }, [selected, running]);
  useEffect(() => { if (running) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [detail?.messages?.length]);
  async function newThread() { setBusy(true); setError(''); try { const value = await api('/ops/threads', { method: 'POST', body: { title: '新的运维会话' } }); setSelected(value.id); await loadStatus(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function send(event) {
    event.preventDefault(); if (!input.trim() || running) return;
    setBusy(true); setError('');
    try {
      let id = selected;
      if (!id) { const created = await api('/ops/threads', { method: 'POST', body: { title: input.trim().slice(0, 60) } }); id = created.id; selection.current = id; setSelected(id); }
      await api(`/ops/threads/${id}/messages`, { method: 'POST', body: { content: input.trim() } }); setInput(''); await loadThread(id); await loadStatus();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function cancel() { setError(''); try { await api(`/ops/threads/${selected}/cancel`, { method: 'POST' }); await loadThread(selected); } catch (e) { setError(e.message); } }
  async function download() { setBusy(true); setError(''); try { await downloadFile('/ops/source', 'prt-ops-source.json'); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  async function retry(id) { setError(''); try { await api(`/ops/maintenance/${id}/retry`, { method: 'POST' }); await loadStatus(); } catch (e) { setError(e.message); } }
  return <>
    <section className="page-heading"><div><div className="eyebrow">PLATFORM OPERATIONS</div><h1>DeepSeek 运维<span className="heading-dot">.</span></h1><p>描述需要开发的功能或遇到的问题，由虚拟运维员工在独立工作区完成代码修改与验证。</p></div><button className="button" disabled={busy || running || !status?.workerConfigured} onClick={download}><Download size={16}/>下载源码</button></section>
    <ErrorBox>{error}</ErrorBox>
    {!status ? <Loading/> : <>
      <div className="ops-identity"><span className="ops-avatar"><Bot size={24}/></span><div><strong>DeepSeek 运维 <span className="category-tag">虚拟员工 · 运维</span></strong><small>{status.model} · 思考强度 {status.reasoningEffort} · {status.maxTokens ? `输出上限 ${status.maxTokens}` : '使用模型默认输出额度'}</small></div><span className={`badge ${status.employee.enabled && status.modelConfigured && status.workerHealthy ? 'published' : 'offline'}`}><i/>{!status.employee.enabled ? '已停用' : !status.modelConfigured ? '待配置模型' : !status.workerConfigured ? '待启用工作器' : !status.workerHealthy ? '工作器不可用' : '可用'}</span></div>
      {!status.workerHealthy && <div className="admin-tip"><Wrench size={20}/><p>请按运维部署手册启用独立工作器，模型自动复用数据说明配置；配置完成后即可编辑源码并运行测试。</p></div>}
      <div className="ops-layout">
        <aside className="ops-threads"><button className="button" disabled={busy} onClick={newThread}><Plus size={16}/>新建会话</button>{threads.map(thread => <button key={thread.id} className={thread.id === selected ? 'active' : ''} onClick={() => { setError(''); setSelected(thread.id); }}><strong>{thread.title}</strong><small>{date(thread.updated_at)}</small></button>)}</aside>
        <section className="ops-conversation">
          <div className="ops-chat-title"><Bot size={18}/><strong>运维对话</strong><small>代码修改、测试及构建记录</small></div>
          <div className="ops-messages" aria-live="polite">
            {!detail?.messages?.length && <div className="ops-empty"><Bot size={38}/><h3>今天需要维护什么？</h3><p>例如：检查需求文档同步失败的原因，修复后运行测试和构建。</p><small>修改保存在独立工作区。验证完成后下载源码，使用更新脚本发布到平台。</small></div>}
            {detail?.messages?.map(message => message.role === 'activity' ? <Activity key={message.id} message={message}/> : <article key={message.id} className={`ops-message ${message.role}`}><strong>{message.role === 'user' ? '你' : 'DeepSeek 运维'}</strong><div>{message.content}</div></article>)}
            {running && <p className="ops-working"><Clock3 size={15}/>正在处理，可继续查看执行记录…</p>}
            {run?.error && <ErrorBox>{run.error}</ErrorBox>}
            <div ref={bottom}/>
          </div>
          <form className="ops-compose" onSubmit={send}><textarea aria-label="运维任务" rows={3} maxLength={12000} placeholder="描述要实现的功能或需要解决的问题…" value={input} onChange={event => setInput(event.target.value)} disabled={running || busy || !status.employee.enabled}/><div><span>仅运维角色可使用 · 对话按账号隔离</span>{running ? <button type="button" className="button" onClick={cancel}><Square size={14}/>停止任务</button> : <button className="button primary" disabled={busy || !input.trim() || !status.employee.enabled || !status.modelConfigured || !status.workerHealthy}><Send size={15}/>发送任务</button>}</div></form>
        </section>
      </div>
      <section className="settings-card ops-maintenance"><div className="panel-title"><div><h2>部署备份与代码归档</h2><span>北京时间 24:00 · {status.maintenance.repository} / {status.maintenance.branch}</span></div><button className="icon-button" aria-label="刷新运维状态" onClick={() => loadStatus().catch(e => setError(e.message))}><RefreshCw size={16}/></button></div><p className="muted">成功部署后，午夜备份数据库、上传文件与当次部署源码；校验成功后替换上一份本地备份，再提交核心代码。GitHub 未配置时仍先完成本地备份。</p><div className="ops-backup-location">备份目录：<code>{status.maintenance.backupDirectory}/latest</code></div>{!status.maintenance.enabled && <p className="muted">尚未启用自动归档，请按运维部署手册配置。</p>}{!status.maintenance.githubConfigured && <p className="muted">GitHub 凭据尚未配置，自动提交将在配置后重试。</p>}{status.maintenance.deployments.map(job => <div className="ops-deployment" key={job.id}><div><strong>{states[job.status] || job.status}</strong><small>部署 {localTime(job.deployed_at)} · 计划 {localTime(job.due_at)} · {job.source_hash.slice(0, 12)}</small>{job.backup && <small><CheckCircle2 size={12}/>本地备份已校验，{job.backup.files} 个文件</small>}{job.github?.sha && <small>GitHub 提交：{job.github.sha.slice(0, 12)}</small>}{job.error && <p>{job.error}</p>}</div>{job.status === 'failed' && <button className="button small" onClick={() => retry(job.id)}>重试</button>}</div>)}</section>
    </>}
  </>;
}
function Activity({ message }) {
  let value; try { value = JSON.parse(message.content); } catch { return null; }
  return <details className={`ops-activity ${value.state}`}><summary><Wrench size={13}/>{toolNames[value.tool] || value.tool}{value.path ? ` · ${value.path}` : ''}{value.kind ? ` · ${value.kind}` : ''}<span>{({ running: '执行中', complete: '完成', failed: '失败' })[value.state]}</span></summary>{value.error && <p>{value.error}</p>}{value.output && <pre>{value.output}</pre>}{value.success !== undefined && <p>{value.success ? '检查通过' : '检查未通过'}</p>}</details>;
}
