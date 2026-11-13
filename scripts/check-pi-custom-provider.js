const Module = require('module');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = { id: 'vscode-stub', filename: 'vscode-stub', loaded: true, exports: {} };

const { PiAdapter } = require(path.join(__dirname, '..', 'out', 'agent', 'piAdapter.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

const server = http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache'
    });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Pi 已使用自定义 Provider。' } }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    fs.appendFileSync(process.env.PTN_PI_TEST_LOG, JSON.stringify({ auth: req.headers.authorization, model: parsed.model }) + '\n');
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-pi-models-'));
  const logFile = path.join(storage, 'requests.log');
  process.env.PTN_PI_TEST_LOG = logFile;
  const settings = {
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    transport: 'sdk',
    model: 'student-custom-model',
    apiKey: 'student-key',
    cwd: process.cwd(),
    rpcCommand: 'pi',
    extraArgs: [],
    timeoutMs: 15000
  };
  const output = { appendLine: (line) => console.log('log:', line) };
  const adapter = new PiAdapter(() => settings, output, storage);
  const config = {
    provider: 'openai-compatible',
    agentBackend: 'pi',
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: 0.2,
    maxContextLines: 100,
    autoContext: true,
    requireDiffApproval: true,
    platformUrl: '',
    systemPromptExtra: '',
    includeProjectContext: false,
    allowedCommands: [],
    commandTimeoutMs: 1000
  };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
  };

  try {
    let text = '';
    const result = await adapter.run(
      { messages: [{ role: 'user', content: 'hello' }], config, apiKey: settings.apiKey },
      { onDelta: (delta) => (text += delta) },
      token
    );
    expect('自定义 Provider 返回', result.text === 'Pi 已使用自定义 Provider。', result.text);
    expect('Pi SDK 最终内容权威', text === result.text && result.text.length > 0, text);

    const modelsFile = path.join(storage, 'pi-models.json');
    expect('生成 Pi models.json', fs.existsSync(modelsFile));
    const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    const provider = models.providers['ptn-openai-compatible'];
    expect('写入自定义 baseUrl', provider.baseUrl === settings.baseUrl, provider.baseUrl);
    expect('写入自定义模型', provider.models[0].id === settings.model, provider.models[0].id);

    const requests = fs
      .readFileSync(logFile, 'utf8')
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const request = requests[requests.length - 1];
    expect('Pi 请求带 Bearer Key', requests.some((r) => r.auth === 'Bearer student-key'), JSON.stringify(requests));
    expect('Pi 请求使用学生模型', requests.some((r) => r.model === settings.model), JSON.stringify(requests));
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    fail++;
  } finally {
    adapter.dispose();
    server.close();
    fs.rmSync(storage, { recursive: true, force: true });
    delete process.env.PTN_PI_TEST_LOG;
  }

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('pi custom provider tests passed');
});
