# 每日完整本地备份

每天北京时间 24:00（次日 00:00）执行，与是否部署新版本、运维账号是否启用、GitHub 是否可用无关。首次启用立即备份；停机错过午夜时，启动后补做一次最新快照。失败每 10 分钟重试，不设六次上限。

Windows 默认目录：`D:\PRT-backups\daily\latest`。备份直接写入宿主机 D 盘，不放在 Docker 的 VHDX 中。

## 包含内容

- 一致的完整 SQLite 数据库：账号、权限、全部需求、回复、Demo、版本、说明、负责人、附件关联、日程和文档同步记录、审计及运维对话等所有业务表。
- `files/` 中全部上传文件，包括所有账号的 Demo、压缩包、需求附件及保留的未关联文件；无文件大小上限。
- `source/`：部署源码、依赖清单、部署脚本、文档、前端构建结果和媒体资源。
- `deployment/`：宿主机 `.env` 等运行配置、Compose 文件和 `config/`。该目录含密钥，只保存在本地备份，不提交到 GitHub。
- `extra-data/`：数据目录内其他持久化文件。
- `ops-workspace/`：运维工作器的持久化工作区，保留尚未部署的源码修改；依赖缓存不复制，恢复时重新建立依赖链接。

未完成的上传临时文件、SQLite 临时 WAL/SHM、依赖缓存、Git 历史和 Docker 镜像不复制。数据库通过 SQLite 在线快照备份；登录会话和未完成登录流程清除，恢复后重新登录。已提交的全部业务数据和原始文件保留。飞书云端文档、日程保留其关联与同步记录，飞书云端内容由飞书保存。

## Windows Docker 配置与更新

在部署机 `.env` 中设置（不要直接在 PowerShell 中输入 `KEY=value`）：

```dotenv
DAILY_BACKUP_HOST_DIR=D:/PRT-backups/daily
```

复制完整最新源码后，现有卷部署仍运行原更新脚本；脚本会自动添加 `compose.daily-backup.yaml`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:\PRT-demo-hub-test\scripts\update-docker.ps1' -ProjectDirectory 'J:\PRT-demo-hub-test' -BackupDirectory 'J:\PRT-backups'
```

手动使用 Compose 时，在原有部署文件之后加 `-f compose.daily-backup.yaml`。保留原数据挂载和 Compose 项目名；灾难恢复实例使用其专用 `compose.recovery.yaml`，不能换成旧数据卷配置。更新脚本会识别恢复实例的主机目录挂载并核对源路径一致。Ubuntu 将 `DAILY_BACKUP_HOST_DIR` 设为主机绝对目录并确保容器 node 用户可写。

## 检查结果

管理员在“平台设置”可查看最近完整备份、下一次执行时间、备份错误和超过 26 小时未成功的提示。

```powershell
Get-Content 'D:\PRT-backups\daily\latest\manifest.json' -Raw | ConvertFrom-Json | Select-Object at,kind,files,bytes,includesDeploymentConfig
docker logs --tail 100 prt-datahub-production
```

正常完成时 `kind` 为 `daily-full`，`includesDeploymentConfig` 为 `true`。新备份先写 `pending-*`，校验数据库、外键、每个已登记文件的 SHA256、源码及配置后才替换 `latest`，成功后删除旧版。轮换时需要同时容纳两份数据；空间不足保留上次 `latest`。进程中断可能暂留 `pending-*` 或 `previous`，下次运行会处理，不把半份备份当作成功版本。历史人工备份、灾难抢救数据不会自动删除。

主机休眠、Docker 未运行或平台停止时无法准点备份，恢复运行后补执行。平台只保留一份自动备份，不能回退到更早日期。

## 恢复

停止应用写入，用 `scripts/restore.mjs` 从 `latest` 恢复到一个不存在的新数据目录，不能覆盖运行库。脚本验证数据库、全部已登记文件、额外文件、源码及配置清单，再恢复业务数据和额外数据。`source/` 是对应源码，`deployment/` 是对应配置；配置单独复制回项目目录。恢复目录用于新服务的数据挂载，验收通过后开放访问。不要把含密钥的备份放进代码仓库。
