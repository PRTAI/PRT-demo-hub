import React, { useEffect, useRef, useState } from 'react';
import { Check, Link2 } from 'lucide-react';

export function ShareLink({ url, label = '复制链接' }) {
  const [copied, setCopied] = useState(false), [manual, setManual] = useState(false), timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let success = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); success = true; } } catch { /* LAN HTTP and browser policies may block the Clipboard API. */ }
    if (!success) {
      const previous = document.activeElement, input = document.createElement('textarea');
      input.value = url; input.style.position = 'fixed'; input.style.opacity = '0'; input.setAttribute('readonly', '');
      document.body.appendChild(input); input.select();
      try { success = document.execCommand('copy'); } catch { /* Show a selectable URL below. */ }
      finally { input.remove(); previous?.focus(); }
    }
    setManual(!success); setCopied(success); clearTimeout(timer.current);
    if (success) timer.current = setTimeout(() => setCopied(false), 2500);
  }
  if (!url) return null;
  return <span className="share-link"><button type="button" className="button small" onClick={copy} title="分享后仍需登录，并具备对应的查看权限">{copied ? <Check size={14}/> : <Link2 size={14}/>}<span aria-live="polite">{copied ? '已复制' : label}</span></button>{manual && <label>请复制链接<input aria-label="分享链接" readOnly value={url} onFocus={event => event.target.select()}/></label>}</span>;
}
