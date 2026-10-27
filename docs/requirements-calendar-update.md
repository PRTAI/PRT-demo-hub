# 需求日期、负责人、发布通知与飞书日历更新

## 功能与使用方式

- 需求中心和“我的需求”的搜索框支持输入负责人姓名，也保留标题、正文、分类和发布人搜索。多人匹配同一需求时只显示一次，原来的查看权限和分页规则继续生效。
- 发布、编辑需求时将日期分为“发布日期”和“截止日期”。发布日期默认今天（北京时间），可修改；截止日期可不填，填写时不能早于发布日期。卡片和详情分别显示两个日期。
- 已设置的截止日期显示醒目的黄色标签；进行中、待更新需求距截止不足 24 小时改为红色闪烁，逾期后仍保留红色提醒并标明“已逾期”。按北京时间截止当天结束计算，页面每 30 秒更新，回到页面时也会更新；已关闭、已交付需求不闪烁。系统开启减少动态效果时保留红色静态提醒。
- 需求中心和“我的需求”默认把已关闭需求排到最后，各组内先按截止日期从早到晚排列（含已逾期需求），未设置截止日期的靠后；同一天截止时按最近更新时间倒序排列。排序在服务端分页前完成，搜索和状态筛选继续生效。
- 项目经理可点击“导出 Excel”，导出当前搜索、状态筛选和“我的需求”范围内的全部可见需求，按照新版模板输出“标题、需求说明、需求文档、商务负责人、研发负责人、进度、截止日期、样例”。一条需求一行，提供需求及 Demo 的平台链接。导出前继续补建或更新飞书协作文档。详细配置见 [需求飞书文档、排序与导出](requirements-export-update.md)。
- 负责人分为“商务负责人”和“研发负责人”，两组均可不选或多选，支持按姓名搜索候选人。商务负责人从商务账号选择；研发负责人从员工、主管和产品／项目经理账号选择。同一人兼具两类角色时可同时加入两组。
- 需求卡片和详情分别显示两组负责人，未选择时显示“未指定”。两组人员都属于需求的指定／关联人员，“我的需求”、姓名搜索和查看权限按照两组的合集生效；转发新增人员归入研发负责人。
- 发布新需求后，飞书机器人通知全部负责人和发布人。同一人同时为负责人、发布人时只通知一次；未选择负责人时仍通知发布人。编辑、上传文档和重试同步不会再次发送“新需求已发布”消息。
- 每条需求对应一个飞书日程，邀请当前启用的两组负责人和发布人。同一账号只邀请一次。填写截止日期后，全天日程覆盖发布日至截止日（包含截止当天）；未填写时仅覆盖发布日期。日程不占用参与人的忙闲时间，消息和日程说明中分别列出日期和两组负责人。
- 日程创建、参与人邀请全部成功后，再向两组负责人和发布人各发送一张机器人日程卡片，包含需求标题、发布日期、截止日期、发布人、两组负责人以及“查看需求”按钮；飞书返回安全的日程链接时还提供“打开飞书日程”按钮。日历原生邀请与机器人卡片均启用，不需要用户通过卡片回调才能加入日程。
- 日程卡片按“需求 + 接收人”去重，同一人兼任多种角色也只发一张；编辑、改状态和重复同步不重复发送。转发或编辑新增负责人后，邀请新人员并发送其首张卡片。卡片是发送时的日期、人员信息，后续变化以飞书日程为准；飞书原生邀请／更新通知用于提醒日程变化。
- 修改标题、发布日期、截止日期、状态、负责人或转发需求时，更新同一个日程。移除负责人、停用或删除账号后，会排队移除其日程参与资格。飞书上已有的历史消息无法撤回，后续平台访问仍由实时权限控制。
- 上线时自动迁移历史数据：原计划日期保留为发布日期，原本没有计划日期的需求取创建当天（北京时间），截止日期留空；原负责人按照当前角色划分到两组，其他历史关联人员保留在研发组，避免失去查看权限。迁移后分组固定，后续角色变化不会自动移除关联。
- 历史需求（包括已关闭需求）会补建日程，已有日程会更新同一条记录的字段和日期，不补发历史“新需求已发布”机器人消息。
- 尚未成功的历史日程在补建或手动重试成功后，也会向当前关联人员发送首张日程卡片。已有同步成功的历史需求不会仅因本次升级批量补发卡片，下一次更新或转发使其同步时才为尚未通知的人员发送。没有必要重复发布旧需求。

通知与日历在需求保存事务中写入本地队列，由后台独立发送。飞书失败不阻塞需求发布。任务支持自动退避重试，连续失败 5 次后，商务、产品／项目经理或管理员可在需求详情点击“重试同步”；管理员也可在“平台设置 → 需求日历同步”重试。飞书消息通知的后台重试仍由管理员管理。重启会保留任务、日程 ID 和幂等标识，避免重复创建日程。

