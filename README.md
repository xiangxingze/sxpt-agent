# SXPT AI Coding Agent

实训平台内置 VS Code 中的 AI 编程 Agent 扩展。

学生用自然语言描述任务，Agent 自己查看代码、修改文件、运行命令并验证结果，直到任务完成。每一次文件修改都先在 VS Code 原生 Diff 中让学生审核，命令执行前需要确认，改错了可以一键撤销。学生只需填写 API 地址、API Key 并选择模型即可使用。

默认界面采用 V4 统一面板：对话、新建会话、历史记录和表单设置都在同一个 VS Code 扩展视图内完成。Diff 使用 VS Code 原生编辑器；另保留原生终端备用对话，供无法加载 Webview 的环境使用。

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

在设置的高级选项中选择操作确认方式，或通过命令面板 `AI Agent: 切换审批模式`、配置项 `ptnAgent.approvalMode` 调整（备用终端支持 `/mode`）：

| 模式 | 行为 |
| --- | --- |
| `ask`（默认，逐项确认） | 每次修改文件、运行命令都需要确认 |
| `autoEdit`（自动应用修改） | 工作区内的文件修改直接应用，仍可一键撤销；运行命令仍需确认 |
| `readOnly`（只读） | Agent 只能查看代码和诊断，不能修改文件或运行命令 |

文件修改的审批里选择「允许，并且本次会话不再询问文件修改」可在当前会话内自动放行后续的文件修改，新建会话后恢复。

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

每次任务结束后，对话里会汇总本次修改的文件，可点击打开。点击输入框下方的「撤销上次修改」，或命令 `AI Agent: 撤销上次 AI 修改` 即可恢复；备用终端也支持 `/undo`。保留最近 10 次任务的快照；超过 1 MB 的文件不保存快照，撤销时会提示。

## 界面

### 统一 Agent 面板

`Ctrl+Alt+I` 或活动栏的 Agent 图标打开「对话」视图，布局参考 Codex 的 VS Code 扩展：

- 顶部只保留「新建会话」「历史记录」「设置」三个操作；对话页不展示历史会话列表。
- 对话居中展示欢迎提示或消息，底部固定圆角输入框、当前文件上下文和模型状态。
- 回答按 Markdown 流式展示，支持标题、列表、表格、代码块；工具步骤可展开，计划显示完成进度。
- 点击回答里的代码格式文件引用（如 `src/main.ts:12`）可以跳转到编辑器。
- 需要确认的操作显示「查看修改」「允许修改 / 允许运行」「暂不执行」；Diff 在原生编辑器中展示。
- 设置和历史记录在当前面板内平滑切换；返回对话时保留输入草稿和阅读位置，未保存的设置也保留。
- 任务运行中发送按钮变为停止按钮；任务结束后可以撤销文件修改。面板关闭后的待确认操作转为原生弹窗。

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| `Esc` | 从设置或历史返回对话 |

### 历史记录与备用入口

历史记录仅从顶部按钮或命令 `AI Agent: 历史会话` 进入。记录保存在当前工作区，最多保留 20 个会话，各会话最多保留 40 条消息并按 60000 字符预算裁剪（最后两条消息保留）。新建会话保留原会话；切换时恢复对话文本与草稿，不恢复旧工具步骤或旧任务执行。执行中切换会话会先停止并收尾当前任务，再进入目标会话。旧版本的单会话文本会自动迁移。

局域网 `http://<IP>` code-server 可能因浏览器安全上下文限制而无法注册 Webview 的 Service Worker。若主面板未完成加载，扩展在约 8 秒后提示打开备用入口，也可以直接执行 `AI Agent: 打开原生备用对话`。此入口保留终端对话、原生设置菜单、Diff 审批和撤销功能；`ptnAgent.chatLocation` 只控制备用终端的位置。备用终端支持 `/new`、`/settings`、`/model`、`/mode`、`/undo` 等斜杠命令。

状态栏显示当前模型和运行状态，点击打开主面板。

## 对话与上下文

