import fs from 'node:fs';
import yauzl from 'yauzl';
const media = { mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime', m4v:'video/mp4', mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4', flac:'audio/flac', aac:'audio/aac', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp' };
const textExtensions = new Set('txt md csv tsv json jsonl xml yaml yml log ini cfg conf sql py js jsx ts tsx java c h cpp hpp cs go rs sh bash ps1 bat css scss html htm vue svelte r rb php toml env gitignore dockerfile makefile ipynb'.split(' '));
export function previewType(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'zip') return { kind:'archive' };
  if (media[ext]) return { kind:media[ext].split('/')[0], mime:media[ext] };
  return { kind:textExtensions.has(ext) ? 'text' : 'unsupported' };
}
const bad = message => Object.assign(new Error(message), {status:400});
let activeArchives = 0;
export async function readZip(file, index) {
  if (activeArchives >= 4) throw Object.assign(new Error('压缩包预览繁忙，请稍后重试'), {status:429});
  activeArchives++;
  let zip;
  try {
    zip = await yauzl.openPromise(file, {lazyEntries:true});
    if (zip.entryCount > 10000) throw bad('压缩包超过 10000 个条目，请下载后查看');
    const entries = []; let i = 0;
    for await (const entry of zip.eachEntry()) {
      const id = i++;
      if (i > 10000 || entry.fileName.length > 2000) throw bad('压缩包目录超过预览限制');
      if (index === undefined) { entries.push({ id, name:entry.fileName, size:entry.uncompressedSize, directory:entry.fileName.endsWith('/'), encrypted:!!(entry.generalPurposeBitFlag & 1) }); continue; }
      if (id !== index) continue;
      if (entry.generalPurposeBitFlag & 1) throw bad('加密文件请下载后解密查看');
      if (entry.fileName.endsWith('/')) throw bad('请选择文件');
      if (entry.uncompressedSize > 64 * 1048576 || entry.uncompressedSize > Math.max(entry.compressedSize, 1) * 1000) throw bad('包内文件超过预览限制（64 MB 或解压比例过高），请下载查看');
      const stream = await zip.openReadStreamPromise(entry); const chunks = []; let total = 0;
      for await (const chunk of stream) { total += chunk.length; if (total > 64 * 1048576) { stream.destroy(); throw bad('包内文件过大'); } chunks.push(chunk); }
      return { name:entry.fileName, buffer:Buffer.concat(chunks) };
    }
    if (index !== undefined) throw bad('包内文件不存在');
    return entries;
  } catch (error) { if (error.status) throw error; throw bad('无法读取 ZIP：文件损坏或压缩方式不受支持，请下载查看'); }
  finally { zip?.close(); activeArchives--; }
}
export async function servePreview(req, res, file, target) {
  let name = file.name, buffer;
  if (req.query.entry !== undefined) {
    if (previewType(name).kind !== 'archive' || !/^\d+$/.test(req.query.entry)) throw bad('无效的压缩包条目');
    const entry = await readZip(target, Number(req.query.entry)); name = entry.name; buffer = entry.buffer;
  }
  const type = previewType(name);
  res.set('Cache-Control', 'no-store');
  if (req.query.raw === '1') {
    if (!['video','audio','image'].includes(type.kind)) throw bad('此类型不能直接播放');
    res.type(type.mime);
    if (!buffer) return res.sendFile(target, {dotfiles:'allow', cacheControl:false});
    res.set('Accept-Ranges','bytes');
    if (req.headers.range) {
      const range = req.range(buffer.length);
      if (!Array.isArray(range) || range.length !== 1 || range.type !== 'bytes') return res.status(416).set('Content-Range',`bytes */${buffer.length}`).end();
      const {start,end} = range[0]; res.status(206).set('Content-Range',`bytes ${start}-${end}/${buffer.length}`); return res.send(buffer.subarray(start,end+1));
    }
    return res.send(buffer);
  }
  if (type.kind === 'archive') {
    if (buffer) return res.json({kind:'unsupported',name,message:'嵌套压缩包请下载原压缩包后查看'});
    return res.json({kind:'archive',name,entries:await readZip(target)});
  }
  if (type.kind === 'text') {
    const limit = 1048576; const size = buffer ? buffer.length : fs.statSync(target).size;
    if (!buffer) { const handle = await fs.promises.open(target, 'r'); try { buffer = Buffer.alloc(Math.min(size,limit)); await handle.read(buffer,0,buffer.length,0); } finally { await handle.close(); } }
    const data = buffer.subarray(0,limit); let content;
    if (data[0] === 255 && data[1] === 254) content = new TextDecoder('utf-16le').decode(data);
    else { try { content = new TextDecoder('utf-8',{fatal:true}).decode(data); } catch { content = new TextDecoder('gb18030').decode(data); } }
    return res.json({kind:'text',name,content,truncated:size>limit});
  }
  res.json({...type,name,message:type.kind === 'unsupported' ? '此格式暂不支持在线预览，请下载查看（压缩包目前支持 ZIP）' : undefined});
}
