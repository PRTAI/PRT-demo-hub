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
