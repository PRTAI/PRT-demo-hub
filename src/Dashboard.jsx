import React, { useEffect, useRef, useState } from 'react';
import { AlarmClock, ArrowUpRight, CalendarClock, CircleCheck, ClipboardList, Clock3, Database, Maximize2, Minimize2, PieChart, RefreshCw, Rocket, Tags, Target, TriangleAlert } from 'lucide-react';
import { api } from './api';
import { Avatar, ErrorBox, Loading, PageHeader, categoryColor, date, statusLabels } from './components';
import { RequirementDeadline, statusLabel as requirementLabel } from './Requirements';
import './dashboard.css';

const clock = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const percent = (part, whole) => whole ? Math.round(part / whole * 100) : 0;

export function DashboardPage({ refreshKey, onOpenDemo, onOpenRequirement, onShowDemos, onShowRequirements }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [tick, setTick] = useState(0), [fullscreen, setFullscreen] = useState(false);
  const board = useRef(null);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true);
    api('/dashboard', { signal: controller.signal }).then(result => { setData(result); setError(''); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [tick, refreshKey]);
  useEffect(() => { const timer = setInterval(() => { if (!document.hidden) setTick(n => n + 1); }, 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { const sync = () => setFullscreen(!!board.current && document.fullscreenElement === board.current); document.addEventListener('fullscreenchange', sync); return () => document.removeEventListener('fullscreenchange', sync); }, []);
  function toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else board.current?.requestFullscreen?.().catch(() => {}); }
  // Detail pages open outside the full-screen element, so leave full screen first.
  const leave = action => (...args) => { if (document.fullscreenElement) document.exitFullscreen(); action(...args); };

  const actions = <>
    {data && <span className="dashboard-updated" aria-live="polite"><i/>更新于 {clock(data.generatedAt)}</span>}
    <button className="icon-button" aria-label="刷新数据" title="刷新数据" disabled={busy} onClick={() => setTick(n => n + 1)}><RefreshCw className={busy ? 'spin' : ''} size={15}/></button>
    {document.fullscreenEnabled && <button className="icon-button" aria-label={fullscreen ? '退出全屏' : '全屏展示'} title={fullscreen ? '退出全屏' : '全屏展示'} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button>}
  </>;
  return <div className={`dashboard ${fullscreen ? 'is-fullscreen' : ''}`} ref={board}>
    <PageHeader title="数据大屏" description="统计范围为当前账号有权查看的 Demo 与需求；Demo 状态按最新版本统计，截止日期按北京时间计算，每分钟自动刷新。" actions={actions}/>
    <ErrorBox>{error}</ErrorBox>
    {!data ? !error && <Loading/> : <Board data={data} onOpenDemo={leave(onOpenDemo)} onOpenRequirement={leave(onOpenRequirement)} onShowDemos={onShowDemos && leave(onShowDemos)} onShowRequirements={leave(onShowRequirements)}/>}
  </div>;
}

function Board({ data, onOpenDemo, onOpenRequirement, onShowDemos, onShowRequirements }) {
  const { demos, requirements } = data;
  const kpis = [
    { title: 'Demo 总数', value: demos.total, note: `${demos.versions} 个版本 · ${data.categories.filter(item => !item.other).length}${data.categories.some(item => item.other) ? '+' : ''} 个分类`, Icon: Database, tone: 'primary', open: onShowDemos && (() => onShowDemos('all')) },
    { title: '已有发布版本', value: demos.published, note: `发布覆盖率 ${percent(demos.published, demos.total)}%`, Icon: CircleCheck, tone: 'success', open: onShowDemos && (() => onShowDemos('published')) },
    { title: '待审核', value: demos.pending, note: demos.pendingReviews ? `其中 ${demos.pendingReviews} 个待我审核` : `${demos.incomplete} 个草稿或退回待完善`, Icon: Clock3, tone: 'warning', open: onShowDemos && (() => onShowDemos('pending')) },
    { title: '进行中需求', value: requirements.active, note: `共 ${requirements.total} 个需求 · 已交付 ${requirements.statuses.find(item => item.key === 'delivered').count}`, Icon: ClipboardList, tone: 'info', open: onShowRequirements },
    { title: '7 天内截止', value: requirements.dueSoon, note: '含今日截止的进行中需求', Icon: AlarmClock, tone: 'orange', open: onShowRequirements },
    { title: '已逾期', value: requirements.overdue, note: requirements.overdue ? '请尽快跟进交付' : '暂无逾期需求', Icon: TriangleAlert, tone: 'danger', open: onShowRequirements, alert: requirements.overdue > 0 },
  ];
  return <>
    <section className="dashboard-kpis">{kpis.map(({ title, value, note, Icon, tone, open, alert }) => {
      const content = <><span className="stat-label"><span className={`stat-icon ${tone}`}><Icon size={14}/></span>{title}</span><strong className={`stat-value ${alert ? 'alert' : ''}`}>{value}</strong><small>{note}</small></>;
      return open ? <button type="button" className="stat-card" key={title} onClick={open} aria-label={`查看${title}`}>{content}</button> : <div className="stat-card" key={title}>{content}</div>;
    })}</section>
    <div className="dashboard-grid">
      <Panel title="Demo 状态分布" icon={PieChart}><Donut statuses={data.statuses} total={demos.total}/></Panel>
      <Panel title="业务分类分布" icon={Tags} extra={<span className="panel-note">按 Demo 数量</span>}>{data.categories.length ? <Bars items={data.categories.map(item => ({ key: item.name, label: item.name, value: item.count, tone: item.other ? 'slate' : categoryColor(item.name) }))}/> : <Quiet>暂无可查看的 Demo</Quiet>}</Panel>
      <Panel className="span-wide" title="需求交付进度" icon={Target}><RequirementProgress requirements={requirements}/></Panel>
      <Panel className="span-half" title="近期截止需求" icon={CalendarClock} extra={<button className="text-link" onClick={onShowRequirements}>需求中心<ArrowUpRight size={14}/></button>}>{data.deadlines.length ? <ul className="dashboard-list deadlines">{data.deadlines.map(item => <li key={item.id}><button type="button" onClick={() => onOpenRequirement(item.id)}><span className="list-main"><strong>{item.title}</strong><small><span className={`requirement-status ${item.status}`}>{requirementLabel(item.status)}</span>已关联 {item.demoCount} 个 Demo</small></span><RequirementDeadline requirement={item} compact/></button></li>)}</ul> : <Quiet>暂无设置截止日期的进行中需求</Quiet>}</Panel>
      <Panel className="span-half" title="最近发布" icon={Rocket}>{data.recent.length ? <ul className="dashboard-list">{data.recent.map(item => <li key={item.id}><button type="button" onClick={() => onOpenDemo(item.id)}><span className="list-main"><strong>{item.title || '未命名 Demo'}</strong><small><span className="category-tag"><i className={categoryColor(item.category)}/>{item.category || '未分类'}</span><span className="owner-cell"><Avatar user={item.owner} small/>{item.owner.name}</span></small></span><span className="list-side"><span className="version-number">V{item.number}</span><time dateTime={item.publishedAt}>{date(item.publishedAt)}</time></span></button></li>)}</ul> : <Quiet>暂无已发布的 Demo</Quiet>}</Panel>
    </div>
  </>;
}

function Panel({ title, icon: Icon, extra, className = '', children }) {
  return <section className={`card dashboard-panel ${className}`}><div className="dashboard-panel-title"><h2><Icon size={15}/>{title}</h2>{extra}</div><div className="dashboard-panel-body">{children}</div></section>;
}
function Quiet({ children }) { return <p className="dashboard-quiet">{children}</p>; }

function Donut({ statuses, total }) {
  let offset = 0;
  return <div className="donut-wrap">
    <div className="donut">
      <svg viewBox="0 0 42 42" aria-hidden="true"><circle className="donut-base" cx="21" cy="21" r="15.915"/>{total > 0 && statuses.filter(item => item.count).map(item => { const length = item.count / total * 100, segment = <circle key={item.key} className={`donut-segment ${item.key}`} cx="21" cy="21" r="15.915" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={25 - offset}/>; offset += length; return segment; })}</svg>
      <div className="donut-center"><strong>{total}</strong><span>个 Demo</span></div>
    </div>
    <ul className="donut-legend">{statuses.map(item => <li key={item.key}><span className={`badge ${item.key}`}><i/>{statusLabels[item.key]}</span><b>{item.count}</b><small>{percent(item.count, total)}%</small></li>)}</ul>
  </div>;
}

function Bars({ items }) {
  const max = Math.max(1, ...items.map(item => item.value));
  return <ul className="bars">{items.map(item => <li key={item.key}><span className="bars-label" title={item.label}><i className={item.tone}/>{item.label}</span><span className="bars-track"><span className={`bars-fill ${item.tone}`} style={{ width: `${item.value / max * 100}%` }}/></span><b>{item.value}</b></li>)}</ul>;
}

function RequirementProgress({ requirements }) {
  const delivered = requirements.statuses.find(item => item.key === 'delivered').count;
  return <div className="progress">
    <div className="stack" role="img" aria-label={requirements.statuses.map(item => `${requirementLabel(item.key)} ${item.count}`).join('，')}>{requirements.total ? requirements.statuses.filter(item => item.count).map(item => <span key={item.key} className={item.key} style={{ flexGrow: item.count }}/>) : <span className="none"/>}</div>
    <ul className="stack-legend">{requirements.statuses.map(item => <li key={item.key}><i className={item.key}/>{requirementLabel(item.key)}<b>{item.count}</b></li>)}</ul>
    <Meter label="进行中需求已关联 Demo" part={requirements.covered} whole={requirements.active}/>
    <Meter label="需求交付完成率" part={delivered} whole={requirements.total}/>
  </div>;
}
function Meter({ label, part, whole }) {
  return <div className="progress-meter"><span><span>{label}</span><b>{part} / {whole}<small>{percent(part, whole)}%</small></b></span><span className="meter"><span className="meter-fill" style={{ width: `${percent(part, whole)}%` }}/></span></div>;
}
