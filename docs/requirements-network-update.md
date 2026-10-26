# 需求协作与内外网上传更新

本次更新继续使用原容器 `prt-datahub-production`、原数据卷及端口 8001。上传接口保持同源：能够访问同一服务内网地址的机器，会在打开页面时切换到内网入口；外网机器继续使用公网入口。切换入口后可能需要重新进行一次飞书登录。

## 1. 同步源码和配置

把完整最新源码复制到 `J:\PRT-demo-hub-test`，包含新增的 `shared/`、`server/network.mjs`、`server/feishu-documents.mjs` 和 `src/network-routing.mjs`。保留部署目录现有 `.env`、数据与备份，不复制开发环境数据或 `node_modules`。

在 Windows `.env` 中添加以下配置；原飞书、模型和管理员配置继续保留。地址不带路径或结尾斜杠。

```dotenv
PUBLIC_APP_ORIGIN=http://data.prt-ai.cn:8001
INTRANET_APP_ORIGIN=http://192.168.110.25:8001
FEISHU_DOCUMENT_PREVIEW=false
```

`APP_ORIGIN` 保留当前有效值。以上两个地址均需指向同一套服务。浏览器打开公网入口后会以短超时探测内网服务实例，匹配时切换整个页面，上传和下载均直接走内网；探测失败时保留公网入口。应用使用浏览器的可达性判断，无法直接读取机器私有 IP。

如果浏览器阻止本地网络探测，可直接打开 `http://192.168.110.25:8001`。要在所有内网机器上稳定使用统一域名，建议在公司 DNS 配置 `data.prt-ai.cn` 的内网解析到 `192.168.110.25`，公网 DNS 仍保持公网解析。这也能避免切换地址导致重新登录。未来改为公网 HTTPS 时，内网也应启用 HTTPS，浏览器不会从 HTTPS 页面探测 HTTP 内网接口。

飞书应用的安全配置中同时登记两个回调地址，然后按控制台要求发布配置：

```text
http://data.prt-ai.cn:8001/api/auth/callback
http://192.168.110.25:8001/api/auth/callback
```

应用发起登录时使用当前入口对应的回调，避免内网用户登录后被带回公网地址。

## 2. 可选：启用飞书正文预览

所有正文中的 HTTP(S) 链接自动成为超链接；飞书云文档链接额外显示预览卡片，点击“预览内容”读取标题和最多 700 字正文。

如需要正文预览，在飞书应用权限管理中开通用户身份的 `docx:document:readonly`、`wiki:wiki:readonly` 权限并发布应用，随后设置：

```dotenv
FEISHU_DOCUMENT_PREVIEW=true
```

重建运行容器后退出并重新飞书登录，授权文档读取。平台只使用当前用户的访问令牌读取其有权访问的文档；用户还必须有该需求的查看权限。普通新版文档 `docx` 及指向新版文档的 `wiki` 支持正文预览，表格、旧版文档和其他类型保留打开入口。未授权、权限不足或文档服务失败时显示链接提示，不影响需求正常使用。令牌只保存在服务内存，服务重启或令牌过期后需重新登录。

## 3. 保留数据更新 Docker

在同一个 PowerShell 窗口执行。每条 Docker 命令失败后停止，不继续下一条。

```powershell
Set-Location 'J:\PRT-demo-hub-test'
$ErrorActionPreference = 'Stop'
$prtUpdate = @('-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')

docker volume inspect prt-datahub-production_production-data prt-datahub-production_production-backups
if ($LASTEXITCODE -ne 0) { throw '原数据卷不存在，请核对挂载' }
docker compose @prtUpdate config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose 配置检查失败' }

$prtStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prtBackupPath = "/app/backups/before-requirements-update-$prtStamp"
$prtHostBackup = "J:\PRT-backups\before-requirements-update-$prtStamp"
docker exec prt-datahub-production node scripts/backup.mjs $prtBackupPath
if ($LASTEXITCODE -ne 0) { throw '备份失败，停止更新' }
New-Item -ItemType Directory -Force -Path $prtHostBackup | Out-Null
docker cp "prt-datahub-production:${prtBackupPath}/." $prtHostBackup
if ($LASTEXITCODE -ne 0) { throw '备份复制失败，停止更新' }

docker compose @prtUpdate build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
docker compose @prtUpdate up -d --no-build --force-recreate --wait app
if ($LASTEXITCODE -ne 0) { throw '启动失败，请检查日志' }
docker compose @prtUpdate ps
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
docker compose @prtUpdate logs --tail 100 app
```

不要执行 `down -v` 或删除数据卷。本次启动会自动迁移需求状态表，保留旧需求、附件、指定人员和 Demo 绑定；无需手动执行 SQL。旧版本应用不支持新增状态，回滚时应同时恢复更新前备份，且先另存更新后数据。

## 4. 验收

1. 在内网电脑打开公网入口，应自动切到 `192.168.110.25:8001`；上传一个小 Demo，浏览器开发者工具 Network 中 `files` 请求的地址应为内网入口。使用外网网络打开公网入口，应保持公网域名。
2. 用被指定人员登录，“我的需求”只显示指定给当前账号的需求；产品经理或商务也按指定关系筛选，不把自己发布但未指定自己的需求算入“我的需求”。
3. 正文粘贴飞书文档链接，保存后可直接点击打开；启用预览并重新授权后，点击“预览内容”显示有权限文档的标题和摘要。
4. 商务或产品经理在需求详情修改状态；其他角色只能查看标签。列表状态筛选有展开、收起动画，并支持键盘方向键和 Escape。
5. 员工提交 Demo，主管退回后，关联的进行中需求变为“待更新”；已交付和已关闭需求不自动改变，发布 Demo 也不自动改成已交付。
6. 管理员在“人员与权限”配置全部账号。可停用有历史数据的账号，再点击“删除”；切换“已删除”筛选可恢复，恢复后保持停用。Demo、需求、文件及历史署名应完整保留。最后一位启用管理员不能被停用或移除管理员角色。

“项目经理”沿用本平台的“产品经理（pm）”角色。手动状态修改开放给产品经理和商务；需求正文、文档、指定人员及绑定管理仍沿用原发布人权限。
