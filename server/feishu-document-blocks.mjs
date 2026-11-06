// Build native Docx blocks rather than displaying Markdown markup as plain text.
const chunks = (value, size = 1000) => {
  const characters = Array.from(String(value)), result = [];
  for (let index = 0; index < characters.length; index += size) result.push(characters.slice(index, index + size).join(''));
  return result;
};
export function runs(value, style = {}) {
  return chunks(value).map(content => ({ text_run: { content, ...(Object.keys(style).length ? { text_element_style: style } : {}) } }));
}
const safeLink = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
export function inline(value) {
  const result = [], pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let previous = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > previous) result.push(...runs(value.slice(previous, match.index)));
    if (match[1] && safeLink(match[2])) result.push(...runs(match[1], { link: { url: safeLink(match[2]) } }));
    else if (match[3]) result.push(...runs(match[3], { bold: true }));
    else if (match[4]) result.push(...runs(match[4], { inline_code: true }));
    else result.push(...runs(match[0]));
    previous = match.index + match[0].length;
  }
  if (previous < value.length) result.push(...runs(value.slice(previous)));
  return result;
}
export const heading = (value, level = 1) => {
  const depth = Math.max(1, Math.min(6, level));
  return { block_type: depth + 2, ['heading' + depth]: { elements: runs(value) } };
};
export const paragraph = (value, url) => ({ block_type: 2, text: { elements: url && safeLink(url) ? runs(value, { link: { url: safeLink(url) } }) : inline(value) } });
export const field = (label, value, url) => ({ block_type: 2, text: { elements: [...runs(label + '：', { bold: true }), ...runs(value || '未填写', url && safeLink(url) ? { link: { url: safeLink(url) } } : {})] } });
export function markdownBlocks(value, headingLevel = 2) {
  if (!value?.trim()) return [paragraph('未填写')];
  const blocks = []; let code = null;
  const flushCode = () => {
    for (const part of chunks(code.join('\n') || ' ', 6000)) blocks.push({ block_type: 14, code: { style: { language: 1, wrap: false }, elements: runs(part) } });
    code = null;
  };
  for (const line of value.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { if (code) flushCode(); else code = []; continue; }
    if (code) { code.push(line); continue; }
    const title = line.match(/^(#{1,6})\s+(.+)$/), bullet = line.match(/^\s*[-*+]\s+(.+)$/), ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (title) blocks.push(heading(title[2], headingLevel + title[1].length - 1));
    else if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) blocks.push({ block_type: 22, divider: {} });
    else if (line.trim()) for (const part of chunks((bullet || ordered)?.[1] || line, 4000)) {
      const kind = bullet ? 'bullet' : ordered ? 'ordered' : 'text';
      blocks.push({ block_type: bullet ? 12 : ordered ? 13 : 2, [kind]: { elements: inline(part) } });
    }
  }
  if (code) flushCode();
  return blocks;
}
