import * as vscode from 'vscode';
import {
  APPROVAL_MODE_HINTS,
  APPROVAL_MODE_LABELS,
  ApprovalMode,
  CONFIG_SECTION,
  isModelConfigured,
  isValidBaseUrl,
  normalizeBaseUrl,
  readConfig
} from './config';
import { SecretStore } from './secrets';
import { fetchModels, testConnection } from './modelCheck';

/** 按 API 地址分别缓存，避免学生试填别的地址时冲掉当前地址的模型列表 */
type ModelCache = Record<string, { models: string[]; at: number }>;

const CACHE_KEY = 'ptnAgent.modelCache.v2';
const MAX_CACHED_URLS = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MODES: ApprovalMode[] = ['ask', 'autoEdit', 'readOnly'];

// ---------------- 输入校验（纯函数，供原生输入框的 validateInput 与自检脚本使用） ----------------

export function validateBaseUrlInput(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return undefined;
  }
  return isValidBaseUrl(v) ? undefined : 'API 地址需要以 http:// 或 https:// 开头。';
}

export function validateContextWindowInput(value: string): string | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isFinite(n) && n >= 2048 && n <= 4_000_000
    ? undefined
    : '上下文窗口需要在 2048 到 4000000 之间。';
}

export function validateMaxOutputInput(value: string): string | undefined {
  const n = Number(value.trim());
  return value.trim() && Number.isFinite(n) && n >= 256 && n <= 1_000_000
    ? undefined
    : '最大输出需要在 256 到 1000000 之间。';
}

type Item = vscode.QuickPickItem & { id?: string; value?: string };

const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });

/**
 * 设置通过 VS Code 原生 QuickPick / InputBox 完成。
 * 模型列表来自学生所填 API 地址的 `/models` 接口，不使用任何预设供应商。
 * API Key 只保存在 SecretStorage，界面上只显示「已保存 / 未填写」。
 */
