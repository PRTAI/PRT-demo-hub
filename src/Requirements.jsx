import React, { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, CalendarDays, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, FileText, Forward, Link2, Plus, Search, Users, X } from 'lucide-react';
import { api, downloadFile, uploadRequirementDocument } from './api';
import { Badge, Empty, ErrorBox, Loading, Modal, bytes, date, roleLabels } from './components';
import { appendRequirementDocuments } from './requirement-documents.mjs';
import { textLinks, feishuDocumentLink } from '../shared/requirement-links.mjs';
import { requirementDate, requirementDeadlineState } from '../shared/requirement-schedule.mjs';
import { businessOwnerRoles, developmentOwnerRoles } from '../shared/requirement-owners.mjs';
import './requirements.css';

const blank = { title: '', content: '', category: '', businessUserIds: [], developmentUserIds: [], publishDate: '', deadlineDate: '' };
const statusLabels = { open: '进行中', needs_update: '待更新', delivered: '已交付', closed: '已关闭' };
const statusLabel = status => statusLabels[status] || status;
const statusOptions = [{ value: 'all', label: '全部需求' }, ...Object.entries(statusLabels).map(([value, label]) => ({ value, label }))];
function Pager({ data, onPage, busy }) { return <div className="table-footer"><span>共 {data.total} 项 · 第 {data.page} / {data.pages} 页</span><div className="pagination"><button type="button" className="icon-button" aria-label="上一页" disabled={busy || data.page <= 1} onClick={() => onPage(data.page - 1)}><ChevronLeft size={17}/></button><button type="button" className="icon-button" aria-label="下一页" disabled={busy || data.page >= data.pages} onClick={() => onPage(data.page + 1)}><ChevronRight size={17}/></button></div></div>; }

export function RequirementPicker({ value, onChange, initialItems = [], disabled = false }) {
  const [query, setQuery] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [known, setKnown] = useState(initialItems), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { const controller = new AbortController(); setLoading(true); const timer = setTimeout(() => api('/requirements?' + new URLSearchParams({ q: query, status: 'active', page: String(page) }), { signal: controller.signal }).then(result => { setData(result); setError(''); setKnown(items => [...items.filter(item => !result.items.some(next => next.id === item.id)), ...result.items]); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }), query ? 200 : 0); return () => { clearTimeout(timer); controller.abort(); }; }, [query, page]);
  return <section className="requirement-picker"><div className="requirement-picker-heading"><strong>关联需求</strong><span>可选多个；提交或发布前至少绑定一个需求</span></div><div className="requirement-tags">{value.map(id => <span key={id}>{known.find(item => item.id === id)?.title || '已选需求'}<button type="button" className="icon-button" aria-label={`移除需求 ${id}`} disabled={disabled} onClick={() => onChange(value.filter(item => item !== id))}><X size={13}/></button></span>)}</div><div className="search-box"><Search size={16}/><input aria-label="搜索可绑定需求" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder="按标题、内容或发布人搜索需求" disabled={disabled}/></div><ErrorBox>{error}</ErrorBox>{loading ? <Loading/> : <div className="requirement-options">{data?.items.map(item => <label key={item.id}><input type="checkbox" checked={value.includes(item.id)} disabled={disabled || (!value.includes(item.id) && value.length >= 20)} onChange={event => onChange(event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))}/><span><strong>{item.title}</strong><small>{item.publisher.name} · {item.category || '未分类'}</small></span></label>)}{!data?.items.length && <p className="muted">暂无匹配的进行中需求，请联系产品经理或商务发布。</p>}</div>}{data && data.pages > 1 && <Pager data={data} onPage={setPage} busy={loading}/>}</section>;
}

