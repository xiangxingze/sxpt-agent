# SXPT AI Coding Agent

实训平台内置 VS Code 中的 AI 编程 Agent 扩展。

学生用自然语言描述任务，Agent 自己查看代码、修改文件、运行命令并验证结果，直到任务完成。每一次文件修改都先在 VS Code 原生 Diff 中让学生审核，命令执行前需要确认，改错了可以一键撤销。学生只需填写 API 地址、API Key 并选择模型即可使用。

界面全部由 VS Code 原生组件构成（终端标签页、树视图、QuickPick、Diff 编辑器），不使用 webview，因此在局域网里以 `http://` 访问的 code-server 中也能正常使用。

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

对话中输入 `/mode`，或命令面板 `AI Agent: 切换审批模式`，或设置 `ptnAgent.approvalMode`：

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

每次任务结束后，对话里会汇总本次修改的文件（侧栏中也列在这一轮对话下面，可点击打开）。对话中输入 `/undo`、点击侧栏标题栏的撤销按钮，或命令 `AI Agent: 撤销上次 AI 修改` 即可恢复。保留最近 10 次任务的快照；超过 1 MB 的文件不保存快照，撤销时会提示。

## 界面

### 为什么不用 webview

webview 依赖 Service Worker，而浏览器只在安全上下文（`https://` 或 `localhost`）里允许注册 Service Worker。实训平台在局域网里以 `http://<IP>` 提供 code-server，无法配置 https，webview 会报 `Could not register service workers` 而一片空白。终端、树视图、QuickPick、Diff 编辑器都由 workbench 自己渲染，不受这个限制。

### 对话窗口

`Ctrl+Alt+I`（或活动栏 → 侧栏标题栏的对话按钮）打开名为 **AI Agent** 的终端标签页，默认在编辑器右侧（`ptnAgent.chatLocation` 可改为底部面板）。界面风格与 Claude Code / Codex 的终端界面一致：

- 回答边生成边按 Markdown 排版（标题、列表、表格、代码块），中文按双宽字符对齐，窗口缩放后重新排版
- 工具调用逐条显示（`● 修改 a.txt  +2 −1`），多步任务显示计划与进度
- 回答里的 `文件:行号` 可 `Ctrl` / `Cmd` + 单击跳转，文件在对话窗口之外的编辑器列打开
- 审批直接在对话里完成：`↑` / `↓` 选择后回车，或按数字键；`y` 允许，`n` / `Esc` 拒绝，`d` 重新打开 Diff。文件修改的 Diff 会同时在旁边的编辑器列打开
- 对话窗口关闭时，等待中的审批自动改用 VS Code 原生弹窗

