# 运行与部署

## 1. 当前交付状态

应用已经实现前后端和持久化，当前已在本机 Docker 部署独立体验环境，地址为 `http://127.0.0.1:8080`，容器名 `prt-datahub`。飞书 OAuth 接入代码已实现，并通过模拟响应验证 state、企业校验和账号初始化；尚未提供真实飞书应用凭据，因此没有完成企业账号的真实联调，也尚未部署至内网服务器。

技术栈：Node.js 24、Express 5、Node 内置 SQLite、React 19、Vite。使用单实例服务、本地持久磁盘，适用于本次 100 人以内的首版范围；并发容量仍需按实际文件大小和服务器条件验证。Node 24 当前可能显示 SQLite 实验特性提示，开发和部署统一使用项目要求的 Node 主版本。

## 2. 本地体验

```powershell
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，选择演示身份，点击“进入演示工作台”。请使用该地址，避免换成不同主机名导致来源校验失败。

| 演示身份 | 权限 |
| --- | --- |
| 林知远 | 主管＋产品经理，能够看到全部，但只管理自己和陈思远、许嘉宁的资产。 |
| 陈思远、许嘉宁 | 员工，仅访问自己的资产。 |
| 周亦舒 | 产品经理，仅全量查看和下载。 |
| 平台管理员 | 配置角色、主管、资产归属及上传限制，无默认文件读取权限。 |
| 李明 | 第二组主管，仅管理自己和王晨。 |
| 王晨 | 第二组员工，用于验证访问隔离。 |
| 待分配用户 | 身份已建立，等待分配角色。 |

演示内容明确标记为合成样例，上传和修改会真实保存到 `.preview-data/`，重启不丢失。开发服务只绑定回环地址；不要用于录入真实企业文件。

正式数据默认为 `data/`。系统记录数据目录用途，拒绝混用演示目录和正式目录；生产模式禁止启用演示登录。

## 3. 正式运行配置

复制 `.env.example` 为 `.env`，填写真实配置。不要将 `.env` 或密钥提交到版本库，也不需要把 App Secret 粘贴到对话中。

| 配置 | 用途 |
| --- | --- |
| `NODE_ENV=production` | 开启正式运行约束。 |
| `HOST=127.0.0.1` | 同机反向代理访问；容器内按需要绑定 `0.0.0.0`。 |
| `PORT=3100` | 后端监听端口。 |
| `APP_ORIGIN` | 员工实际访问的 HTTPS 地址，不含结尾斜杠，例如 `https://demo.company.internal`。 |
| `DATA_DIR` | 数据库和文件目录，推荐独立持久磁盘上的绝对路径。 |
| `FEISHU_APP_ID` | 飞书企业自建应用的 App ID。 |
| `FEISHU_APP_SECRET` | 飞书企业自建应用的 App Secret，仅后端使用。 |
| `FEISHU_TENANT_KEY` | 允许访问的唯一企业 tenant_key。身份信息不匹配时拒绝接入。 |
| `BOOTSTRAP_ADMIN_OPEN_IDS` | 可选。允许初始化首位管理员的飞书 open_id，用逗号分隔；已有管理员后不自动提权。 |
| `DEMO_MODE=false` | 正式运行必须关闭。 |

构建并运行：

```powershell
npm ci
npm run build
npm start
```

正式环境由 Express 同时提供 `dist/` 和 `/api`，不运行 Vite 开发服务器。推荐由企业反向代理终止 HTTPS，后端仅对该代理可达；内网或 VPN 访问范围由服务器和网络部署落实，应用本身另行校验飞书企业及业务权限。

反向代理需保持 `Origin` 请求头，不缓存 `/api`，上传请求大小及超时要与平台限制一致。请求日志避免记录 OAuth 回调查询串中的授权码；下载路径不能映射为静态公共目录。

### Docker 单容器部署

本机体验已实际执行构建、启动与健康检查：

```powershell
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail 100
```

