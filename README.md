# PTN AI Coding Agent

实训平台内置 VS Code 中的 AI 编程 Agent 扩展。

学生用自然语言描述任务，Agent 自己查看代码、修改文件、运行命令并验证结果，直到任务完成。每一次文件修改都先在 VS Code 原生 Diff 中让学生审核，命令执行前需要确认，改错了可以一键撤销。学生可自行配置模型供应商、API 地址、模型名称与 API Key。

## Agent 能力

Agent 基于内置的 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK，由模型驱动「推理 → 调用工具 → 观察结果 → 再推理」的多步循环。

| 工具 | 作用 | 是否需要学生确认 |
| --- | --- | --- |
| `read` / `grep` / `find` / `ls` | 查看文件、搜索代码、列目录 | 否（限工作区内） |
| `edit` | 对已有文件做局部修改 | 是，先弹出 Diff |
| `write` | 新建文件或整体重写 | 是，先弹出 Diff |
| `bash` | 运行测试、构建等命令 | 是（白名单命令可免确认） |
| `get_diagnostics` | 读取 VS Code 问题面板中的错误和警告 | 否 |
| `update_plan` | 展示多步任务的计划与进度 | 否 |

典型流程：学生说「给 UserService 加参数校验并补测试」→ Agent 列出计划 → 读相关代码 → 修改（学生在 Diff 中确认）→ 运行 `dotnet test` → 根据失败信息继续修复 → 总结改了什么、为什么。

### 审批模式

命令面板 `AI Agent: 切换审批模式`，或点击侧栏顶部的模式标签，或设置 `ptnAgent.approvalMode`：

| 模式 | 行为 |
| --- | --- |
| `ask`（默认，逐项确认） | 每次修改文件、运行命令都需要确认 |
| `autoEdit`（自动应用修改） | 工作区内的文件修改直接应用，仍可一键撤销；运行命令仍需确认 |
| `readOnly`（只读） | Agent 只能查看代码和诊断，不能修改文件或运行命令 |

审批卡片上的「本次会话全部允许」可在当前会话内自动放行后续的文件修改，新建会话后恢复。

### 安全边界

- **路径围栏**：所有工具只能访问工作区内的路径；会解析符号链接，工作区内的链接不能指向工作区外。
- **敏感文件**：`.env`、私钥、`.pem`、`.npmrc` 等不允许 Agent 读取（`.env.example` 除外）；`.git` 目录不允许写入。
- **Diff 审核**：`edit` / `write` 先在编辑器里打开 Diff，通过后才写入；被拒绝时 Agent 会收到提示并改变方案。
- **未保存保护**：文件在编辑器里有未保存的修改时，Agent 不会覆盖它。
- **命令分级**：高危命令（`rm -rf`、`sudo`、`git reset --hard`、`git clean -f`、`find -delete`、管道执行脚本等）一律拦截；命中白名单且不含 `; & | < > $ ( ) 反引号 换行` 的命令才可免确认。
- **超时与步数**：单条命令默认 120 秒超时；单次任务默认最长 600 秒、最多 40 轮推理。
- **隔离**：Pi 的配置、凭据、项目 `.pi` 资源一律不读取，全部使用扩展自己的存储目录；API Key 只保存在 VS Code SecretStorage，不写入任何配置文件；已关闭 Pi 的安装遥测。

> `bash` 的限制：命令在工作区目录下执行，但 shell 本身无法被限制在工作区内，也无法被一键撤销；因此命令始终需要确认（白名单除外）。修改文件优先通过 `edit` / `write`，它们才有撤销快照。

### 撤销

每次任务结束后，侧栏会汇总「本次修改了 N 个文件」，点击「撤销本次修改」即可恢复；也可用命令 `AI Agent: 撤销上次 AI 修改`。保留最近 10 次任务的快照；超过 1 MB 的文件不保存快照，撤销时会提示。

## 对话与上下文

- 活动栏入口、侧栏对话、右键菜单、快捷键
- 每条消息自动附带当前文件、选区、光标、语言、诊断、Git 分支、终端输出（带敏感信息脱敏）
- 项目类问题自动附带项目结构摘要
- 可随时查看「下一条消息将发送什么」（`AI Agent: 查看当前上下文`）
- 多轮会话，窗口重启后恢复；对话过长时 Pi 会自动压缩历史
- 快捷操作：解释代码、分析错误、**修复问题**、生成测试、运行测试、项目结构、重构

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
code --install-extension ptn-agent-0.2.0.vsix
```

安装包约 26 MB，已包含 Pi 运行依赖。

## 配置

命令面板执行 `AI Agent: 模型设置`，或在设置中搜索 `ptnAgent`。

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `ptnAgent.approvalMode` | 审批模式：`ask` / `autoEdit` / `readOnly` | `ask` |
| `ptnAgent.provider` | `deepseek` / `openai-compatible` / `ollama` | `deepseek` |
| `ptnAgent.baseUrl` | API 地址，含版本路径 | `https://api.deepseek.com/v1` |
| `ptnAgent.model` | 模型名称，需支持工具调用（function calling） | `deepseek-chat` |
| `ptnAgent.contextWindow` | 模型上下文窗口（token），用于自动压缩 | `128000` |
| `ptnAgent.maxOutputTokens` | 单次回复最大输出 token | `8192` |
| `ptnAgent.runTimeoutMs` | 单次任务最长运行时间 | `600000` |
| `ptnAgent.commandTimeoutMs` | 单条命令超时 | `120000` |
| `ptnAgent.allowedCommands` | 可免确认执行的命令前缀，如 `npm test` | `[]` |
| `ptnAgent.maxContextLines` | 单次附带的最大代码行数 | `400` |
| `ptnAgent.autoContext` | 自动附带当前文件与选区 | `true` |
| `ptnAgent.includeProjectContext` | 项目类问题附带结构摘要 | `true` |
| `ptnAgent.platformUrl` | 实训平台地址，留空不连接 | 空 |
| `ptnAgent.systemPromptExtra` | 追加课程规范到系统提示词 | 空 |

