import { openStore, parse, uid, now } from '../server/db.mjs';
const id = process.argv[2];
if (!id) throw new Error('Usage: node --env-file-if-exists=.env scripts/admin.mjs PLATFORM_USER_ID');
const store = openStore(process.env.DATA_DIR || './data');
try {
  store.tx(() => {
    const user = store.one('SELECT * FROM users WHERE id=?', id);
    if (!user) throw new Error('User not found; complete Feishu login first');
    if (store.all('SELECT roles FROM users WHERE enabled=1').some(u => parse(u.roles, []).includes('admin'))) throw new Error('An administrator already exists; use the administration UI');
    store.run('UPDATE users SET roles=?,enabled=1,revision=revision+1 WHERE id=?', JSON.stringify([...new Set([...parse(user.roles, []), 'admin'])]), id);
    store.run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', uid(), null, null, 'server-operator', '服务器初始化', 'user_update', JSON.stringify({ user: user.name, reason: '初始化首位管理员' }), now());
    console.log('Initial administrator assigned. Refresh the user session.');
  });
} finally { store.db.close(); }