需求详情显示日历同步状态；等待中的状态每 5 秒刷新，失败时显示原因。同步成功后，如果飞书返回日程链接，可点击“打开飞书日程”。从通知或日程打开需求，需要登录时会在登录后返回对应需求，实际详情访问仍检查权限。

需求详情还显示日程卡片已发送、等待发送、发送失败的人数。日程同步与卡片发送是独立任务：消息失败不会把已创建的日程标成失败，也不会重新创建日程。消息自动重试 5 次后，管理员在“平台设置 → 飞书通知”找到“需求日程卡片”并点击重试；日历接口本身失败则在“需求日历同步”或需求详情重试。重试仍使用同一消息 ID，发送前再次检查人员关联及账号启用状态。

## 飞书应用配置

使用平台现有的同一个企业自建应用和 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`，不需要另外配置用户日历令牌。

1. 在飞书开放平台，为该应用开启机器人能力，并确认网页应用入口已正确配置。
2. 在“权限管理”中，为应用身份开通机器人向用户发送消息，以及以下日历接口所需的权限。通过接口文档的“权限要求”进入控制台勾选，避免误选为仅用户身份权限：

| 用途 | 官方接口文档 |
| --- | --- |
| 创建应用私密日历 | [创建日历](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/create) |
| 读取已配置日历，确认访问权限 | [查询日历信息](https://open.feishu.cn/document/server-docs/calendar-v4/calendar/get) |
| 为需求创建日程 | [创建日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create) |
| 更新同一个需求日程 | [更新日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/patch) |
| 查询已邀请人员 | [获取日程参与人列表](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event-attendee/list) |
| 邀请负责人和发布人 | [添加日程参与人](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event-attendee/create) |
| 移除不再负责的人员 | [删除日程参与人](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event-attendee/batch_delete) |
| 发送需求文字通知、机器人日程卡片 | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) |

3. 应用可用范围需覆盖全部负责人和发布人；他们应已用同一飞书应用登录平台，平台账号应已启用并配置角色。
4. 保存权限后创建、发布应用版本，完成企业管理员审批。只在编辑页勾选权限而未发布，运行中的应用可能仍无权限。

日历权限之外，还要开启“以应用的身份发消息”（`im:message:send_as_bot`，以发送消息接口控制台的权限要求为准）及机器人能力。应用可用范围必须覆盖被邀请和接收卡片的人员，人员账号来自同一企业及同一应用的登录。纯创建、邀请和打开日程功能不需要事件订阅、Webhook、卡片回调地址或额外的用户日历授权。

错误码 `99991672` 表示飞书应用缺少调用接口的权限。平台中给商务、产品／项目经理开放“重试同步”，允许他们重新提交失败的日历任务；飞书应用的接口权限仍须由应用管理员在开放平台配置。出现该错误时，按上表开通相应的应用身份权限并发布应用新版本，再由有重试权限的人员在需求详情点击“重试同步”。仅修改平台角色或重复点击重试不会补齐飞书应用权限。

默认不填写 `FEISHU_REQUIREMENT_CALENDAR_ID`，应用会自动创建一个名为“PRT 需求协作”的私密共享日历，日历 ID 保存在平台数据库。每条需求邀请自己的负责人和发布人，无需让所有人订阅整个共享日历。

如果希望使用已有日历，在部署机 `.env` 文件中填写：

```dotenv
FEISHU_REQUIREMENT_CALENDAR_ID=已有日历的真实calendar_id
```

该日历必须为私密的共享日历或主日历，并且**当前应用身份**已有 `writer` 或 `owner` 权限。普通用户有编辑权限，不代表应用也有权限。使用自动创建模式更省配置，可留空：

```dotenv
FEISHU_REQUIREMENT_CALENDAR_ID=
```

配置项写进 `.env` 文件，不作为 PowerShell 命令执行。已同步需求继续更新原日历的原日程；后续修改此配置只影响尚未绑定日历的新任务，不会自动搬迁已有日程。

本次日程卡片功能无新增必填环境变量。部署机 `.env` 应保留如下配置，已有真实值不要覆盖：

```dotenv
FEISHU_APP_ID=已有应用ID
FEISHU_APP_SECRET=已有应用密钥
FEISHU_TENANT_KEY=已有企业tenant_key
FEISHU_REQUIREMENT_CALENDAR_ID=
DEMO_MODE=false
```

网页应用入口和 OAuth 回调沿用当前正常登录的平台地址，确保飞书客户端能够访问。服务器需能通过 HTTPS 访问 `open.feishu.cn:443`。如果平台登录和机器人通知本来就正常，只需确认日历权限已发布生效，日历 ID 留空即可。

## Windows Docker 保留旧数据更新

以下沿用当前运行的 `prt-datahub-production` 和数据卷。把最新源码同步到 `J:\PRT-demo-hub-test`，包括 `server/requirement-calendar.mjs`、`server/notifications.mjs` 和整个 `shared` 目录（含新增的 `shared/feishu-links.mjs`）；保留部署机原 `.env`，不覆盖密钥，不复制开发数据或 `node_modules`。本次更新不需要新增环境变量，但必须重新构建镜像并重建容器才能生效。

推荐每次同步最新源码后，直接运行仓库自带的更新脚本（无需修改系统执行策略）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\update-docker.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test'
```

