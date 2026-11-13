# PTN AI Coding Agent

实训平台内置 VS Code 中的 AI 编程学习与开发助手扩展。

学生在编辑器内即可获得代码解释、错误分析、测试生成、重构建议和代码修改预览，并可自行配置模型供应商、API 地址、模型名称与 API Key。扩展同时可与实训平台对接，自动带入课程与项目上下文。

## 功能

### 对话与上下文

- 活动栏入口、侧栏对话、右键菜单、快捷键，完全使用 VS Code 原生交互
- 自动附带当前文件、选区、光标、语言、诊断、Git 分支、终端输出
- 敏感信息自动脱敏（`api_key=`、`password:`、私钥块等）
- 会话多轮上下文，按字符预算自动裁剪，工作区重启后恢复
- 可随时查看“下一条消息将发送什么”的上下文预览

### Agent 基座

- **双 Agent 基座**：直连模型接口（Native）或内置 Pi Agent（SDK）
- **Pi 自定义 Provider**：学生配置的 Provider、Base URL、模型和 API Key 会同步生成 Pi 专属 `models.json`，Pi SDK 不再依赖 Pi 自己预置的模型目录
- **Pi RPC 备用传输**：支持启动 `pi --mode rpc` 子进程，适合调试、隔离和平台环境
- Pi 默认只开放 `read`、`grep`、`find`、`ls`，不让 Pi 直接写文件或执行命令
- Pi 的修改建议仍通过扩展的 `ptn-patch` 协议和 VS Code Diff 审核
- 命令面板执行 `AI Agent: 切换 Agent 基座` 或设置 `ptnAgent.agentBackend=pi`

### 代码能力

- 解释代码、分析错误、生成测试、理解项目结构、重构建议
- 项目结构摘要：顶层目录、文件数、技术栈线索、关键文件
- 修改以补丁形式返回，先预览、后确认，支持批量与逐个审核
- 支持撤销上次 AI 修改（保留最近 5 批快照）

### 调试与命令

- 定位问题：汇总工作区诊断，一键跳转到具体行
- 受控命令执行：高危命令拦截 + 强制二次确认 + 超时限制
- 自动识别技术栈并推荐测试/构建命令（npm / dotnet / mvn / gradle / pytest / go）

### 模型与安全

- DeepSeek、OpenAI 兼容接口、Ollama；Base URL 与模型名可改
- API Key 与平台令牌保存在 VS Code SecretStorage
- 命令白名单可配置；白名单也不会跳过硬性确认

## 安装

### 开发模式

```bash
npm install
npm run compile
```

在 VS Code 中打开本目录，按 `F5` 启动扩展开发宿主。

### 打包安装

```bash
npm install -g @vscode/vsce
npm run package
code --install-extension ptn-agent-0.1.0.vsix
```

已生成的安装包：`ptn-agent-0.1.0.vsix`（约 26 MB，已包含 Pi 运行依赖）。

## 配置

命令面板执行 `AI Agent: 模型设置`，或在设置中搜索 `ptnAgent`。

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `ptnAgent.provider` | `deepseek` / `openai-compatible` / `ollama` | `deepseek` |
| `ptnAgent.agentBackend` | `native` / `pi` | `native` |
| `ptnAgent.piTransport` | `sdk` / `rpc`，Pi 接入方式 | `sdk` |
| `ptnAgent.piCommand` | RPC 模式的 Pi 可执行文件 | `pi` |
| `ptnAgent.piExtraArgs` | RPC 进程额外参数 | `[]` |
| `ptnAgent.piTimeoutMs` | Pi 单次运行超时 | `180000` |

| `ptnAgent.baseUrl` | API 地址，含版本路径 | `https://api.deepseek.com/v1` |
| `ptnAgent.model` | 模型名称 | `deepseek-chat` |
| `ptnAgent.temperature` | 采样温度 | `0.2` |
| `ptnAgent.maxContextLines` | 单次发送最大代码行数 | `400` |
| `ptnAgent.autoContext` | 自动附带当前文件与选区 | `true` |
| `ptnAgent.includeProjectContext` | 项目类问题附带结构摘要 | `true` |
| `ptnAgent.requireDiffApproval` | 修改必须经确认 | `true` |
| `ptnAgent.platformUrl` | 实训平台地址，留空不连接 | 空 |
| `ptnAgent.allowedCommands` | 命令白名单前缀 | `[]` |
| `ptnAgent.commandTimeoutMs` | 命令超时 | `120000` |
| `ptnAgent.systemPromptExtra` | 追加课程规范到系统提示词 | 空 |

