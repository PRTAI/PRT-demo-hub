import React, { useEffect, useRef, useState } from 'react';
import { UploadCloud, Plus, Trash2, FileText, Download, Pencil, Send, CheckCircle2, RotateCcw, History, GitCompareArrows, Layers3, ShieldCheck, ChevronRight, ArrowLeft, ArrowUpRight, X, LoaderCircle, Sparkles } from 'lucide-react';
import { api, uploadFile } from './api';
import { FilePreview } from './FilePreview';
import { createRequestId } from './request-id.mjs';
import { Modal, ErrorBox, Badge, Avatar, FileIcon, Loading, Empty, bytes, date, actionLabels, roleLabels } from './components';

const blank = { title: '', summary: '', category: '', tags: [], content: '', usage: '', costEstimate: '', difficulty: '', notes: '', changes: '', schemaVersion: 1 };
export function Editor({ asset, version, user, config, onClose, onSaved }) {
  const [form, setForm] = useState(version?.description || blank), [tags, setTags] = useState(version?.description.tags?.join('，') || ''), [pending, setPending] = useState([]), [existing, setExisting] = useState(version?.files || []);
  const [assetId, setAssetId] = useState(asset?.id), [versionId, setVersionId] = useState(version?.id), [revision, setRevision] = useState(version?.revision || 0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState(null), [dragging, setDragging] = useState(false), [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [aiJob, setAiJob] = useState(null), [aiDraft, setAiDraft] = useState(''), [aiError, setAiError] = useState('');
  useEffect(() => { if (!versionId) return; api(`/versions/${versionId}/description/jobs/latest`).then(job => { if (job) { setAiJob(job); setAiDraft(job.result.markdown); } }).catch(() => {}); }, [versionId]);
  useEffect(() => { if (!aiJob || ['complete','failed'].includes(aiJob.status)) return; const check = async () => { try { const job = await api(`/description/jobs/${aiJob.id}`); setAiJob(job); if (job.status === 'complete') setAiDraft(job.result.markdown); if (job.status === 'failed') setAiError(job.error); } catch (e) { setAiError(e.message); } }; const timer = setInterval(check, 2000); check(); return () => clearInterval(timer); }, [aiJob?.id, aiJob?.status]);
  async function reloadVersion() { if (!window.confirm('重新加载会覆盖当前未保存的数据说明，待上传文件会保留。是否继续？')) return; setBusy(true); try { const data = await api(`/assets/${assetId}`); const latest = data.versions.find(v => v.id === versionId); if (!latest || !data.canEdit || !['draft', 'returned', 'pending'].includes(latest.status) || (latest.status === 'pending' && !data.canManage)) { setError('当前版本已不允许编辑，请关闭窗口后查看最新状态。'); return; } setForm(latest.description); setTags(latest.description.tags.join('，')); setExisting(latest.files); setRevision(latest.revision); setConflict(false); setError(''); setDirty(pending.length > 0); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const input = useRef();
  const requestId = useRef(null);
  if (!requestId.current) requestId.current = createRequestId();
  const change = (key, value) => { setForm(v => ({ ...v, [key]: value })); setDirty(true); };
  const close = () => { if (!busy && (!dirty || window.confirm('还有未保存的说明或文件，确认关闭？'))) onClose(); };
  function choose(files) {
    const list = [...files]; setError('');
    if (list.some(f => f.size === 0)) { setError('不支持空文件，请选择有内容的文件'); return; }
    if (list.some(f => f.size > config.maxFileMB * 1048576)) { setError(`单文件不能超过 ${config.maxFileMB} MB`); return; }
    if (existing.length + pending.length + list.length > config.maxFiles) { setError(`每个版本最多 ${config.maxFiles} 个文件`); return; }
    if ([...existing, ...pending.map(p => p.file), ...list].reduce((s, f) => s + f.size, 0) > config.maxVersionMB * 1048576) { setError(`版本总大小不能超过 ${config.maxVersionMB} MB`); return; }
    setPending(p => [...p, ...list.map(file => ({ id: createRequestId(), file }))]); setDirty(true);
  }
  async function removeFile(file) {
    if (!window.confirm(`从当前草稿移除「${file.name}」？历史版本不会改变。`)) return;
    setBusy(true); try { await api(`/versions/${versionId}/files/${file.id}`, { method: 'DELETE', body: { revision } }); setExisting(fs => fs.filter(f => f.id !== file.id)); setRevision(r => r + 1); } catch (e) { setError(e.message); if (e.status === 409) setConflict(true); } finally { setBusy(false); }
  }
  async function generateDescription() {
    setAiError(''); setAiDraft('');
    try { setAiJob(await api(`/versions/${versionId}/description/generate`, { method: 'POST', body: { revision } })); }
    catch (e) { setAiError(e.message); if (e.status === 409) setConflict(true); }
  }
  async function reviewAi(action) { if (!aiJob) return; try { await api(`/description/jobs/${aiJob.id}/review`, { method: 'POST', body: { action } }); if (action === 'accepted') change('content', aiDraft); setAiDraft(''); setAiJob(null); } catch (e) { setAiError(e.message); } }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    let aid = assetId, vid = versionId, rev = revision;
    try {
      const description = { ...form, tags: [...new Set(tags.split(/[,，]/).map(t => t.trim()).filter(Boolean))] };
      if (!aid) { const result = await api('/assets', { method: 'POST', body: { description, requestId: requestId.current } }); aid = result.id; vid = result.versionId; setAssetId(aid); setVersionId(vid); }
      else { await api(`/versions/${vid}`, { method: 'PUT', body: { revision: rev, description } }); rev++; setRevision(rev); }
      for (const item of pending) {
        setProgress({ name: item.file.name, percent: 0 });
        const result = await uploadFile(vid, item.file, rev, percent => setProgress({ name: item.file.name, percent }));
        rev = result.revision; setRevision(rev); setExisting(files => [...files, { id: result.id, name: item.file.name, size: item.file.size }]); setPending(list => list.filter(p => p.id !== item.id));
      }
      setDirty(false); onSaved(aid);
    } catch (e) { if (e.status === 409) setConflict(true); setError(`${e.message}${aid && e.status !== 409 ? '。已保存的内容仍保留，未完成文件可继续重试。' : ''}`); }
    finally { setBusy(false); setProgress(null); }
  }
  return <Modal title={version ? `编辑 V${version.number}` : '上传新的 Demo'} subtitle="让数据有清晰的说明，也有可追溯的版本。" onClose={close} wide busy={busy}><form onSubmit={save}><div className="editor-body"><ErrorBox>{error}</ErrorBox>{conflict && <div className="conflict-note"><p>此版本可能已被其他人更新。请先复制需要保留的说明，再加载最新内容后继续编辑。</p><button type="button" className="button" disabled={busy} onClick={reloadVersion}><RotateCcw size={16}/>加载最新版本</button></div>}<div className="identity-strip"><Avatar user={asset?.owner || user}/><div><strong>{asset?.owner?.name || user.name}</strong><span>数据归属人 · 自动关联企业身份</span></div><span className="identity-badge"><ShieldCheck size={14}/>身份已关联</span></div>
    <div className="section-heading"><span>01</span><div><h3>基本信息</h3><p>帮助团队快速了解这份数据。</p></div></div>
    <label className="field">Demo 名称 <b>*</b><input maxLength={120} value={form.title} onChange={e => change('title', e.target.value)} placeholder="例如：零售门店销售分析样例" disabled={busy}/></label>
    <div className="form-grid"><label className="field">业务分类 <b>*</b><select value={form.category} onChange={e => change('category', e.target.value)} disabled={busy}><option value="">选择业务分类</option>{config?.categories.map(c => <option key={c}>{c}</option>)}{form.category && !config?.categories.includes(form.category) && <option>{form.category}</option>}</select></label><label className="field">标签 <span className="optional">选填</span><input value={tags} onChange={e => { setTags(e.target.value); setDirty(true); }} placeholder="例如：销售分析，客户画像" disabled={busy}/></label></div>
    <label className="field">简介 <b>*</b><textarea rows={2} maxLength={500} value={form.summary} onChange={e => change('summary', e.target.value)} placeholder="一句话说明数据包含什么、适合什么场景" disabled={busy}/></label>
    <div className="section-heading"><span>02</span><div><h3>Demo 文件</h3><p>支持压缩包及任意类型文件，按原文件保存。</p></div></div>
    <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) choose(e.dataTransfer.files); }}><UploadCloud size={32}/><strong>拖拽文件到这里，或<button type="button" className="inline-link" disabled={busy} onClick={() => input.current.click()}>点击上传</button></strong><p>单文件 ≤ {config?.maxFileMB} MB · 最多 {config?.maxFiles} 个文件 · 总大小 ≤ {config?.maxVersionMB} MB</p><input ref={input} type="file" multiple hidden onChange={e => { choose(e.target.files); e.target.value = ''; }}/></div>
    <div className="editor-files">{existing.map(f => <div className="file-row" key={f.id}><FileIcon name={f.name}/><div><strong>{f.name}</strong><small>{bytes(f.size)} · 已保存</small></div><button type="button" className="icon-button danger-text" aria-label={`移除 ${f.name}`} disabled={busy} onClick={() => removeFile(f)}><Trash2 size={17}/></button></div>)}{pending.map(item => <div className="file-row" key={item.id}><FileIcon name={item.file.name}/><div><strong>{item.file.name}</strong><small>{bytes(item.file.size)} · 等待上传</small></div><button type="button" className="icon-button" aria-label={`取消 ${item.file.name}`} disabled={busy} onClick={() => setPending(list => list.filter(p => p.id !== item.id))}><X size={17}/></button></div>)}</div>
    {progress && <div className="upload-progress"><span>{progress.percent === 100 ? '正在校验并保存' : '正在上传'} · {progress.name} <b>{progress.percent}%</b></span><progress value={progress.percent} max={100}/></div>}
    <div className="section-heading description-heading"><span>03</span><div><h3>数据说明</h3><p>使用 Markdown 编写数据概述和数据格式，也可以交给 AI 后台生成。</p></div><button type="button" className="button ai-description-button" onClick={generateDescription} disabled={conflict || !versionId || !existing.length || (aiJob && !['complete','failed'].includes(aiJob.status))}><Sparkles size={16}/>{aiJob && !['complete','failed'].includes(aiJob.status) ? 'AI 后台生成中…' : 'AI 生成'}</button></div>
    {(!versionId || !existing.length) && <p className="ai-description-hint">请先保存 Demo 和文件，再重新编辑即可使用 AI 生成。</p>}
    {aiJob && !['complete','failed'].includes(aiJob.status) && <div className="ai-job-note"><LoaderCircle className="spin" size={16}/><div><strong>AI 正在后台生成数据说明</strong><p>你可以继续填写其他内容或直接保存草稿，完成后飞书机器人会通知你。</p></div></div>}
    {aiError && <ErrorBox>{aiError}</ErrorBox>}
    {aiDraft && <div className="ai-review"><div><strong>AI 数据说明待审查</strong><span>生成结果不会自动覆盖当前内容</span></div><pre>{aiDraft}</pre><div><button type="button" className="button" onClick={() => reviewAi('dismissed')}>暂不采用</button><button type="button" className="button primary" onClick={() => reviewAi('accepted')}>应用到数据说明</button></div></div>}
    <label className="field">数据说明 <b>*</b><textarea className="tree-textarea" rows={15} maxLength={20000} value={form.content} onChange={e => change('content', e.target.value)} placeholder={'# 数据概述\n\n用一段话说明整体数据情况、组织方式、用途和适用场景。\n\n# 数据格式\n\n```text\n单个任务/\n├── instruction.md  # 任务说明\n└── data/            # 输入数据\n```\n\n说明关键文件内容。'} disabled={busy}/></label>
    <div className="form-grid"><label className="field">成本预估 <span className="optional">选填</span><textarea rows={4} maxLength={5000} value={form.costEstimate || ''} onChange={e => change('costEstimate', e.target.value)} placeholder="说明主要成本来源、估算口径和不确定因素…" disabled={busy}/></label><label className="field">难度说明 <span className="optional">选填</span><textarea rows={4} maxLength={5000} value={form.difficulty || ''} onChange={e => change('difficulty', e.target.value)} placeholder="说明难度等级、判断依据、主要门槛和所需能力…" disabled={busy}/></label></div>
    <label className="field">注意事项 <span className="optional">选填</span><textarea rows={2} maxLength={10000} value={form.notes} onChange={e => change('notes', e.target.value)} placeholder="环境依赖、已知问题或使用提示…" disabled={busy}/></label>
    {(version?.number || 1) > 1 && <label className="field">本次变更说明 <b>*</b><textarea rows={2} value={form.changes} onChange={e => change('changes', e.target.value)} placeholder="本次版本新增或调整了哪些内容？" disabled={busy}/></label>}
    </div><footer className="modal-footer"><span>可先保存草稿，完善后再提交或发布</span><button type="button" className="button" onClick={close} disabled={busy}>取消</button><button type="submit" className="button primary" disabled={busy || conflict}>{busy ? <LoaderCircle size={17} className="spin"/> : <FileText size={17}/>} {busy ? '正在保存…' : '保存 Demo'}</button></footer></form></Modal>;
}

