import React, { useEffect, useRef } from 'react';
import { ArrowLeft, LoaderCircle, FileArchive, FileText, Database, ArrowUpRight, Check, AlertCircle } from 'lucide-react';
export const statusLabels = { draft: '草稿', pending: '待审核', returned: '已退回', published: '已发布', offline: '已下架' };
export const roleLabels = { employee: '员工', supervisor: '主管', pm: '产品经理', business: '商务', admin: '管理员' };
export const actionLabels = { backup_start: '开始备份', backup_complete: '备份完成', backup_failed: '备份失败', create: '创建 Demo', edit: '更新数据说明', upload: '上传文件', remove_file: '移除文件', submit: '提交审核', withdraw: '撤回提交', reject: '退回修改', publish: '发布版本', unpublish: '下架版本', restore: '恢复发布', set_default: '设为默认版本', new_version: '创建新版本', download: '下载文件', transfer: '资产交接', delete_draft: '删除草稿', user_update: '更新人员权限', settings_update: '更新基础配置' };
export const date = value => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
export function bytes(value) { if (!value) return '0 B'; const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1024))); return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][i]}`; }
export function Badge({ status }) { return <span className={`badge ${status}`}><i />{statusLabels[status] || status}</span>; }
export function Avatar({ user, small = false }) { return <span className={`avatar ${small ? 'small' : ''}`} aria-label={user?.name}>{user?.name?.slice(-2) || 'PR'}</span>; }
export function FileIcon({ name = '', large = false }) { const archive = /\.(zip|rar|7z|tar|gz)$/i.test(name); const Icon = archive ? FileArchive : /\.(csv|json|xlsx?)$/i.test(name) ? Database : FileText; return <span className={`file-icon ${large ? 'large' : ''} ${archive ? 'archive' : ''}`}><Icon size={large ? 25 : 20}/></span>; }
export function Empty({ title = '暂时没有 Demo', description = '上传第一个数据样例，让数据更容易被管理和复用。', action }) { return <div className="empty"><div className="empty-icon"><Database size={32}/></div><h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Loading() { return <div className="loading"><LoaderCircle className="spin" size={24}/><span>正在加载…</span></div>; }
export function ErrorBox({ children }) { return children ? <div className="error-box" role="alert"><AlertCircle size={17}/><span>{children}</span></div> : null; }
export function Modal({ title, subtitle, children, onClose, wide = false, busy = false }) {
  const ref = useRef();
  const behavior = useRef({ busy, onClose }); behavior.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement, previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const key = e => {
      if (e.key === 'Escape' && !behavior.current.busy) behavior.current.onClose();
    };
    document.addEventListener('keydown', key); return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="workspace-page-shell"><section className={`workspace-page modal ${wide ? 'wide' : ''}`} role="region" aria-label={title} tabIndex={-1} ref={ref}><header className="modal-header page-view-header"><button className="page-back" aria-label="返回上一页" onClick={onClose} disabled={busy}><ArrowLeft size={19}/>返回</button><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section></div>;
}
export function Toast({ message }) { return message ? <div className="toast" role="status"><Check size={18}/>{message}</div> : null; }
export function RowLink({ children, onClick }) { return <button className="text-link" onClick={onClick}>{children}<ArrowUpRight size={14}/></button>; }
