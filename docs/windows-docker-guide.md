# Windows Docker 简明部署手册

本次需求状态、我的需求、飞书文档预览和内外网上传更新，请先参照 [需求协作与内外网上传更新](requirements-network-update.md)，其中包含新增配置与保留原数据卷的更新命令。

适用环境：源码已复制到 `J:\PRT-demo-hub-test`，Windows 主机 IP 为 `192.168.110.25`，使用 Docker Desktop 的 Linux 容器模式。

访问地址为 `http://192.168.110.25:8001`。全部命令在这台 Windows 主机的同一个 PowerShell 窗口执行，另有说明的除外。无需在宿主机安装 Node.js，也无需手动执行 npm 构建；Dockerfile 会完成编译和依赖安装。

## 更新当前已运行的容器并保留旧数据

本节适用于已确认运行容器为 `prt-datahub-production`、数据卷为 `prt-datahub-production_production-data`、备份卷为 `prt-datahub-production_production-backups`，且容器使用 `/app/data` 的实例。使用本节的 `compose.keep-data.yaml`，不要叠加后文用于新建独立测试实例的 `compose.windows-test.yaml`。

1. 将开发目录的最新源码重新复制到 `J:\PRT-demo-hub-test`，包含 `src`、`server`、`shared`、`scripts`、`public`、`docs`、`config`、`Dockerfile`、`package.json`、`package-lock.json`、`index.html`、`vite.config.mjs`、`compose.production.yaml` 和新增的 `compose.keep-data.yaml`。保留 Windows 上现有 `.env`，无需传输 `node_modules`、`dist`、开发环境数据或备份。
2. 在 Windows PowerShell 中执行准备、核对和备份：

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'J:\PRT-demo-hub-test'
$prtUpdate = @('-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')
foreach ($prtFile in @('Dockerfile', 'compose.production.yaml', 'compose.keep-data.yaml', '.env')) {
    if (-not (Test-Path $prtFile)) { throw "缺少文件：$prtFile" }
}
docker version
if ($LASTEXITCODE -ne 0) { throw '请先启动 Docker Desktop' }
docker inspect --format '{{json .Mounts}}' prt-datahub-production
if ($LASTEXITCODE -ne 0) { throw '未找到当前业务容器，停止操作' }
docker volume inspect prt-datahub-production_production-data prt-datahub-production_production-backups
if ($LASTEXITCODE -ne 0) { throw '原数据卷不存在，停止操作' }
docker compose @prtUpdate config --quiet
if ($LASTEXITCODE -ne 0) { throw '配置检查失败，停止操作' }
$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prtContainerBackup = '/app/backups/before-requirement-docs-' + $prtStamp
$prtBackup = 'J:\PRT-backups\before-requirement-docs-' + $prtStamp
docker exec prt-datahub-production node scripts/backup.mjs $prtContainerBackup
if ($LASTEXITCODE -ne 0) { throw '备份失败，停止更新' }
New-Item -ItemType Directory -Path $prtBackup -Force | Out-Null
docker cp "prt-datahub-production:${prtContainerBackup}/." $prtBackup
if ($LASTEXITCODE -ne 0) { throw '备份导出失败，停止更新' }
if (-not (Test-Path (Join-Path $prtBackup 'manifest.json'))) { throw '备份不完整，停止更新' }
```

挂载核对应看到两个原卷分别挂到 `/app/data` 和 `/app/backups`；如果名称或路径与本节不同，先按实际挂载调整保留数据配置，再继续。

3. 构建并重建当前容器：

```powershell
docker compose @prtUpdate build
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败，停止更新' }
docker compose @prtUpdate up -d --no-build --force-recreate --wait app
if ($LASTEXITCODE -ne 0) { throw '容器启动失败，请查看日志' }
docker compose @prtUpdate ps
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
docker compose @prtUpdate logs --tail 80 app
```

若再次遇到“新镜像已有功能，但运行容器仍是旧代码”，确认执行了本节的 `up --force-recreate`；单独 `build` 或 `restart` 不会替换旧容器使用的镜像。无需在 Windows 上运行 npm，也无需手动修改数据库。

4. 浏览器打开 `http://192.168.110.25:8001`，按 `Ctrl+F5` 强制刷新，重新登录后验收：