export class SettingsController {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: SecretStore,
    private readonly output: vscode.OutputChannel,
    private readonly onChanged: () => Promise<void>
  ) {}

  // ---------------- 模型列表缓存 ----------------

  /** 当前接口地址对应的已缓存模型列表（不论是否过期） */
  cachedModels(): string[] {
    const cache = this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {};
    return cache[readConfig().baseUrl]?.models ?? [];
  }

  private storeModels(baseUrl: string, models: string[]): void {
    const cache: ModelCache = { ...(this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {}) };
    cache[baseUrl] = { models, at: Date.now() };
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    for (const old of keys.slice(MAX_CACHED_URLS)) {
      delete cache[old];
    }
    void this.context.globalState.update(CACHE_KEY, cache);
  }

  /** 后台刷新：已配置接口且缓存缺失/过期时拉取一次，失败时静默（不打扰学生） */
  async refreshModelsIfNeeded(): Promise<void> {
    const cfg = readConfig();
    if (!cfg.baseUrl) {
      return;
    }
    const entry = (this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {})[cfg.baseUrl];
    if (entry && Date.now() - entry.at < CACHE_TTL_MS) {
      return;
    }
    const result = await fetchModels(cfg.baseUrl, await this.secrets.getApiKey());
    if (result.ok) {
      this.storeModels(cfg.baseUrl, result.models);
    } else {
      this.output.appendLine(`[models] ${result.message}`);
    }
  }

  private update(key: string, value: unknown): Thenable<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = configuration.inspect?.(key);
    const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    return configuration.update(key, value, target);
  }

  // ---------------- 入口 ----------------

  /** 打开设置：尚未配置模型服务时先走引导，否则显示设置菜单 */
  async open(): Promise<void> {
    if (!isModelConfigured(readConfig())) {
      await this.setup();
      return;
    }
    await this.menu();
  }

  /** 首次引导：API 地址 → API Key → 模型 → 测试连接 */
  async setup(): Promise<boolean> {
    if (!(await this.editBaseUrl('连接模型服务（1/3）'))) {
      return false;
    }
    if (!readConfig().baseUrl) {
      return false;
    }
    await this.editApiKey('连接模型服务（2/3）');
    if (!(await this.pickModel('连接模型服务（3/3）'))) {
      return false;
    }
    await this.test();
    return isModelConfigured(readConfig());
  }

  private async menu(): Promise<void> {
    let last: string | undefined;
    for (;;) {
      const cfg = readConfig();
      const hasKey = await this.secrets.hasApiKey();
      const items: Item[] = [
        sep('模型服务'),
        { id: 'baseUrl', label: '$(globe) API 地址', description: cfg.baseUrl || '未填写' },
        { id: 'apiKey', label: '$(key) API Key', description: hasKey ? '已保存' : '未填写（本地模型可留空）' },
        { id: 'model', label: '$(sparkle) 模型', description: cfg.model || '未选择' },
        { id: 'test', label: '$(plug) 测试连接', description: '用当前的地址、Key 和模型发一个最小请求' },
        sep('Agent 行为'),
        {
          id: 'mode',
          label: '$(shield) 审批模式',
          description: APPROVAL_MODE_LABELS[cfg.approvalMode],
          detail: APPROVAL_MODE_HINTS[cfg.approvalMode]
        },
        {
          id: 'allowed',
          label: '$(terminal) 免确认的命令',
          description: cfg.allowedCommands.length ? `${cfg.allowedCommands.length} 条前缀` : '无'
        },
        sep('高级'),
        { id: 'contextWindow', label: '$(symbol-numeric) 上下文窗口', description: `${cfg.contextWindow} token` },
        { id: 'maxOutput', label: '$(symbol-numeric) 单次回复最大输出', description: `${cfg.maxOutputTokens} token` },
        {
          id: 'autoContext',
          label: '$(file-code) 自动附带当前文件与选区',
          description: cfg.autoContext ? '开' : '关'
        },
        {
          id: 'extra',
          label: '$(note) 自定义指令',
          description: cfg.systemPromptExtra.trim() ? '已填写' : '未填写（如课程的代码规范）'
        },
        { id: 'all', label: '$(settings-gear) 在设置编辑器中查看全部选项' }
      ];
      const picked = await this.pick(items, {
        title: 'AI Agent 设置',
        placeHolder: '选择要修改的项，Esc 关闭',
        matchOnDescription: true,
        active: last
      });
      if (!picked?.id) {
        return;
      }
      last = picked.id;
      switch (picked.id) {
        case 'baseUrl':
          await this.editBaseUrl();
          break;
        case 'apiKey':
          await this.editApiKey();
          break;
        case 'model':
          await this.pickModel();
          break;
        case 'test':
          await this.test();
          break;
        case 'mode':
          await this.pickMode();
          break;
        case 'allowed':
          await this.editAllowedCommands();
          break;
        case 'contextWindow':
          await this.editNumber('contextWindow', '上下文窗口（token）', cfg.contextWindow, validateContextWindowInput);
          break;
        case 'maxOutput':
          await this.editNumber('maxOutputTokens', '单次回复最大输出（token）', cfg.maxOutputTokens, validateMaxOutputInput);
          break;
        case 'autoContext':
          await this.update('autoContext', !cfg.autoContext);
          await this.onChanged();
          break;
        case 'extra':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'ptnAgent.systemPromptExtra');
          return;
        case 'all':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'ptnAgent.');
          return;
        default:
          return;
      }
    }
  }

  /** showQuickPick 的薄封装：支持把上一次选中的项设为默认高亮 */
  private async pick(
    items: Item[],
    options: vscode.QuickPickOptions & { active?: string }
  ): Promise<Item | undefined> {
    const { active, ...rest } = options;
    if (active) {
      // 把上次操作的项挪到提示里即可；原生 showQuickPick 不支持指定高亮项，这里保持顺序不变
      rest.placeHolder = rest.placeHolder ?? '';
    }
    return vscode.window.showQuickPick(items, { ...rest, ignoreFocusOut: true });
  }

  // ---------------- 模型服务 ----------------

  async editBaseUrl(title = 'API 地址'): Promise<boolean> {
    const cfg = readConfig();
    const value = await vscode.window.showInputBox({
      title,
      value: cfg.baseUrl,
      prompt: 'OpenAI 兼容接口地址，需包含版本路径。局域网地址可以使用 http://',
      placeHolder: 'https://api.example.com/v1',
      ignoreFocusOut: true,
      validateInput: validateBaseUrlInput
    });
    if (value === undefined) {
      return false;
    }
    const baseUrl = normalizeBaseUrl(value);
    if (baseUrl && !isValidBaseUrl(baseUrl)) {
      void vscode.window.showErrorMessage('API 地址需要以 http:// 或 https:// 开头。');
      return false;
    }
    if (baseUrl !== cfg.baseUrl) {
      await this.update('baseUrl', baseUrl);
      await this.onChanged();
    }
    return true;
  }

  async editApiKey(title = 'API Key'): Promise<boolean> {
    const hasKey = await this.secrets.hasApiKey();
    if (hasKey) {
      const action = await this.pick(
        [
          { id: 'keep', label: '$(check) 保留已保存的 Key' },
          { id: 'new', label: '$(key) 输入新的 API Key' },
          { id: 'clear', label: '$(trash) 清除已保存的 Key' }
        ],
        { title, placeHolder: '已保存过 API Key' }
      );
      if (!action?.id || action.id === 'keep') {
        return false;
      }
      if (action.id === 'clear') {
        await this.secrets.setApiKey('');
        await this.onChanged();
        void vscode.window.showInformationMessage('已清除保存的 API Key。');
        return true;
      }
    }
    const value = await vscode.window.showInputBox({
      title,
      password: true,
      prompt: 'API Key 只保存在 VS Code SecretStorage，不写入配置文件。本地模型可直接回车跳过',
      placeHolder: 'sk-…',
      ignoreFocusOut: true
    });
    const key = (value ?? '').trim();
    if (!key) {
      return false;
    }
    await this.secrets.setApiKey(key);
    await this.onChanged();
    return true;
  }

  /** 从所填 API 地址获取模型列表并选择；接口不提供列表时可手动输入 */
  async pickModel(title = '选择模型'): Promise<boolean> {
    const cfg = readConfig();
    if (!cfg.baseUrl) {
      void vscode.window.showWarningMessage('请先填写 API 地址。');
      if (!(await this.editBaseUrl()) || !readConfig().baseUrl) {
        return false;
      }
    }
    let refresh = false;
    for (;;) {
      const baseUrl = readConfig().baseUrl;
      const entry = (this.context.globalState.get<ModelCache>(CACHE_KEY) ?? {})[baseUrl];
      let models = entry?.models ?? [];
      let note = '';
      if (refresh || !entry || Date.now() - entry.at >= CACHE_TTL_MS) {
        const apiKey = await this.secrets.getApiKey();
        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: '正在获取模型列表…' },
          () => fetchModels(baseUrl, apiKey)
        );
        if (result.ok) {
          models = result.models;
          this.storeModels(baseUrl, models);
        } else {
          note = result.message ?? '获取模型列表失败';
          this.output.appendLine(`[models] ${note}`);
        }
        refresh = false;
      }

      const current = readConfig().model;
      const items: Item[] = [];
      if (models.length > 0) {
        items.push(sep(`来自 ${baseUrl}/models`));
        for (const m of models) {
          items.push({ id: 'model', value: m, label: m, description: m === current ? '当前' : '' });
        }
      }
      if (current && !models.includes(current)) {
        items.push({ id: 'model', value: current, label: current, description: '当前（手动输入）' });
      }
      items.push(sep('其他'));
      items.push({ id: 'manual', label: '$(edit) 手动输入模型名称…' });
      items.push({ id: 'refresh', label: '$(refresh) 重新获取模型列表' });

      const picked = await this.pick(items, {
        title,
        placeHolder: note ? `${note} 可以手动输入模型名称` : '选择一个支持工具调用（function calling）的模型'
      });
      if (!picked?.id) {
        return false;
      }
      if (picked.id === 'refresh') {
        refresh = true;
        continue;
      }
      let model = picked.value ?? '';
      if (picked.id === 'manual') {
        const typed = await vscode.window.showInputBox({
          title: '模型名称',
          value: current,
          prompt: '与模型服务里的名称完全一致',
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : '请填写模型名称。')
        });
        if (typed === undefined) {
          continue;
        }
        model = typed.trim();
      }
      if (!model) {
        continue;
      }
      await this.setModel(model);
      return true;
    }
  }

  async setModel(model: string): Promise<void> {
    await this.update('model', model.trim());
    await this.onChanged();
  }

  async test(): Promise<boolean> {
    const cfg = readConfig();
    const apiKey = await this.secrets.getApiKey();
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在测试连接…' },
      () => testConnection(cfg.baseUrl, cfg.model, apiKey)
    );
    if (result.ok) {
      void vscode.window.showInformationMessage(`${result.message}，可以开始对话了。`);
    } else {
      void vscode.window.showErrorMessage(`连接失败：${result.message}`);
    }
    return result.ok;
  }

  // ---------------- Agent 行为 ----------------

  async pickMode(): Promise<void> {
    const current = readConfig().approvalMode;
    const picked = await this.pick(
      MODES.map((mode) => ({
        id: 'mode',
        value: mode,
        label: APPROVAL_MODE_LABELS[mode],
        description: mode === current ? '当前' : '',
        detail: APPROVAL_MODE_HINTS[mode]
      })),
      { title: 'Agent 审批模式', placeHolder: '控制修改文件、运行命令前是否需要确认' }
    );
    if (picked?.value) {
      await this.setMode(picked.value);
    }
  }

  async setMode(mode: string): Promise<void> {
    if (!MODES.includes(mode as ApprovalMode)) {
      return;
    }
    await this.update('approvalMode', mode);
    await this.onChanged();
  }

  private async editAllowedCommands(): Promise<void> {
    for (;;) {
      const list = readConfig().allowedCommands;
      const items: Item[] = [{ id: 'add', label: '$(add) 添加命令前缀…', description: '例如 npm test、dotnet build' }];
      if (list.length > 0) {
        items.push(sep('已添加（选中即可删除）'));
        for (const c of list) {
          items.push({ id: 'remove', value: c, label: `$(trash) ${c}` });
        }
      }
      const picked = await this.pick(items, {
        title: '免确认的命令',
        placeHolder: '命中前缀且不含 &&、|、; 等符号的命令不再询问；高危命令一律拦截'
      });
      if (!picked?.id) {
        return;
      }
      if (picked.id === 'remove') {
        await this.update(
          'allowedCommands',
          list.filter((c) => c !== picked.value)
        );
      } else {
        const typed = await vscode.window.showInputBox({
          title: '添加免确认的命令前缀',
          placeHolder: 'npm test',
          ignoreFocusOut: true,
          validateInput: (v) => (/[;&|<>$()`\n]/.test(v) ? '前缀里不能包含 ; & | < > $ ( ) ` 等符号。' : undefined)
        });
        const command = (typed ?? '').trim();
        if (command && !list.includes(command)) {
          await this.update('allowedCommands', [...list, command]);
        }
      }
      await this.onChanged();
    }
  }

  private async editNumber(
    key: string,
    title: string,
    current: number,
    validate: (value: string) => string | undefined
  ): Promise<void> {
    const value = await vscode.window.showInputBox({
      title,
      value: String(current),
      ignoreFocusOut: true,
      validateInput: validate
    });
    if (value === undefined || validate(value)) {
      return;
    }
    await this.update(key, Math.round(Number(value.trim())));
    await this.onChanged();
  }
}