- 入口：对话窗口、侧栏、编辑器右键菜单 `AI Agent` 子菜单、命令 `AI Agent: 输入任务…`（原生输入框，不必打开对话窗口）、快捷键
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
code --install-extension sxpt-agent-0.3.0.vsix
```

安装包约 26 MB，已包含 Pi 运行依赖。

## 配置

点击主面板顶部唯一的设置图标，或执行 `AI Agent: 打开设置`，在当前面板内打开表单。

| 分组 | 内容 |
| --- | --- |
| 模型服务 | **API 地址**、**API Key**、**模型**（从你填的 API 地址自动获取列表，也可手动输入）、测试连接 |
| 高级（默认折叠） | 操作确认方式、上下文窗口、单次最大输出、自动附带当前文件、免确认命令、自定义指令、清除 Key |

- **首次使用**在同一张表单填写 API 地址、API Key 和模型，可先「获取模型」「测试连接」再「保存设置」。获取和测试使用表单当前值，不提前保存；保存后返回对话。
- **没有预设供应商**：接入任何 OpenAI 兼容接口（DeepSeek、通义、OpenAI、Ollama、vLLM、公司内部网关……），模型列表来自 `GET {API 地址}/models`，缓存 10 分钟，可在列表里「重新获取」。接口不提供列表时，手动输入模型名即可。
- **API Key** 只保存在 VS Code SecretStorage，不回传已存 Key；输入框为空时保留原 Key。更换 API 地址时需要填写对应 Key，或在高级设置明确清除旧 Key 后使用无 Key 的本地模型。
- 命令「切换模型」「切换审批模式」在主面板统一进入此表单；备用终端保留原生菜单与逐步引导。

对应的 VS Code 配置项（搜索 `ptnAgent`）：

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `ptnAgent.baseUrl` | API 地址，含版本路径，如 `https://api.example.com/v1` | 空 |
| `ptnAgent.model` | 模型名称，需支持工具调用（function calling） | 空 |
| `ptnAgent.approvalMode` | `ask` / `autoEdit` / `readOnly` | `ask` |
| `ptnAgent.chatLocation` | 备用终端位置：`beside`（编辑器右侧）/ `panel`（底部面板），下次打开备用终端时生效 | `beside` |
| `ptnAgent.allowedCommands` | 可免确认执行的命令前缀，如 `npm test` | `[]` |
| `ptnAgent.contextWindow` | 模型上下文窗口（token），用于自动压缩 | `128000` |
| `ptnAgent.maxOutputTokens` | 单次回复最大输出 token | `8192` |
| `ptnAgent.autoContext` | 自动附带当前文件与选区 | `true` |
| `ptnAgent.systemPromptExtra` | 自定义指令，追加到系统提示词 | 空 |
| `ptnAgent.runTimeoutMs` | 单次任务最长运行时间 | `600000` |
| `ptnAgent.commandTimeoutMs` | 单条命令超时 | `120000` |
| `ptnAgent.maxContextLines` | 单次附带的最大代码行数 | `400` |
| `ptnAgent.includeProjectContext` | 项目类问题附带结构摘要 | `true` |
| `ptnAgent.platformUrl` | （管理员配置，学生无需填写）平台上下文接口地址 | 空 |

**模型要求**：Agent 依赖模型的工具调用能力。DeepSeek、GPT-4 系列、Qwen2.5-Coder 及以上等支持 function calling 的模型可用；不支持工具调用的模型只能对话，无法完成多步任务。接口目前按 OpenAI-compatible Chat Completions 接入。

## 命令

| 命令 | 快捷键 |
| --- | --- |
| `AI Agent: 打开对话` | `Ctrl+Alt+I` |
| `AI Agent: 输入任务…` | — |
| `AI Agent: 停止当前任务` | 对话窗口中 `Esc` |
| `AI Agent: 打开设置` / `切换模型` | — |
| `AI Agent: 新建对话` | — |
| `AI Agent: 历史会话` / `打开原生备用对话` | — |
| `AI Agent: 解释选中代码` | `Ctrl+Alt+E` |
| `AI Agent: 分析当前错误` / `修复当前问题` | — |
| `AI Agent: 生成单元测试` / `重构选中代码` / `理解项目结构` | — |
| `AI Agent: 切换审批模式` | — |
| `AI Agent: 撤销上次 AI 修改` | — |
| `AI Agent: 定位问题` | — |
| `AI Agent: 运行测试或构建` / `运行命令` | — |
| `AI Agent: 查看当前上下文` / `查看项目结构摘要` | — |
| `AI Agent: 检查 Agent 运行环境` | — |

## 平台上下文（管理员侧，学生不可见）

学生界面不提供任何实训平台地址或令牌的配置。平台对接由管理员在部署时配置 `ptnAgent.platformUrl`，扩展会请求：

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