- 商务或产品经理：发布需求，选择一个员工并上传两份小文档，详情中应能下载。
- 被指定员工：列表能看到需求，可查看详情和下载文档；详情页可点击“上传 Demo”，但没有发布、编辑、上传文档、关闭或修改绑定按钮。
- 侧栏“我的需求”：只显示指定给当前账号的需求；需求状态可见“进行中”“待更新”“已交付”“已关闭”。
- 未指定员工及未指定的单独管理员角色：列表不显示该需求，复制详情或下载链接也无法访问。
- 原发布人取消指定该员工后，该员工立即失去详情和文档下载权限。
- 不选择人员也能发布，此时仅商务和产品经理可在需求中心查看。历史需求默认没有指定人员，需原发布人编辑补选。
- 原有 Demo、账号、文件及角色继续存在。

“项目经理”沿用平台现有的“产品经理（pm）”角色。此更新会自动创建人员指定和需求文档关联表，需求文档纳入原有备份恢复流程。不要执行 `docker compose down -v`、`docker volume rm` 或删除数据目录。`compose.keep-data.yaml` 将原卷声明为外部卷，卷不存在时会报错，避免意外启动空库。

以下章节用于新建独立测试实例；已运行实例完成本节即可，无需重复迁移或初始化管理员。

## 1. 检查文件并准备配置

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'J:\PRT-demo-hub-test'
docker version
docker compose version
$prtCompose = @('-f', 'compose.production.yaml', '-f', 'compose.windows-test.yaml')
```

目录应包含 `Dockerfile`、`compose.production.yaml`、`compose.windows-test.yaml`、`package.json`、`package-lock.json`、`src`、`server` 和 `scripts`。若缺少本手册或测试配置文件，从最新开发目录补复制。

如果没有 `.env`，从模板复制，已有配置则直接编辑：

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.exampl .env }
notepad .env
```

修改并补齐以下内容，所有“填写”值都需要替换：

```dotenv
APP_ORIGIN=http://192.168.110.25:8001
FEISHU_APP_ID=填写原飞书应用的AppID
FEISHU_APP_SECRET=填写原飞书应用的AppSecret
FEISHU_TENANT_KEY=填写原企业tenant_key
DEEPSEEK_API_KEY=填写DeepSeek官方平台签发的Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_ENABLE_THINKING=false
RAG_LLM_MAX_TOKENS=
RAG_LLM_REQUEST_TIMEOUT_MS=90000
DESCRIPTION_AGENT_TIMEOUT_MS=180000
DESCRIPTION_AGENT_REQUEST_TIMEOUT_MS=90000
DESCRIPTION_AGENT_MAX_TOKENS=
BOOTSTRAP_ADMIN_OPEN_IDS=
```

数据说明和智能检索共用 DeepSeek 官方 Pro 模型配置，旧阿里云配置及原来的 `DESCRIPTION_AGENT_API_KEY`、地址、型号、协议和思考开关不再读取。完整说明与双功能自检见 [DeepSeek 官方 Pro 配置](deepseek-configuration.md)。

Compose 读取的是新目录的 `.env`，不读取 `.env.host`。当前主配置固定内网 HTTP 模式、关闭体验登录，监听宿主机 `8001`；`.env` 里的 `PORT`、`DATA_DIR` 和 `NODE_ENV` 不覆盖 Compose 中同名的显式配置。测试数据放在独立卷中，容器内路径为 `/app/data/live`。

## 2. 校验并编译镜像

```powershell
docker compose @prtCompose config --quiet
if ($LASTEXITCODE -ne 0) { throw '配置检查失败，请检查 .env' }
docker compose @prtCompose build
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败，停止部署' }
```

若构建时基础镜像下载失败，检查 Docker 网络或企业镜像仓库；不要跳过失败继续启动。

## 3. 迁移旧 Docker 数据

如需保留旧数据，在首次启动前完成本节。若已有完整校验备份，可以直接将 `$prtBackup` 设置为该备份的绝对路径，并从“恢复备份”继续。全新空库可以跳过本节。

查看旧容器，确认哪个是原飞书业务平台，不能选体验容器或新测试容器：

```powershell
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
$prtOldContainer = Read-Host '请输入旧业务容器的准确名称'
docker inspect --format '{{json .Mounts}}' $prtOldContainer
```

