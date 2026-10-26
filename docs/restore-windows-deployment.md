# Windows 恢复旧数据并更新到新目录

本次方案以 `D:\PRT-demo-hub` 为旧部署目录，将旧数据通过完整备份恢复到独立的新目录，再运行最新代码。沿用前面建议的新入口 `http://192.168.110.25:8081`。用户、角色、Demo、文件、需求及已有审计记录以旧数据库实际内容为准，旧目录和原数据保留。

本文用于恢复旧数据，替代前面的空库部署步骤。默认新项目目录为当前 Windows 用户目录下的 `PRT-DataHub-New`；已经按之前步骤创建新目录也可以继续使用，但恢复目标使用单独的 `host-data-restored`，不会覆盖该目录中已有的空库。

所有业务命令在实际 Windows 部署机的同一个 PowerShell 窗口中按顺序执行，使用 Node.js 24。密钥在本地配置，检查输出只需要分享路径、文件是否存在、条目数量和错误信息。

## 1. 找到旧配置和真实数据库

```powershell
$ErrorActionPreference = 'Stop'
$prtOld = 'D:\PRT-demo-hub'
$prtNew = Join-Path $env:USERPROFILE 'PRT-DataHub-New'
$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$prtBackup = Join-Path 'D:\PRT-backups' ('before-upgrade-' + $prtStamp)
$prtNewData = Join-Path $prtNew 'host-data-restored'
Set-Location $prtOld
node --version
if ($LASTEXITCODE -ne 0) { throw '请先安装 Node.js 24' }
if (-not (Test-Path .\.env.host)) { throw '旧目录中未找到 .env.host，请先找到原服务实际使用的配置' }
$prtOldData = node --env-file=.env.host --input-type=module -e "import path from 'node:path'; process.stdout.write(path.resolve(process.env.DATA_DIR || './data'));"
if ($LASTEXITCODE -ne 0) { throw '旧配置读取失败' }
Write-Output ('旧数据目录：' + $prtOldData)
if (-not (Test-Path (Join-Path $prtOldData 'platform.sqlite'))) { throw '旧数据库不存在，停止操作，不能用空库代替' }
if (-not (Test-Path (Join-Path $prtOldData 'files'))) { throw '旧文件目录不存在，请先找到完整数据' }
if (Test-Path $prtNewData) { throw '恢复目标已存在，请选择一个尚不存在的新数据目录，并同步修改后续 DATA_DIR' }
```

旧库以原 `.env.host` 的 `DATA_DIR` 为准，不应仅凭目录名认定 `host-data` 就是正式库。上面只读取配置和检查路径，不创建数据库。

查看旧库的模式及条目数量，记录输出，恢复后用于核对：

```powershell
node --env-file=.env.host --input-type=module -e "import path from 'node:path'; import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || './data'), 'platform.sqlite'), { readOnly: true }); const mode = db.prepare('SELECT value FROM metadata WHERE key=?').get('mode')?.value; if (mode === 'preview') throw new Error('这是体验库，请先找到正式数据'); console.log('mode:', mode || '未记录'); for (const table of ['users', 'assets', 'versions', 'files']) console.log(table + ':', db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count); db.close();"
if ($LASTEXITCODE -ne 0) { throw '旧数据检查失败，停止操作' }
```

如果 `.env.host` 或正式库不存在，先定位实际运行配置和数据。若只找到已有备份，可使用其中同时含有 `manifest.json`、`platform.sqlite` 和 `files/` 的完整目录作为后续 `$prtBackup`；该备份只包含它生成时的数据，不能代表之后的业务变更。

## 2. 准备最新代码

本轮功能包含尚未提交的修改和新增文件，需要将当前完整源码同步到新目录。旧部署目录中的历史代码不一定含有新功能。