脚本默认使用脚本所在仓库目录、现有生产容器与两个数据卷，先检查挂载，再备份并导出到 `J:\PRT-backups\before-update-时间戳-随机标识`，随后构建、重建容器、等待健康检查并显示日志。任何步骤失败都会停止；备份失败时不会构建或重建容器。不会自动还原数据。请避免多人同时运行更新脚本。

如果部署目录或备份目录不同，可以显式指定：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\update-docker.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test' -BackupDirectory 'J:\PRT-backups' -HealthUrl 'http://127.0.0.1:8001/api/health'
```

此脚本用于更新当前已有部署，运行前应确保旧容器正在运行，以便执行备份。脚本不会下载或同步源码，不会修改 `.env`；更新前请先自行同步源码并保留部署机配置。备份为更新前时点的数据，更新期间的新写入不会包含在这份备份中。

也可以在同一个 PowerShell 窗口手动依次执行以下命令，每条命令失败后先处理错误：

```powershell
Set-Location 'J:\PRT-demo-hub-test'
$ErrorActionPreference = 'Stop'
$prtUpdate = @('-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')

docker version
if ($LASTEXITCODE -ne 0) { throw '请先启动 Docker Desktop 的 Linux 引擎' }
docker volume inspect prt-datahub-production_production-data prt-datahub-production_production-backups
if ($LASTEXITCODE -ne 0) { throw '原数据卷不存在，请先核对当前容器挂载' }
docker compose @prtUpdate config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose 配置检查失败' }

$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prtBackupPath = "/app/backups/before-requirement-calendar-$prtStamp"
$prtHostBackup = "J:\PRT-backups\before-requirement-calendar-$prtStamp"
docker exec prt-datahub-production node scripts/backup.mjs $prtBackupPath
if ($LASTEXITCODE -ne 0) { throw '备份失败，停止更新' }
New-Item -ItemType Directory -Force -Path $prtHostBackup | Out-Null
docker cp "prt-datahub-production:${prtBackupPath}/." $prtHostBackup
if ($LASTEXITCODE -ne 0) { throw '备份导出失败，停止更新' }

docker compose @prtUpdate build
if ($LASTEXITCODE -ne 0) { throw '构建失败，停止更新' }
docker compose @prtUpdate up -d --no-build --force-recreate --wait app
if ($LASTEXITCODE -ne 0) { throw '启动失败，请检查容器日志' }
docker compose @prtUpdate ps
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
docker compose @prtUpdate logs --tail 100 app
```

启动时自动迁移 SQLite，保留账号、需求、文档、Demo 和旧通知，不需要手动执行 SQL。不要执行 `down -v` 或删除旧数据卷。若回滚到旧源码，应先另存更新后数据，再恢复更新前备份，避免旧版本误读新通知结构。

## 上线验收

1. 用商务或产品经理发布测试需求，分别选择商务负责人、研发负责人，并填写发布日期和截止日期。卡片和详情应分别显示两组人员和两个日期；不填负责人或截止日期也能发布。
2. 输入任一组负责人姓名，确认可找到该需求。普通员工只能搜到自己有权限查看的需求，关联后可在“我的需求”中找到，不能编辑。
3. 检查两组负责人和发布人的飞书机器人消息：先收到“新需求已发布”文字通知，日程及邀请同步完成后再收到“需求日程已创建”卡片；同一账号每类消息各一条。卡片应显示日期和人员，点击“打开飞书日程”可查看同一日程，点击“查看需求”可回到需求详情。
4. 打开飞书日历，确认对应的全天日程覆盖发布日至截止日，未填截止日期时仅覆盖发布日期；负责人和发布人都收到邀请。如飞书提示接受邀请，接受后在个人日历查看。需求详情应显示“已关联日程”。
5. 修改两个日期、转发给另一位员工，确认原日程更新、参与人新增，新增人员显示为研发负责人并收到自己的首张日程卡片，已有人员不会重复收到卡片，没有额外创建另一个日程。移除负责人后，确认相应参与人从原日程移除。截止日期早于发布日期时应被阻止保存。
6. 若显示失败，商务、产品／项目经理可直接在需求详情查看具体飞书错误码；管理员也可在“平台设置”查看。补齐飞书应用权限并发布新版本后点击“重试同步”。员工和普通主管仅能查看同步状态，等待任务自动重试期间不要重复发布相同需求。

本地自动化使用模拟飞书服务验证消息、日程、权限、重试、幂等和重启恢复；真实机器人消息和日历邀请需要在企业应用发布权限后完成上述验收。演示模式只展示本地任务，不发送真实消息或创建外部日程。
