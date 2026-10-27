export function appendRequirementDocuments(current, selected) {
  const files = [...current];
  const identity = file => JSON.stringify([file.name, file.size, file.lastModified, file.webkitRelativePath || '']);
  const known = new Set(files.map(identity));
  for (const file of selected) {
    const key = identity(file);
    if (!known.has(key)) { files.push(file); known.add(key); }
  }
  return files;
}

export function droppedRequirementDocuments(transfer) {
  const items = Array.from(transfer?.items || []).filter(item => item.kind === 'file');
  let hasDirectories = false;
  const files = items.length ? items.flatMap(item => {
    if (item.webkitGetAsEntry?.()?.isDirectory) { hasDirectories = true; return []; }
    const file = item.getAsFile(); return file ? [file] : [];
  }) : Array.from(transfer?.files || []);
  return { files, hasDirectories };
}