```powershell
$prtCode = Read-Host '请输入包含本轮修改的最新源码目录'
if (-not (Test-Path (Join-Path $prtCode 'server\requirements.mjs'))) { throw '该源码缺少需求功能，请确认使用本轮最新完整代码' }
if (-not (Test-Path (Join-Path $prtCode 'scripts\check-description-agent.mjs'))) { throw '该源码缺少本轮 AI 修复文件' }
if ([IO.Path]::GetFullPath($prtCode).TrimEnd('\') -eq [IO.Path]::GetFullPath($prtOld).TrimEnd('\')) { throw '请先将最新源码放到独立目录，保留旧目录用于回退' }
if ([IO.Path]::GetFullPath($prtNew).TrimEnd('\') -eq [IO.Path]::GetFullPath($prtOld).TrimEnd('\')) { throw '新旧部署目录必须分开' }
if (Test-Path (Join-Path $prtNew 'scripts\stop-host.ps1')) {
    & (Join-Path $prtNew 'scripts\stop-host.ps1')
}
if ([IO.Path]::GetFullPath($prtCode).TrimEnd('\') -ne [IO.Path]::GetFullPath($prtNew).TrimEnd('\')) {
    robocopy $prtCode $prtNew /E /XD node_modules .git dist data host-data host-data-restored .preview-data backups .preview-backups .host-runtime test-results /XF .env .env.* *.log /R:1 /W:1
    if ($LASTEXITCODE -ge 8) { throw '同步最新源码失败' }
}
Set-Location $prtNew
npm ci --include=dev
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
npm test
if ($LASTEXITCODE -ne 0) { throw '测试失败' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
```

这一步保留新目录已有的配置和数据，仅准备最新代码并完成构建。旧服务在此阶段可以继续运行，正式切换时再停机备份。

## 3. 停止旧服务并生成最终备份

通知使用者进入维护时段，暂停上传、编辑和发布，直到新平台验收完成。然后执行：

```powershell
Set-Location $prtOld
.\scripts\stop-host.ps1
node --env-file=.env.host scripts/backup.mjs $prtBackup
if ($LASTEXITCODE -ne 0) { throw '旧数据备份失败，停止迁移' }
if (-not (Test-Path (Join-Path $prtBackup 'manifest.json'))) { throw '备份未完成，停止迁移' }
Write-Output ('已校验备份：' + $prtBackup)
```

应看到 `Backup verified`。备份会生成 SQLite 一致快照并逐一校验原文件的大小和哈希，包含数据库中实际存在的需求及绑定。登录会话和未完成 OAuth 登录会从备份中清除。备份完成后旧服务继续保持停止，避免切换期间出现备份之后的新写入。

如果旧服务已经无法启动，但数据库和文件完整，这套备份命令仍可使用。若备份失败，先排查数据库、缺失文件或磁盘空间，保留旧库，不继续启动新实例。

## 4. 恢复到全新的数据目录

```powershell
Set-Location $prtNew
node scripts/restore.mjs $prtBackup $prtNewData
if ($LASTEXITCODE -ne 0) { throw '恢复失败，停止部署' }
if (-not (Test-Path (Join-Path $prtNewData 'platform.sqlite'))) { throw '恢复结果缺少数据库' }
Write-Output ('恢复数据目录：' + $prtNewData)
```

恢复脚本会先检查数据库完整性和全部文件，再写入新目录。`$prtNewData` 必须尚不存在；不要提前创建 `host-data-restored`。如果恢复中途失败留下该目录，应保留现场并换一个新目录重试，不覆盖或删除旧部署数据。

这里使用的是刚刚生成的完整备份。不要只复制运行中的 `platform.sqlite`，SQLite 的未合并写入可能仍位于 WAL 文件中；原数据库还需要与原文件对象配套。

## 5. 沿用旧凭据并修改新地址

先保留新目录中原有配置的副本，再复制旧正式配置：

```powershell
if (Test-Path .\.env.host) {
    Copy-Item .\.env.host ('.\.env.host.before-migration-' + $prtStamp)
}
Copy-Item (Join-Path $prtOld '.env.host') .\.env.host -Force
notepad .\.env.host
```

在记事本中修改对应的原有行并保存，避免添加同名的重复配置：

```dotenv
NODE_ENV=development
DEMO_MODE=false
HOST=192.168.110.25
PORT=8081
APP_ORIGIN=http://192.168.110.25:8081
DATA_DIR=./host-data-restored
BACKUP_DIR=./backups
DEEPSEEK_API_KEY=填写DeepSeek官方Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_ENABLE_THINKING=false
```

`DATA_DIR` 必须与刚恢复出的目录一致，不能保留旧库的绝对路径，也不能指向之前新建的空库。若第一步更换了恢复目标名称，这里同步修改。