API Key 与平台令牌通过命令面板 `AI Agent: 模型设置` 写入 SecretStorage，不落磁盘配置文件。

## 命令

| 命令 | 快捷键 |
| --- | --- |
| `AI Agent: 打开对话` | `Ctrl+Alt+I` |
| `AI Agent: 解释选中代码` | `Ctrl+Alt+E` |
| `AI Agent: 分析当前错误` | — |
| `AI Agent: 生成单元测试` | — |
| `AI Agent: 理解项目结构` | — |
| `AI Agent: 重构选中代码` | — |
| `AI Agent: 定位问题` | — |
| `AI Agent: 运行测试或构建` | — |
| `AI Agent: 运行命令` | — |
| `AI Agent: 撤销上次 AI 修改` | — |
| `AI Agent: 查看当前上下文` | — |
| `AI Agent: 查看项目结构摘要` | — |
| `AI Agent: 刷新平台上下文` | — |
| `AI Agent: 模型设置` | — |
| `AI Agent: 测试模型连接` | — |

## 模型输出协议

### 修改已有文件

````text
```ptn-patch
file: src/UserService.cs
<<<<<<< SEARCH
原始代码，必须与文件中内容一致
=======
替换后的代码
>>>>>>> REPLACE
```
````

`SEARCH` 片段先精确匹配，失败后退化为按行 trim 匹配，仍失败则跳过并提示。一次回复可包含多个补丁块。

### 新建文件

````text
```ptn-newfile
file: src/NewService.cs
// 完整文件内容
```
````

### 提议执行命令

````text
```ptn-run
npm test
```
````

扩展会弹出确认对话框；高危命令（`rm -rf`、`drop database`、`docker system prune`、`curl | sh` 等）直接拦截。

## 平台上下文契约

`GET {platformUrl}/api/agent/context?workspace=<name>`，可选 `Authorization: Bearer <token>`。

```json
{
  "courseTitle": "C# Web API 实训",
  "projectName": "user-service",
  "stage": "实现阶段",
  "goals": ["掌握参数校验"],
  "guidelines": ["使用 ASP.NET Core 约定"],
  "knowledge": ["ModelState 的作用"],
  "allowedCommands": ["dotnet build"]
}
```

也接受 `{ "context": { ... } }` 或 `{ "course": { "title": "...", "id": "..." } }` 形式。请求失败或超时会回退到缓存，再失败则按本地模式继续，不影响对话。

## 目录结构

```text
ptn-agent/
├── src/
│   ├── extension.ts           命令注册与激活
│   ├── chatView.ts            侧栏对话主流程
│   ├── provider.ts            OpenAI 兼容流式调用
│   ├── agent/
│   │   ├── types.ts           AgentAdapter 接口
│   │   ├── nativeAdapter.ts   直连实现 + 错误友好化
│   │   └── session.ts         多轮会话与持久化
│   ├── contextCollector.ts    IDE 上下文采集与脱敏
│   ├── project/outline.ts     项目结构摘要
│   ├── platform/client.ts     平台上下文与缓存
│   ├── tools/commandRunner.ts 受控命令执行
│   ├── patch.ts               补丁解析与定位
│   ├── patchReview.ts         批量 Diff 审核与撤销
│   ├── prompts.ts             系统提示词
│   ├── config.ts              配置读取
│   ├── secrets.ts             SecretStorage
│   └── webviewHtml.ts         侧栏 HTML
├── media/                     前端资源
└── scripts/                   8 个自检脚本
```

## 自检

```bash
npm run compile
npm run check
```

覆盖：补丁解析、补丁定位（精确 + 模糊）、命令安全、会话裁剪、平台客户端、撤销快照、SSE 流式、Pi SDK、Pi RPC、扩展激活。

## 已知限制

- Pi SDK 需要 Node.js >= 22.19.0（当前包版本依赖要求）；不满足时可切换 RPC
- Pi 自定义 Provider 当前按 OpenAI-compatible Chat Completions 接口生成配置；非该协议需增加 Pi Provider 扩展
- Pi 默认只读，不能自主写文件或执行命令；修改仍使用扩展 Diff 流程
- 终端输出读取依赖 Shell Integration，未启用时自动跳过
- 命令执行为一次性执行，不提供交互式终端
- 未实现账号级统一配额与审计上报（待平台接口确定）

## 后续规划

参考 `../docs/development-plan.md`。
