import React, { useEffect, useState } from 'react';
import { api } from './api';
import { ErrorBox, Loading, bytes } from './components';
export function FilePreview({ versionId, file, onClose }) {
  const [data,setData] = useState(null), [error,setError] = useState(''), [entry,setEntry] = useState(null), [folder,setFolder] = useState('');
  const base = `/versions/${versionId}/files/${file.id}/preview`;
  const endpoint = base + (entry === null ? '' : `?entry=${entry}`);
  useEffect(() => { const controller = new AbortController(); setData(null); setError(''); api(endpoint,{signal:controller.signal}).then(setData).catch(e=>{if(e.name!=='AbortError')setError(e.message);}); return ()=>controller.abort(); },[endpoint]);
  const raw = '/api' + endpoint + (entry === null ? '?' : '&') + 'raw=1';
  const folders = data?.entries ? [...new Set(data.entries.filter(e=>e.name.startsWith(folder)).map(e=>e.name.slice(folder.length)).filter(n=>n.includes('/')).map(n=>n.split('/')[0]))].sort() : [];
  return <section className="file-preview" aria-label="文件预览"><header><strong>{data?.name || file.name}</strong><button className="button" onClick={onClose}>关闭预览</button></header>
    {entry !== null && <button className="button" onClick={()=>setEntry(null)}>返回压缩包</button>}
    <ErrorBox>{error}</ErrorBox>{!data && !error && <Loading/>}
    {data?.kind === 'archive' && <><p>ZIP · {data.entries.length} 个条目 · 点击文件夹进入，再选择文件预览</p><div className="archive-path">/{folder}{folder && <button className="button" onClick={()=>setFolder(folder.split('/').slice(0,-2).join('/') + (folder.split('/').length > 2 ? '/' : ''))}>上一级</button>}</div><div className="archive-list">{folders.map(n=><button key={n} onClick={()=>setFolder(folder+n+'/')}>📁 {n}/</button>)}{data.entries.filter(e=>!e.directory && e.name.startsWith(folder) && !e.name.slice(folder.length).includes('/')).map(e=><button key={e.id} onClick={()=>setEntry(e.id)}><span>{e.name.slice(folder.length)}</span><small>{bytes(e.size)}{e.encrypted ? ' · 已加密' : ''}</small></button>)}</div></>}
    {data?.kind === 'text' && <>{data.truncated && <p>内容较大，仅展示前 1 MB。</p>}<pre className="preview-code"><code>{data.content}</code></pre></>}
    {data?.kind === 'video' && <video key={raw} controls playsInline preload="metadata" src={raw} onError={()=>setError('视频无法播放，可能是编码不受浏览器支持；请下载查看。')}/>}
    {data?.kind === 'audio' && <audio key={raw} controls preload="metadata" src={raw} onError={()=>setError('音频无法播放，可能是编码不受浏览器支持；请下载查看。')}/>}
    {data?.kind === 'image' && <img src={raw} alt={data.name} onError={()=>setError('图片无法显示，请下载查看。')}/>}
    {data?.kind === 'unsupported' && <p>{data.message}</p>}
  </section>;
}
