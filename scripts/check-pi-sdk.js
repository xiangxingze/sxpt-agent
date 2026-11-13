const Module = require('module');
const path = require('path');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: {}
};

const { PiAdapter, probePiSdk } = require(path.join(__dirname, '..', 'out', 'agent', 'piAdapter.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

const config = {
  provider: 'deepseek',
  agentBackend: 'pi',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.2,
  maxContextLines: 400,
  autoContext: true,
  requireDiffApproval: true,
  platformUrl: '',
  systemPromptExtra: '',
  includeProjectContext: false,
  allowedCommands: [],
  commandTimeoutMs: 1000
};

(async () => {
  const probe = await probePiSdk();
  expect('内置 SDK 可加载', probe.ok === true, probe.error);
  if (probe.version) {
    expect('读到 Pi 版本号', typeof probe.version === 'string' && probe.version.length > 0, probe.version);
    console.log('   Pi SDK version =', probe.version);
  } else {
    console.log('   Pi SDK version metadata unavailable (package exports protected)');
  }

  // 用不存在的模型验证错误路径：应快速失败并给出可操作提示
  const settings = {
    provider: 'deepseek',
    transport: 'sdk',
    model: '__definitely_missing_model__',
    apiKey: 'sk-invalid',
    cwd: process.cwd(),
    rpcCommand: 'pi',
    extraArgs: [],
    timeoutMs: 20000
  };
  const logs = [];
  const adapter = new PiAdapter(() => settings, { appendLine: (l) => logs.push(l) });
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
  };

  const started = Date.now();
  let message = '';
  try {
    await adapter.run(
      { messages: [{ role: 'user', content: 'hi' }], config },
      { onDelta: () => undefined },
      token
    );
    message = 'no-error';
  } catch (err) {
    message = err.message;
  }
  const elapsed = Date.now() - started;

  expect('未知模型时抛出可读错误', message !== 'no-error' && message.length > 0, message);
  expect('错误指向模型或回退建议', /模型|模型接口|无法识别|回退/.test(message), message);
  expect('失败较快（<20s）', elapsed < 20000, elapsed + 'ms');
  console.log('   error message =', message.slice(0, 160));

  adapter.dispose();

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('pi sdk adapter tests passed');
})();