API Key 与平台令牌通过 `AI Agent: 模型设置` 写入 SecretStorage。

**模型要求**：Agent 依赖模型的工具调用能力。DeepSeek、GPT-4 系列、Qwen2.5-Coder 及以上等支持 function calling 的模型可用；不支持工具调用的模型只能对话，无法完成多步任务。Provider 目前按 OpenAI-compatible Chat Completions 接口接入。

## 命令

| 命令 | 快捷键 |
| --- | --- |
| `AI Agent: 打开对话` | `Ctrl+Alt+I` |
| `AI Agent: 解释选中代码` | `Ctrl+Alt+E` |
| `AI Agent: 分析当前错误` | — |
| `AI Agent: 修复当前问题` | — |
| `AI Agent: 生成单元测试` | — |
| `AI Agent: 理解项目结构` | — |
| `AI Agent: 重构选中代码` | — |
| `AI Agent: 切换审批模式` | — |
| `AI Agent: 撤销上次 AI 修改` | — |
| `AI Agent: 定位问题` | — |
| `AI Agent: 运行测试或构建` / `运行命令` | — |
| `AI Agent: 查看当前上下文` / `查看项目结构摘要` | — |
| `AI Agent: 刷新平台上下文` | — |
| `AI Agent: 模型设置` / `测试模型连接` / `检查 Agent 运行环境` | — |

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

也接受 `{ "context": { ... } }` 或 `{ "course": { "title": "...", "id": "..." } }` 形式。请求失败或超时会回退到缓存，再失败则按本地模式继续，不影响对话。平台上下文会随每条消息一起发给 Agent。

> 平台对接目前只有扩展侧；后端接口、身份绑定、统一模型网关和审计上报尚未实现。

## 目录结构

```text
ptn-agent/
├── src/
│   ├── extension.ts           命令注册与激活
│   ├── chatView.ts            侧栏对话、审批卡片、事件转发（Agent 的 VS Code 宿主）
│   ├── agent/
│   │   ├── piAgent.ts         Agent 核心：Pi 会话、tool_call 拦截、自定义工具
│   │   ├── policy.ts          路径围栏、敏感文件、edit 预览（纯逻辑，可单测）
│   │   ├── toolLabels.ts      工具调用的面向学生的说明
│   │   ├── types.ts           AgentHost 等接口
│   │   └── session.ts         多轮会话文本与持久化
│   ├── changeTracker.ts       撤销快照
│   ├── diffPreview.ts         Diff 预览（虚拟文档）
│   ├── contextCollector.ts    IDE 上下文采集与脱敏
│   ├── project/outline.ts     项目结构摘要
│   ├── platform/client.ts     平台上下文与缓存
│   ├── tools/commandRunner.ts 高危命令规则、白名单、命令分级
│   ├── prompts.ts             系统提示词
│   ├── modelCheck.ts          连接测试、错误友好化
│   ├── config.ts / secrets.ts / webviewHtml.ts
├── media/                     侧栏前端（chat.js / chat.css）
└── scripts/                   自检脚本
```

Agent 核心不依赖 `vscode`：它通过 `AgentHost` 接口向宿主要审批、快照、诊断，因此可以在 Node 中用假模型服务做端到端测试。

## 自检

```bash
npm run compile
npm run check
```

| 脚本 | 覆盖 |
| --- | --- |
| `check-policy.js` | edit 预览（唯一匹配、重叠、CRLF、BOM）、路径围栏、符号链接逃逸、敏感文件 |
| `check-commands.js` | 高危规则、白名单词边界、shell 元字符、命令分级 |
| `check-undo.js` | 快照批次、同文件只存首次、新建文件删除、超大文件、批次上限 |
| `check-session.js` / `check-platform.js` | 会话裁剪与持久化、平台客户端与降级 |
| `check-pi-custom-provider.js` | 自定义 Base URL / 模型 / Bearer Key 注入，Key 不落盘 |
| `check-agent.js` | 真实 Pi SDK + 脚本化假模型：多步工具链、拦截与审批、只读/自动模式、未保存保护、停止、接口报错 |
| `check-chat.js` | 侧栏消息协议顺序、审批往返、原生弹窗降级、停止、撤销 |
| `smoke.js` | 扩展激活与命令注册 |

## 已知限制

- Pi SDK 需要 Node.js ≥ 22.19；在 code-server 中运行时取决于 code-server 自带的 Node 版本，可用 `AI Agent: 检查 Agent 运行环境` 查看。
- 目前只验证过 OpenAI-compatible 的 Chat Completions；Anthropic / Responses 等协议需要增加 Pi Provider 配置。
- `bash` 无法限制在工作区内、无法撤销（见上）。
- 终端输出读取依赖 Shell Integration，未启用时自动跳过。
- 修改后 `get_diagnostics` 依赖语言服务，更新可能有短暂延迟。
- 未实现账号级统一配额与审计上报（待平台接口确定）。
