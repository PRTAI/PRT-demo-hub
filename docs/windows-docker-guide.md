# Windows Docker 更新手册

适用于 `J:\PRT-demo-hub-test` 中的现有平台，容器为 `prt-datahub-production`。命令均在部署机 PowerShell 执行；Docker 自动编译，无需宿主机安装 Node.js。

## 更新当前已运行的容器并保留旧数据

首次启用内置 DeepSeek 运维，请先按 [运维配置与部署](deepseek-ops.md)填写工作器随机密钥和 GitHub 令牌，并在更新命令末尾加 `-EnableOps`。启用后的后续更新脚本会自动保留工作器。运维开发、北京时间午夜备份及 feature/deepseek 自动提交也见该文档。

1. 将最新完整源码同步到 `J:\PRT-demo-hub-test`，包含 `scripts`、`server`、`src`、`shared`、`tests`、`docs`、`public`、Dockerfile、Compose、依赖清单，以及隐藏文件 `.gitignore`、`.dockerignore`。保留部署机 `.env`，不复制开发数据、`node_modules` 或 `dist`。通过 `scp *` 复制可能漏掉隐藏文件；更新脚本会先调用 `scripts/repair-docker-build.ps1` 补齐缺失的构建忽略文件，再检查完整源码。
2. 启动 Docker Desktop，执行下面整段命令。脚本自动检查原数据卷、备份并导出到 J 盘、构建镜像、重建容器、检查健康状态。
3. 成功后打开平台并按 `Ctrl+F5` 刷新。

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'J:\PRT-demo-hub-test'

docker version
if ($LASTEXITCODE -ne 0) { throw '请先启动 Docker Desktop' }

docker start prt-datahub-production
if ($LASTEXITCODE -ne 0) { throw '旧容器启动失败，停止更新' }

docker exec prt-datahub-production node -e 'console.log(process.version)'
if ($LASTEXITCODE -ne 0) { throw '容器运行环境异常，停止更新' }

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File 'J:\PRT-demo-hub-test\scripts\update-docker.ps1' `
  -ProjectDirectory 'J:\PRT-demo-hub-test' `
  -BackupDirectory 'J:\PRT-backups'
if ($LASTEXITCODE -ne 0) { throw '更新失败，请查看上方报错，不继续操作' }

Invoke-RestMethod 'http://127.0.0.1:8001/api/health' -TimeoutSec 15
```

内网地址：`http://192.168.110.25:8001`；公网地址：`http://data.prt-ai.cn:8001`。健康接口应返回 `ok: true`。

自动需求卡片和默认个人根目录导出无需新增环境变量；指定知识库需配置 `FEISHU_REQUIREMENT_EXPORT_WIKI_PARENT_URL`，数据库启动时自动升级。批量导出：项目经理按筛选点击“导出 Excel”，按提示完成飞书授权并继续本批；全部文档成功后自动下载表格。自动卡片验收：员工或主管上传新 Demo，不选择需求，保存后在“我的需求”查看自动卡片；项目经理、商务可编辑卡片及调整负责人。原有账号、Demo 和文件应仍可访问。

本轮更新需飞书应用开通用户身份 `docs:document.media:upload`（附件上传）及原 `docx:document`，知识库目标还需 `wiki:wiki`；发布应用版本后，项目经理在导出时重新授权。关闭需求删除日程需应用身份 `calendar:calendar.event:delete` 或已有 `calendar:calendar`。无需新增环境变量。更新后重新导出一条需求检查原生排版、真实附件和准确文档名，再验证成本／数据量级“保存选填、提交必填”、关闭／重开日程，以及详情返回列表定位。

上级查看下属需求：无需新增 `.env` 或飞书权限。更新后在“人员与权限”为员工、主管依次设置“负责主管”，各级上级即可在需求中心查看下属被分配的历史及新需求、下载附件并读取关联 Demo；“我的需求”只列直接分配给自己。可用两级主管验证可见性，再变更负责主管确认旧上级权限回收。

独立上传验收：Demo 名称和至少一个非空文件／压缩包必填，首个文件完整保存后才创建需求卡片，初始不创建日程。只保存说明、空文件、首个文件上传失败／中断均不建卡。移除全部文件或删除草稿后，尚未被维护的自动卡片退出需求列表和导出；原 Demo 补传文件后恢复同一张卡片。旧空卡片同样处理，已维护和手动发布的需求保留。项目经理或商务补充需求正文或上传需求文档后才建日程；只改负责人、标题或状态不触发。首次导出成功后，改需求状态或 Demo 说明，等待同步成功，刷新原飞书链接检查新内容。同步与导出共用原导出项目经理的用户授权，不再读取 sample 或另外创建协作文档。授权失效、退出登录或容器重启后，由原导出者重新授权再点“同步当前内容”。无需新增 `.env`，也无需仅为同步已导出文档额外开通应用身份的 sample 权限。关闭需求后卡片整体为灰色，仍排在最后。

