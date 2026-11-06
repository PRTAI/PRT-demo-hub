# Windows Docker 新建独立测试实例

仅用于新实例或迁移到独立数据卷。现有平台日常更新请使用 [Windows Docker 更新手册](windows-docker-guide.md)。不要将两套 Compose 配置混用。

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
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
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

