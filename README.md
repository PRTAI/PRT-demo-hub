# PRT 数据样例管理平台

面向企业内部员工、主管和产品经理的 Demo 文件管理平台，支持飞书登录、数据说明、版本管理和主管审核发布。

当前版本：1.1.0。正式飞书环境已部署到 Windows 宿主机，访问 http://192.168.110.54:8080 。原 Docker 容器已停止，原数据卷保留。当前启停、日志和备份操作见 [宿主机部署说明](docs/host-deployment.md)。

- [第一版产品需求文档](docs/requirements-v1.md)：业务范围、角色权限、流程、数据对象、页面及验收标准。
- [操作手册](docs/user-manual.md)：各角色上手、需求与 Demo 绑定、AI 说明、审核发布、飞书通知、管理维护和部署验收。
- [Windows Docker 简明部署手册](docs/windows-docker-guide.md)：在 `J:\PRT-demo-hub-test` 编译部署、迁移旧容器数据、验证和维护。
- [DeepSeek 官方 Pro 配置](docs/deepseek-configuration.md)：数据说明和智能检索统一使用 `deepseek-v4-pro`，包含旧配置迁移及双功能自检。
- [现有 Windows 服务更新步骤](docs/host-deployment.md#版本更新)：备份、同步代码、构建、重启、检查和回退。
- [Windows 新目录全新部署](docs/fresh-windows-deployment.md)：针对 `192.168.110.25:8081` 的独立目录、空数据、飞书配置和管理员初始化步骤。
- [Windows 恢复旧数据并更新部署](docs/restore-windows-deployment.md)：从 `D:\PRT-demo-hub` 校验备份、恢复到新目录，保留原账号和权限并上线新版本。
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
- [需求中心与 Demo 绑定](docs/requirements.md)：产品经理和商务发布需求，Demo 支持多需求绑定，提交或发布前必须关联需求；发布后自动飞书通知全部产品经理及关联需求的商务发布人。
- 文件上传与下载、结构化数据说明、草稿与完整版本历史。
- 需求文档支持多选、分次累加和移除待上传文件；数据说明生成与智能检索共用 DeepSeek 官方 Pro 模型。
- [需求日期、负责人、通知与日历](docs/requirements-calendar-update.md)：区分发布日期与截止日期、商务与研发负责人，两组均支持可选多选；新需求通知负责人和发布人，自动创建飞书日程并邀请，成功后发送可打开日程的机器人卡片，支持失败重试和保留数据更新部署。
- [需求飞书文档、排序与 Excel 导出](docs/requirements-export-update.md)：发布时在 sample 同目录新建需求协作文档，关联 Demo 上传并保存后自动同步数据概述、数据格式、成本预估、难度说明及注意事项，保留其他人工区块；按截止日期排序，仅项目经理可按页面筛选补建历史文档、同步内容并导出截止日期、Demo 名称、关联人员及文档链接，支持进度和失败重试。
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

## 提交到 GitHub

提交源码、测试、`package-lock.json`、配置模板、Compose 文件、部署脚本及 `docs/` 文档。首次配置时将 `.env.example` 复制为 `.env`，只在本机填写凭据。

`node_modules/`、`dist/`、真实 `.env`、数据库、上传数据、备份和日志由忽略规则排除。测试目录中的小型 ZIP／CSV 样例是自动测试所需文件，应保留。不要把生产平台的数据卷或导出的 Demo 数据复制进源码仓库。

提交前执行 `npm test`、`npm run build` 和 `git diff --check`，再用 `git status --short` 核对变更。构建生成的 `dist/` 无需提交，Docker 构建时会重新生成。
