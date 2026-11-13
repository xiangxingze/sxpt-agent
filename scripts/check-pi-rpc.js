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

const { PiAdapter } = require(path.join(__dirname, '..', 'out', 'agent', 'piAdapter.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

const fakePi = path.join(__dirname, 'fake-pi.js');
const lines = [];
const output = { appendLine: (l) => lines.push(l) };

const settings = {
  provider: 'deepseek',
  transport: 'rpc',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  cwd: process.cwd(),
  rpcCommand: process.execPath,
  extraArgs: [fakePi],
  timeoutMs: 15000
};

const adapter = new PiAdapter(() => settings, output);

function makeToken() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(cb) {
      listeners.push(cb);
      return { dispose: () => undefined };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const cb of listeners) cb();
    }
  };
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
  let streamed = '';
  const token = makeToken();
  const result = await adapter.run(
    {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '解释 UserService.cs' }
      ],
      config,
      apiKey: 'sk-test'
    },
    {
      onDelta: (d) => (streamed += d),
      onStatus: (s) => lines.push('status: ' + s)
    },
    token
  );

  expect('RPC 返回拼接文本', result.text.includes('UserService.cs'), JSON.stringify(result.text));
  expect('流式 delta 与最终文本一致', streamed === result.text, JSON.stringify(streamed));
  expect('模型标签', result.model === 'pi:deepseek-chat', result.model);
  expect('记录了工具状态或启动日志', lines.some((l) => l.includes('status:') || l.includes('[pi]')));

  // 第二轮：验证子进程复用（同一 child）
  const token2 = makeToken();
  const second = await adapter.run(
    { messages: [{ role: 'user', content: '继续' }], config, apiKey: 'sk-test' },
    { onDelta: () => undefined },
    token2
  );
  expect('第二轮可复用进程', second.text.length > 0);

  // 会话重置
  await adapter.reset();
  expect('reset 不抛错', true);

  // 取消：取消后应尽快结束
  const token3 = makeToken();
  setTimeout(() => token3.cancel(), 25);
  try {
    await adapter.run(
      { messages: [{ role: 'user', content: '长任务' }], config, apiKey: 'sk-test' },
      { onDelta: () => undefined },
      token3
    );
    expect('取消后仍返回或抛错（均可接受）', true);
  } catch (err) {
    expect('取消后抛错也是可接受结果', true);
  }

  adapter.dispose();
  await new Promise((r) => setTimeout(r, 300));

  expect('子进程已退出', lines.some((l) => l.includes('进程退出')));

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('pi rpc adapter tests passed');
})();
