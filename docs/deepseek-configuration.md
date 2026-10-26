# DeepSeek 官方 Pro 模型配置与更新

数据说明生成和智能检索统一使用 DeepSeek 官方高级模型 `deepseek-v4-pro`，通过官方 OpenAI 兼容接口直接调用。模型名和官方地址按 2026-10-19 的[官方模型列表](https://api-docs.deepseek.com/quick_start/pricing)核对；无需安装 Agent 软件。

## 配置

Windows Docker 在 `J:\PRT-demo-hub-test\.env` 修改以下配置，同名配置只保留一行。Key 从 [DeepSeek 官方平台](https://platform.deepseek.com/)获取，不要使用阿里云签发的 Key，也不要粘贴到聊天或提交到代码库。

```dotenv
DEEPSEEK_API_KEY=填写DeepSeek官方平台签发的Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_ENABLE_THINKING=false

RAG_LLM_MAX_TOKENS=
RAG_LLM_REQUEST_TIMEOUT_MS=90000
DESCRIPTION_AGENT_MAX_TOKENS=
DESCRIPTION_AGENT_TIMEOUT_MS=180000
DESCRIPTION_AGENT_REQUEST_TIMEOUT_MS=90000
```

两处 AI 功能共用以上 Key、地址、模型及思考开关。请求地址为 `https://api.deepseek.com/chat/completions`，协议固定为 OpenAI 兼容格式；代码发送 `thinking: {"type":"disabled"}`，避免供应商默认开启思考而占用输出额度。`deepseek-v4-pro` 本身是 Pro 型号，关闭思考不会切换到 Flash 型号。

删除旧的 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`RAG_LLM_MODEL`、`DESCRIPTION_AGENT_API_KEY`、`DESCRIPTION_AGENT_BASE_URL`、`DESCRIPTION_AGENT_MODEL`、`DESCRIPTION_AGENT_ENABLE_THINKING`、`DESCRIPTION_AGENT_TRANSPORT`、`DESCRIPTION_AGENT_API_FORMAT`、`DESCRIPTION_AGENT_COMMAND`。新版本不读取这些连接配置，防止两处功能误用不同供应商或继续开启旧的思考设置。原生 Node.js 部署把同样配置写到 `.env.host`。

未设置 `DEEPSEEK_API_KEY` 时，智能检索回退本地搜索，数据说明生成提示配置缺失。

默认不设置应用侧的输出 token 上限：两个 `MAX_TOKENS` 变量删除或留空时，请求中省略 `max_tokens`，Docker 也不再补入 4096 或 8192。模型服务自身的默认输出额度和上下文限制仍生效，省略参数并不代表无限输出，也不代表自动使用模型支持的最大额度。请求超时限制继续生效；说明生成仍拒绝保存截断结果，检索截断时回退本地检索。

后续需要控制输出费用时，可在 `.env` 设置以下示例值，按实际需要调整；留空可再次取消应用侧限制，不要填 `0`。配置值须为 `1024`～`32768` 的整数，且符合实际模型限制。额度是每次模型请求的输出上限，不是账户余额或整次任务费用上限，智能检索可能调用模型多轮。

```dotenv
RAG_LLM_MAX_TOKENS=4096
DESCRIPTION_AGENT_MAX_TOKENS=8192
```

首次更新需同步最新源码和 Compose 并重新构建镜像；旧 Compose 会继续注入原默认上限。更新完成后，单独调整 `.env` 的额度只需重建容器使环境变量生效，不能仅执行 `restart`。

## 更新当前 Windows Docker 实例

将最新源码同步到 `J:\PRT-demo-hub-test`，保留 Windows 的 `.env` 和数据。至少需要新的 `src/Requirements.jsx`、`src/requirement-documents.mjs`、`src/requirements.css`、`server/model-config.mjs`、`server/app.mjs`、`server/rag.mjs`、`server/description-agent.mjs`、`scripts/check-description-agent.mjs`、`Dockerfile`、`compose.production.yaml` 和 `compose.keep-data.yaml`；推荐同步完整源码，排除 `node_modules`、`dist`、数据目录和 `.env`。

按 [Docker 手册的备份步骤](windows-docker-guide.md#更新当前已运行的容器并保留旧数据)备份当前实例后，在同一个 PowerShell 窗口执行：

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'J:\PRT-demo-hub-test'
$prtUpdate = @('-f', 'compose.production.yaml', '-f', 'compose.keep-data.yaml')
docker compose @prtUpdate config --quiet
if ($LASTEXITCODE -ne 0) { throw '配置检查失败' }
docker compose @prtUpdate build
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败' }
docker compose @prtUpdate up -d --no-build --force-recreate --wait app
if ($LASTEXITCODE -ne 0) { throw '容器启动失败，请查看日志' }
Invoke-RestMethod 'http://127.0.0.1:8001/api/health'
```

有前后端代码修改，必须重新构建镜像并重建容器。不要仅执行 `restart`；不要使用 `compose.windows-test.yaml` 切换到另一组卷，不要执行 `down -v` 或删除数据卷。

## 自检与验收

使用合成 CSV 和合成 Demo 同时自检数据说明、检索和工具调用，不读取业务数据，不修改数据库，也不打印 Key。此命令实际调用官方付费接口：

```powershell
docker exec prt-datahub-production node scripts/check-description-agent.mjs --all
```

应看到：

```text
模型：deepseek-v4-pro
调用方式：api；HTTP 协议：openai
HTTP 地址：https://api.deepseek.com/chat/completions
思考模式：false
输出额度：未设置（不发送 max_tokens，使用模型服务默认值）
自检成功，……
智能检索输出额度：未设置（不发送 max_tokens，使用模型服务默认值）
智能检索自检成功，模型 deepseek-v4-pro，……
```

仅自检说明生成可去掉 `--all`。实际付费接口仍需在部署机使用自己的有效 Key 验证；本地自动化测试使用模拟接口。

如果仍显示旧模型或 `思考模式：true`，检查是否同步新代码和 Compose、重建了正确容器；检查 `.env` 重复行以及 PowerShell 中同名 `DEEPSEEK_*` 环境变量覆盖。HTTP 401/403 检查官方 Key 和账号权限，402 检查账户余额，404 检查模型及地址。检索失败会显示本地结果及模型错误，不应把本地回退当成模型调用成功。

页面在 `http://192.168.110.25:8001` 按 `Ctrl+F5` 后验收：先选两份需求文档，再点击添加第三份，待上传列表应显示三份；移除一份后保存，详情应保留其余两份并分别可下载。最后分别测试小 CSV 的 AI 数据说明和一次智能检索。
