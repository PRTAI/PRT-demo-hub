import fs from 'node:fs';
import path from 'node:path';

// Upload file bytes as Docx media, then bind the token to the already-recorded File block.
// Each persisted step can resume without creating another visible attachment block.
export async function uploadDocumentAttachments(store, job, snapshot, states, request, persist, { singleUploadBytes = 20 * 1024 * 1024 } = {}) {
  for (const file of snapshot.attachments || []) {
    const state = states[file.position] ||= {};
    if (state.done) continue;
    if (!/^[a-f0-9-]{36}$/i.test(file.id) || !/^[a-zA-Z0-9_-]+$/.test(state.blockId || '')) throw new Error('导出附件记录无效，请重新发起导出');
    const recorded = store.one('SELECT size,checksum FROM files WHERE id=?', file.id), source = path.join(store.root, 'files', file.id);
    if (!recorded || recorded.size !== file.size || file.checksum && recorded.checksum !== file.checksum) throw new Error(`附件“${file.name}”的记录已变化，请重新发起导出`);
    let stat;
    try { stat = await fs.promises.stat(source); } catch { throw new Error(`附件“${file.name}”的原文件缺失，无法上传到飞书`); }
    if (!stat.isFile() || stat.size !== file.size) throw new Error(`附件“${file.name}”的原文件不完整，无法上传到飞书`);
    if (!state.fileToken) {
      const blob = await fs.openAsBlob(source);
      const meta = { file_name: file.name, parent_type: 'docx_file', parent_node: state.blockId, size: file.size, extra: JSON.stringify({ drive_route_token: job.document_id }) };
      if (file.size <= singleUploadBytes) {
        const form = new FormData();
        for (const [key, value] of Object.entries(meta)) form.set(key, String(value));
        form.set('file', blob, file.name);
        const result = await request('drive/v1/medias/upload_all', form, 'POST', 90000);
        state.fileToken = result.file_token;
      } else {
        if (!state.uploadId) {
          const result = await request('drive/v1/medias/upload_prepare', meta);
          if (!result.upload_id || !Number.isInteger(result.block_size) || result.block_size < 1 || result.block_size > 64 * 1024 * 1024 || result.block_num !== Math.ceil(file.size / result.block_size)) throw new Error('飞书未返回有效的附件分片方案，请重试');
          Object.assign(state, { uploadId: result.upload_id, blockSize: result.block_size, blockNum: result.block_num, nextPart: 0 }); persist();
        }
        for (let index = state.nextPart; index < state.blockNum; index++) {
          const part = blob.slice(index * state.blockSize, Math.min(file.size, (index + 1) * state.blockSize)), form = new FormData();
          form.set('upload_id', state.uploadId); form.set('seq', String(index)); form.set('size', String(part.size)); form.set('file', part, file.name);
          await request('drive/v1/medias/upload_part', form, 'POST', 90000);
          state.nextPart = index + 1; persist();
        }
        state.fileToken = (await request('drive/v1/medias/upload_finish', { upload_id: state.uploadId, block_num: state.blockNum })).file_token;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(state.fileToken || '')) throw new Error('飞书未返回有效的附件 Token，请重试');
      persist();
    }
    await request(`docx/v1/documents/${job.document_id}/blocks/${state.blockId}?document_revision_id=-1`, { replace_file: { token: state.fileToken } }, 'PATCH');
    state.done = true; persist();
  }
}
