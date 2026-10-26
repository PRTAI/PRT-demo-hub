# 按原始名称导出 Demo 文件

导出脚本读取数据库中的原始文件名，将全部 Demo 的全部版本导出为“Demo 名称/V版本号/原始文件名”。同名 Demo 和同版本内的同名文件追加 `(2)` 等后缀，Windows 不支持的文件名字符替换为下划线。压缩包保持原样，不自动解压；本脚本不导出需求附件或修改现有文件、数据库。

将 `scripts/export-demo-files.mjs` 同步到 Windows 项目目录后，在 PowerShell 依次运行。脚本只依赖 Node 内置模块，可以直接复制到现有容器的可写备份数据卷运行，无需重建或重启服务。生产容器启用了只读根文件系统，`docker cp` 不应向 `/tmp` 复制脚本，请使用 `/app/backups`。

```powershell
Set-Location 'J:\PRT-demo-hub-test'
$ErrorActionPreference = 'Stop'
docker cp '.\scripts\export-demo-files.mjs' 'prt-datahub-production:/app/backups/export-demo-files.mjs'
if ($LASTEXITCODE -ne 0) { throw '复制导出脚本失败' }

$prtExportName = 'demo-export-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$prtExportPath = "/app/backups/$prtExportName"
docker exec prt-datahub-production node /app/backups/export-demo-files.mjs $prtExportPath
if ($LASTEXITCODE -ne 0) { throw '导出失败，停止复制，请查看上方报错' }

New-Item -ItemType Directory -Force -Path 'J:\PRT-demo-export' | Out-Null
docker cp "prt-datahub-production:${prtExportPath}" 'J:\PRT-demo-export'
if ($LASTEXITCODE -ne 0) { throw '导出成功，但复制到 Windows 失败' }
Write-Host "完成，请查看 J:\PRT-demo-export\$prtExportName"
```

每次使用新目录，避免覆盖。`export-manifest.json` 保存文件原名、导出路径、Demo、版本、文件 ID 和校验值的对应关系；仅在全部文件校验通过后生成。导出失败的目录可能留有部分文件，应换新目录重试。导出会同时占用容器备份卷和 Windows 目标目录空间。

这是一份方便阅读和使用的文件导出，不含可还原的平台数据库；平台迁移或灾备仍应使用完整备份。

## docker cp 出现 resolv.conf input/output error 时

如果导出已完成，但复制时 Docker 报 `chown .../resolv.conf: input/output error`，可以绕过该容器的 `docker cp`，用临时容器只读挂载已有备份卷，直接复制到 Windows 的绑定目录。保持原 PowerShell 窗口的 `$prtExportPath` 变量，执行：

```powershell
$ErrorActionPreference = 'Stop'
if ($prtExportPath -notmatch '^/app/backups/demo-export-[A-Za-z0-9-]+$') {
    throw '缺少有效的导出路径，请先恢复之前的 $prtExportPath 值'
}
$prtExportName = $prtExportPath.Substring('/app/backups/'.Length)
$prtCopyName = $prtExportName + '-copy-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
New-Item -ItemType Directory -Force -Path 'J:\PRT-demo-export' | Out-Null

docker volume inspect prt-datahub-production_production-backups
if ($LASTEXITCODE -ne 0) { throw '原备份数据卷不存在，请核对挂载，停止操作' }

$prtCopyCode = "const fs=require('node:fs');const path=require('node:path');const source=process.argv[1];const target=process.argv[2];if(!fs.existsSync(path.join(source,'export-manifest.json')))throw new Error('No completed export manifest found');if(fs.existsSync(target))throw new Error('Destination already exists');fs.cpSync(source,target,{recursive:true,force:false,errorOnExist:true});console.log('Copy completed: '+target);"
docker run --rm --network none --mount 'type=volume,source=prt-datahub-production_production-backups,target=/backups,readonly' --mount 'type=bind,source=J:\PRT-demo-export,target=/export' --entrypoint node prt-datahub:production -e $prtCopyCode "/backups/$prtExportName" "/export/$prtCopyName"
if ($LASTEXITCODE -ne 0) { throw '临时容器复制失败，请查看错误，不要删除原数据卷' }
Write-Host "完成，请查看 J:\PRT-demo-export\$prtCopyName"
```

临时容器使用本机已有镜像，备份卷只读挂载，复制到新的子目录以避开上次可能留下的部分文件。若临时容器也出现底层 I/O 错误，请保存命令和导出路径，在允许平台短暂停机时重启 Docker Desktop 后重试；不要清空 Docker 数据或恢复出厂设置。
