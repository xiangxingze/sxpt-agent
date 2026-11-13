import * as vscode from 'vscode';

const KEY_API = 'ptnAgent.apiKey';
const KEY_PLATFORM_TOKEN = 'ptnAgent.platformToken';

export class SecretStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    return this.context.secrets.get(KEY_API);
  }

  async setApiKey(value: string): Promise<void> {
    if (!value) {
      await this.context.secrets.delete(KEY_API);
      return;
    }
    await this.context.secrets.store(KEY_API, value);
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return typeof key === 'string' && key.length > 0;
  }

  async getPlatformToken(): Promise<string | undefined> {
    return this.context.secrets.get(KEY_PLATFORM_TOKEN);
  }

  async setPlatformToken(value: string): Promise<void> {
    if (!value) {
      await this.context.secrets.delete(KEY_PLATFORM_TOKEN);
      return;
    }
    await this.context.secrets.store(KEY_PLATFORM_TOKEN, value);
  }

  async promptForApiKey(provider: string): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: `${provider} API Key`,
      prompt: '密钥仅保存在 VS Code SecretStorage，不会写入配置文件或项目目录',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-...'
    });
    if (value === undefined) {
      return false;
    }
    await this.setApiKey(value.trim());
    return true;
  }
}