export function Detail({ id, user, onClose, onEdit, onChanged, notify }) {
  const [preview, setPreview] = useState(null);
  const [asset, setAsset] = useState(null), [selected, setSelected] = useState(null), [tab, setTab] = useState('description'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(null), [reason, setReason] = useState(''), [reviewers,setReviewers]=useState([]), [supervisorId,setSupervisorId]=useState(''), [candidates,setCandidates]=useState([]), [grantUser,setGrantUser]=useState(''), [grantLevel,setGrantLevel]=useState('readonly'), [ccCandidates,setCcCandidates]=useState([]), [ccUserIds,setCcUserIds]=useState([]), [ccRole,setCcRole]=useState('all');
  async function load(openLatest = false) { try { const result = await api(`/assets/${id}`); setAsset(result); setSelected(old => openLatest || !result.versions.some(v => v.id === old) ? result.latest.id : old); } catch (e) { setError(e.message); } }
  useEffect(() => { setTab('description'); setPreview(null); load(true); }, [id]);
  useEffect(() => { if (tab === 'permissions' && asset?.canGrant) api(`/assets/${id}/grant-candidates`).then(setCandidates).catch(e => setError(e.message)); }, [tab, asset?.canGrant, id]);
  const version = asset?.versions.find(v => v.id === selected), description = version?.description;
  const isWorking = version && ['draft', 'pending', 'returned'].includes(version.status), canEdit = asset?.canEdit && isWorking && (asset.canManage || version.status !== 'pending');
  async function act(action) {
    setBusy(true); setError('');
    try {
      if (action === 'delete') { await api(`/versions/${version.id}`, { method: 'DELETE', body: { revision: version.revision } }); onChanged(); onClose(); notify('草稿已删除'); return; }
      if (action === 'new') { const result = await api(`/assets/${id}/versions`, { method: 'POST', body: { revision: asset.revision, baseVersionId: version.id } }); const updated = await api(`/assets/${id}`); onChanged(); onEdit(updated, updated.versions.find(v => v.id === result.versionId)); return; }
      await api(`/versions/${version.id}/actions`, { method: 'POST', body: { action, reason, supervisorId: action === 'submit' ? supervisorId : undefined, ccUserIds: action === 'publish' ? ccUserIds : [], revision: version.revision } }); setConfirm(null); setReason(''); await load(); onChanged(); notify(`${actionLabels[action]}成功`);
    } catch (e) { setError(e.message); setConfirm(null); if (!['new', 'delete'].includes(action)) await load(); } finally { setBusy(false); }
  }
  async function requestAction(action) { setReason(''); try { if (action === 'submit') { const people = await api('/reviewers'); setReviewers(people); setSupervisorId(people.find(p => p.id !== user.id)?.id || ''); } if (action === 'publish') { setCcCandidates((await api('/notification-candidates')).filter(p => p.id !== user.id && p.id !== asset.owner.id && !p.roles.includes('pm'))); setCcUserIds([]); setCcRole('all'); } } catch (e) { setError(e.message); return; } setConfirm(action); }
  async function saveGrant() { if (!grantUser) return; setBusy(true); try { await api(`/assets/${id}/permissions/${grantUser}`, { method:'PUT', body:{level:grantLevel} }); await load(); setGrantUser(''); notify('Demo 权限已更新'); } catch(e) { setError(e.message); } finally { setBusy(false); } }
  async function revokeGrant(userId) { setBusy(true); try { await api(`/assets/${id}/permissions/${userId}`, {method:'DELETE'}); await load(); notify('授权已取消'); } catch(e) { setError(e.message); } finally { setBusy(false); } }
  const needsReason = ['reject', 'unpublish', 'restore'].includes(confirm);
  const comparison = asset && version ? asset.versions.filter(v => v.number < version.number).sort((a, b) => b.number - a.number)[0] : null;
  const returnedEvent = asset?.events.find(e => e.version_id === version?.id && e.action === 'reject');
  const detailTabs = asset?.businessRestricted
    ? [['description', '数据说明', FileText], ['files', `文件清单 (${version?.files.length || 0})`, Download]]
    : [['description', '数据说明', FileText], ['files', `文件清单 (${version?.files.length || 0})`, Download], ['history', '版本与差异', GitCompareArrows], ['events', '操作记录', History], ...(asset?.canGrant ? [['permissions', '权限设置', ShieldCheck]] : [])];
  return <Modal title={description?.title || 'Demo 详情'} subtitle={asset ? `创建人 ${asset.creator.name} · ${date(asset.createdAt)}` : '正在获取数据'} onClose={onClose} wide busy={busy}>
    <div className="detail-body"><ErrorBox>{error}</ErrorBox>{!asset || !version ? error ? <button className="button" onClick={() => { setError(''); load(); }}>重新加载</button> : <Loading/> : <>
      <div className="detail-overview"><div><span className="category-tag">{description.category || '未分类'}</span>{description.tags.map(t => <span className="tag" key={t}>{t}</span>)}<p>{description.summary || '暂无简介'}</p></div><div className="detail-owner"><Avatar user={asset.owner}/><div><small>归属人</small><strong>{asset.owner.name}</strong></div></div></div>
      <div className="version-bar"><Layers3 size={20}/><label>查看版本<select aria-label="选择版本" value={selected} onChange={e => setSelected(e.target.value)}>{asset.versions.map(v => <option key={v.id} value={v.id}>V{v.number}{v.id === asset.currentVersionId ? ' · 当前发布' : ''}</option>)}</select></label><Badge status={version.status}/><span className="version-time">更新于 {date(version.updatedAt)}</span></div>
      {version.status === 'returned' && returnedEvent && <div className="return-note"><RotateCcw size={18}/><div><strong>主管退回意见</strong><p>{returnedEvent.detail.reason}</p></div></div>}
      {version.status === 'offline' && <div className="return-note"><ShieldCheck size={18}/><div><strong>此版本已下架</strong><p>历史内容保留，文件停止下载。需要继续使用时，请由主管恢复发布。</p></div></div>}
      <div className="detail-tabs">{detailTabs.map(([key, title, Icon]) => <button className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}><Icon size={16}/>{title}</button>)}</div>
      {tab === 'description' && <div className="description-content"><section><h3>数据说明</h3><MarkdownText value={description.content}/></section>{(asset.businessRestricted ? [['difficulty', '难度说明']] : [['costEstimate', '成本预估'], ['difficulty', '难度说明'], ['notes', '注意事项'], ['changes', '本次变更']]).map(([key, title]) => <section key={key}><h3>{title}</h3><p>{description[key] || '暂未填写'}</p></section>)}</div>}
      {tab === 'files' && <div className="detail-files"><div className="file-summary">共 {version.files.length} 个文件 · {bytes(version.files.reduce((s, f) => s + f.size, 0))}<span>按原始格式保存</span></div>{!version.files.length ? <Empty title="还没有上传文件" description="编辑此草稿，添加对应的 Demo 文件。"/> : version.files.map(f => <div className="file-row" key={f.id}><FileIcon name={f.name} large/><div><strong>{f.name}</strong><small>{bytes(f.size)} · {f.uploader} · {date(f.createdAt)}</small><small className="checksum">SHA-256 {f.checksum?.slice(0, 20)}…</small></div>{version.status !== 'offline' && <button className="button small" onClick={() => setPreview(f)}>预览</button>}{version.status !== 'offline' ? <a className="button small" href={`/api/versions/${version.id}/files/${f.id}/download`}><Download size={15}/>下载</a> : <span className="muted">已停止下载</span>}</div>)}</div>}
      {tab === 'files' && preview && version.status !== 'offline' && version.files.some(f => f.id === preview.id) && <FilePreview key={version.id + preview.id} versionId={version.id} file={preview} onClose={() => setPreview(null)}/>}
      {!asset.businessRestricted && tab === 'history' && <div className="history-content"><h3>版本时间线</h3><div className="version-timeline">{asset.versions.map(v => <button key={v.id} className={v.id === selected ? 'selected' : ''} onClick={() => setSelected(v.id)}><span className="timeline-dot"/><div><strong>V{v.number} {v.id === asset.currentVersionId && <small>当前发布</small>}</strong><p>{v.description.changes || '首次创建 / 草稿完善'}</p><small>{date(v.updatedAt)} · {v.files.length} 个文件</small></div><Badge status={v.status}/></button>)}</div><h3 className="diff-heading">{comparison ? `V${comparison.number} → V${version.number} 变更对比` : '版本对比'}</h3>{comparison ? <Diff before={comparison} after={version}/> : <p className="muted">这是首个版本，后续版本会在这里展示说明和文件变化。</p>}
      <h3 className="diff-heading">提交快照</h3>{asset.submissions.filter(s => s.version_id === version.id).map(s => <details className="snapshot" key={s.id}><summary>第 {s.round} 次提交 · {s.submitter} · {date(s.created_at)}</summary><div><p>{s.snapshot.description?.content}</p><strong>原始文件清单</strong>{s.snapshot.files?.map(f => <p key={f.id}>{f.name} · {bytes(f.size)}</p>)}</div></details>)}{!asset.submissions.some(s => s.version_id === version.id) && <p className="muted">此版本没有员工提交记录。</p>}</div>}
      {tab === 'permissions' && asset.canGrant && <div className="history-content"><h3>Demo 授权</h3><p className="muted">只读权限可以查看和下载；上传权限可以编辑说明、上传文件和创建版本；管理权限可以审核、发布和配置授权。</p><div className="form-grid"><label className="field">授权成员<select value={grantUser} onChange={e=>setGrantUser(e.target.value)}><option value="">请选择成员</option>{candidates.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">权限<select value={grantLevel} onChange={e=>setGrantLevel(e.target.value)}><option value="readonly">只读</option><option value="upload">上传</option><option value="manage">管理</option></select></label></div><button className="button primary" disabled={!grantUser||busy} onClick={saveGrant}>保存授权</button><div className="events-list">{asset.permissions.map(p=><div className="event-item" key={p.userId}><div><div><strong>{p.name}</strong><span>{{readonly:'只读',upload:'上传',manage:'管理'}[p.level]}</span><button className="button small" onClick={()=>revokeGrant(p.userId)}>取消授权</button></div></div></div>)}</div></div>}
      {!asset.businessRestricted && tab === 'events' && <div className="events-list">{asset.events.map(e => <div className="event-item" key={e.id}><span className="event-dot"/><div><div><strong>{e.actor_name}</strong><span>{actionLabels[e.action] || e.action}</span><time>{date(e.created_at)}</time></div>{e.detail.reason && <p>{e.detail.reason}</p>}{e.detail.name && <p>{e.detail.name}</p>}{e.detail.direct && <small>主管直接发布 · 免审核</small>}{e.action === 'edit' && <details><summary>查看说明修改</summary><Diff before={{ description: e.detail.before, files: [] }} after={{ description: e.detail.after, files: [] }}/></details>}{e.detail.snapshot && <details><summary>查看发布快照</summary><p>{e.detail.snapshot.description?.content}</p>{e.detail.snapshot.files?.map(f => <p key={f.id}>{f.name} · {bytes(f.size)}</p>)}</details>}</div></div>)}</div>}
    </>}</div>
    {version && <footer className="modal-footer detail-actions"><span className="footer-access"><ShieldCheck size={15}/>{asset.businessRestricted ? '商务查看权限' : asset.canManage ? '管理权限' : asset.accessLevel === 'upload' ? '上传权限' : asset.canEdit ? '我的数据' : '只读权限'}</span>{canEdit && <button className="button" disabled={busy} onClick={() => onEdit(asset, version)}><Pencil size={16}/>编辑内容</button>}{asset.canEdit && version.status === 'published' && !asset.versions.some(v => ['draft', 'pending', 'returned'].includes(v.status)) && <button className="button" disabled={busy} onClick={() => act('new')}><Plus size={16}/>创建新版本</button>}
      {asset.canManage && version.status === 'published' && <><button className="button danger-text" disabled={busy} onClick={() => requestAction('unpublish')}>下架</button>{asset.currentVersionId !== version.id && <button className="button" disabled={busy} onClick={() => requestAction('set_default')}>设为默认</button>}</>}
      {asset.canManage && version.status === 'offline' && <button className="button primary" disabled={busy} onClick={() => requestAction('restore')}>恢复发布</button>}
      {asset.canManage && version.status === 'pending' && <button className="button danger-text" disabled={busy} onClick={() => requestAction('reject')}><RotateCcw size={16}/>退回修改</button>}
      {asset.canManage && isWorking && <button className="button primary" disabled={busy} onClick={() => requestAction('publish')}><CheckCircle2 size={16}/>{version.status === 'pending' ? '审核通过并发布' : '直接发布'}</button>}
      {!asset.canManage && asset.canEdit && ['draft', 'returned'].includes(version.status) && <button className="button primary" disabled={busy} onClick={() => requestAction('submit')}><Send size={16}/>提交主管审核</button>}
      {asset.owner.id === user.id && !asset.canManage && version.status === 'pending' && <button className="button" disabled={busy} onClick={() => requestAction('withdraw')}>撤回提交</button>}
      {canEdit && version.status === 'draft' && !version.submissionCount && <button className="icon-button danger-text" aria-label="删除草稿" title="删除草稿" disabled={busy} onClick={() => requestAction('delete')}><Trash2 size={17}/></button>}
    </footer>}
    {confirm && <div className="confirm-panel" role="alertdialog" aria-label="确认操作"><div><h3>{confirm === 'delete' ? '删除未提交草稿' : actionLabels[confirm]}</h3><p>{({ publish: '将当前文件及说明发布为可使用版本，发布后只能通过新版本修改。', submit: '请选择本次负责审核的主管，提交后文件与说明将锁定。', reject: '请写明需要员工补充或调整的内容。', unpublish: '下架后此版本文件将停止下载，历史记录保留。', restore: '恢复后当前版本重新允许下载，并设为默认版本。', withdraw: '撤回后恢复为草稿，可以继续修改。', delete: '删除后此草稿不再显示，无法从页面恢复。', set_default: '将此已发布版本设为默认使用版本。' })[confirm]}</p>{confirm === 'publish' && <div className="field">额外抄送人员 <span className="optional">产品经理将自动收到通知 · 已选 {ccUserIds.length} 人</span><select className="cc-role-filter" aria-label="按身份筛选抄送人员" value={ccRole} onChange={e => setCcRole(e.target.value)}><option value="all">全部身份</option>{Object.entries(roleLabels).filter(([role]) => role !== 'pm').map(([role,label]) => <option key={role} value={role}>{label}</option>)}</select><div className="cc-options">{ccCandidates.filter(person => ccRole === 'all' || person.roles.includes(ccRole)).length ? ccCandidates.filter(person => ccRole === 'all' || person.roles.includes(ccRole)).map(person => <label key={person.id}><input type="checkbox" checked={ccUserIds.includes(person.id)} onChange={e => setCcUserIds(ids => e.target.checked ? [...ids, person.id] : ids.filter(id => id !== person.id))}/><span>{person.name}</span></label>) : <p className="muted">暂无其他可抄送成员</p>}</div></div>}{confirm === 'submit' && <label className="field">审核主管<select value={supervisorId} onChange={e => setSupervisorId(e.target.value)}><option value="">请选择主管</option>{reviewers.filter(p => p.id !== user.id).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}{needsReason && <textarea autoFocus rows={3} aria-label="处理原因" placeholder="请输入处理原因（必填）" value={reason} onChange={e => setReason(e.target.value)}/>}<div><button className="button" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="button primary" disabled={busy || (needsReason && !reason.trim()) || (confirm === 'submit' && !supervisorId)} onClick={() => act(confirm)}>{busy ? '处理中…' : '确认操作'}</button></div></div></div>}
  </Modal>;
}
function MarkdownText({ value }) {
  if (!value?.trim()) return <p>暂未填写</p>;
  const blocks = [], lines = value.split(/\r?\n/); let code = [], inCode = false;
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim().startsWith('```')) { if (inCode) { blocks.push(<pre className="markdown-code" key={`code-${index}`}>{code.join('\n')}</pre>); code = []; } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    const header = cells(line), separator = index + 1 < lines.length ? cells(lines[index + 1]) : [];
    const isTable = line.includes('|') && header.length > 1 && separator.length === header.length && separator.every(cell => /^:?-{3,}:?$/.test(cell));
    if (isTable) {
      const rows = []; index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { const row = cells(lines[index]); rows.push([...row, ...Array(Math.max(0, header.length - row.length)).fill('')].slice(0, header.length)); index++; }
      index--;
      blocks.push(<div className="markdown-table-scroll" key={`table-${index}`}><table className="markdown-table"><thead><tr>{header.map((cell, column) => <th key={column}>{cell}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>);
    } else if (/^#\s+/.test(line)) blocks.push(<h2 key={index}>{line.replace(/^#\s+/,'')}</h2>);
    else if (/^##\s+/.test(line)) blocks.push(<h3 key={index}>{line.replace(/^##\s+/,'')}</h3>);
    else if (/^[-*]\s+/.test(line)) blocks.push(<div className="markdown-list-item" key={index}>• {line.replace(/^[-*]\s+/,'')}</div>);
    else if (line.trim()) blocks.push(<p key={index}>{line}</p>);
  }
  if (code.length) blocks.push(<pre className="markdown-code" key="code-last">{code.join('\n')}</pre>);
  return <div className="markdown-content">{blocks}</div>;
}
function Diff({ before, after }) {
  const keys = { title: '名称', summary: '简介', category: '分类', tags: '标签', content: '数据说明', costEstimate: '成本预估', difficulty: '难度说明', notes: '注意事项', changes: '变更说明' };
  const changed = Object.keys(keys).filter(k => JSON.stringify(before.description?.[k]) !== JSON.stringify(after.description?.[k]));
  const removed = before.files.filter(f => !after.files.some(g => f.id === g.id)), added = after.files.filter(f => !before.files.some(g => g.id === f.id));
  return <div className="diff-list">{changed.map(k => <div className="diff-item" key={k}><strong>{keys[k]}</strong><del>{String(before.description?.[k] || '空')}</del><ins>{String(after.description?.[k] || '空')}</ins></div>)}{removed.map(f => <p className="diff-removed" key={f.id}>− 移除文件：{f.name}</p>)}{added.map(f => <p className="diff-added" key={f.id}>＋ 新增文件：{f.name}</p>)}{!changed.length && !removed.length && !added.length && <p className="muted">说明与文件没有变化。</p>}</div>;
}