## 本次功能验收：删除需求卡片

无需新增 `.env` 或手工执行 SQL，沿用上方更新命令，启动时自动升级数据库。更新后按 `Ctrl+F5` 刷新：项目经理、商务在卡片与详情页均能看到“删除需求”，其他角色不显示。用测试需求确认删除后列表、搜索和导出不再包含它，关联 Demo 和原文件仍可访问；关联飞书日程随后删除，已导出的飞书文档保留。

## 删除需求文档验收

无需修改 `.env`，沿用上方更新脚本。更新后按 `Ctrl+F5` 刷新，在需求详情检查：项目经理、商务可见附件右侧“删除”按钮，其他角色不显示；确认删除后附件消失、原下载入口失效，已导出的飞书文档随后同步。其他需求或 Demo 引用的原文件保留。

## 草稿箱和需求回复验收

本次无需修改 `.env` 或新增飞书权限，数据库启动时自动建立回复记录表；按上方同一段命令更新。同步完整源码，包含新增的 `server/requirement-replies.mjs`、`src/RequirementReplies.jsx` 和样式文件。

1. 下架一份已发布样例，确认自动打开新草稿，可在“草稿箱”找到并编辑；原下架版本和发布记录保留。已有未完成版本时应保留原内容。
2. 在需求内容下方发送进展，输入 `@` 搜索并选择研发，确认关联账号可回复、被提醒人员收到飞书消息。直接回复留言应提醒原作者；仅继承查看权限的上级保持只读。
3. 刷新页面检查回复、提及和历史记录仍在；管理员可在飞书通知记录查看“需求回复提醒”。

## 磁盘清理后首次更新

若之前出现退出码 `135` 或 `input/output error`，释放空间后先退出 Docker Desktop，执行 `wsl --shutdown`，再重新打开 Docker Desktop，等待引擎启动后执行上面的更新命令。这会中断其他 WSL 和 Docker 服务。

脚本先在 `/app/backups` 生成全量备份，再复制到 `J:\PRT-backups`。Docker 虚拟磁盘所在盘和 J 盘都需要足够空间；J 盘空间充足不能替代 Docker 内部可用空间。备份失败不继续更新；失败目录不可用于恢复。

仍有 `135`、I/O 错误、名称冲突或挂载不符时停止操作，保留报错和容器状态。不要删除冲突容器、数据卷或重置 Docker 来强行继续。

## 查看状态和日志

如果构建报 `"/.dockerignore": not found` 或缺少 `.gitignore`，同步新增的修复脚本后，先执行以下命令，再运行上方更新命令：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\repair-docker-build.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test'
if ($LASTEXITCODE -ne 0) { throw '构建文件修复失败，请查看上方报错' }
~~~

修复脚本补齐缺失的忽略文件，保留已有自定义规则，确保 Docker 可以复制这两个构建元数据文件，同时排除密钥、运行数据和依赖目录。此阶段构建失败且健康检查仍为 true 时，旧平台继续运行，补文件后重新更新即可。

```powershell
docker ps -a --filter 'name=prt-datahub-production'
docker logs --tail 100 prt-datahub-production
Invoke-RestMethod 'http://127.0.0.1:8001/api/health' -TimeoutSec 15
```

现有平台使用 `compose.production.yaml` + `compose.keep-data.yaml`，保留 `prt-datahub-production_production-data` 和 `prt-datahub-production_production-backups` 两个数据卷。不要执行 `down -v` 或删除数据卷。单独 `restart` 不会更新镜像或加载新的环境变量。

更新脚本自动沿用当前容器所属的 Compose 项目，包括 `prt-datahub-current`，避免切回默认项目导致名称冲突。批量 Excel 与单条需求共用项目经理的用户授权，默认导出到其个人云文档。统一放到指定知识库时，新增 `FEISHU_REQUIREMENT_EXPORT_WIKI_PARENT_URL` 并按 [目标目录设置](requirements-export-update.md#将单条和批量导出放到指定知识库目录)补齐用户权限、重新授权。首次批量授权返回后点击“已授权，继续本批导出”。详情见 [导出及权限排查](requirements-export-update.md#批量导出的权限与失败排查)。

## 其他说明

- [新建独立测试实例与迁移](windows-docker-new-instance.md)：仅在新建实例时使用 `compose.windows-test.yaml`。
- [DeepSeek 模型配置与自检](deepseek-configuration.md)。
- [需求、Demo 自动卡片与权限](requirements.md)。
- [飞书文档和 Excel 导出配置](requirements-export-update.md)。
- [需求日历配置](requirements-calendar-update.md)。