确认挂载指向原数据库和文件。暂停旧平台业务操作，生成完整备份并取出：

```powershell
$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prtBackup = 'J:\PRT-backups\docker-' + $prtStamp
$prtContainerBackup = '/app/backups/migration-' + $prtStamp
docker exec $prtOldContainer node scripts/backup.mjs $prtContainerBackup
if ($LASTEXITCODE -ne 0) { throw '旧容器备份失败' }
New-Item -ItemType Directory -Path $prtBackup | Out-Null
docker cp "${prtOldContainer}:${prtContainerBackup}/." $prtBackup
if ($LASTEXITCODE -ne 0) { throw '导出备份失败' }
if (-not (Test-Path (Join-Path $prtBackup 'manifest.json'))) { throw '备份不完整' }
docker stop $prtOldContainer
if ($LASTEXITCODE -ne 0) { throw '旧容器停止失败' }
```

备份会生成一致数据库快照，并校验文件。自备份开始至切换验收完成，旧平台不应再接收写入。保留旧容器和旧数据卷，不删除。

恢复备份（目标 `/app/data/live` 必须不存在）：

```powershell
docker compose @prtCompose run --rm --no-deps `
  --volume "${prtBackup}:/restore:ro" `
  app node scripts/restore.mjs /restore /app/data/live
if ($LASTEXITCODE -ne 0) { throw '恢复失败，停止部署' }
```

若提示目标已存在，不要删除数据或卷，先确认是否已恢复或启动过。旧账号、角色、Demo、版本和文件随备份保留；登录会话会清除，需要重新登录。

## 4. 配置飞书并启动

在原飞书应用中新增登录回调：`http://192.168.110.25:8001/api/auth/callback`，保留旧回调。测试消息跳转时，将网页应用主页切换为 `http://192.168.110.25:8001/`，按控制台要求发布配置。应用可用范围应覆盖使用者，机器人需具备 `im:message:send_as_bot` 权限。

```powershell
docker compose @prtCompose up -d --wait
if ($LASTEXITCODE -ne 0) { throw '启动失败，请查看容器日志' }
docker compose @prtCompose ps
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
docker compose @prtCompose logs --tail 80 app
```

应看到容器健康，接口返回 `ok: true`。浏览器打开 `http://192.168.110.25:8001/`，用原飞书账号登录，核对 Demo、文件下载、角色、需求绑定、AI 说明及发布通知。恢复旧库后不需要初始化管理员。

如为空库：指定管理员先完成飞书登录，取得待授权页面的“平台用户编号”，然后初始化首位管理员：

```powershell
$prtAdminId = Read-Host '请输入指定管理员的平台用户编号'
docker compose @prtCompose exec app node scripts/admin.mjs $prtAdminId
```

如果本机访问正常、其他内网电脑访问失败，检查 Windows 防火墙和 Docker Desktop 端口映射。在管理员 PowerShell 中按需增加规则：

```powershell
if (-not (Get-NetFirewallRule -Name 'PRT-Docker-8001' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'PRT-Docker-8001' -DisplayName 'PRT Docker TCP 8001' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8001 -RemoteAddress LocalSubnet -Profile Any
}
```

## 5. 常用维护命令

每次重新打开 PowerShell，先执行：

```powershell
Set-Location 'J:\PRT-demo-hub-test'
$prtCompose = @('-f', 'compose.production.yaml', '-f', 'compose.windows-test.yaml')
```

```powershell
docker compose @prtCompose ps
docker compose @prtCompose logs --tail 100 app
docker compose @prtCompose restart app
docker compose @prtCompose stop
docker compose @prtCompose start
```

更新前备份并导出到宿主机（每次使用新目录）：

```powershell
$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prtBackup = 'J:\PRT-backups\before-update-' + $prtStamp
$prtContainerBackup = '/app/backups/before-update-' + $prtStamp
docker compose @prtCompose exec app node scripts/backup.mjs $prtContainerBackup
if ($LASTEXITCODE -ne 0) { throw '备份失败' }
New-Item -ItemType Directory -Path $prtBackup | Out-Null
docker cp "prt-datahub-windows-test:${prtContainerBackup}/." $prtBackup
if ($LASTEXITCODE -ne 0) { throw '导出备份失败' }
```

