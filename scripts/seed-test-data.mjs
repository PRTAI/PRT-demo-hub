import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openStore, now } from '../server/db.mjs';

const root = path.resolve(process.env.DATA_DIR || './host-data');
const store = openStore(root), { all, one, run, tx } = store;
const marker = 'testdata-';
const uuid = value => { const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split(''); hex[12] = '4'; hex[16] = '8'; return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`; };

function clean() {
  const fileIds = all("SELECT DISTINCT f.id FROM files f JOIN version_files vf ON vf.file_id=f.id JOIN versions v ON v.id=vf.version_id WHERE v.asset_id LIKE 'testdata-%'").map(x => x.id);
  tx(() => { run("DELETE FROM events WHERE asset_id LIKE 'testdata-%'"); run("DELETE FROM submissions WHERE version_id IN (SELECT id FROM versions WHERE asset_id LIKE 'testdata-%')"); run("DELETE FROM version_files WHERE version_id IN (SELECT id FROM versions WHERE asset_id LIKE 'testdata-%')"); run("DELETE FROM versions WHERE asset_id LIKE 'testdata-%'"); run("DELETE FROM assets WHERE id LIKE 'testdata-%'"); for (const id of fileIds) run('DELETE FROM files WHERE id=? AND NOT EXISTS(SELECT 1 FROM version_files WHERE file_id=?)', id, id); });
  for (const id of fileIds) { const target = path.join(root, 'files', id); if (fs.existsSync(target) && !one('SELECT id FROM files WHERE id=?', id)) fs.unlinkSync(target); }
  return fileIds.length;
}

if (process.argv.includes('--clean')) { const files = clean(); console.log(`Removed test data and ${files} test files.`); store.db.close(); process.exit(0); }
if (process.argv.includes('--report')) {
  const counts = all("SELECT v.status,COUNT(*) AS count FROM versions v WHERE v.asset_id LIKE 'testdata-%' GROUP BY v.status ORDER BY v.status");
  const files = all("SELECT f.id FROM files f JOIN version_files vf ON vf.file_id=f.id JOIN versions v ON v.id=vf.version_id WHERE v.asset_id LIKE 'testdata-%'");
  console.log(JSON.stringify({ counts, files: files.length, missing: files.filter(file => !fs.existsSync(path.join(root, 'files', file.id))).length })); store.db.close(); process.exit(0);
}

const users = all('SELECT * FROM users WHERE enabled=1 ORDER BY created_at');
const parseRoles = user => { try { return JSON.parse(user.roles); } catch { return []; } };
const owners = users.filter(user => parseRoles(user).some(role => ['employee','supervisor'].includes(role)));
if (!owners.length) throw new Error('No enabled employee or supervisor is available for test data ownership.');

const templates = [
  ['华东门店销售流水','零售与消费',['销售趋势','区域经营'],'门店日销售额、客单价、订单量与商品分类数据，适合制作经营趋势和区域对比 Demo。'],
  ['会员复购行为分析','零售与消费',['会员','复购'],'会员等级、消费频次、最近购买时间及品类偏好，用于复购和用户分层演示。'],
  ['供应链库存周转','零售与消费',['库存','供应链'],'仓库库存、采购入库、销售出库和周转天数数据，用于库存健康分析。'],
  ['企业客户回款分析','金融服务',['回款','应收'],'客户合同额、应收账期、开票和回款记录，用于现金流和逾期风险演示。'],
  ['设备传感器监测','工业制造',['设备','时序'],'设备温度、振动、转速与告警时间序列，用于状态监控和故障预警。'],
  ['产线质量检验记录','工业制造',['质检','良率'],'生产批次、检测项目、不良类型及良率数据，用于质量追溯分析。'],
  ['门诊预约运营分析','医疗健康',['预约','运营'],'预约渠道、科室、候诊时长和到诊状态的合成数据，用于服务效率展示。'],
  ['区域行政编码字典','通用数据',['字典','地理'],'省市区三级编码、名称和层级关系，用于地图展示及区域汇总。'],
  ['营销活动转化漏斗','零售与消费',['营销','转化'],'曝光、点击、领券、下单和支付事件数据，用于活动转化漏斗演示。'],
  ['客户服务工单分析','通用数据',['工单','服务'],'工单来源、问题类型、响应时长、解决状态和满意度数据。']
];
const statuses = ['published','published','published','pending','draft','returned','offline'];
let created = 0;
for (let i = 1; i <= 30; i++) {
  const assetId = `${marker}${String(i).padStart(3,'0')}`; if (one('SELECT id FROM assets WHERE id=?', assetId)) continue;
  const owner = owners[(i - 1) % owners.length], template = templates[(i - 1) % templates.length], status = statuses[(i - 1) % statuses.length], time = new Date(Date.now() - i * 3600000).toISOString();
  const versionId = uuid(`${assetId}-v1`), fileId = uuid(`${assetId}-file-v1`), title = `${template[0]} · 测试${String(i).padStart(2,'0')}`;
  const description = { title, summary: template[3], category: template[1], tags: [...template[2], '测试数据'], content: `数据覆盖${template[2].join('、')}等主题，包含日期、组织、指标值和状态字段。所有记录均为系统生成的测试数据。`, usage: `用于验证列表筛选、自然语言检索、文件预览、下载、审核与版本管理。检索示例：查找${template[2][0]}相关的数据。`, notes: '仅用于平台功能测试，不代表真实业务数据。', changes: '', schemaVersion: 1 };
  const csv = Buffer.from(`record_id,date,region,metric,status\n${i}001,2026-08-01,华东,${100+i},正常\n${i}002,2026-08-02,华南,${120+i},正常\n`, 'utf8'), checksum = createHash('sha256').update(csv).digest('hex');
  tx(() => {
    run('INSERT INTO assets(id,owner_id,creator_id,current_version_id,next_number,created_at,updated_at) VALUES(?,?,?,?,2,?,?)', assetId, owner.id, owner.id, status === 'published' ? versionId : null, time, time);
    run('INSERT INTO versions(id,asset_id,number,status,description,creator_id,created_at,updated_at,published_at) VALUES(?,?,1,?,?,?,?,?,?)', versionId, assetId, status, JSON.stringify(description), owner.id, time, time, status === 'published' ? time : null);
    run('INSERT INTO files(id,original_name,size,checksum,uploader_id,created_at) VALUES(?,?,?,?,?,?)', fileId, `test-sample-${String(i).padStart(2,'0')}.csv`, csv.length, checksum, owner.id, time);
    run('INSERT INTO version_files(version_id,file_id) VALUES(?,?)', versionId, fileId);
    run('INSERT INTO events(id,asset_id,version_id,actor_id,actor_name,action,detail,created_at) VALUES(?,?,?,?,?,?,?,?)', uuid(`${assetId}-event`), assetId, versionId, owner.id, owner.name, 'create', JSON.stringify({ testData: true }), time);
  });
  fs.writeFileSync(path.join(root, 'files', fileId), csv); created++;
}
console.log(JSON.stringify({ created, totalTestAssets: one("SELECT COUNT(*) AS n FROM assets WHERE id LIKE 'testdata-%'").n, owners: owners.map(x => x.name) }));
store.db.close();