| 按键 | 作用 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行（也可用 `Alt+Enter`、`Ctrl+J`，或行尾输入 `\` 再回车） |
| `↑` / `↓` | 翻看输入历史 |
| `Esc` | 停止正在运行的任务 / 拒绝审批 |
| `Ctrl+C` | 清空输入；任务运行中为停止 |
| `Ctrl+U` | 删除到行首 |

输入 `/` 弹出斜杠命令：`/new`（`/clear`）、`/model`、`/mode`、`/settings`、`/undo`、`/context`、`/explain`、`/problems`、`/fix`、`/tests`、`/refactor`、`/project`、`/run`、`/stop`、`/help`。

### 侧栏

活动栏图标打开「对话」树视图：

- 未配置时显示「配置模型服务」引导；配置后显示欢迎页和常用任务入口
- 有对话后按轮次列出：每一轮下面是工具步骤（成功 / 失败）、回答（点击在编辑器中以 Markdown 打开）、改动的文件
- 等待确认的操作置顶，行内有「查看修改」「允许」「拒绝」按钮，视图图标上显示待确认数量
- 标题栏按钮：停止（运行中）、打开对话、新建对话、撤销、设置；`…` 菜单里有切换模型 / 模式、查看上下文、项目结构摘要、运行测试、检查运行环境

状态栏显示当前模型；运行中显示旋转图标，等待确认时高亮提示，点击打开对话窗口。

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

常用设置都在一个原生菜单（QuickPick）里完成：侧栏标题栏的 ⚙、对话中输入 `/settings`，或命令面板执行 `AI Agent: 打开设置`。

| 分组 | 内容 |
| --- | --- |
| 模型服务 | **API 地址**、**API Key**、**模型**（从你填的 API 地址自动获取列表，也可手动输入）、测试连接 |
| Agent 行为 | 审批模式（逐项确认 / 自动应用修改 / 只读）、免确认的命令前缀、对话窗口位置 |
| 高级 | 上下文窗口、单次最大输出、是否自动附带当前文件、自定义指令（转到设置编辑器） |

- **首次使用**会依次引导填写 API 地址 → API Key → 选择模型，最后测试连接并打开对话窗口；没填好之前不会调用模型。
- **没有预设供应商**：接入任何 OpenAI 兼容接口（DeepSeek、通义、OpenAI、Ollama、vLLM、公司内部网关……），模型列表来自 `GET {API 地址}/models`，缓存 10 分钟，可在列表里「重新获取」。接口不提供列表时，手动输入模型名即可。
- **API Key** 只保存在 VS Code SecretStorage，不写入配置文件；输入框是密码框，菜单里只显示「已保存 / 未填写」，可保留、重新输入或清除。本地模型可以不填 Key。
- 对话中输入 `/model`、`/mode` 可直接切换模型和审批模式。

对应的 VS Code 配置项（搜索 `ptnAgent`）：

| 配置项 | 说明 | 默认 |
| --- | --- | --- |
| `ptnAgent.baseUrl` | API 地址，含版本路径，如 `https://api.example.com/v1` | 空 |
| `ptnAgent.model` | 模型名称，需支持工具调用（function calling） | 空 |
| `ptnAgent.approvalMode` | `ask` / `autoEdit` / `readOnly` | `ask` |
| `ptnAgent.chatLocation` | 对话窗口位置：`beside`（编辑器右侧）/ `panel`（底部面板），下次打开时生效 | `beside` |
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
│   │   ├── chatTerminal.ts    对话窗口：原生终端标签页（Pseudoterminal）、文件链接
│   │   ├── chatTui.ts         终端里的对话界面：流式排版、工具步骤、审批、输入框、斜杠命令
│   │   ├── lineEditor.ts      多行输入编辑（光标、历史、粘贴）
│   │   ├── markdownAnsi.ts    Markdown → 终端排版（流式）
│   │   ├── diffLines.ts       审批里显示的精简行级 Diff
│   │   ├── ansi.ts            ANSI 样式、宽字符宽度、折行、外部文本清洗
│   │   └── sessionTree.ts     侧栏树视图：对话轮次、工具步骤、待确认操作
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
│   ├── settingsController.ts  原生设置菜单与首次引导：读写设置、按所填 API 获取模型、连接测试
│   ├── modelCheck.ts          模型列表解析、连接测试、错误友好化
│   ├── config.ts / secrets.ts
├── media/agent.svg            活动栏图标
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
| `check-models.js` | `/models` 三种响应形态解析、按所填地址获取、401/404/空列表、连接测试、错误友好化 |
| `check-chat.js` | 控制器消息协议与顺序、审批往返（对话窗口 / 原生弹窗 / 窗口关闭后降级 / 侧栏按钮）、停止、撤销；原生设置菜单与首次引导、校验、Key 不回显、模型列表与缓存；文件引用；侧栏树视图 |
| `check-tui.js` | 用一个最小终端模拟器驱动对话界面：宽字符与折行、Markdown 流式排版（逐字与一次性结果一致、无残影）、转义序列清洗、工具与计划、审批按键、斜杠命令、多行输入与粘贴、窗口缩放、打开前的消息补放 |
| `smoke.js` | 扩展激活、命令注册、侧栏树视图、打开对话终端并绘制欢迎框、文件链接只作用于对话终端 |

## 已知限制

- Pi SDK 需要 Node.js ≥ 22.19；在 code-server 中运行时取决于 code-server 自带的 Node 版本，可用 `AI Agent: 检查 Agent 运行环境` 查看。
- 目前只验证过 OpenAI-compatible 的 Chat Completions；Anthropic / Responses 等协议需要增加 Pi Provider 配置。
- `bash` 无法限制在工作区内、无法撤销（见上）。
- 终端输出读取依赖 Shell Integration，未启用时自动跳过。
- 修改后 `get_diagnostics` 依赖语言服务，更新可能有短暂延迟。
- 未实现账号级统一配额与审计上报（待平台接口确定）。
