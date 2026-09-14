import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { uid, now } from './db.mjs';

export function seedPreview(store) {
  const { one, run, tx } = store;
  if (one("SELECT value FROM metadata WHERE key='seeded'")) return;
  tx(() => {
    const users = [
      ['preview-manager', '林知远', ['supervisor', 'pm'], null],
      ['preview-employee', '陈思远', ['employee'], 'preview-manager'],
      ['preview-colleague', '许嘉宁', ['employee'], 'preview-manager'],
      ['preview-pm', '周亦舒', ['pm'], null],
      ['preview-admin', '平台管理员', ['admin'], null],
      ['preview-business', '商务同事', ['business'], null],
      ['preview-other-manager', '李明', ['supervisor'], null],
      ['preview-other', '王晨', ['employee'], 'preview-other-manager'],
      ['preview-unassigned', '待分配用户', [], null],
    ];
    for (const [id, name, roles, supervisor] of users) run('INSERT INTO users(id,open_id,name,roles,supervisor_id,created_at) VALUES(?,?,?,?,?,?)', id, 'preview:' + id, name, JSON.stringify(roles), supervisor, now());
    const samples = [
      ['零售门店销售分析', '覆盖门店、商品与交易的完整分析样例，支持销售趋势和经营看板演示。', '零售与消费', ['经营分析', '多表关联'], 'published', 'preview-employee', 'retail_sales.csv'],
      ['银行客户分群数据集', '面向客户画像与分群场景，包含客户基础属性及行为特征。', '金融服务', ['客户画像', '分群'], 'pending', 'preview-colleague', 'customer_segments.json'],
      ['设备运行与故障监测', '生产设备时序指标及故障记录，用于设备健康度分析。', '工业制造', ['时序数据', '设备监测'], 'published', 'preview-manager', 'equipment_metrics.csv'],
      ['电商订单与用户行为', '订单、用户和行为事件样例，用于转化路径与复购分析。', '零售与消费', ['用户行为', '订单'], 'returned', 'preview-employee', 'ecommerce_orders.json'],
      ['供应链库存周转分析', '仓库库存及出入库记录，适用于库存周转和补货场景。', '工业制造', ['库存管理'], 'draft', 'preview-colleague', 'inventory.csv'],
      ['门诊服务运营样例', '合成的预约及门诊服务记录，演示运营效率指标。', '医疗健康', ['运营分析', '合成数据'], 'published', 'preview-employee', 'outpatient.csv'],
      ['通用地理区域字典', '区域代码及层级关系，供地图和区域汇总场景使用。', '通用数据', ['基础字典'], 'offline', 'preview-manager', 'regions.json'],
      ['项目二组经营数据', '用于验证不同主管团队之间的访问隔离。', '通用数据', ['演示'], 'published', 'preview-other', 'team_b.csv'],
    ];
    samples.forEach(([title, summary, category, tags, status, owner, filename], i) => {
      const assetId = uid(), versionId = uid(), fileId = uid(), time = new Date(Date.now() - (i + 1) * 7200000).toISOString();
      const description = { title, summary, category, tags, content: '演示用合成数据，包含编号、业务维度与指标字段。文件内容仅用于体验平台的上传、说明、审核和版本流程。', usage: '1. 下载数据文件。\n2. 使用表格软件或文本编辑器打开。\n3. 按业务字段进行筛选、汇总或导入分析工具。', notes: '此条目为平台预览数据，不是真实企业业务数据。', changes: '首次建立数据样例。', schemaVersion: 1 };
      const bytes = Buffer.from(filename.endsWith('.json') ? JSON.stringify([{ id: 1, region: '华东', value: 128 }, { id: 2, region: '华南', value: 96 }], null, 2) : '\uFEFFid,region,value\n1,华东,128\n2,华南,96\n');
      fs.writeFileSync(path.join(store.root, 'files', fileId), bytes);
      run('INSERT INTO assets(id,owner_id,creator_id,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', assetId, owner, owner, status === 'published' ? versionId : null, time, time);
      run('INSERT INTO versions(id,asset_id,number,status,description,submission_count,creator_id,created_at,updated_at,published_at) VALUES(?,?,1,?,?,?,?,?,?,?)', versionId, assetId, status, JSON.stringify(description), ['pending', 'returned'].includes(status) ? 1 : 0, owner, time, time, status === 'published' ? time : null);
      run('INSERT INTO files VALUES(?,?,?,?,?,?)', fileId, filename, bytes.length, createHash('sha256').update(bytes).digest('hex'), owner, time);
      run('INSERT INTO version_files VALUES(?,?)', versionId, fileId);
      run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', uid(), assetId, versionId, owner, users.find(u => u[0] === owner)[1], 'create', JSON.stringify({ preview: true }), time);
      if (['pending', 'returned'].includes(status)) run('INSERT INTO submissions VALUES(?,?,?,?,?,?)', uid(), versionId, 1, owner, JSON.stringify({ description, files: [{ id: fileId, name: filename, size: bytes.length }] }), time);
      if (status === 'returned') run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?)', uid(), assetId, versionId, 'preview-manager', '林知远', 'reject', JSON.stringify({ reason: '请补充订单状态字段说明，以及关联用户表的使用步骤。' }), time);
    });
    run("INSERT INTO metadata VALUES('seeded','true')");
    run("UPDATE versions SET reviewer_id=(SELECT u.supervisor_id FROM assets a JOIN users u ON u.id=a.owner_id WHERE a.id=versions.asset_id) WHERE reviewer_id IS NULL AND submission_count>0");
  });
}