也接受 `{ "context": { ... } }` 或 `{ "course": { "title": "...", "id": "..." } }` 形式。请求失败或超时会回退到缓存，再失败则按本地模式继续，不影响对话，也不会向学生弹出提示。上下文会随每条消息一起发给 Agent。

> 平台对接目前只有扩展侧：后端接口、身份绑定、令牌下发、统一模型网关和审计上报都尚未实现，暂缓处理。

## 目录结构

```text
ptn-agent/
├── src/
│   ├── extension.ts           命令注册与激活，组装对话窗口、侧栏、状态栏
│   ├── chatController.ts      Agent 的 VS Code 宿主：审批、Diff、上下文、快捷任务，向各界面广播消息
│   ├── ui/
│   │   ├── chatWebview.ts     V4 统一面板宿主：本地资源、消息桥接、备用入口提示
│   │   ├── chatTerminal.ts    备用对话：原生终端标签页（Pseudoterminal）、文件链接
│   │   ├── chatTui.ts         终端里的对话界面：流式排版、工具步骤、审批、输入框、斜杠命令
│   │   ├── lineEditor.ts      多行输入编辑（光标、历史、粘贴）
│   │   ├── markdownAnsi.ts    Markdown → 终端排版（流式）
│   │   ├── diffLines.ts       审批里显示的精简行级 Diff
│   │   ├── ansi.ts            ANSI 样式、宽字符宽度、折行、外部文本清洗
│   │   └── sessionTree.ts     旧树视图实现（主界面不再注册）
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
│   ├── settingsController.ts  表单操作及原生备用设置：读写设置、获取模型、连接测试
│   ├── modelCheck.ts          模型列表解析、连接测试、错误友好化
│   ├── config.ts / secrets.ts
├── media/                    活动栏图标、chat.html / chat.css / chat.js 面板资源
└── scripts/                   自检脚本
```

Agent 核心不依赖 `vscode`：它通过 `AgentHost` 接口向宿主要审批、快照、诊断，因此可以在 Node 中用假模型服务做端到端测试。

## 自检

```bash
node node_modules/typescript/bin/tsc --noEmit -p .
node scripts/check-session.js
node scripts/check-chat.js
node scripts/check-webview.js
node scripts/smoke.js
```

以上脚本直接检查当前源码，TypeScript 仅在测试进程内转换，不生成 `out` 或安装包。完整历史回归还包含依赖既有 `out` 的脚本，手动构建后可运行：

```bash
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
| `check-models.js` | `/models` 三种响应形态解析、按所填地址获取、401/404/空列表、连接测试、错误友好化 |
| `check-chat.js` | 控制器消息协议与顺序、审批往返（对话窗口 / 原生弹窗 / 窗口关闭后降级 / 侧栏按钮）、停止、撤销；原生设置菜单与首次引导、校验、Key 不回显、模型列表与缓存；文件引用；侧栏树视图 |
| `check-webview.js` | 实际面板 DOM 交互：设置切换、草稿与滚动保留、失败重试、流式消息、Markdown 转义、审批、历史与新建会话 |
| `check-tui.js` | 用一个最小终端模拟器驱动对话界面：宽字符与折行、Markdown 流式排版（逐字与一次性结果一致、无残影）、转义序列清洗、工具与计划、审批按键、斜杠命令、多行输入与粘贴、窗口缩放、打开前的消息补放 |
| `smoke.js` | 扩展激活、命令注册、统一 Webview 注册与实际模板加载、CSP、本地资源、设置页补发、备用终端及其文件链接 |

## 已知限制

- V4 主面板依赖 VS Code Webview；非安全 HTTP code-server 需使用原生备用对话，或配置 HTTPS / 安全上下文后使用主面板。
- Pi SDK 需要 Node.js ≥ 22.19；在 code-server 中运行时取决于 code-server 自带的 Node 版本，可用 `AI Agent: 检查 Agent 运行环境` 查看。
- 目前只验证过 OpenAI-compatible 的 Chat Completions；Anthropic / Responses 等协议需要增加 Pi Provider 配置。
- `bash` 无法限制在工作区内、无法撤销（见上）。
- 终端输出读取依赖 Shell Integration，未启用时自动跳过。
- 修改后 `get_diagnostics` 依赖语言服务，更新可能有短暂延迟。
- 未实现账号级统一配额与审计上报（待平台接口确定）。
