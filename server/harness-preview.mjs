import { now } from './db.mjs';

/** Deterministic, isolated same-app identities and business records for the local Harness preview. */
export function seedHarnessPreview(store) {
  const { run } = store;
  const time = now(), start = time.slice(0, 10), deadline = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  store.tx(() => {
    for (const [id, openId, name, roles] of [
      ['harness-preview-member', 'ou_prt_dev_member', 'PRT 测试成员', ['employee']],
      ['harness-preview-admin', 'ou_prt_dev_admin', 'PRT 测试管理员', ['admin', 'employee', 'pm']],
    ]) run('INSERT OR IGNORE INTO users(id,open_id,name,roles,created_at) VALUES(?,?,?,?,?)', id, openId, name, JSON.stringify(roles), time);
    for (const [id, title, content] of [
      ['39171df0-3000-4000-8000-000000000001', '零售销售数据 Demo', '生成一份合成零售销售 CSV，包含日期、门店、商品、数量和销售额，至少 30 行。提供字段说明与示例分析。完成后将 CSV 和说明上传为关联此需求的 Demo 草稿。'],
      ['39171df0-3000-4000-8000-000000000002', '客户分群分析样例', '生成不含真实个人信息的客户分群数据及使用说明，用于演示客户画像、消费频率和客单价分析。'],
    ]) {
      run("INSERT OR IGNORE INTO requirements(id,title,content,category,status,publisher_id,created_at,updated_at,planned_date,deadline_date) VALUES(?,?,?,'演示数据','open','preview-pm',?,?,?,?)", id, title, content, time, time, start, deadline);
      for (const user of ['harness-preview-member', 'harness-preview-admin']) run("INSERT OR IGNORE INTO requirement_assignees(requirement_id,user_id,assigned_by,created_at,responsibility) VALUES(?,?,'preview-pm',?,'development')", id, user, time);
    }
  });
}
