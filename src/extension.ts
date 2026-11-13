import * as vscode from 'vscode';
import { readConfig } from './config';
import { SecretStore } from './secrets';
import { collectContext, contextToPrompt } from './contextCollector';
import { ChangeTracker } from './changeTracker';
import { DiffPreview } from './diffPreview';
import { ChatViewProvider } from './chatView';
import { PlatformClient, courseContextToPrompt } from './platform/client';
import { getProjectOutline } from './project/outline';
import { piSdkLoadError, probePiSdk } from './agent/piAgent';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('AI Coding Agent');
  const secrets = new SecretStore(context);
  const tracker = new ChangeTracker(context, output);
  const diffs = new DiffPreview();
  diffs.register(context);

  // 平台上下文是管理员侧能力，学生没有配置入口；令牌由平台对接方注入，目前不提供
  const platform = new PlatformClient(async () => undefined, output);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ptnAgent.openChat';
  context.subscriptions.push(statusBar, output);

  const provider = new ChatViewProvider(
    context.extensionUri,
    secrets,
    tracker,
    diffs,
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
  register('ptnAgent.fixProblems', () => provider.runQuickAction('fix'));
  register('ptnAgent.explainProject', () => provider.runQuickAction('project'));
  register('ptnAgent.newSession', () => provider.newSession());
  register('ptnAgent.undoLastPatch', async () => {
    await tracker.undoLast();
    await provider.pushState();
  });
  register('ptnAgent.pickMode', () => provider.pickApprovalMode());
  register('ptnAgent.runTests', () => provider.runTests());
  register('ptnAgent.runCommand', () => provider.promptRunCommand());

  // 所有设置、模型选择与连接测试都在侧栏的同一个设置页里完成
  register('ptnAgent.settings', () => provider.openSettings());

  register('ptnAgent.checkPi', async () => {
    const sdk = await probePiSdk();
    const lines = [
      sdk.ok ? `Agent 运行环境：正常${sdk.version ? `（Pi SDK v${sdk.version}）` : ''}` : 'Agent 运行环境：不可用',
      sdk.ok ? `Node.js：${process.version}` : `原因：${sdk.error ?? piSdkLoadError() ?? '未知'}`
    ];
    void vscode.window.showInformationMessage(lines.join('\n'));
  });

  context.subscriptions.push({
    dispose: () => provider.dispose()
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
      sections.push('## 课程上下文', courseText);
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
  void provider.pushState();

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(() => void provider.refreshContext()),
    vscode.window.onDidChangeActiveTextEditor(() => void provider.refreshContext())
  );

  output.appendLine('[ai-agent] activated');
}

export function deactivate(): void {
  // nothing to clean up
}
