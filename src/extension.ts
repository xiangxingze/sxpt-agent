import * as vscode from 'vscode';
import { readConfig, providerDefaults, CONFIG_SECTION, ProviderKind } from './config';
import { SecretStore } from './secrets';
import { testConnection } from './provider';
import { collectContext, contextToPrompt } from './contextCollector';
import { PatchReviewService } from './patchReview';
import { ChatViewProvider } from './chatView';
import { PlatformClient, courseContextToPrompt } from './platform/client';
import { getProjectOutline, clearProjectCache } from './project/outline';
import { isDangerous, isWhitelisted } from './tools/commandRunner';
import { piSdkLoadError, probePiSdk } from './agent/piAdapter';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('PTN AI Coding Agent');
  const secrets = new SecretStore(context);
  const patches = new PatchReviewService(output, context);
  patches.register();

  const platform = new PlatformClient(secrets, output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ptnAgent.openChat';
  context.subscriptions.push(statusBar, output);

  const provider = new ChatViewProvider(
    context.extensionUri,
    secrets,
    patches,
    platform,
    output,
    statusBar,
    context
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const register = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('ptnAgent.openChat', () => provider.reveal());
  register('ptnAgent.explainSelection', () => provider.runQuickAction('explain'));
  register('ptnAgent.refactorSelection', () => provider.runQuickAction('refactor'));
  register('ptnAgent.generateTests', () => provider.runQuickAction('tests'));
  register('ptnAgent.analyzeProblem', () => provider.runQuickAction('problem'));
  register('ptnAgent.explainProject', () => provider.runQuickAction('project'));
  register('ptnAgent.newSession', () => provider.newSession());
  register('ptnAgent.clearSession', () => provider.newSession());
  register('ptnAgent.undoLastPatch', () => patches.undoLast());
  register('ptnAgent.runTests', () => provider.runTests());
  register('ptnAgent.runCommand', () => provider.promptRunCommand());

  register('ptnAgent.checkPi', async () => {
    const sdk = await probePiSdk();
    const rpcCmd = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('piCommand') || 'pi';
    const lines = [
      sdk.ok ? `内置 Pi SDK：可用${sdk.version ? `（v${sdk.version}）` : ''}` : '内置 Pi SDK：不可用',
      sdk.ok ? '' : `原因：${sdk.error ?? piSdkLoadError() ?? '未知'}`,
      `RPC 可执行文件：${rpcCmd}（仅 piTransport=rpc 时需要）`
    ].filter(Boolean);
    const action = await vscode.window.showInformationMessage(
      lines.join('\n'),
      sdk.ok ? '切换到 Pi 基座' : '打开设置'
    );
    if (action === '切换到 Pi 基座') {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update('agentBackend', 'pi', vscode.ConfigurationTarget.Global);
      await provider.pushState();
    } else if (action === '打开设置') {
      await vscode.commands.executeCommand('ptnAgent.settings');
    }
  });

  context.subscriptions.push({
    dispose: () => provider.dispose()
  });

  register('ptnAgent.refreshPlatform', async () => {
    platform.clear();
    clearProjectCache();
    const cfg = readConfig();
    if (!cfg.platformUrl) {
      void vscode.window.showInformationMessage('未配置平台地址（ptnAgent.platformUrl）。');
      return;
    }
    const ctx = await platform.getContext(cfg.platformUrl, true);
    if (!ctx) {
      void vscode.window.showWarningMessage(
        `平台连接失败：${platform.lastErrorMessage ?? '未知原因'}。本地功能不受影响。`
      );
    } else {
      void vscode.window.showInformationMessage(
        `平台上下文已更新：${ctx.courseTitle ?? ctx.projectName ?? '课程'}`
      );
    }
    await provider.pushState();
  });

  register('ptnAgent.showProjectOutline', async () => {
    const outline = await getProjectOutline(true);
    const text = outline?.summary ?? '（未检测到工作区项目）';
    const doc = await vscode.workspace.openTextDocument({
      content: `# 项目结构摘要\n\n${text}\n`,
      language: 'markdown'
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('ptnAgent.checkCommand', async () => {    const cfg = readConfig();
    const input = await vscode.window.showInputBox({
      title: '命令安全自检',
      prompt: '输入命令，检查是否高危或是否在白名单',
      ignoreFocusOut: true
    });
    if (!input) {
      return;
    }
    const dangerous = isDangerous(input);
    const whitelisted = isWhitelisted(input, cfg.allowedCommands);
    void vscode.window.showInformationMessage(
      `高危：${dangerous ? '是' : '否'}；白名单：${whitelisted ? '是' : '否'}`
    );
  });

  register('ptnAgent.testConnection', async () => {
    const cfg = readConfig();
    const apiKey = await secrets.getApiKey();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '测试模型连接…' },
      async () => {
        const result = await testConnection(cfg, apiKey);
        if (result.ok) {
          void vscode.window.showInformationMessage(`✅ ${result.message}`);
        } else {
          void vscode.window.showErrorMessage(`❌ ${result.message}`);
        }
      }
    );
  });

  register('ptnAgent.showContext', async () => {
    const cfg = readConfig();
    const ctx = await collectContext();
    const ideText = contextToPrompt(ctx) || '（当前没有可用上下文）';
    const outline = cfg.includeProjectContext ? await getProjectOutline() : undefined;
    const course = cfg.platformUrl ? await platform.getContext(cfg.platformUrl) : undefined;
    const courseText = courseContextToPrompt(course);

    const sections = [
      '# 当前上下文预览',
      '> 下面内容会随下一条消息发送给模型。API Key 不在其中。',
      '## IDE 上下文',
      ideText
    ];
    if (courseText) {
      sections.push('## 实训平台上下文', courseText);
    }
    if (outline) {
      sections.push('## 项目结构摘要', outline.summary);
    }

    const doc = await vscode.workspace.openTextDocument({
      content: `${sections.join('\n\n')}\n`,
      language: 'markdown'
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('ptnAgent.settings', async () => {
    const cfg = readConfig();
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: '$(server) 选择模型供应商',
          description: cfg.provider,
          action: 'provider'
        },
        {
          label: '$(link) 设置 API 地址',
          description: cfg.baseUrl,
          action: 'baseUrl'
        },
        {
          label: '$(symbol-method) 设置模型名称',
          description: cfg.model,
          action: 'model'
        },
        {
          label: '$(key) 设置 API Key',
          description: (await secrets.hasApiKey()) ? '已保存（SecretStorage）' : '未设置',
          action: 'apiKey'
        },
        {
          label: '$(organization) 设置实训平台地址',
          description: cfg.platformUrl || '未配置',
          action: 'platformUrl'
        },
        {
          label: '$(shield) 设置平台访问令牌',
          description: (await secrets.getPlatformToken()) ? '已保存' : '未设置',
          action: 'platformToken'
        },
        {
          label: '$(checklist) 设置命令白名单',
          description: cfg.allowedCommands.length ? `${cfg.allowedCommands.length} 条` : '空',
          action: 'allowList'
        },
        {
          label: '$(chip) 切换 Agent 基座',
          description: cfg.agentBackend === 'pi' ? 'Pi Agent' : '直连模型接口',
          action: 'backend'
        },
        { label: '$(beaker) 测试连接', action: 'test' },
        { label: '$(gear) 打开完整设置', action: 'open' }
      ],
      { title: 'PTN AI Coding Agent 设置', placeHolder: '选择要修改的项' }
    );

    if (!pick) {
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const target = vscode.ConfigurationTarget.Global;

    switch (pick.action) {
      case 'provider': {
        const chosen = await vscode.window.showQuickPick(
          [
            { label: 'DeepSeek', value: 'deepseek' as ProviderKind },
            { label: 'OpenAI 兼容接口', value: 'openai-compatible' as ProviderKind },
            { label: 'Ollama（本地）', value: 'ollama' as ProviderKind }
          ],
          { title: '选择模型供应商' }
        );
        if (!chosen) {
          return;
        }
        const defaults = providerDefaults(chosen.value);
        await config.update('provider', chosen.value, target);
        await config.update('baseUrl', defaults.baseUrl, target);
        await config.update('model', defaults.model, target);
        void vscode.window.showInformationMessage(
          `已切换为 ${chosen.label}，记得确认 API Key。`
        );
        break;
      }
      case 'baseUrl': {
        const value = await vscode.window.showInputBox({
          title: 'API Base URL',
          value: cfg.baseUrl,
          prompt: '需包含版本路径，例如 https://api.deepseek.com/v1',
          ignoreFocusOut: true,
          validateInput: (v) =>
            /^https?:\/\//.test(v.trim()) ? undefined : '请输入以 http:// 或 https:// 开头的地址'
        });
        if (value !== undefined) {
          await config.update('baseUrl', value.trim().replace(/\/+$/, ''), target);
        }
        break;
      }
      case 'model': {
        const value = await vscode.window.showInputBox({
          title: '模型名称',
          value: cfg.model,
          prompt: '例如 deepseek-chat、qwen2.5-coder',
          ignoreFocusOut: true
        });
        if (value !== undefined && value.trim()) {
          await config.update('model', value.trim(), target);
        }
        break;
      }
      case 'apiKey': {
        const saved = await secrets.promptForApiKey(cfg.provider);
        if (saved) {
          void vscode.window.showInformationMessage('API Key 已保存到 VS Code SecretStorage。');
        }
        break;
      }
      case 'test':
        await vscode.commands.executeCommand('ptnAgent.testConnection');
        break;
      case 'backend': {
        const chosen = await vscode.window.showQuickPick(
          [
            { label: '直连模型接口（无额外依赖）', value: 'native' },
            { label: 'Pi Agent 基座（可调用只读工具）', value: 'pi' }
          ],
          { title: '选择 Agent 基座' }
        );
        if (!chosen) {
          return;
        }
        await config.update('agentBackend', chosen.value, target);
        if (chosen.value === 'pi') {
          const probe = await probePiSdk();
          if (!probe.ok) {
            void vscode.window.showWarningMessage(
              `内置 Pi SDK 不可用：${probe.error ?? '未知原因'}。可改用 piTransport=rpc。`
            );
          } else {
            void vscode.window.showInformationMessage(
              `已切换到 Pi 基座${probe.version ? `（Pi v${probe.version}）` : ''}。`
            );
          }
        }
        break;
      }
      case 'platformUrl': {
        const value = await vscode.window.showInputBox({
          title: '实训平台地址',
          value: cfg.platformUrl,
          prompt: '例如 http://192.168.100.231:8080，留空表示不连接平台',
          ignoreFocusOut: true,
          validateInput: (v) =>
            v.trim() === '' || /^https?:\/\//.test(v.trim())
              ? undefined
              : '请输入以 http:// 或 https:// 开头的地址'
        });
        if (value !== undefined) {
          await config.update('platformUrl', value.trim().replace(/\/+$/, ''), target);
          platform.clear();
        }
        break;
      }
      case 'platformToken': {
        const value = await vscode.window.showInputBox({
          title: '平台访问令牌',
          prompt: '保存在 VS Code SecretStorage，用于访问平台上下文接口',
          password: true,
          ignoreFocusOut: true
        });
        if (value !== undefined) {
          await secrets.setPlatformToken(value.trim());
          platform.clear();
        }
        break;
      }
      case 'allowList': {
        const value = await vscode.window.showInputBox({
          title: '命令白名单',
          value: cfg.allowedCommands.join(','),
          prompt: '逗号分隔的命令前缀，例如 npm test,dotnet build；白名单不跳过硬性确认',
          ignoreFocusOut: true
        });
        if (value !== undefined) {
          const list = value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await config.update('allowedCommands', list, target);
        }
        break;
      }
      case 'open':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:ptn.ptn-agent'
        );
        break;
      default:
        break;
    }

    await provider.pushState();
  });

  register('ptnAgent.gotoProblem', async () => {
    const items: Array<vscode.QuickPickItem & { uri: vscode.Uri; range: vscode.Range }> = [];
    const seen = new Set<string>();
    const push = (uri: vscode.Uri) => {
      if (seen.has(uri.toString())) {
        return;
      }
      seen.add(uri.toString());
      for (const diag of vscode.languages.getDiagnostics(uri)) {
        if (diag.severity > vscode.DiagnosticSeverity.Warning) {
          continue;
        }
        const line = diag.range.start.line + 1;
        items.push({
          label: `$(${diag.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}) ${vscode.workspace.asRelativePath(uri, false)}:${line}`,
          description: diag.message.slice(0, 120),
          uri,
          range: diag.range
        });
      }
    };

    for (const editor of vscode.window.visibleTextEditors) {
      push(editor.document.uri);
    }
    for (const uri of vscode.languages.getDiagnostics().map(([u]) => u)) {
      push(uri);
    }

    if (items.length === 0) {
      void vscode.window.showInformationMessage('当前工作区没有错误或警告。');
      return;
    }
    if (items.length > 200) {
      items.length = 200;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: `定位问题（${items.length}）`,
      placeHolder: '选择要跳转的诊断'
    });
    if (!picked) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(picked.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    editor.selection = new vscode.Selection(picked.range.start, picked.range.end);
    editor.revealRange(picked.range, vscode.TextEditorRevealType.InCenter);
  });

  // 激活后立即展示状态栏，避免侧栏未打开时没有任何入口提示
  const cfg = readConfig();
  statusBar.text = `$(comment-discussion) ${cfg.model}`;
  statusBar.tooltip = '打开 PTN AI Coding Agent';
  statusBar.show();

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => void provider.refreshContext()),
    vscode.window.onDidChangeActiveTextEditor(() => void provider.refreshContext())
  );

  output.appendLine('[ptn-agent] activated');
}

export function deactivate(): void {
  // nothing to clean up
}
