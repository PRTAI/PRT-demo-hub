import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Layers3, LayoutDashboard, FolderOpen, ClipboardCheck, ClipboardList, ListChecks, Users, UserCog, Settings2, Search, Plus, ChevronRight, ArrowUpRight, LogOut, Grid2X2, List, Database, CircleCheck, Clock3, FilePenLine, ShieldCheck, X, Menu, RefreshCw, Bell, ArrowRight, Sparkles, FlaskConical, Info } from 'lucide-react';
import { api, setCsrf, streamApi } from './api';
import { Avatar, Badge, Empty, Loading, ErrorBox, PageHeader, Toast, date, roleLabels } from './components';
import { Editor, Detail } from './Demo';
import { UsersPage, SettingsPage } from './Admin';
import { RequirementsPage } from './Requirements';
import { routeToIntranet } from './network-routing.mjs';

export default function App() {
  const [auth, setAuth] = useState(null), [error, setError] = useState(''), [assets, setAssets] = useState([]), [config, setConfig] = useState(null), [loading, setLoading] = useState(true);
  const [page, setPage] = useState(() => { const params = new URLSearchParams(location.search); return params.has('requirement') || ['requirements', 'my-requirements'].includes(params.get('view')) ? params.get('view') === 'my-requirements' ? 'my-requirements' : 'requirements' : 'library'; }), [status, setStatus] = useState('all'), [query, setQuery] = useState(''), [category, setCategory] = useState('all'), [owner, setOwner] = useState('all'), [layout, setLayout] = useState(() => window.matchMedia('(max-width: 700px)').matches ? 'grid' : 'list');
  const [requirementId, setRequirementId] = useState(new URLSearchParams(location.search).get('requirement'));
  const [detailId, setDetailId] = useState(new URLSearchParams(location.search).get('demo')), [editor, setEditor] = useState(() => { const params = new URLSearchParams(location.search); return params.get('view') === 'upload' ? { requirementIds: params.get('requirement') ? [params.get('requirement')] : [] } : null; }), [toast, setToast] = useState(''), [menu, setMenu] = useState(false), [reload, setReload] = useState(0);
  const [catalog, setCatalog] = useState({ stats: {}, owners: [], categories: [], total: 0, page: 1, pages: 1, pendingReviews: 0 });
  const [pageNumber, setPageNumber] = useState(1), [pageSize, setPageSize] = useState(10), [days, setDays] = useState('0'), [sort, setSort] = useState('updated');
  const [ragQuestion, setRagQuestion] = useState(''), [ragResult, setRagResult] = useState(null), [ragBusy, setRagBusy] = useState(false), [ragError, setRagError] = useState('');
  const [ragStages, setRagStages] = useState([]);
  const previousUser = useRef(null);
  const listRef = useRef(null);
  useEffect(() => { const id = auth?.user?.id || null; if (previousUser.current && previousUser.current !== id) { setEditor(null); setDetailId(null); setConfig(null); setAssets([]); setPage('library'); } previousUser.current = id; }, [auth?.user?.id]);
  const user = auth?.user, has = role => user?.roles.includes(role);
  const notify = message => { setToast(message); window.setTimeout(() => setToast(''), 4000); };
  function showDetail(id, replace = false) { history[replace ? 'replaceState' : 'pushState']({}, '', `/?demo=${encodeURIComponent(id)}` + (['requirements', 'my-requirements'].includes(page) ? `&view=${page}` + (requirementId ? `&requirement=${encodeURIComponent(requirementId)}` : '') : '')); setEditor(null); setDetailId(id); }
  function showUpload(requirement = null) { history.pushState({}, '', '/?view=upload' + (requirement?.id ? `&requirement=${encodeURIComponent(requirement.id)}` : '')); setDetailId(null); setEditor(requirement?.id ? { requirementIds: [requirement.id], requirements: [requirement] } : {}); }
  function closeWorkspacePage() { history.pushState({}, '', ['requirements', 'my-requirements'].includes(page) ? requirementId ? `/?requirement=${encodeURIComponent(requirementId)}&view=${page}` : `/?view=${page}` : '/'); setDetailId(null); setEditor(null); }
  function showRequirement(id) { history.pushState({}, '', id ? `/?requirement=${encodeURIComponent(id)}&view=${page === 'my-requirements' ? 'my-requirements' : 'requirements'}` : `/?view=${page === 'my-requirements' ? 'my-requirements' : 'requirements'}`); setRequirementId(id); setPage(page === 'my-requirements' ? 'my-requirements' : 'requirements'); setDetailId(null); setEditor(null); }
  useEffect(() => { const sync = () => { const params = new URLSearchParams(location.search); const id = params.get('demo'), requirement = params.get('requirement'), view = params.get('view'); setDetailId(id); setRequirementId(requirement); if (requirement || ['requirements', 'my-requirements'].includes(view)) setPage(view === 'my-requirements' ? 'my-requirements' : 'requirements'); else if (!id && !view) setPage('library'); if (!id && view === 'upload') setEditor(requirement ? { requirementIds: [requirement] } : {}); else setEditor(null); }; addEventListener('popstate', sync); return () => removeEventListener('popstate', sync); }, []);
  async function loadAuth() { try { const result = await api('/auth/me'); setCsrf(result.csrf); setAuth(result); setError(''); } catch (e) { setError(e.message); } }
  function refresh() { setReload(n => n + 1); }
  useEffect(() => {
    routeToIntranet(window.location).then(redirected => { if (!redirected) loadAuth(); });
    const renew = () => loadAuth();
    const timer = window.setInterval(renew, 60000);
    window.addEventListener('focus', renew); window.addEventListener('prt-session-expired', renew);
    return () => { clearInterval(timer); window.removeEventListener('focus', renew); window.removeEventListener('prt-session-expired', renew); };
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    if (detailId) url.searchParams.set('demo', detailId); else url.searchParams.delete('demo');
    history.replaceState(null, '', url.pathname + url.search);
  }, [detailId]);
  const identity = user ? [user.id, user.revision, user.enabled, user.roles.join(',')].join(':') : '';
  const businessOnly = user?.roles.includes('business') && !user.roles.some(r => ['employee', 'supervisor', 'pm', 'admin'].includes(r));
  const home = businessOnly ? 'search' : user?.roles.length === 1 && has('admin') ? 'users' : 'library';
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('requirement') && !['requirements', 'my-requirements'].includes(new URLSearchParams(location.search).get('view'))) {
      if (user?.enabled && home !== 'library') setPage(home);
    }
    if (!user?.enabled || !user?.roles.length) { setAssets([]); setLoading(false); }
  }, [identity]);
  useEffect(() => { if (!user?.enabled || !user.roles.length) return; const controller = new AbortController(); api('/config', { signal: controller.signal }).then(setConfig).catch(error => { if (!controller.signal.aborted) setError(error.message); }); return () => controller.abort(); }, [identity, reload]);
  useEffect(() => { setPageNumber(1); }, [page, status, query, category, owner, pageSize, days, sort]);
  useEffect(() => {
    if (!user?.enabled || !user.roles.length || ['users', 'settings', 'search', 'requirements', 'my-requirements'].includes(page)) return;
    const controller = new AbortController(); setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ scope: page, status, q: query, category, owner, page: String(pageNumber), pageSize: String(pageSize), days, sort });
        const data = await api('/catalog?' + params, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAssets(data.items || []); setCatalog(data); setError('');
      } catch (e) { if (e.name !== 'AbortError') { setAssets([]); setError(e.message); } }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [identity, page, status, query, category, owner, pageNumber, pageSize, days, sort, reload]);
  async function logout() { try { await api('/auth/logout', { method: 'POST' }); setAssets([]); setDetailId(null); setEditor(null); setPage('library'); setStatus('all'); setQuery(''); setCategory('all'); setOwner('all'); await loadAuth(); } catch (e) { setError(e.message); } }
  function navigate(next) { history.pushState({}, '', ['requirements', 'my-requirements'].includes(next) ? `/?view=${next}` : '/'); setDetailId(null); setEditor(null); setRequirementId(null); setPage(next); setStatus('all'); setQuery(''); setCategory('all'); setOwner('all'); setDays('0'); setSort('updated'); setPageNumber(1); setMenu(false); }
  function showStatus(next) { setStatus(next); setQuery(''); setCategory('all'); setOwner('all'); setDays('0'); setPageNumber(1); requestAnimationFrame(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  async function searchRag(e) { e.preventDefault(); if (ragQuestion.trim().length < 2) return; setRagBusy(true); setRagError(''); setRagResult(null); setRagStages([]); try { await streamApi('/search/rag/stream', { question: ragQuestion.trim() }, event => { if (event.type === 'stage') setRagStages(items => [...items, event]); else if (event.type === 'result') setRagResult(event); else if (event.type === 'error') setRagError(event.error); }); } catch (err) { setRagError(err.message); } finally { setRagBusy(false); } }
  if (!auth) return <div className="boot"><div className="boot-card"><img className="boot-logo" src="/logo.png" alt="PRT"/>{error ? <><ErrorBox>{error}</ErrorBox><button className="button primary" onClick={loadAuth}>重试</button></> : <Loading/>}</div></div>;
  if (!user) return <Login auth={auth} onLogin={loadAuth}/>;
  if (!user.enabled || !user.roles.length) return <div className="boot"><div className="boot-card"><span className="boot-icon"><ShieldCheck size={22}/></span><h1>{user.enabled ? '身份已确认，等待分配权限' : '账号已停用'}</h1><p>{user.name}，请联系平台管理员配置角色和负责主管。</p><p className="muted">平台用户编号：{user.id}</p><div className="boot-actions"><button className="button" onClick={logout}>退出登录</button><button className="button primary" onClick={loadAuth}>刷新权限</button></div></div></div>;
  const items = assets, counts = catalog.stats || {};
  const pending = catalog.pendingReviews || 0;
  const dataRoles = has('employee') || has('supervisor') || has('pm') || has('business'), globalView = has('pm') || has('business');
  const stats = [{ title: 'Demo 总数', filter: 'all', value: counts.total || 0, note: `${counts.versions || 0} 个版本持续沉淀`, Icon: Database, tone: 'primary' }, { title: '已有发布版本', filter: 'published', value: counts.published || 0, note: '新版本审核不影响已发布数据', Icon: CircleCheck, tone: 'success' }, { title: '待审核', filter: 'pending', value: counts.pending || 0, note: '等待主管确认发布', Icon: Clock3, tone: 'warning' }, { title: '待完善', filter: 'incomplete', value: (counts.draft || 0) + (counts.returned || 0), note: '草稿与退回待修改', Icon: FilePenLine, tone: 'info' }];
  const titles = { library: globalView ? '数据资产库' : '数据工作台', search: '智能检索', requirements: '需求中心', 'my-requirements': '我的需求', mine: '我的 Demo', team: '团队 Demo', reviews: '审核工作台', users: '人员与权限', settings: '平台设置' };
  const descriptions = { reviews: '把好发布前的最后一关，让每份数据都准备就绪。', mine: '管理你的数据样例，从第一次上传到每一次迭代。', team: '查看团队成员的数据样例与版本进展。' };
  return <div className="app-shell">
    <header className="app-header">
      <button className="icon-button mobile-toggle" aria-label="打开菜单" onClick={() => setMenu(true)}><Menu size={18}/></button>
      <a className="brand" href="/" onClick={e => { e.preventDefault(); navigate(home); }}><img src="/logo.png" alt="PRT"/><span className="brand-divider" aria-hidden="true"/><span className="wordmark">DataHub</span><span className="brand-sub">数据样例管理平台</span></a>
      {auth.demoMode && <span className="env-banner"><FlaskConical size={13}/>体验环境 · 仅使用独立样例数据</span>}
      <div className="header-actions">
        {has('supervisor') && <button className="icon-button notification" aria-label={pending ? `查看待审核，${pending} 个版本` : '查看待审核'} title="待我审核" onClick={() => navigate('reviews')}><Bell size={17}/>{pending > 0 && <span className="notification-count">{pending > 99 ? '99+' : pending}</span>}</button>}
        <span className="header-divider" aria-hidden="true"/>
        <div className="header-user"><span className="header-user-meta"><strong>{user.name}</strong><small>{user.roles.map(r => roleLabels[r]).join(' · ')}</small></span><Avatar user={user} small/></div>
        <button className="icon-button" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={16}/></button>
      </div>
    </header>
    <div className="app-body">
      {menu && <div className="mobile-scrim" onClick={() => setMenu(false)}/>}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <nav aria-label="主导航">
          <div className="nav-label">需求协作</div>
          <Nav active={page === 'requirements'} icon={ClipboardList} onClick={() => navigate('requirements')}>需求中心</Nav>
          <Nav active={page === 'my-requirements'} icon={ListChecks} onClick={() => navigate('my-requirements')}>我的需求</Nav>
          {dataRoles && <>
            <div className="nav-label">数据资产</div>
            <Nav active={page === 'library'} icon={LayoutDashboard} onClick={() => navigate('library')}>{titles.library}</Nav>
            <Nav active={page === 'search'} icon={Sparkles} onClick={() => navigate('search')}>智能检索</Nav>
            {(has('employee') || has('supervisor')) && <Nav active={page === 'mine'} icon={FolderOpen} onClick={() => navigate('mine')}>我的 Demo</Nav>}
            {has('supervisor') && <><Nav active={page === 'team'} icon={Users} onClick={() => navigate('team')}>团队 Demo</Nav><Nav active={page === 'reviews'} icon={ClipboardCheck} count={pending} onClick={() => navigate('reviews')}>待我审核</Nav></>}
          </>}
          {has('admin') && <>
            <div className="nav-label">平台管理</div>
            <Nav active={page === 'users'} icon={UserCog} onClick={() => navigate('users')}>人员与权限</Nav>
            <Nav active={page === 'settings'} icon={Settings2} onClick={() => navigate('settings')}>平台设置</Nav>
          </>}
        </nav>
        <div className="sidebar-footer"><ShieldCheck size={14}/>企业内部工作空间</div>
      </aside>
      <main className="main">
        <ErrorBox>{error}</ErrorBox>
        {page === 'users' ? <UsersPage notify={notify}/> : page === 'settings' ? <SettingsPage notify={notify} onSaved={refresh}/> : ['requirements', 'my-requirements'].includes(page) ? <RequirementsPage key={identity} user={user} config={config} selectedId={requirementId} assignedOnly={page === 'my-requirements'} refreshKey={reload} onSelect={showRequirement} onOpenDemo={showDetail} onCreateDemo={showUpload} notify={notify} onChanged={refresh}/> : page === 'search' ? <RagPage question={ragQuestion} setQuestion={setRagQuestion} result={ragResult} stages={ragStages} busy={ragBusy} error={ragError} onSearch={searchRag} onOpen={showDetail}/> : <>
          <PageHeader title={titles[page]} description={descriptions[page] || '汇集业务数据样例，让每一次演示都有据可依。'} actions={(has('employee') || has('supervisor')) && <button className="button primary" disabled={!config || loading} onClick={() => showUpload()}><Plus size={16}/>上传 Demo</button>}/>
          <section className="stats-grid">{stats.map(({ title, filter, value, note, Icon, tone }) => <button type="button" className={`stat-card ${status === filter ? 'selected' : ''}`} key={filter} onClick={() => showStatus(filter)} aria-pressed={status === filter} aria-label={`查看${title}列表`}><span className="stat-label"><span className={`stat-icon ${tone}`}><Icon size={14}/></span>{title}</span><strong className="stat-value">{value}</strong><small>{note}</small></button>)}</section>
          {page === 'reviews' && <div className="inline-hint"><ClipboardCheck size={16}/><div><strong>有 {pending} 个版本等待你的审核</strong><span>检查数据说明与文件，可直接修改后发布，也可以退回给员工补充。</span></div></div>}
          <section className="card asset-panel" ref={listRef}>
            <div className="panel-title"><div><h2>{page === 'reviews' ? '待审核列表' : 'Demo 列表'}</h2><span>{counts.total || 0} 项数据资产</span></div><div className="panel-tools"><button className="icon-button" aria-label="刷新列表" title="刷新列表" onClick={refresh}><RefreshCw size={15}/></button><div className="view-toggle"><button className={layout === 'list' ? 'active' : ''} aria-label="列表视图" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={15}/></button><button className={layout === 'grid' ? 'active' : ''} aria-label="卡片视图" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><Grid2X2 size={14}/></button></div></div></div>
            <div className="status-tabs" role="tablist">{['all', 'published', 'pending', 'incomplete', 'draft', 'returned', 'offline'].map(key => <button key={key} role="tab" aria-selected={status === key} onClick={() => showStatus(key)} className={status === key ? 'active' : ''}>{({ all: '全部', published: '已有发布', pending: '待审核', incomplete: '待完善', draft: '草稿', returned: '已退回', offline: '已下架' })[key]}<span>{key === 'all' ? counts.total || 0 : key === 'incomplete' ? (counts.draft || 0) + (counts.returned || 0) : counts[key] || 0}</span></button>)}</div>
            <div className="filter-row"><div className="search-box"><Search size={15}/><input aria-label="搜索 Demo" placeholder="搜索 Demo 名称、说明、标签或创建人…" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={14}/></button>}</div><select aria-label="业务分类筛选" value={category} onChange={e => setCategory(e.target.value)}><option value="all">全部业务分类</option>{[...new Set([...(config?.categories || []), ...(catalog.categories || [])])].map(c => <option key={c}>{c}</option>)}</select><select aria-label="归属人筛选" value={owner} onChange={e => setOwner(e.target.value)}><option value="all">全部归属人</option>{(catalog.owners || []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select><select aria-label="更新时间筛选" value={days} onChange={e => setDays(e.target.value)}><option value="0">全部时间</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select><select aria-label="排序方式" value={sort} onChange={e => setSort(e.target.value)}><option value="updated">最近更新</option><option value="created">最近创建</option><option value="name">名称排序</option></select></div>
            {loading ? <Loading/> : !items.length ? <Empty title={counts.total ? '没有找到匹配的 Demo' : '从第一份 Demo 开始'} description={counts.total ? '试试其他关键词，或调整上方的筛选条件。' : '上传文件、补充说明，让数据在这里有序沉淀。'}/> : layout === 'list' ? <div className="table-scroll"><table className="asset-table"><thead><tr><th>Demo 名称</th><th>业务分类</th><th>归属人</th><th>版本 / 状态</th><th>最近更新</th><th className="actions">操作</th></tr></thead><tbody>{items.map(a => <tr key={a.id}><td><button className="asset-name" onClick={() => showDetail(a.id)}><strong>{a.latest.description.title || '未命名 Demo'}</strong><small>{a.latest.description.summary || '暂未填写简介'}</small></button></td><td><span className="category-tag"><i className={categoryColor(a.latest.description.category)}/>{a.latest.description.category || '未分类'}</span></td><td><span className="owner-cell"><Avatar user={a.owner} small/>{a.owner.name}</span></td><td><div className="version-cell"><span className="version-number">V{a.latest.number}</span><Badge status={a.latest.status}/></div>{a.currentVersion && a.latest.id !== a.currentVersionId && <small className="current-hint">当前发布 V{a.currentVersion}</small>}</td><td><span className="date-cell">{date(a.updatedAt)}</span></td><td className="actions"><button className="table-open" onClick={() => showDetail(a.id)}>查看详情</button></td></tr>)}</tbody></table></div> : <div className="asset-grid">{items.map(a => <button className="asset-card" key={a.id} onClick={() => showDetail(a.id)}><div className="card-top"><span className={`asset-symbol ${categoryColor(a.latest.description.category)}`}><Database size={17}/></span><Badge status={a.latest.status}/></div><h3>{a.latest.description.title || '未命名 Demo'}</h3><p>{a.latest.description.summary || '暂未填写简介'}</p><div className="card-tags"><span>{a.latest.description.category || '未分类'}</span>{a.latest.description.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}</div><div className="card-bottom"><span className="owner-cell"><Avatar user={a.owner} small/>{a.owner.name}</span><span className="version-number">V{a.latest.number}<ArrowUpRight size={14}/></span></div></button>)}</div>}
            <div className="table-footer"><span>共 {catalog.total || 0} 项结果 · 第 {catalog.page || 1} / {catalog.pages || 1} 页</span><div className="pagination"><select aria-label="每页条数" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}><option value={5}>5 条 / 页</option><option value={10}>10 条 / 页</option><option value={20}>20 条 / 页</option><option value={50}>50 条 / 页</option></select><button className="icon-button" aria-label="上一页" disabled={loading || catalog.page <= 1} onClick={() => setPageNumber(catalog.page - 1)}><ChevronLeft size={16}/></button><span className="page-current">{catalog.page || 1}</span><button className="icon-button" aria-label="下一页" disabled={loading || catalog.page >= catalog.pages} onClick={() => setPageNumber(catalog.page + 1)}><ChevronRight size={16}/></button></div></div>
          </section>
          <p className="list-explainer"><Info size={13}/>“已有发布”包含有新版本在审核中的 Demo；其他状态按最新版本统计。</p>
        </>}
      </main>
    </div>
    {detailId && <Detail id={detailId} user={user} onClose={closeWorkspacePage} onOpenRequirement={showRequirement} onEdit={(asset, version) => { history.pushState({}, '', `/?demo=${encodeURIComponent(asset.id)}&edit=${encodeURIComponent(version.id)}`); setDetailId(null); setEditor({ asset, version }); }} onChanged={() => { refresh(); }} notify={notify}/>}
    {editor && <Editor {...editor} user={user} config={config} onClose={() => editor.asset ? showDetail(editor.asset.id, true) : closeWorkspacePage()} onSaved={id => { showDetail(id, true); refresh(); notify('Demo 已保存'); }}/>}<Toast message={toast}/>
  </div>;
}
function RagPage({ question, setQuestion, result, stages, busy, error, onSearch, onOpen }) {
  return <>
    <PageHeader title="智能检索" description="描述你正在解决的问题，检索 Agent 会自主调用工具，从有权查看的数据说明中寻找答案。"/>
    <section className="card rag-panel">
      <form className="rag-form" onSubmit={onSearch}><label htmlFor="rag-question"><Sparkles size={15}/>你想找什么数据？<span>可以输入业务场景、数据字段、分析目标或 Demo 用途</span></label><textarea id="rag-question" autoFocus rows={3} value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} placeholder="例如：有哪些适合演示门店销售趋势和区域经营分析的数据？"/><div className="rag-form-footer"><small>Enter 开始检索 · Shift + Enter 换行</small><button className="button primary" disabled={busy || question.trim().length < 2}>{busy ? 'Agent 检索中…' : <><Search size={15}/>开始检索</>}</button></div></form>
      <ErrorBox>{error}</ErrorBox>
      {stages.length > 0 && <div className="rag-progress" aria-live="polite">{stages.map((stage, index) => <div className={index === stages.length - 1 && busy ? 'active' : 'done'} key={stage.key + '-' + index}><i/>{stage.text}</div>)}</div>}
    </section>
    {result ? <section className="card rag-answer"><div className="rag-answer-title"><strong>检索结果</strong><span>{result.modelUsed ? 'LLM · RAG' : '本地检索'}</span></div><p>{result.answer}</p>{result.modelError && <small className="rag-fallback">模型暂时不可用，已展示本地检索结果。</small>}{result.sources.length > 0 && <div className="rag-sources">{result.sources.map((asset, index) => <button key={asset.id} onClick={() => onOpen(asset.id)}><span>{index + 1}</span><div><strong>{asset.latest.description.title || '未命名 Demo'}</strong><small>{asset.latest.description.summary || '暂未填写简介'} · {asset.owner.name}</small></div><ArrowUpRight size={15}/></button>)}</div>}</section> : !busy && <div className="card rag-empty"><span className="empty-icon"><Search size={22}/></span><strong>输入一句话开始检索</strong><p>系统只会检索当前账号有权限查看的数据说明。</p></div>}
  </>;
}
function Nav({ active, icon: Icon, children, onClick, count = 0 }) { return <button className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}><Icon size={16}/><span>{children}</span>{count > 0 && <span className="nav-count">{count > 99 ? '99+' : count}</span>}</button>; }
function categoryColor(category) { return ({ 金融服务: 'violet', 工业制造: 'blue', 医疗健康: 'rose', 通用数据: 'amber' })[category] || 'green'; }
function Login({ auth, onLogin }) {
  const [accounts, setAccounts] = useState([]), [selected, setSelected] = useState('preview-manager'), [busy, setBusy] = useState(false), [error, setError] = useState(new URLSearchParams(location.search).get('authError') || '');
  useEffect(() => { if (auth.demoMode) api('/auth/demo-users').then(setAccounts).catch(e => setError(e.message)); }, []);
  // Keep shared requirement/Demo links intact so the workspace opens where the link pointed.
  async function login() { setBusy(true); try { await api('/auth/demo-login', { method: 'POST', body: { userId: selected } }); const url = new URL(location.href); url.searchParams.delete('authError'); history.replaceState(null, '', url.pathname + url.search); await onLogin(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  const requirementId = new URLSearchParams(location.search).get('requirement');
  const demoId = new URLSearchParams(location.search).get('demo');
  const loginQuery = new URLSearchParams({ ...(requirementId ? { requirement: requirementId } : {}), ...(demoId ? { demo: demoId } : {}) });
  const loginUrl = '/api/auth/feishu' + (loginQuery.size ? '?' + loginQuery : '');
  return <div className="login-page">
    <div className="login-card">
      <section className="login-brand">
        <div className="login-logo"><img src="/logo.png" alt="PRT"/><span className="brand-divider" aria-hidden="true"/><span className="wordmark">DataHub</span></div>
        <h2>数据样例管理平台</h2>
        <p>从一次上传到每一次迭代，在同一个空间管理样例、规范说明、协作发布，让好数据成为团队的共同资产。</p>
        <ul className="login-features">
          <li><span><FolderOpen size={15}/></span><div><strong>集中管理</strong><small>业务数据样例统一归档，按分类与归属快速检索</small></div></li>
          <li><span><Layers3 size={15}/></span><div><strong>版本可溯</strong><small>每次修改形成新版本，差异与审核记录完整保留</small></div></li>
          <li><span><ShieldCheck size={15}/></span><div><strong>权限可控</strong><small>基于企业身份与角色控制查看、下载与发布</small></div></li>
        </ul>
        <small className="login-copyright">PRT DataHub · 企业内部工作空间</small>
      </section>
      <section className="login-form">
        <h1>登录</h1>
        <p>使用企业飞书账号登录，连接你的数据与团队。</p>
        <ErrorBox>{error}</ErrorBox>
        <a className={`button primary large feishu-button ${!auth.feishuConfigured ? 'unconfigured' : ''}`} href={loginUrl}>使用飞书账号登录<ArrowRight size={16}/></a>
        {!auth.feishuConfigured && <p className="login-note">飞书登录将在管理员完成应用配置后启用。</p>}
        {auth.demoMode && <div className="demo-login"><div className="demo-login-divider"><span>功能体验 · 仅使用独立演示数据</span></div><label htmlFor="preview-user">选择身份体验完整流程</label><select id="preview-user" value={selected} onChange={e => setSelected(e.target.value)}>{accounts.map(u => <option key={u.id} value={u.id}>{u.name} · {u.roles.map(r => roleLabels[r]).join(' / ') || '待授权'}</option>)}</select><button className="button large" onClick={login} disabled={busy}>{busy ? '正在进入…' : '进入演示工作台'}<ArrowRight size={16}/></button></div>}
        <div className="login-privacy"><ShieldCheck size={13}/>仅限企业内部人员访问</div>
      </section>
    </div>
  </div>;
}