同步最新源码时保留 `.env` 和备份，更新服务：

```powershell
docker compose @prtCompose build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
docker compose @prtCompose up -d --wait
if ($LASTEXITCODE -ne 0) { throw '启动失败' }
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
```

只修改 `.env` 后也需执行 `up -d --wait`，单独 `restart` 不会加载新的容器环境变量。不要执行 `down -v` 或删除数据卷。测试使用的独立数据卷为 `prt-datahub-windows-test-data` 和 `prt-datahub-windows-test-backups`。

验收失败且尚无需保留的新写入时，可停止新测试容器，再启动旧容器，并恢复飞书原主页。新实例已有业务写入时，先备份并确认数据取舍，不直接切回旧库。Docker 自动重启依赖 Docker Desktop 引擎已启动；Windows 重启后需确保 Docker Desktop 正常运行。

## AI 输出被截断

模型返回 `max_tokens` 或 `length` 表示输出额度耗尽，不等同于网络超时。新版默认不设置应用侧 token 上限：`.env` 中 `DESCRIPTION_AGENT_MAX_TOKENS` 和 `RAG_LLM_MAX_TOKENS` 删除或留空时，请求中不发送 `max_tokens`，使用模型服务默认值。模型服务仍有自己的默认输出和上下文限制，省略参数并不表示无限输出。

后续需要控制成本时，可按需填写 `DESCRIPTION_AGENT_MAX_TOKENS=8192`、`RAG_LLM_MAX_TOKENS=4096`，重建容器后生效；留空可以取消应用侧额度。显式额度允许范围为 1024～32768，且须符合实际模型限制，不要填 `0`。额度只限制每次请求的输出，增加额度可能增加延迟和费用。

统一设置 `DEEPSEEK_ENABLE_THINKING=false`，数据说明和智能检索均向官方接口发送 `thinking: {type: disabled}`。截断结果不会保存，也不会为额度耗尽自动重试；智能检索出现截断时会回退本地检索。

更新最新源码、`Dockerfile` 及 `compose.production.yaml` 后重新构建并重建当前实例，保留原数据卷及其配置。仅修改 `.env` 不会更新旧镜像代码。可在当前容器执行 `node scripts/check-description-agent.mjs --all`，使用合成 CSV 和合成 Demo 检查实际接口、输出额度、生成结果及检索工具调用。

### 切换 DeepSeek 官方接口

两处 AI 功能统一使用官方高级模型，不能将阿里云 Key 或阿里云模型部署名称原样用于官方接口。按当前 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/) 和 [思考模式文档](https://api-docs.deepseek.com/guides/thinking_mode)，配置如下：

```dotenv
DEEPSEEK_API_KEY=填写DeepSeek官方平台签发的Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_ENABLE_THINKING=false
DESCRIPTION_AGENT_MAX_TOKENS=
RAG_LLM_MAX_TOKENS=
```

新代码调用 `https://api.deepseek.com/chat/completions`，发送官方的 `thinking: {type: disabled}` 参数。切换前需同步最新源码（包括 `server/model-config.mjs`）、Compose 和 Dockerfile，重新构建镜像并重建容器。旧的连接、型号、协议和思考参数不再读取，具体迁移清单见 [统一模型配置](deepseek-configuration.md)。

对当前 `prt-datahub-production` 实例，在本手册开头的备份步骤完成后执行：

```powershell
$prtUpdate = @('-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')
docker compose @prtUpdate config --quiet
if ($LASTEXITCODE -ne 0) { throw '配置检查失败' }
docker compose @prtUpdate build
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }
docker compose @prtUpdate up -d --no-build --force-recreate --wait app
if ($LASTEXITCODE -ne 0) { throw '容器启动失败' }
docker exec prt-datahub-production node scripts/check-description-agent.mjs --all
```

自检应显示 `deepseek-v4-pro`、`openai`、官方 HTTP 地址、`思考模式：false`，并报告说明生成和智能检索自检成功。若仍显示 `true`，检查 `.env` 的 `DEEPSEEK_ENABLE_THINKING` 重复条目、PowerShell 同名环境变量覆盖，以及是否已重建正确容器。两处 AI 功能现在均使用这一套官方配置。
