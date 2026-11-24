import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronDown, Layers3, ShieldCheck } from 'lucide-react';
import { api } from './api';
import { ErrorBox, roleLabels } from './components';
import './Login.css';

const poster = '/media/login-forest-poster.jpg';
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// The DOM order keeps the outgoing film above its preloaded successor.
const films = [
  { id: 'ambient', src: '/media/login-forest-ambient.mp4', poster, loop: true },
  { id: 'landing', src: '/media/login-forest-landing.mp4', poster: '/media/login-forest-opening.jpg', next: 'ambient' },
  { id: 'intro', src: '/media/login-forest.mp4', poster: '/media/login-forest-opening.jpg', next: 'landing' },
];

export function Login({ auth, onLogin }) {
  const [accounts, setAccounts] = useState([]), [selected, setSelected] = useState('preview-manager'), [busy, setBusy] = useState(false), [error, setError] = useState(new URLSearchParams(location.search).get('authError') || '');
  const [phase, setPhase] = useState(() => reducedMotion() ? 'ready' : 'opening'), [reduced, setReduced] = useState(reducedMotion);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [scene, setScene] = useState('intro'), [visibleScene, setVisibleScene] = useState('intro');
  const videos = useRef({});
  const opening = phase === 'opening';

  const reveal = useCallback(() => {
    setPhase(current => current === 'opening' ? 'revealing' : current);
  }, []);
  const mediaError = useCallback(() => { setMediaFailed(true); reveal(); }, [reveal]);

  useEffect(() => {
    if (!opening) return;
    // The interface floats in promptly, independently of the background film.
    const timer = setTimeout(reveal, 1800);
    return () => clearTimeout(timer);
  }, [opening, reveal]);

  useEffect(() => {
    if (phase !== 'revealing') return;
    const timer = setTimeout(() => setPhase('ready'), 2800);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    for (const [id, film] of Object.entries(videos.current)) if (id !== scene) film?.pause();
    if (reduced || mediaFailed || document.hidden) return;
    let cancelled = false;
    videos.current[scene]?.play()?.catch(() => { if (!cancelled) mediaError(); });
    return () => { cancelled = true; };
  }, [scene, reduced, mediaFailed, mediaError]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReduced(preference.matches);
      if (preference.matches) { Object.values(videos.current).forEach(film => film?.pause()); setPhase('ready'); }
    };
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const update = () => {
      if (document.hidden) Object.values(videos.current).forEach(film => film?.pause());
      else if (!reduced && !mediaFailed) videos.current[scene]?.play()?.catch(mediaError);
    };
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [scene, reduced, mediaFailed, mediaError]);

  useEffect(() => { if (auth.demoMode) api('/auth/demo-users').then(setAccounts).catch(e => setError(e.message)); }, [auth.demoMode]);
  async function login() { setBusy(true); try { await api('/auth/demo-login', { method: 'POST', body: { userId: selected } }); history.replaceState(null, '', '/'); await onLogin(); } catch (e) { setError(e.message); } finally { setBusy(false); } }

  const requirementId = new URLSearchParams(location.search).get('requirement');
  const demoId = new URLSearchParams(location.search).get('demo');
  const loginQuery = new URLSearchParams({ ...(requirementId ? { requirement: requirementId } : {}), ...(demoId ? { demo: demoId } : {}) });
  const loginUrl = '/api/auth/feishu' + (loginQuery.size ? '?' + loginQuery : '');

  return <div className={`login-page login-cinematic login-${phase}`}>
    <div className="login-scene" aria-hidden="true">
      <img className="login-scene-poster" src={poster} alt="" fetchPriority="high"/>
      {!reduced && !mediaFailed && films.map(film => <video key={film.id} ref={node => { videos.current[film.id] = node; }} className={`login-scene-video login-scene-${film.id} ${(film.id === 'intro' && visibleScene !== 'intro') || (film.id === 'landing' && visibleScene === 'ambient') ? 'is-settled' : ''}`} src={film.src} poster={film.poster} muted loop={film.loop || false} playsInline preload="auto" disablePictureInPicture tabIndex={-1} onPlaying={() => { if (scene === film.id) setVisibleScene(film.id); }} onEnded={() => { if (scene === film.id && film.next) setScene(film.next); }} onError={mediaError}/>)}
      <div className="login-scene-wash"/>
    </div>

    <header className="login-header">
      <div className="brand"><span className="brand-icon"><Layers3 size={22}/></span><span><strong>PRT / DataHub</strong><small>企业内部数据样例管理平台</small></span></div>
    </header>

    <div className="login-foreground">
      <div className="login-form" inert={opening}>
        <div className="login-box">
          <div className="login-card-kicker"><span/>YOUR DATA, AT HOME</div>
          <h2>欢迎回到数据工作台</h2>
          <p>使用企业身份，连接你的数据与团队。</p>
          <ErrorBox>{error}</ErrorBox>
          <a className={`button primary feishu-button ${!auth.feishuConfigured ? 'unconfigured' : ''}`} href={loginUrl}><ArrowUpRight size={18}/>使用飞书账号登录<ArrowRight size={16}/></a>
          {!auth.feishuConfigured && <p className="login-note">飞书登录将在管理员完成应用配置后启用。</p>}
          {auth.demoMode && <details className="demo-login"><summary><span>本地功能体验</span><ChevronDown size={13}/></summary><div className="demo-login-body"><label htmlFor="preview-user">选择演示身份</label><select id="preview-user" value={selected} onChange={e => setSelected(e.target.value)}>{accounts.map(u => <option key={u.id} value={u.id}>{u.name} · {u.roles.map(r => roleLabels[r]).join(' / ') || '待授权'}</option>)}</select><button className="button" onClick={login} disabled={busy}>{busy ? '正在进入…' : '进入演示工作台'}<ArrowRight size={16}/></button><small>仅使用独立演示数据</small></div></details>}
          <div className="login-privacy"><ShieldCheck size={12}/>仅限企业内部人员访问</div>
        </div>
      </div>
    </div>

    <footer className="login-footer">
      <div className="login-caption"><div className="eyebrow">A SHARED SPACE FOR YOUR DATA</div><h1>让好数据，<br/>成为团队的共同资产。</h1></div>
      <div className="login-footer-meta"><span>PRT DataHub · 企业内部工作空间</span></div>
    </footer>
  </div>;
}
