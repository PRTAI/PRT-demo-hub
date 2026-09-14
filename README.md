# PRT 数据样例管理平台

面向企业内部员工、主管和产品经理的 Demo 文件管理平台，支持飞书登录、数据说明、版本管理和主管审核发布。

当前版本：1.1.0。正式飞书环境已部署到 Windows 宿主机，访问 http://192.168.110.54:8080 。原 Docker 容器已停止，原数据卷保留。当前启停、日志和备份操作见 [宿主机部署说明](docs/host-deployment.md)。

- [第一版产品需求文档](docs/requirements-v1.md)：业务范围、角色权限、流程、数据对象、页面及验收标准。
- [运行与部署说明](docs/deployment.md)：本地体验、飞书配置、正式运行、管理员初始化、备份恢复及已知边界。

## Docker 启动（推荐）

只需要 Docker Desktop / Docker Engine 与 Compose。

```powershell
docker compose up -d --build --wait
```

打开 http://127.0.0.1:8080 。容器名 `prt-datahub`，一个容器包含前端静态页面、API 与 SQLite。上传文件和数据库存入独立数据卷，备份存入另一个卷，重启或重建容器保留数据。默认仅本机可访问，提供合成数据和角色体验。

```powershell
docker compose ps
docker compose logs --tail 100
docker compose restart
docker compose stop
```

正式环境使用独立的 `compose.production.yaml`，需要 HTTPS 入口和飞书凭据，详见部署文档。不要将体验登录开放到企业网络。

## 本地开发

需要 Node.js 24 和 npm。

```powershell
npm ci
npm run dev
```

打开 http://127.0.0.1:5173，选择演示身份即可体验。使用 `.preview-data/` 保存演示数据；正式数据目录与演示目录隔离。

## 已实现

- 飞书 OAuth 登录、待授权、角色配置与主管关系管理。
- 文件上传与下载、结构化数据说明、草稿与完整版本历史。
- 员工提交、撤回、退回重提、主管修改审核与直接发布。
- 下架和恢复、默认版本选择、版本差异、提交快照与操作记录。
- 员工自有数据、主管团队数据、产品经理全量只读的后端权限控制。
- 人员启停、资产交接、分类与上传限制、存储及备份状态。
- SQLite 持久化、本地磁盘文件保存、管理员手动备份及恢复脚本。
- 权限范围内的服务端分页、关键词/分类/归属人/更新时间筛选和排序。
- 编辑冲突恢复、会话过期处理、分享详情链接、运行状态与飞书配置检查。

## 验证

```powershell
npm test
npm run build
```

## 项目结构

```text
src/                  React 中文工作台
server/               API、权限、飞书登录、SQLite 与演示数据
scripts/              开发启动、管理员初始化、备份与恢复
tests/                权限和业务流程集成测试
docs/                 需求与部署文档
.env.example          正式配置示例，不包含密钥
Dockerfile            固定基础镜像、多阶段构建和健康检查
compose.yaml          本机体验：单容器、独立数据卷和备份卷
compose.production.yaml  企业正式环境：独立配置和数据卷
```

正式启用前需填写飞书 App ID、App Secret、企业 tenant_key 和实际 HTTPS 地址；详细步骤见部署说明。
