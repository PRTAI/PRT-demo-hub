# 本机飞书登录联调

网页入口已保存为 http://127.0.0.1:8080 ，重定向 URL 已登记为 http://127.0.0.1:8080/api/auth/callback 。应用已由用户发布启用，已完成真实飞书授权及回调验证。

独立配置 compose.feishu-local.yaml 关闭演示登录，只发布本机回环端口，使用独立数据和备份卷。现有演示卷保留。正式部署仍须使用 HTTPS 生产配置。

在本地 .env.feishu-local 填写 FEISHU_APP_SECRET 和 FEISHU_TENANT_KEY。App ID 已填，密钥文件已由 Git 和 Docker 构建排除。不要把密钥发到聊天中。

完成应用所需权限、测试可用范围及发布审核后，由维护人员切换容器：

```powershell
docker compose stop app
docker compose --env-file .env.feishu-local -f compose.feishu-local.yaml up -d --build --wait
```

首次登录默认待授权。指定管理员登录后取得平台用户编号，再初始化首位管理员：

```powershell
docker compose --env-file .env.feishu-local -f compose.feishu-local.yaml exec app node scripts/admin.mjs <平台用户编号>
```

需要恢复原演示环境时：

```powershell
docker compose --env-file .env.feishu-local -f compose.feishu-local.yaml stop app
docker compose start app
```

应用凭据和企业信息接口已真实验证，企业标识已写入本地配置。联调容器 prt-datahub-login 已启动并通过健康检查；原演示容器已停止，演示数据卷保留。登录接口返回正确的飞书授权跳转，浏览器已显示首次授权页面，仅请求获取用户身份标识。已完成真实授权回调，刘昊霖已初始化为首位管理员，页面验证进入人员与权限工作台。切勿执行删除数据卷的命令。


## 局域网监听调整

按用户要求，compose.feishu-local.yaml 已发布到 0.0.0.0:8080；PRT_APP_ORIGIN 已配置为 http://192.168.110.54:8080，飞书后台已新增该地址的 /api/auth/callback 重定向 URL。数据卷及管理员保持。

Docker 健康检查正常，但本机通过局域网 IP 的直连检查超时，Windows 未显示对应监听端口。当前进程没有管理员权限，已准备 scripts/enable-lan.ps1，在管理员 PowerShell 中执行，创建仅当前 LAN 地址的端口转发和仅 LocalSubnet 的 TCP 8080 入站规则，然后检查健康接口。此脚本尚未执行，局域网可用性尚未验证。飞书网页应用主页暂保留旧的本机入口，待局域网联通后更新。

Docker 的全网卡监听与本地 HTTP 配置用于本次局域网联调；原先仅回环访问的说明适用于更早阶段。地址变化后应使用新的访问地址重新登录；企业正式部署仍采用 HTTPS。


## 回调连接超时修复

局域网转发尚未配置时提前切换 APP_ORIGIN，会让 OAuth 返回不可达的局域网地址。已将运行配置恢复到 http://127.0.0.1:8080 并重建容器，健康检查及授权重定向验证通过；Docker 继续发布 0.0.0.0:8080。待管理员运行 enable-lan.ps1 且通过 LAN 健康检查后，再切换 PRT_APP_ORIGIN 和飞书网页入口。不要刷新失败页的一次性授权码，应从主页重新登录。