保留旧 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TENANT_KEY`。模型配置按 [DeepSeek 官方 Pro 配置](deepseek-configuration.md)切换，两处 AI 功能共用官方 Key、地址和型号，旧模型连接配置不再读取。恢复旧账号及角色时应沿用原飞书应用；更换应用会改变用户身份映射，不能假定旧账号权限会自动对应到新应用。

此处 `NODE_ENV=development` 适用于沿用现有内网 HTTP 的运行方式，`DEMO_MODE=false` 仍关闭体验登录。当前源码在 `NODE_ENV=production` 时要求 HTTPS；若已经配置企业 HTTPS 域名，应按实际代理入口保留生产模式并同步修改地址。

核对配置最终指向的目录，并比较用户、Demo、版本和文件数量：

```powershell
node --env-file=.env.host --input-type=module -e "import path from 'node:path'; import { DatabaseSync } from 'node:sqlite'; const root = path.resolve(process.env.DATA_DIR || './data'); console.log('DATA_DIR:', root); const db = new DatabaseSync(path.join(root, 'platform.sqlite'), { readOnly: true }); for (const table of ['users', 'assets', 'versions', 'files']) console.log(table + ':', db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count); db.close();"
if ($LASTEXITCODE -ne 0) { throw '恢复后数据检查失败，不能启动' }
```

启动前条目数量应与旧库最终备份时一致。数据库只读检查不会创建空库；路径或数量不对时，先处理配置与备份来源。

## 6. 检查新地址并配置飞书

确认本机网卡有该 IP，且 8081 没有其他程序监听：

```powershell
Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.110.25' -ErrorAction Stop
$prtListener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($prtListener) { throw '8081 已占用，停止启动并先确认占用来源' }
```

在原飞书应用后台新增回调 `http://192.168.110.25:8081/api/auth/callback`，并在切换新平台时将网页应用主页设为 `http://192.168.110.25:8081/`；移动端如需使用也同步设置。保留旧回调，便于验收失败时回退。配置按飞书控制台要求发布生效。

机器人和 `im:message:send_as_bot` 权限继续沿用，应用可用范围需覆盖产品经理、商务和其他实际使用者。消息里的飞书应用链接依赖网页应用主页，验收时要确认跳转到新实例。

从“以管理员身份运行”的另一个 PowerShell 窗口配置新端口的内网防火墙规则：

```powershell
$prtRuleName = 'PRT-DataHub-LAN-8081'
if (-not (Get-NetFirewallRule -Name $prtRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $prtRuleName -DisplayName 'PRT DataHub LAN TCP 8081' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress '192.168.110.25' -LocalPort 8081 -RemoteAddress LocalSubnet -Profile Any
}
```

原网络脚本内含旧 IP 和端口，本次使用上述新规则。

## 7. 启动新版并验收旧数据

回到保留前述变量的原 PowerShell 窗口，在新目录启动：

```powershell
Set-Location $prtNew
.\scripts\start-host.ps1
```

等待数秒后执行：

```powershell
Invoke-RestMethod -Uri 'http://192.168.110.25:8081/api/health'
Get-Content .host-runtime/server.log -Tail 80
```

应返回 `ok: true`。首次启动会自动补齐当前版本所需的表和索引，无需手工执行 SQL。

通过新首页完成飞书登录，核对以下内容：

- 原管理员能够登录，原角色和主管配置保留；无需再次执行首位管理员初始化命令。
- 原 Demo、版本、说明和文件可以按原有权限访问，抽查几个文件的下载。
- 原库已存在的需求及绑定保留；若旧版尚无需求功能，需求中心为空是正常的，需要自行发布需求并逐步补绑。
- 历史已发布 Demo 继续可用，后续提交、发布和恢复发布前需补绑至少一个需求。
- 新建合成数据进行一次需求绑定和发布验收，确认全部产品经理及对应商务收到飞书消息。
- 消息入口打开新实例中的正确 Demo，管理员可以查看通知送达记录。

恢复会清除旧登录会话，需要重新登录。服务启动会将此前未完成的 AI 生成任务标为中断，可以重新生成。旧库中的有效待发通知会按队列规则继续处理；历史已发布数据不会仅因恢复而新增一轮发布通知。

## 8. 切换自动启动并保留回退路径

新平台验收成功后，在新目录执行：

```powershell
.\scripts\install-host-startup.ps1
node --env-file=.env.host scripts/backup.mjs
if ($LASTEXITCODE -ne 0) { throw '新版首次备份失败，请排查后重试' }
```

登录启动快捷方式会改为新目录。旧服务保持停止，保留 `D:\PRT-demo-hub`、其原数据及迁移前备份。之后的业务写入只在新实例进行，避免两套库分叉。

如在正式开放新平台写入之前验收失败，停止新目录的服务，恢复飞书应用主页为仍可达的旧入口，再从旧目录启动原服务。若旧入口的 IP 已变化，也要先修正旧实例的地址、回调及防火墙配置。新平台已经产生业务写入后，不应直接切回旧库；先备份新库并确定需要保留的数据。
