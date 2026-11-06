# DeepSeek 运维：配置、使用与自动归档

平台内置虚拟员工“DeepSeek 运维”，固定拥有 ops（运维）角色。管理员可在“人员与权限”启用／停用它，也可给真人账号分配运维角色。只有明确拥有 ops 角色的账号可见侧栏中的“DeepSeek 运维”入口并访问其页面、接口；仅有管理员角色的账号也需先添加运维角色。虚拟员工不能用飞书、体验登录或外部 Harness 登录，不自动拥有项目经理、商务或管理员权限。

## 运行逻辑

1. 在运维对话中描述开发或排障任务。内置 Harness 调用 DeepSeek，按需读取、搜索、修改源码并运行测试、构建。执行记录和对话持久化；不同账号的会话互不可读。
2. 模型复用数据说明模块的 DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。运维始终开启思考，默认 reasoning_effort=max；OPS_MAX_TOKENS 留空时不发送 max_tokens，使用模型服务默认额度。max 是思考强度，不是无限输出。
3. 代码修改发生在独立 Docker 工作器的持久化工作区。它可编辑核心源码、运行固定测试及构建命令，无线上数据、备份、密钥或 Docker socket 挂载，不直接修改正在运行的应用容器。工作器网络为内部网络，不开放宿主机端口；测试子进程不传入工作器认证密钥。
4. 完成后点击“下载源码”，按下方脚本导入到新目录并发布。对话完成、修改文件、运行测试不算部署；新镜像运行并健康检查通过后，记录该次核心源码版本。相同版本重启不重复登记；同一天多次更新，午夜归档当前运行的最新版。
5. 部署当天北京时间 24:00，即次日 00:00，先在线备份数据库、全部已登记上传文件和部署源码，校验后替换 ops/latest，再把核心源码提交到 PRTAI/PRT-demo-hub 的 feature/deepseek 分支。不会推送 main，也不会强制推送或自动合并。

本地自动备份只保留一份成功版本，轮换期间需要同时容纳新旧两份。新备份失败时保留旧版；GitHub 失败时保留已完成的本地备份，重试只处理提交。失败自动每 10 分钟重试，最多 6 次，之后在工作台点击“重试”。服务午夜未运行时，下次启动补执行到期任务。关闭 Docker Desktop 或 Windows 休眠期间不能准点执行，需保持主机和 Docker 运行。

自动归档记录、对话、工具审计保存在平台数据库。停用虚拟员工暂停新任务及自动归档。已完成的修改不会因停止对话而撤销。

## 首次在 Windows 启用

同步完整最新源码到 J:\PRT-demo-hub-test，保留部署机 .env。本次新增 Dockerfile.ops、compose.ops.yaml、server/ops-*.mjs、src/Ops.jsx 等文件都要复制。

先运行配置脚本。它会生成工作器随机密钥，补齐默认配置并打开 .env；已有配置保留，不会输出密钥：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\configure-ops.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test'
~~~

在记事本内补充以下配置，保留原来的 DEEPSEEK_*。不要在 PowerShell 提示符直接输入这些 KEY=value 行：

~~~dotenv
OPS_REASONING_EFFORT=max
OPS_MAX_TOKENS=
OPS_GITHUB_TOKEN=填写GitHub仓库令牌
OPS_GITHUB_REPOSITORY=PRTAI/PRT-demo-hub
OPS_GITHUB_BRANCH=feature/deepseek
OPS_GITHUB_BASE_BRANCH=main
OPS_HOST_BACKUP_DIR=J:/PRT-backups/ops
~~~

GitHub 令牌：GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens，Repository access 仅选 PRTAI/PRT-demo-hub，Repository permissions 中 Contents: Read and write。组织要求审批时须先通过组织审批；分支规则也须允许该令牌创建或推送 feature/deepseek。令牌只放 .env。无需把 Git 凭据、SSH 私钥或 .git 挂载进容器。未配置时午夜仍先完成备份，但提交会报告缺少配置；补配后重建应用容器并在页面重试。

启用并部署：

