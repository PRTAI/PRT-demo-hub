import { createApp } from './app.mjs';
import { validateBinding } from './runtime.mjs';
const { app, config, store, notifications } = createApp();
const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 3100);
validateBinding({ ...config, host, containerPreview: process.env.CONTAINER_PREVIEW === 'true' });
for (const entry of (await import('node:fs')).readdirSync(store.root + '/tmp', { withFileTypes: true })) {
  const fs = await import('node:fs'); const file = store.root + '/tmp/' + entry.name;
  if (entry.isFile() && Date.now() - fs.statSync(file).mtimeMs > 86400000) fs.unlinkSync(file);
}
const server = app.listen(port, host, error => {
  if (error) {
    console.error(`Server failed to listen on ${host}:${port}: ${error.code}`);
    store.db.close();
    process.exit(1);
  }
  console.log(`PRT ${config.demoMode ? 'preview' : 'server'} ready at http://${host}:${port}`);
});
server.requestTimeout = 30 * 60 * 1000;
const stopNotifications = notifications.start();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  console.log(`Received ${signal}; shutting down server`);
  if (stopping) return; stopping = true; stopNotifications();
  server.close(() => { store.db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 30000).unref();
});