默认入口 `http://127.0.0.1:8080`，只发布到本机回环地址。使用 `PRT_PORT` 可以更改端口，访问地址必须与该端口一致。容器内部监听 `3100`。

- 一个容器提供 React 静态页面、Express API 与 SQLite，不需要另外启动数据库或 Vite。
- `prt-datahub_preview-data` 卷保存 `/app/data` 的数据库和原始文件。
- `prt-datahub_preview-backups` 卷保存 `/app/backups` 的备份。
- 使用非 root 用户、只读容器根文件系统、健康检查、自动重启策略与日志大小限制。
- 容器数据与开发环境 `.preview-data/` 相互独立，不自动迁移。
- 基础镜像固定为 Node 24 的镜像摘要，默认通过 Google 官方镜像缓存拉取。可用 `--build-arg NODE_IMAGE=...` 指定企业镜像仓库中的等效 Node 24 镜像。

更新代码后重新运行 `docker compose up -d --build --wait`；临时停止使用 `docker compose stop`，再次启动使用 `docker compose start`。这些操作保留数据卷。**不要执行 `docker compose down -v`，它会删除数据卷。**

### 正式 Docker 配置

先按上表填好 `.env` 中的真实 HTTPS 地址和飞书配置，再执行：

```powershell
docker compose -f compose.production.yaml up -d --build --wait
```

此文件单独使用，不与体验 Compose 合并。正式容器名 `prt-datahub-production`，宿主机端口默认 `127.0.0.1:8081`，用于同机企业 HTTPS 反向代理连接；可用 `PRT_PRODUCTION_PORT` 更改。正式数据库及备份分别保存在 `prt-datahub-production_production-data` 与 `prt-datahub-production_production-backups` 卷，不包含体验账号。缺少必需配置时 Compose 拒绝启动。

正式文件存储在 Docker 持久卷对应的服务器磁盘；运维应将 Docker 数据目录安排在容量充足的持久磁盘。单容器使用 SQLite，不进行多副本扩容。

HTTPS 反向代理以及企业内网 / VPN 入口使用企业现有设施，本次没有修改其他容器或发布公网地址。首次管理员初始化也可执行：

```powershell
docker compose -f compose.production.yaml exec app node scripts/admin.mjs <平台用户编号>
```

## 4. 飞书应用接入

1. 在目标企业创建或选择自建应用，为需要使用的员工开放应用可用范围。
2. 配置网页应用入口为实际 `APP_ORIGIN`。
3. 在应用安全配置中登记登录回调：`APP_ORIGIN/api/auth/callback`，例如 `https://demo.company.internal/api/auth/callback`。
4. 根据飞书后台实际要求启用获取登录用户身份信息所需能力，发布应用配置；本平台不读取组织架构通讯录。
5. 在服务器配置 App ID、App Secret、允许的 tenant_key。
6. 使用真实企业账号完成一次登录，验证姓名、企业匹配、回调成功和待授权页面。
7. 初始化管理员，再在平台配置员工角色与主管。

服务使用 OAuth 授权码流程，后端交换令牌并获取用户身份；一次性 state 绑定发起登录的浏览器，使用 S256 PKCE。用户身份令牌不发送到前端，也不保存为平台长期会话。平台会话使用 HttpOnly、SameSite Cookie，生产使用 Secure Cookie，默认有效期 8 小时。

接口参考：