~~~powershell
$ErrorActionPreference = 'Stop'
Set-Location 'J:\PRT-demo-hub-test'
New-Item -ItemType Directory -Path 'J:\PRT-backups\ops' -Force | Out-Null

powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\scripts\update-docker.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test' -BackupDirectory 'J:\PRT-backups' -EnableOps
if ($LASTEXITCODE -ne 0) { throw '更新失败，请检查上方报错' }

Invoke-RestMethod 'http://127.0.0.1:8001/api/health' -TimeoutSec 15
~~~

更新脚本自动构建应用和工作器，并保留原数据卷。后续沿用更新命令；脚本能识别旧容器已启用的运维 Compose，不会因省略 -EnableOps 移除工作器。运维备份实际在 Windows J:\PRT-backups\ops\latest，独立于 C 盘 Docker 数据盘；已有的 before-update-* 更新前备份不自动删除。

## 验收与使用

1. 更新成功，管理员先在“人员与权限”为需要使用的真人账号添加“运维”角色（管理员自己使用也需要添加）。该账号浏览器 Ctrl+F5，从侧栏打开“DeepSeek 运维”，确认模型已配置、工作器可用。
2. 发送“检查运行状态并列出源码目录”。应看到工具执行记录和回复。再试一个小改动，要求运行测试和构建；确认有结果后下载源码。
3. 停止任务会停止后续工具调用，已完成写入保留。多人共用一份工作区，同一时刻只运行一个任务；会话私有，源码改动共享。同一部署版本重启保留改动，发布新版本会建立新工作区，并额外保留上一版工作区。
4. “部署备份与代码归档”可查看当次部署摘要、北京时间执行时刻、备份、提交及错误。午夜后检查 J:\PRT-backups\ops\latest\manifest.json、platform.sqlite、files、source 和 source-manifest.json，再查看 GitHub feature/deepseek。

## 将运维改动发布到平台

在工作台下载 prt-ops-source.json，将其放到部署机，例如 J:\PRT-ops\prt-ops-source.json。源码包不包含 .env、上传文件或数据库。执行：

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\apply-ops-update.ps1' -SourceSnapshotPath 'J:\PRT-ops\prt-ops-source.json' -ProjectDirectory 'J:\PRT-demo-hub-test' -OutputDirectory 'J:\PRT-demo-hub-ops-update' -BackupDirectory 'J:\PRT-backups'
if ($LASTEXITCODE -ne 0) { throw '运维更新失败，请查看上方报错' }
~~~

OutputDirectory 必须是新目录。脚本在临时容器校验路径和 SHA256，再复制部署配置到新目录，执行已有备份、构建、重建和健康检查流程，不要求 Windows 安装 Node。成功后以后更新以该新目录为准；下一次再选择另一个新目录。.env 不进入源码包或 GitHub。

## 备份恢复与其他部署

latest 的数据格式与现有 scripts/restore.mjs 兼容，source/ 是对应部署源码。恢复数据应先停止服务，使用恢复脚本写入新数据目录／数据卷并验证，按 [更新手册](windows-docker-guide.md)的迁移资料切换；不要覆盖运行中的 SQLite 文件。旧备份被成功新版替换后不可从本地自动找回，如需长期历史需另行复制到其他存储。

当前自动提交只提交白名单核心源码，不包含 Git 历史、运行数据、密钥或构建产物；归档分支提交包含该次部署完整核心源码，分支上同路径的旧代码以部署版为准。如人工也在该分支开发，应先同步并检查差异。推送并发冲突会失败并提示重试，不强制覆盖远程提交历史。

Ubuntu 部署时将 OPS_HOST_BACKUP_DIR 改成主机绝对目录，例如 /srv/prt-backups/ops，确保应用容器的 node 用户可写。使用相同三个 Compose 文件。需要原生运行运维调度时，设置 OPS_ENABLED=true、OPS_SOURCE_DIR 和 OPS_BACKUP_DIR，并单独运行隔离工作器；默认普通开发和体验环境不自动备份或推送。