export function RequirementsPage({ user, config, selectedId, refreshKey, onSelect, onOpenDemo, onCreateDemo, notify, onChanged, assignedOnly = false }) {
  const [query, setQuery] = useState(''), [status, setStatus] = useState('all'), [page, setPage] = useState(1), [data, setData] = useState(null), [detail, setDetail] = useState(null), [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0), [binding, setBinding] = useState(false);
  const [assigneeUsers, setAssigneeUsers] = useState([]), [pendingDocuments, setPendingDocuments] = useState([]), [uploadProgress, setUploadProgress] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportJob, setExportJob] = useState(null), [exportRefresh, setExportRefresh] = useState(0);
  const canPublish = user.roles.some(role => ['pm', 'business'].includes(role));
  const canExport = user.roles.includes('pm');
  const canCreateDemo = user.roles.some(role => ['employee', 'supervisor'].includes(role));
  const exportStorageKey = `prt-requirement-export-${user.id}`;
  useEffect(() => {
    let id;
    try { id = sessionStorage.getItem(exportStorageKey); } catch { /* Progress recovery is optional. */ }
    setExportJob(canExport && id ? { id, status: 'pending' } : null);
  }, [exportStorageKey, canExport]);
  useEffect(() => {
    if (!canExport || !exportJob?.id) return;
    const controller = new AbortController(); let timer;
    async function check() {
      try {
        const result = await api(`/requirements/exports/${exportJob.id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setExportJob(result);
        if (result.status === 'ready') {
          await downloadFile(`/requirements/exports/${result.id}/file.xlsx`, `${result.filters.assigned === '1' ? '我的需求' : '需求中心'}-${requirementDate()}.xlsx`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          try { sessionStorage.removeItem(exportStorageKey); } catch { /* Progress recovery is optional. */ }
          setExportJob(null); setReload(value => value + 1);
          notify(result.preview ? '演示模式：已导出表格，未创建或更新外部飞书文档' : `Excel 已导出，已同步 ${result.completed} 条需求的飞书文档`);
        } else if (result.status === 'pending') timer = setTimeout(check, 2500);
      } catch (error) {
        if (controller.signal.aborted) return;
        setError(error.message);
        if (error.status === 404) {
          try { sessionStorage.removeItem(exportStorageKey); } catch { /* Progress recovery is optional. */ }
          setExportJob(null);
        }
      }
    }
    check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [exportJob?.id, exportRefresh, canExport, exportStorageKey]);
  useEffect(() => { if (canPublish) api('/requirements/assignees').then(result => setAssigneeUsers(result.items)).catch(error => setError(error.message)); }, [canPublish]);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(''); setDetail(null); setEditing(null); setBinding(false); const timer = setTimeout(() => { const url = selectedId ? `/requirements/${selectedId}` : '/requirements?' + new URLSearchParams({ q: query, status, assigned: assignedOnly ? '1' : '0', page: String(page) }); api(url, { signal: controller.signal }).then(result => selectedId ? setDetail(result) : setData(result)).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, !selectedId && query ? 200 : 0); return () => { clearTimeout(timer); controller.abort(); }; }, [selectedId, query, status, page, reload, refreshKey, assignedOnly]);
  function refresh() { setReload(value => value + 1); onChanged(); }
  async function exportRequirements() {
    if (!canExport) return;
    setExporting(true); setError('');
    try {
      const job = await api('/requirements/exports', { method: 'POST', body: { q: query, status, assigned: assignedOnly ? '1' : '0' } });
      try { sessionStorage.setItem(exportStorageKey, job.id); } catch { /* Progress recovery is optional. */ }
      setExportJob(job);
    } catch (error) { setError(error.message); }
    finally { setExporting(false); }
  }
  async function retryExport() {
    if (!canExport || !exportJob) return;
    setExporting(true); setError('');
    try { setExportJob(await api(`/requirements/exports/${exportJob.id}/retry`, { method: 'POST' })); setExportRefresh(value => value + 1); }
    catch (error) { setError(error.message); }
    finally { setExporting(false); }
  }
  function closeExport() {
    try { sessionStorage.removeItem(exportStorageKey); } catch { /* Progress recovery is optional. */ }
    setExportJob(null);
  }
  function cancelEdit() { if (window.confirm('放弃尚未保存的需求内容？')) { setEditing(null); setError(''); setPendingDocuments([]); } }
  async function save(event) {
    event.preventDefault();
    const publishDate = editing.publishDate || editing.plannedDate || requirementDate(), deadlineDate = editing.deadlineDate || '';
    if (deadlineDate && deadlineDate < publishDate) { setError('截止日期不能早于发布日期'); return; }
    const invalid = pendingDocuments.find(file => !file.size || file.size > (config?.maxFileMB || 512) * 1048576);
    if (invalid) { setError(`文档「${invalid.name}」为空或超过单文件大小限制，请移除后重新选择`); return; }
    setBusy(true); setError(''); let saved = false;
    try {
      const result = await api(editing.id ? `/requirements/${editing.id}` : '/requirements', { method: editing.id ? 'PUT' : 'POST', body: { title: editing.title, content: editing.content, category: editing.category, businessUserIds: editing.businessUserIds || editing.businessOwners?.map(user => user.id) || [], developmentUserIds: editing.developmentUserIds || editing.developmentOwners?.map(user => user.id) || [], publishDate, deadlineDate, ...(editing.id ? { revision: editing.revision } : {}) } });
      saved = true; setEditing(current => ({ ...current, id: result.id, revision: result.revision }));
      for (const file of pendingDocuments) {
        setUploadProgress(0);
        const uploaded = await uploadRequirementDocument(result.id, file, progress => setUploadProgress(progress));
        setEditing(current => ({ ...current, revision: uploaded.revision }));
        setPendingDocuments(files => files.filter(item => item !== file));
      }
      setUploadProgress(0); setEditing(null); onSelect(result.id); refresh(); notify(editing.id ? '需求已更新' : '需求已发布');
    } catch (error) { setError(saved ? `需求内容已保存，未完成的文档上传可再次保存重试：${error.message}` : error.message); }
    finally { setBusy(false); }
  }
  async function changeStatus(next) { if (next === detail.status) return; if (!window.confirm(`确认将需求状态修改为“${statusLabel(next)}”？`)) return; setBusy(true); setError(''); try { await api(`/requirements/${detail.id}/actions`, { method: 'POST', body: { revision: detail.revision, action: 'set_status', status: next } }); refresh(); notify('需求状态已更新'); } catch (error) { setError(error.message); } finally { setBusy(false); } }
  async function unbind(asset) { if (!window.confirm(`解除与「${asset.latest.description.title || '未命名 Demo'}」的绑定？`)) return; setBusy(true); setError(''); try { await api(`/requirements/${detail.id}/demos/${asset.id}`, { method: 'DELETE', body: { revision: asset.revision } }); refresh(); notify('绑定已解除'); } catch (error) { setError(error.message); } finally { setBusy(false); } }
  if (editing) return <RequirementForm editing={editing} setEditing={setEditing} config={config} assigneeUsers={assigneeUsers} pendingDocuments={pendingDocuments} setPendingDocuments={setPendingDocuments} uploadProgress={uploadProgress} error={error} busy={busy} save={save} cancelEdit={cancelEdit}/>;
  return <>
    <section className="page-heading"><div><div className="eyebrow">BUSINESS REQUIREMENTS</div><h1>{assignedOnly ? '我的需求' : '需求中心'}<span className="heading-dot">.</span></h1><p>{assignedOnly ? '查看指定给当前账号的业务需求和交付进展。' : '从业务需求出发，关联数据样例并跟进演示准备。'}</p></div>{canPublish && !assignedOnly && <button className="button primary" disabled={busy} onClick={() => { setError(''); setPendingDocuments([]); setEditing({ ...blank }); }}><Plus size={17}/>发布需求</button>}</section>
    <ErrorBox>{error}</ErrorBox>
    {selectedId ? <>
      <button type="button" className="button requirement-back" onClick={() => onSelect(null)}><ArrowLeft size={16}/>返回需求列表</button>
      {loading ? <Loading/> : detail && <RequirementDetail detail={detail} canCreateDemo={canCreateDemo} busy={busy} binding={binding} setBinding={setBinding} onCreateDemo={onCreateDemo} onOpenDemo={onOpenDemo} onEdit={() => { setPendingDocuments([]); setEditing({ ...detail, assignedUserIds: detail.assignedUsers.map(item => item.id) }); }} onStatus={changeStatus} onUnbind={unbind} onBound={() => { refresh(); notify('Demo 已绑定'); }} onForwarded={count => { refresh(); notify(count ? `需求已转发，新增关联 ${count} 人` : '所选人员已关联，无需重复转发'); }}/>}</> :
      <RequirementList data={data} loading={loading} query={query} setQuery={value => { setQuery(value); setPage(1); }} status={status} setStatus={value => { setStatus(value); setPage(1); }} onSelect={onSelect} canPublish={canPublish} canExport={canExport} page={page} onPage={setPage} exporting={exporting} exportJob={exportJob} onExport={exportRequirements} onRetryExport={retryExport} onRefreshExport={() => { setError(''); setExportRefresh(value => value + 1); }} onCloseExport={closeExport}/>
    }
  </>;
}

function RequirementForm({ editing, setEditing, config, assigneeUsers, pendingDocuments, setPendingDocuments, uploadProgress, error, busy, save, cancelEdit }) {
  const documentInput = useRef(null);
  const publishDate = editing.publishDate || editing.plannedDate || requirementDate();
  return <>
    <section className="page-heading"><div><div className="eyebrow">BUSINESS REQUIREMENTS</div><h1>{editing.id ? '编辑需求' : '发布需求'}<span className="heading-dot">.</span></h1><p>说明业务场景、需要的数据和验收标准，方便团队准备 Demo。</p></div></section>
    <form className="settings-card requirement-form" onSubmit={save}>
      <ErrorBox>{error}</ErrorBox>
      <label className="field">需求标题 <b>*</b><input autoFocus required maxLength={120} value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} disabled={busy}/></label>
      <label className="field">业务分类<select value={editing.category} onChange={event => setEditing({ ...editing, category: event.target.value })} disabled={busy}><option value="">未分类</option>{[...new Set([...(config?.categories || []), editing.category].filter(Boolean))].map(category => <option key={category}>{category}</option>)}</select></label>
      <div className="requirement-date-fields">
        <label className="field">发布日期 <b>*</b><input type="date" min="1900-01-01" max="2199-12-31" required value={publishDate} onChange={event => setEditing({ ...editing, publishDate: event.target.value })} disabled={busy}/><small>默认今天（北京时间）。</small></label>
        <label className="field">截止日期（可选）<input type="date" min={publishDate} max="2199-12-31" value={editing.deadlineDate || ''} onChange={event => setEditing({ ...editing, deadlineDate: event.target.value })} disabled={busy}/><small>填写后，飞书全天日程覆盖发布日至截止日，不占用忙闲时间。</small></label>
      </div>
      <label className="field">需求内容 <b>*</b><textarea required rows={12} maxLength={20000} value={editing.content} onChange={event => setEditing({ ...editing, content: event.target.value })} disabled={busy} placeholder="请描述业务背景、演示场景、所需数据内容及验收标准。"/></label>
      <div className="requirement-owner-fields">
        <OwnerPicker title="商务负责人" description="负责业务沟通与客户对接" users={assigneeUsers} roles={businessOwnerRoles} selectedUsers={editing.businessOwners || []} value={editing.businessUserIds || editing.businessOwners?.map(user => user.id) || []} onChange={ids => setEditing(current => ({ ...current, businessUserIds: ids }))} disabled={busy}/>
        <OwnerPicker title="研发负责人" description="负责技术实现与 Demo 交付" users={assigneeUsers} roles={developmentOwnerRoles} selectedUsers={editing.developmentOwners || []} value={editing.developmentUserIds || editing.developmentOwners?.map(user => user.id) || []} onChange={ids => setEditing(current => ({ ...current, developmentUserIds: ids }))} disabled={busy}/>
      </div>
      <p className="requirement-owner-hint">两组均可不选或多选。发布后通知两组负责人及发布人，并邀请参加需求日程；转发新增人员归入研发负责人。</p>
      <div className="requirement-document-picker">
        <strong>需求文档（可选，可多选）</strong>
        <p className="muted">可按住 Ctrl 或 Shift 一次选择多个文件，也可多次点击添加，已选文件会保留。单文件 ≤ {config?.maxFileMB || 512} MB。</p>
        <input ref={documentInput} type="file" multiple hidden aria-label="选择需求文档" disabled={busy} onChange={event => { const files = Array.from(event.target.files || []); setPendingDocuments(current => appendRequirementDocuments(current, files)); event.target.value = ''; }}/>
        <button type="button" className="button" disabled={busy} onClick={() => documentInput.current.click()}><Plus size={16}/>添加需求文档</button>
        {!!editing.documents?.length && <p className="muted">已保存 {editing.documents.length} 个文档，本次添加会保留已有文档。</p>}
        <p className="muted" role="status">待上传 {pendingDocuments.length} 个文档{busy && uploadProgress > 0 ? ` · 当前文件上传进度 ${uploadProgress}%` : ''}</p>
        <div className="requirement-pending-documents">{pendingDocuments.map((file, index) => <div key={index}><FileText size={16}/><span>{file.name}<small>{bytes(file.size)}</small></span><button type="button" className="icon-button" disabled={busy} aria-label={`移除待上传文档 ${file.name}`} onClick={() => setPendingDocuments(current => current.filter(item => item !== file))}><X size={16}/></button></div>)}</div>
      </div>
      <div className="requirement-actions"><button type="button" className="button" onClick={cancelEdit} disabled={busy}>取消</button><button className="button primary" disabled={busy || !editing.title.trim() || !editing.content.trim()}>{busy ? '保存中…' : editing.id ? '保存修改' : '发布需求'}</button></div>
    </form>
  </>;
}

function OwnerPicker({ title, description, users, roles, selectedUsers, value, onChange, disabled }) {
  const [query, setQuery] = useState('');
  const candidates = [...new Map([...users.filter(user => user.roles.some(role => roles.includes(role))), ...selectedUsers].map(user => [user.id, user])).values()];
  const matches = candidates.filter(user => user.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <fieldset className="requirement-owner-picker" disabled={disabled}>
    <legend>{title}<span>可选 · 可多选</span></legend>
    <div className="requirement-owner-heading"><span>{description}</span><strong>已选 {value.length} 人</strong></div>
    <div className="search-box"><Search size={15}/><input aria-label={`搜索${title}`} placeholder="输入姓名搜索" value={query} onChange={event => setQuery(event.target.value)} disabled={disabled}/></div>
    <div className="requirement-owner-options">{matches.map(user => <label key={user.id}>
      <input type="checkbox" aria-label={`${title} ${user.name}`} checked={value.includes(user.id)} disabled={disabled || !user.enabled && !value.includes(user.id)} onChange={event => onChange(event.target.checked ? [...value, user.id] : value.filter(id => id !== user.id))}/>
      <span>{user.name}<small>{!user.enabled ? '已停用，可取消关联' : user.roles.some(role => roles.includes(role)) ? user.roles.map(role => roleLabels[role] || role).join('、') : '原关联人员'}</small></span>
    </label>)}{!matches.length && <p className="muted">{query ? '暂无匹配人员' : '暂无可选人员'}</p>}</div>
  </fieldset>;
}

function RequirementList({ data, loading, query, setQuery, status, setStatus, onSelect, canPublish, canExport, page, onPage, exporting, exportJob, onExport, onRetryExport, onRefreshExport, onCloseExport }) {
  return <section className="asset-panel requirements-panel">
    <div className="filter-row"><div className="search-box"><Search size={17}/><input aria-label="搜索需求或负责人" placeholder="搜索负责人、需求标题、内容或发布人…" value={query} onChange={event => setQuery(event.target.value)}/></div><StatusMenu value={status} onChange={setStatus} ariaLabel="需求状态"/>{canExport && data?.canExport && <button type="button" className="button" disabled={loading || exporting || ['pending', 'ready'].includes(exportJob?.status) || !data?.total} onClick={onExport} title="同步当前筛选下的需求飞书文档，完成后导出全部结果"><ArrowDownToLine size={16}/>{exporting ? '提交中…' : exportJob?.status === 'pending' ? '同步文档中…' : exportJob?.status === 'ready' ? '下载中…' : '导出 Excel'}</button>}</div>
    {canExport && exportJob && <div className="requirement-export-progress" role="status" aria-live="polite">
      <strong>{exportJob.status === 'ready' ? '文档同步完成，正在准备下载表格' : exportJob.status === 'failed' ? '部分飞书文档同步失败，请重试失败项' : '正在创建或更新筛选需求的飞书文档'}</strong>
      <p>{exportJob.total === undefined ? '正在恢复导出进度…' : `共 ${exportJob.total} 条需求 · 已完成 ${exportJob.completed} 条 · 等待 ${exportJob.pending} 条${exportJob.failed ? ` · 失败 ${exportJob.failed} 条` : ''}`}</p>
      {exportJob.filters && <p>本次范围：{exportJob.filters.assigned === '1' ? '我的需求' : '需求中心'} · {exportJob.filters.status === 'all' ? '全部状态' : statusLabel(exportJob.filters.status)}{exportJob.filters.q ? ` · 搜索“${exportJob.filters.q}”` : ''}。完成后自动下载；后台同步期间可继续使用平台。</p>}
      {!!exportJob.errors?.length && <details open={exportJob.status === 'failed'}><summary>查看失败需求{exportJob.failed > exportJob.errors.length ? `（仅显示前 ${exportJob.errors.length} 条）` : ''}</summary><ul>{exportJob.errors.map(item => <li key={item.requirementId}><a href={`/?view=requirements&requirement=${encodeURIComponent(item.requirementId)}`} target="_blank" rel="noopener noreferrer">{item.title}</a>：{item.error}</li>)}</ul></details>}
      <div className="requirement-actions"><button type="button" className="button small" disabled={exporting} onClick={onRefreshExport}>{exportJob.status === 'ready' ? '重新下载' : '刷新导出进度'}</button>{exportJob.failed > 0 && <button type="button" className="button primary small" disabled={exporting} onClick={onRetryExport}>重试失败项</button>}<button type="button" className="button small" disabled={exporting} onClick={onCloseExport} title="关闭后后台文档同步仍会继续">关闭进度</button></div>
    </div>}
    <p className="requirement-list-hint">按截止日期从早到晚排列，未设置截止日期的靠后，已关闭需求排在最后。</p>
    {loading ? <Loading/> : data?.items.length ? <div className="requirement-list">{data.items.map(item => <article className="requirement-row" key={item.id}>
      <div className="requirement-list-main">
        <button className="requirement-title" onClick={() => onSelect(item.id)}><strong>{item.title}</strong><span className={`requirement-status ${item.status}`}>{statusLabel(item.status)}</span></button>
        <p>{renderLinkedText(item.content)}</p>
        <RequirementOwners requirement={item}/>
        <small className="requirement-list-meta"><span>发布人 {item.publisher.name} · {item.category || '未分类'} · 发布 {item.publishDate}</span><RequirementDeadline requirement={item}/><span>更新 {date(item.updatedAt)}</span></small>
        {item.wiki?.url && <a className="requirement-wiki-link" href={item.wiki.url} target="_blank" rel="noopener noreferrer"><FileText size={14}/>飞书协作文档<ExternalLink size={12}/></a>}
      </div>
      <button className="requirement-count" onClick={() => onSelect(item.id)} aria-label={`查看需求 ${item.title}`}>{item.demoCount} 个可见 Demo<ArrowUpRight size={16}/></button>
    </article>)}</div> : <Empty title="暂无匹配需求" description={canPublish ? '尝试搜索负责人姓名，或发布新的业务需求。' : '仅展示指定给你的需求，可按负责人姓名搜索。'}/>}
    {data && <Pager data={data} onPage={onPage} busy={loading}/>}
  </section>;
}

function ResponsiblePeople({ users = [], label }) {
  return <div className="requirement-responsible"><Users size={14}/><span>{label}</span>{users.length ? users.map(user => <span className="requirement-person" key={user.id}>{user.name}</span>) : <span className="muted">未指定</span>}</div>;
}

function RequirementOwners({ requirement }) {
  return <div className="requirement-owner-summary"><ResponsiblePeople label="商务负责人" users={requirement.businessOwners}/><ResponsiblePeople label="研发负责人" users={requirement.developmentOwners}/></div>;
}

function RequirementDeadline({ requirement }) {
  const [currentTime, setCurrentTime] = useState(Date.now);
  const { deadlineDate, status } = requirement;
  useEffect(() => {
    setCurrentTime(Date.now());
    if (!deadlineDate || ['closed', 'delivered'].includes(status)) return;
    const update = () => setCurrentTime(Date.now());
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [deadlineDate, status]);
  const state = requirementDeadlineState(deadlineDate, status, currentTime);
  if (state === 'none') return <span className="requirement-deadline-empty">截止日期：未设置</span>;
  return <span className={`requirement-deadline ${state}`} title="按北京时间截止当天结束计算">
    <CalendarDays size={14}/><span>截止日期：<time dateTime={deadlineDate}>{deadlineDate}</time></span>
    {state === 'urgent' && <span className="requirement-deadline-note">不足 24 小时</span>}
    {state === 'overdue' && <span className="requirement-deadline-note">已逾期</span>}
  </span>;
}

function RequirementCalendarStatus({ requirement }) {
  const [calendar, setCalendar] = useState(requirement.calendar), [busy, setBusy] = useState(''), [error, setError] = useState('');
  useEffect(() => { setCalendar(requirement.calendar); setError(''); }, [requirement.id, requirement.calendar]);
  useEffect(() => {
    if (calendar?.status !== 'pending' && !calendar?.messages?.pending) return;
    const controller = new AbortController();
    const timer = setInterval(() => api(`/requirements/${requirement.id}/calendar`, { signal: controller.signal }).then(result => { setCalendar(result); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }), 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [requirement.id, calendar?.status, calendar?.messages?.pending]);
  async function refreshCalendar() {
    setBusy('refresh');
    try { setCalendar(await api(`/requirements/${requirement.id}/calendar`)); setError(''); }
    catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }
  async function retryCalendar() {
    setBusy('retry'); setError('');
    try { setCalendar(await api(`/requirements/${requirement.id}/calendar/retry`, { method: 'POST' })); }
    catch (error) { setError(error.message); }
    finally { setBusy(''); }
  }
  return <div className="requirement-calendar">
    <div><CalendarDays size={16}/><strong>飞书日历</strong><span>发布日期：{requirement.publishDate}（全天）</span><RequirementDeadline requirement={requirement}/></div>
    <p role="status">{({ pending: '正在同步，失败时会自动重试', synced: '已关联日程，并同步负责人及发布人', failed: requirement.canRetryCalendar ? '同步失败，修复下方问题后可点击“重试同步”' : '同步失败，请联系商务、项目经理或管理员检查后重试' })[calendar?.status] || '等待同步'}</p>
    {calendar?.messages && (calendar.messages.pending + calendar.messages.sent + calendar.messages.failed > 0) && <p role="status">日程卡片：已发送 {calendar.messages.sent} 人{calendar.messages.pending > 0 ? `，等待发送 ${calendar.messages.pending} 人` : ''}{calendar.messages.failed > 0 ? `，${calendar.messages.failed} 人发送失败，请管理员在“平台设置 → 飞书通知”重试` : ''}。</p>}
    {(calendar?.error || error) && <p className="requirement-calendar-error">{error || calendar.error}</p>}
    {calendar?.error?.includes('99991672') && <p>此错误需要飞书应用管理员在开放平台开通日历接口的应用身份权限，并发布新版本使权限生效。</p>}
    <div>{calendar?.appLink && <a className="button small" href={calendar.appLink} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/>打开飞书日程</a>}<button type="button" className="button small" disabled={!!busy} onClick={refreshCalendar}>{busy === 'refresh' ? '刷新中…' : '刷新同步状态'}</button>{requirement.canRetryCalendar && calendar?.status === 'failed' && <button type="button" className="button primary small" disabled={!!busy} onClick={retryCalendar}>{busy === 'retry' ? '提交中…' : '重试同步'}</button>}</div>
  </div>;
}

function RequirementWikiStatus({ requirement }) {
  const [wiki, setWiki] = useState(requirement.wiki), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { setWiki(requirement.wiki); setError(''); }, [requirement.id, requirement.wiki]);
  useEffect(() => {
    if (wiki?.status !== 'pending') return;
    const controller = new AbortController();
    const timer = setInterval(() => api(`/requirements/${requirement.id}/wiki`, { signal: controller.signal }).then(result => { setWiki(result); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }), 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [requirement.id, wiki?.status]);
  async function sync() {
    setBusy(true); setError('');
    try { setWiki(await api(`/requirements/${requirement.id}/wiki/retry`, { method: 'POST' })); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="requirement-calendar requirement-wiki">
    <strong><FileText size={15}/>飞书协作文档</strong>
    <p role="status">{({ not_created: '此历史需求尚未创建飞书文档，可点击下方按钮创建。', pending: '正在创建或同步飞书文档、Demo 内容及关联人员编辑权限，失败时自动重试。', synced: '文档已就绪，关联 Demo 上传文件或保存说明后会自动同步。', failed: '飞书文档同步失败，请检查知识库和文档权限后重试。' })[wiki?.status] || '等待同步'}</p>
    <p>平台维护“需求简述”“需求文档”和“Demo 内容（平台自动同步）”区域，人工补充请写在其他区块。Demo 上传文件并保存说明后，自动同步数据概述、数据格式、成本预估、难度说明和注意事项；文件仍在平台，查看和下载需要相应权限。</p>
    {(wiki?.error || error) && <p className="requirement-calendar-error">{error || wiki.error}</p>}
    <div>{wiki?.url && <a className="button small" href={wiki.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14}/>打开飞书文档</a>}{requirement.canSyncWiki && wiki?.status !== 'pending' && <button type="button" className="button small" disabled={busy} onClick={sync}>{busy ? '提交中…' : wiki?.status === 'not_created' ? '创建飞书文档' : wiki?.status === 'failed' ? '重试文档同步' : '同步文档与人员'}</button>}</div>
  </div>;
}

function RequirementDetail({ detail, canCreateDemo, busy, binding, setBinding, onCreateDemo, onOpenDemo, onEdit, onStatus, onUnbind, onBound, onForwarded }) {
  const [forwarding, setForwarding] = useState(false);
  return <>
    <section className="settings-card requirement-detail">
      <div className="requirement-title"><h2>{detail.title}</h2><span className={`requirement-status ${detail.status}`}>{statusLabel(detail.status)}</span></div>
      <div className="requirement-meta requirement-list-meta"><span>发布人 {detail.publisher.name} · {detail.category || '未分类'} · 发布日期 {detail.publishDate}</span><RequirementDeadline requirement={detail}/><span>更新于 {date(detail.updatedAt)}</span></div>
      <div className="requirement-content">{renderLinkedText(detail.content)}</div>
      <RequirementLinkPreviews key={`${detail.id}:${detail.revision}`} requirement={detail}/>
      <RequirementOwners requirement={detail}/>
      <RequirementCalendarStatus requirement={detail}/>
      <RequirementWikiStatus requirement={detail}/>
      {(detail.canManage || detail.canStatusManage || detail.canForward) && <div className="requirement-actions">{detail.canForward && <button type="button" className="button" disabled={busy} onClick={() => setForwarding(true)}><Forward size={16}/>转发需求</button>}{detail.canManage && <button className="button" disabled={busy} onClick={onEdit}>编辑需求 / 上传文档</button>}{detail.canStatusManage && <StatusMenu value={detail.status} onChange={onStatus} ariaLabel="修改需求状态" disabled={busy} filter={false}/>}</div>}
    </section>
    <section className="settings-card requirement-documents">
      <div className="panel-title"><div><h2><FileText size={18}/>需求文档</h2><span>{detail.documents?.length || 0} 个文件</span></div></div>
      {detail.documents?.length ? <div className="requirement-document-list">{detail.documents.map(file => <a className="requirement-document" key={file.id} href={`/api/requirements/${detail.id}/documents/${file.id}/download`}><FileText size={16}/><span>{file.name}<small>{Math.ceil(file.size / 1024)} KB</small></span><ArrowDownToLine size={16}/></a>)}</div> : <p className="muted">暂无需求文档</p>}
    </section>
    <section className="asset-panel requirement-demos">
      <div className="panel-title"><div><h2>关联 Demo</h2><span>{detail.demos.length} 个可见 Demo</span></div>{['open', 'needs_update'].includes(detail.status) && <div className="requirement-actions">{canCreateDemo && <button className="button" onClick={() => onCreateDemo(detail)}><Plus size={16}/>上传 Demo</button>}{detail.canManage && <button className="button primary" onClick={() => setBinding(value => !value)}><Link2 size={16}/>{binding ? '收起绑定' : '绑定已有 Demo'}</button>}</div>}</div>
      <p className="requirement-access-note">仅展示你有权查看的 Demo；员工或主管可上传 Demo 并默认关联当前需求，需求内容与文档仍由发布人管理。</p>
      {binding && detail.canManage && <BindDemo requirement={detail} onBound={onBound}/>}
      {detail.demos.length ? <div className="requirement-demo-list">{detail.demos.map(asset => <div key={asset.id}><button className="requirement-demo-open" onClick={() => onOpenDemo(asset.id)}><div><strong>{asset.latest.description.title || '未命名 Demo'}</strong><small>{asset.owner.name} · V{asset.latest.number}</small></div><Badge status={asset.latest.status}/><ArrowUpRight size={16}/></button>{detail.canManage && <button className="button small" disabled={busy} onClick={() => onUnbind(asset)}>解除绑定</button>}</div>)}</div> : <Empty title="还没有可见的关联 Demo" description={detail.canManage ? '可以绑定已有 Demo。' : '此处仅展示你有权查看的关联 Demo。'}/>}
    </section>
    {forwarding && <RequirementForward requirement={detail} onClose={() => setForwarding(false)} onForwarded={count => { setForwarding(false); onForwarded(count); }}/>}
  </>;
}

function RequirementForward({ requirement, onClose, onForwarded }) {
  const [data, setData] = useState(null), [selectedIds, setSelectedIds] = useState([]), [query, setQuery] = useState(''), [role, setRole] = useState('all');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    api(`/requirements/${requirement.id}/forward-candidates`, { signal: controller.signal }).then(result => {
      setData(result);
      setSelectedIds(ids => ids.filter(id => result.items.some(item => item.id === id && !item.assigned)));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [requirement.id, reload]);
  const candidates = (data?.items || []).filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()) && (role === 'all' || item.roles.includes(role)));
  const available = Math.max(0, (data?.maxAssignees || 100) - (data?.assignedCount || 0));
  async function forward(event) {
    event.preventDefault();
    if (!data || !selectedIds.length || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api(`/requirements/${requirement.id}/forward`, { method: 'POST', body: { revision: data.revision, assignedUserIds: selectedIds } });
      onForwarded(result.addedUserIds.length);
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <Modal title="转发需求" subtitle={requirement.title} onClose={onClose} busy={busy}>
    <form onSubmit={forward}>
      <div className="modal-content requirement-forward">
        <ErrorBox>{error}</ErrorBox>
        <p className="muted">{data?.allowedRoles.includes('supervisor') ? '可选择多位主管或员工。' : '可选择多位员工。'}转发后将追加到关联人员，接收人可在“我的需求”查看详情和下载文档。</p>
        <div className="requirement-forward-tools">
          <div className="search-box"><Search size={16}/><input autoFocus aria-label="搜索转发人员" placeholder="搜索人员姓名" value={query} onChange={event => setQuery(event.target.value)} disabled={busy}/></div>
          {data?.allowedRoles.includes('supervisor') && <select aria-label="筛选转发人员角色" value={role} onChange={event => setRole(event.target.value)} disabled={busy}><option value="all">主管和员工</option><option value="supervisor">主管</option><option value="employee">员工</option></select>}
          <button type="button" className="button small" disabled={busy || loading} onClick={() => { setError(''); setReload(value => value + 1); }}>刷新人员</button>
        </div>
        {loading ? <Loading/> : <div className="requirement-forward-list">{candidates.map(item => <label key={item.id} className={item.assigned ? 'assigned' : ''}>
          <input type="checkbox" aria-label={`转发给 ${item.name}`} checked={item.assigned || selectedIds.includes(item.id)} disabled={busy || item.assigned || !selectedIds.includes(item.id) && selectedIds.length >= available} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, item.id] : ids.filter(id => id !== item.id))}/>
          <span><strong>{item.name}</strong><small>{item.roles.map(itemRole => roleLabels[itemRole] || itemRole).join('、')}</small></span>
          {item.assigned && <small>已关联</small>}
        </label>)}{!candidates.length && <p className="muted">暂无符合条件的主管或员工。</p>}</div>}
        <p className="muted" role="status">已选择 {selectedIds.length} 人 · 当前关联 {data?.assignedCount || 0} 人 · 每条需求最多关联 {data?.maxAssignees || 100} 人</p>
      </div>
      <footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || loading || !data || !selectedIds.length || selectedIds.length > available}><Forward size={16}/>{busy ? '转发中…' : `确认转发${selectedIds.length ? `（${selectedIds.length} 人）` : ''}`}</button></footer>
    </form>
  </Modal>;
}

function StatusMenu({ value, onChange, disabled = false, ariaLabel = '状态', filter = true }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null);
  const current = statusOptions.find(option => option.value === value) || statusOptions[0];
  useEffect(() => { if (!open) return; const close = event => { if (!root.current?.contains(event.target)) setOpen(false); }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close); }, [open]);
  function keyboard(event) {
    if (event.key === 'Escape') { setOpen(false); trigger.current.focus(); event.preventDefault(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); setOpen(true);
    requestAnimationFrame(() => {
      const buttons = [...root.current.querySelectorAll('[role="menuitemradio"]')], index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    });
  }
  return <div ref={root} className={`status-menu ${open ? 'open' : ''}`} onKeyDown={keyboard} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}><button ref={trigger} type="button" className="status-menu-trigger" aria-label={ariaLabel} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(currentOpen => !currentOpen)}><span className={value !== 'all' ? `requirement-status ${value}` : ''}>{current.label}</span><ChevronDown size={16}/></button><div className="status-menu-options" role="menu" aria-label={ariaLabel} inert={!open}>{statusOptions.filter(option => filter || option.value !== 'all').map(option => <button type="button" role="menuitemradio" aria-checked={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); trigger.current.focus(); }}>{option.value !== 'all' ? <span className={`requirement-status ${option.value}`}>{option.label}</span> : option.label}{option.value === value && <CheckCircle2 size={14}/>}</button>)}</div></div>;
}

function renderLinkedText(value) {
  const text = String(value || ''), links = textLinks(text), parts = []; let offset = 0;
  while (offset < text.length) {
    const next = links.map(url => ({ url, index: text.indexOf(url, offset) })).filter(item => item.index >= 0).sort((left, right) => left.index - right.index)[0];
    if (!next) { parts.push(text.slice(offset)); break; }
    parts.push(text.slice(offset, next.index));
    parts.push(<a className="requirement-link" href={next.url} target="_blank" rel="noreferrer" onClick={event => event.stopPropagation()} key={next.index}>{next.url}</a>);
    offset = next.index + next.url.length;
  }
  return parts;
}

function RequirementLinkPreviews({ requirement }) {
  const [previews, setPreviews] = useState({}), [loading, setLoading] = useState({});
  const links = textLinks(requirement.content).filter(feishuDocumentLink);
  async function preview(url) {
    setLoading(current => ({ ...current, [url]: true }));
    try { const result = await api(`/requirements/${requirement.id}/link-preview?` + new URLSearchParams({ url })); setPreviews(current => ({ ...current, [url]: result })); }
    catch (error) { setPreviews(current => ({ ...current, [url]: { message: error.message } })); }
    finally { setLoading(current => ({ ...current, [url]: false })); }
  }
  return links.length > 0 && <div className="feishu-link-previews">{links.map(url => <div className="feishu-link-card" key={url}><FileText size={23}/><div><a href={url} target="_blank" rel="noreferrer"><strong>{previews[url]?.title || '飞书云文档'}</strong><ExternalLink size={13}/></a><small>{new URL(url).hostname}</small>{previews[url]?.excerpt && <p>{previews[url].excerpt}</p>}{previews[url]?.message && <p className="muted">{previews[url].message}</p>}</div><button type="button" className="button small" disabled={loading[url]} onClick={() => preview(url)}>{loading[url] ? '读取中…' : previews[url] ? '刷新预览' : '预览内容'}</button></div>)}</div>;
}

function BindDemo({ requirement, onBound }) {
  const [query, setQuery] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); setLoading(true); const timer = setTimeout(() => api(`/requirements/${requirement.id}/demo-candidates?` + new URLSearchParams({ q: query, page: String(page) }), { signal: controller.signal }).then(result => { setData(result); setError(''); }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }), query ? 200 : 0); return () => { clearTimeout(timer); controller.abort(); }; }, [requirement.id, query, page]);
  async function bind(asset) { setBusy(true); setError(''); try { await api(`/requirements/${requirement.id}/demos`, { method: 'POST', body: { assetId: asset.id, revision: asset.revision } }); onBound(); } catch (error) { setError(error.message); } finally { setBusy(false); } }
  return <div className="requirement-bind"><div className="search-box"><Search size={16}/><input aria-label="搜索待绑定 Demo" placeholder="搜索 Demo 名称或归属人" value={query} onChange={event => { setQuery(event.target.value); setPage(1); }}/></div><ErrorBox>{error}</ErrorBox>{loading ? <Loading/> : <div className="requirement-demo-list">{data?.items.map(asset => { const linked = requirement.demos.some(item => item.id === asset.id); return <div key={asset.id}><div><strong>{asset.latest.description.title || '未命名 Demo'}</strong><small>{asset.owner.name} · V{asset.latest.number}</small></div><button className="button small" disabled={busy || linked || !asset.canBind} onClick={() => bind(asset)}>{linked ? <><CheckCircle2 size={14}/>已绑定</> : asset.canBind ? '绑定' : '无绑定权限'}</button></div>; })}{!data?.items.length && <p className="muted">暂无匹配的可见 Demo。</p>}</div>}{data && data.pages > 1 && <Pager data={data} onPage={setPage} busy={loading}/>}</div>;
}