- [飞书获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)
- [飞书官方 OpenAPI 工作空间：身份验证接口](https://www.postman.com/feishu-op/feishu-s-public-workspace/documentation/8hmv1ib/feishu-openapi)

真实应用权限、回调和企业配置需要在企业应用上联调确认，模拟测试不能替代该步骤。

## 5. 初始化管理员

可在没有管理员时通过 `BOOTSTRAP_ADMIN_OPEN_IDS` 指定人员，其首次登录会获得管理员角色。

若暂时不知道 open_id：让指定管理员先完成飞书登录，复制待授权页面的“平台用户编号”，由有服务器权限的运维执行：

```powershell
node --env-file-if-exists=.env scripts/admin.mjs <平台用户编号>
```

该命令仅允许初始化首位管理员，已有管理员时拒绝执行。之后通过界面分配角色。不要将“首个登录的人”自动设为管理员。

人员离职或调岗：先交接资产；如其负责下属，先调整下属主管，再停用账号。平台账号停用由管理员操作，首版不自动同步飞书离职事件；飞书端账号失效不会自动撤销已经建立的 8 小时平台会话。

## 6. 文件与说明

- 默认单文件 512 MB、单版本合计 2048 MB、20 个文件；这些是可调整的初始配置，并非容量承诺。
- 文件保存原始内容，不自动解压、执行、在线预览或检测业务敏感性。
- 文件存储名为 UUID，原始名称仅用于展示和下载。
- 说明填写后保存，待完善内容允许成为草稿；提交或发布时检查必填字段和文件。
- 下载按请求时权限及版本状态检查；下架版本禁止下载。
- 移除草稿文件仅解除当前版本关联，磁盘对象保留以保护历史快照和版本引用。首版不做自动永久清理，需根据使用增长规划空间。

## 7. 备份与恢复

管理员可在“平台设置 → 服务器存储”点击“立即备份”，页面显示任务状态与校验结果，同一进程同时只执行一个页面备份任务。最近成功备份时间保存在数据库中，容器重启仍可查看。正在运行的备份若被关停会中断，缺少 `manifest.json` 的目录不能恢复。

备份和数据在不同卷，但仍属于同一台机器，运维需要将完成的备份复制到独立存储。容器内也可执行命令（每次使用新的目标名）：

```powershell
docker compose exec app node scripts/backup.mjs /app/backups/manual-2026-09-03
```

取出备份时先创建本机目录，再从容器复制，例如：

```powershell
New-Item -ItemType Directory -Force .preview-backups
docker cp prt-datahub:/app/backups/. .preview-backups/
```

本地运行的备份命令：

```powershell
npm run backup -- D:/PRT-backups/backup-2026-09-03
```

目标目录必须尚不存在，且不能在源数据目录内部。备份先生成 SQLite 一致快照，再复制快照引用的不可变文件，逐个验证大小和 SHA-256。最后写入 `manifest.json`，缺少该文件表示未完成备份。成功后“平台设置”显示备份时间。备份不保留登录会话和未完成 OAuth 登录。

恢复命令：

```powershell
node scripts/restore.mjs D:/PRT-backups/backup-2026-09-03 D:/PRT-data-restored
```

恢复前校验数据库及文件，目标必须是不存在的新目录，不覆盖原数据。恢复完成后停止应用，将 `DATA_DIR` 指向新目录，再启动并验证。现有测试覆盖备份恢复和会话失效；运维还需按最终服务器环境定期进行恢复演练。

备份计划由运维配置到操作系统调度，建议将已完成备份同步到其他磁盘或受控备份系统。当前没有自动创建定时任务。

### 容器业务验收

以下脚本仅允许本机体验环境，使用合成文件创建一份标为“容器验收”的数据，执行员工上传、主管审核、产品经理下载、跨组拒绝访问及管理员备份：

```powershell
node scripts/smoke-docker.mjs
docker compose restart
node scripts/smoke-docker.mjs --verify
```

首次结果写入 `test-results/docker-smoke.json`；第二次验证重启前的版本、提交快照、审计记录和文件校验值均保持一致。脚本不会删除验收数据或其他业务数据。

## 8. 验证和已知边界

```powershell
npm test
npm run build
```

自动化测试使用独立临时目录，覆盖员工／主管／产品经理权限、文件下载隔离、审核快照、旧版保护、重复请求、并发编辑、上传失败清理、主管与归属交接、备份恢复及模拟飞书回调。

首版暂不包含断点续传、自动飞书离职同步、飞书消息推送、压缩包预览、LLM 生成和多实例数据库协调。上传失败可以重试；已完成文件不会重复上传。建议在正式启用前用企业真实的最大文件和常见网络条件执行容量验证。
