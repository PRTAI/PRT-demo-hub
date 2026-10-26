# Windows 新目录全新部署

如需恢复 `D:\PRT-demo-hub` 中的旧数据，改用[恢复旧数据并更新到新目录](restore-windows-deployment.md)；恢复已有管理员时无需重新初始化。

本次目标：在同一台 Windows 电脑的新目录运行一套空数据环境，使用内网 IP `192.168.110.25`。建议端口为 `8081`，与原服务分开。默认新目录为当前 Windows 用户目录下的 `PRT-DataHub-New`，也可在第一步将目标变量改成其他尚不存在的目录。

新实例不迁移旧用户、角色、Demo、文件、需求或通知记录；飞书应用和模型凭据可以继续使用原配置。旧服务和数据保留。本文命令均在实际部署电脑的 PowerShell 中执行，使用 Node.js 24。

## 1. 确认地址、端口和 Node

在当前完整源码的根目录打开 PowerShell，先运行：

```powershell
$ErrorActionPreference = 'Stop'
node --version
if ($LASTEXITCODE -ne 0) { throw '请先安装 Node.js 24' }
Get-NetIPAddress -AddressFamily IPv4 -IPAddress '192.168.110.25' -ErrorAction Stop
$prtListener = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($prtListener) { throw '8081 已被占用，请先选择其他端口' }
```

Node 版本应为 `v24.x`。如果找不到该 IP，先确认本机网卡地址，再统一调整本文中的 IP。端口如需改变，应同时修改环境配置、健康检查地址、防火墙规则和飞书入口及回调。

## 2. 复制源码到独立目录

以下操作只复制源码到新的目录，不停止旧服务、不删除原目录。`robocopy` 的退出码小于 8 表示没有复制错误。

```powershell
$prtSource = (Get-Location).Path
$prtTarget = Join-Path $env:USERPROFILE 'PRT-DataHub-New'
if (-not (Test-Path (Join-Path $prtSource 'package.json'))) { throw '请在当前源码根目录执行' }
if (-not (Test-Path (Join-Path $prtSource 'config\host-lan.env.example'))) { throw '源码缺少本次新增的部署模板' }
if (Test-Path $prtTarget) { throw '目标目录已存在，请选一个新的空目录' }
robocopy $prtSource $prtTarget /E /XD node_modules .git dist data host-data .preview-data backups .preview-backups .host-runtime test-results /XF .env .env.* *.log /R:1 /W:1
if ($LASTEXITCODE -ge 8) { throw '复制源码失败' }
Set-Location $prtTarget
```

原有密钥配置、数据库、文件、运行 PID 和构建产物均不带入。新目录中的源码包括本次尚未提交的修改和新增文件。

## 3. 创建并填写新环境配置

```powershell
Copy-Item .\config\host-lan.env.example .\.env.host -ErrorAction Stop
notepad .\.env.host
```

在记事本中填写并保存：

| 配置 | 填写方式 |
| --- | --- |
| `FEISHU_APP_ID` | 原飞书自建应用的 App ID，或新建应用的 App ID。 |
| `FEISHU_APP_SECRET` | 对应应用的 App Secret，仅在本地填写。 |
| `FEISHU_TENANT_KEY` | 允许访问的企业 tenant_key。 |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 Key，数据说明和智能检索共用；暂不启用 AI 时可留空。 |
| `DEEPSEEK_BASE_URL` | 官方地址 `https://api.deepseek.com`。 |
| `DEEPSEEK_MODEL` | 官方高级模型 `deepseek-v4-pro`。 |
| `DEEPSEEK_ENABLE_THINKING` | 保持 `false`，减少等待和输出截断。 |

保留本次新配置中的 `APP_ORIGIN=http://192.168.110.25:8081`、`PORT=8081` 和 `DATA_DIR=./host-data`。相对数据目录会位于新项目内，保证与旧库分离。`BOOTSTRAP_ADMIN_OPEN_IDS` 可以留空，后续通过命令初始化首位管理员。

当前源码在 `NODE_ENV=production` 时要求 HTTPS。这里沿用既有内网 HTTP 运行方式，模板设置 `NODE_ENV=development`；服务仍使用构建后的前端，`DEMO_MODE=false` 关闭体验登录并使用企业飞书认证。后续接入 HTTPS 时，应按实际代理入口调整地址及生产模式。

两处功能通过 OpenAI 兼容协议调用官方 Pro 模型，旧阿里云和独立数据说明连接配置不再读取。详细迁移与双功能自检见 [DeepSeek 官方 Pro 配置](deepseek-configuration.md)。

## 4. 安装、验证和构建

在新目录中执行：

```powershell
npm ci --include=dev
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
npm test
if ($LASTEXITCODE -ne 0) { throw '测试失败' }
npm run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
```

当前版本已在开发工作区通过 56 项测试和前端构建。部署机上以实际执行结果为准。文件夹 `host-data` 在服务首次启动时自动创建，不需要复制旧数据库，也不需要手动建表。

AI 配置完成后，可选运行模型自检；该命令会使用内置的两行合成 CSV 调用模型接口，不读取正式 Demo：

```powershell
node --env-file=.env.host scripts/check-description-agent.mjs
```

## 5. 启动并验证本机访问

```powershell
.\scripts\start-host.ps1
```

