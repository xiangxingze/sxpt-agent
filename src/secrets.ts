import * as vscode from 'vscode';

const KEY_API = 'ptnAgent.apiKey';

/** API Key 只存放在 VS Code SecretStorage，不写入任何配置文件 */
export class SecretStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getApiKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(KEY_API);
    return key && key.length > 0 ? key : undefined;
  }

  async setApiKey(value: string): Promise<void> {
    if (!value) {
      await this.context.secrets.delete(KEY_API);
      return;
    }
    await this.context.secrets.store(KEY_API, value);
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }
}