等待数秒后执行：

```powershell
Invoke-RestMethod -Uri 'http://192.168.110.25:8081/api/health'
Get-Content .host-runtime/server.log -Tail 80
```

应返回 `ok: true`，浏览器打开 `http://192.168.110.25:8081/` 应显示登录页面。模板只绑定该内网 IP，健康检查也使用该 IP。

若配置需要修改，在新项目目录保存 `.env.host` 后依次运行停止、启动脚本：

```powershell
.\scripts\stop-host.ps1
.\scripts\start-host.ps1
```

每个目录的 PID 文件独立保存，因此在新目录执行启停脚本只针对新实例。此阶段旧服务继续保留。

## 6. 开放内网访问

另开“以管理员身份运行”的 PowerShell，创建仅针对本 IP、本端口和本子网的入站规则：

```powershell
$prtRuleName = 'PRT-DataHub-LAN-8081'
if (-not (Get-NetFirewallRule -Name $prtRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $prtRuleName -DisplayName 'PRT DataHub LAN TCP 8081' -Direction Inbound -Action Allow -Protocol TCP -LocalAddress '192.168.110.25' -LocalPort 8081 -RemoteAddress LocalSubnet -Profile Any
}
```

从另一台同内网电脑访问 `http://192.168.110.25:8081/api/health` 及首页，确认网络可达。现有 `prepare-host-network.ps1` 内含旧 IP 和端口，本次按本文创建新规则。

## 7. 配置飞书地址和通知能力

在飞书开发者后台选择 `.env.host` 对应的应用，配置如下：

| 项目 | 新地址或要求 |
| --- | --- |
| 登录重定向 URL | `http://192.168.110.25:8081/api/auth/callback`。先添加新回调，旧服务仍在使用时保留旧回调。 |
| 网页应用主页 | 新平台验收后切换为 `http://192.168.110.25:8081/`。消息中的飞书应用入口会依此打开新平台。 |
| 移动端主页 | 如需在飞书移动端使用，同步设置为新平台首页，并确认手机网络可访问。 |
| 应用可用范围 | 包含需要登录的人员，以及接收通知的产品经理和商务。 |
| 机器人及消息权限 | 开启机器人，申请并生效 `im:message:send_as_bot`。 |

配置变更按飞书控制台提示保存、发布生效。如果后台要求 HTTPS，应改用企业可达的 HTTPS 域名及代理入口，再同步环境配置和回调。

所有人从统一的 `http://192.168.110.25:8081/` 发起登录，避免混用不同主机地址。测试新环境时仍可直接通过该首页进入飞书登录；正式切换后确认消息中的应用入口指向新主页。

## 8. 初始化首位管理员

新库没有旧账号或管理员，按以下顺序操作：

1. 指定管理员从新首页完成一次飞书登录。
2. 在“身份已确认，等待分配权限”页面复制“平台用户编号”。
3. 在新项目目录的 PowerShell 中执行：

```powershell
$prtAdminUserId = Read-Host '请输入待授权页面上的平台用户编号'
node --env-file=.env.host scripts/admin.mjs $prtAdminUserId
if ($LASTEXITCODE -ne 0) { throw '管理员初始化失败，请检查是否已通过新平台登录' }
```

看到 `Initial administrator assigned` 后，回到页面点击“刷新权限”。该命令仅允许初始化首位管理员，已有管理员后通过平台界面维护人员。

其他人员首次登录后会重新建立账号，管理员进入“人员与权限”配置员工、主管、产品经理和商务。需要同时发布需求及准备 Demo 的人员，可配置多个角色。

## 9. 验收业务与通知

按[操作手册](user-manual.md#部署更新与验收)完成验收。至少确认以下结果：

- 新平台没有旧用户、Demo 和需求，登录后按新角色进入页面。
- 商务发布需求，员工从需求创建 Demo，绑定关系正确。
- 未绑定草稿可保存，提交或发布前必须至少关联一个需求。
- 完成文件和说明后可以审核发布。
- 全部已启用产品经理及关联需求的商务发布人收到飞书消息，同一人不重复发送。
- 消息中的应用入口打开新平台的正确 Demo。
- 管理员在“平台设置 → 飞书通知”查看发送状态，必要时修复配置并重试。

发布验收数据会真实通知符合规则的接收人，可使用明确标注为验收的合成数据，并提前告知参与人员。

## 10. 确认后切换自动启动并备份

新平台验收通过后，在新目录运行：

```powershell
.\scripts\install-host-startup.ps1
```

该脚本会将当前 Windows 用户的 `PRT DataHub.lnk` 登录启动快捷方式改为新目录，因此在确认切换时执行。它按用户登录启动；电脑休眠、关机或无人登录会影响服务可用性。

如不再使用旧服务，在旧项目目录运行其 `stop-host.ps1`，保留旧目录和数据以便查阅。新服务不需要占用旧服务的端口。

在新目录执行首份备份：

```powershell
node --env-file=.env.host scripts/backup.mjs
if ($LASTEXITCODE -ne 0) { throw '备份失败' }
```

确认输出 `Backup verified`，并将完成的备份另存到独立存储。之后按[现有服务更新流程](host-deployment.md#版本更新)维护，使用新目录、新端口和新访问地址。
