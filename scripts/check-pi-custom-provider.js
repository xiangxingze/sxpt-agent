const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const { PiAgent, piModelsConfig, probePiSdk } = require(path.join(__dirname, '..', 'out', 'agent', 'piAgent.js'));

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra ? ' -> ' + extra : ''));
    fail++;
  }
}

const requests = [];
const server = http.createServer((req, res) => {
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    requests.push({ auth: req.headers.authorization, model: parsed.model, maxTokens: parsed.max_tokens ?? parsed.max_completion_tokens });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (delta, finish) => ({ id: 'x', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] });
    res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: 'Pi 已使用自定义 Provider。' })) + '\n\n');
    res.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-pi-models-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-pi-ws-'));
  const settings = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'student-custom-model',
    apiKey: 'student-key',
    cwd: ws,
    roots: [ws],
    approvalMode: 'ask',
    allowedCommands: [],
    commandTimeoutMs: 5000,
    runTimeoutMs: 30000,
    contextWindow: 64000,
    maxOutputTokens: 2048,
    systemPromptExtra: '课程规范：变量使用 camelCase'
  };
  const host = {
    requestApproval: async () => 'deny',
    beforeWrite: async () => undefined,
    isDirty: () => false,
    getDiagnostics: async () => '',
    onPlan: () => undefined
  };
  const agent = new PiAgent(host, (l) => console.log('log:', l), storage);

  try {
    const probe = await probePiSdk();
    expect('内置 SDK 可加载', probe.ok === true, probe.error);

    let text = '';
    const result = await agent.run(
      { prompt: 'hello', history: [], settings, signal: new AbortController().signal },
      {
        onTextDelta: (d) => (text += d),
        onTextReset: () => undefined,
        onToolStart: () => undefined,
        onToolEnd: () => undefined,
        onStatus: () => undefined
      }
    );
    expect('自定义 Provider 返回', result.text === 'Pi 已使用自定义 Provider。', result.text);
    expect('文本被流式推送', text === result.text, text);

    const modelsFile = path.join(storage, 'pi-agent', 'models.json');
    expect('生成 Pi models.json', fs.existsSync(modelsFile));
    const models = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    const provider = models.providers['ptn-custom'];
    expect('写入自定义 baseUrl', provider.baseUrl === settings.baseUrl, provider.baseUrl);
    expect('写入自定义模型', provider.models[0].id === settings.model, provider.models[0].id);
    expect('写入上下文窗口与输出上限', provider.models[0].contextWindow === 64000 && provider.models[0].maxTokens === 2048);
    expect('API Key 不落盘', !fs.readFileSync(modelsFile, 'utf8').includes('student-key'));
    expect('不写入 auth.json 明文 Key', !fs.existsSync(path.join(storage, 'pi-agent', 'auth.json')) || !fs.readFileSync(path.join(storage, 'pi-agent', 'auth.json'), 'utf8').includes('student-key'));

    expect('请求带 Bearer Key', requests.some((r) => r.auth === 'Bearer student-key'), JSON.stringify(requests));
    expect('请求使用学生模型', requests.some((r) => r.model === settings.model), JSON.stringify(requests));

    const noKey = piModelsConfig({ ...settings, apiKey: undefined });
    expect('没有填写 Key（本地模型）时不发送 Authorization 头', noKey.providers['ptn-custom'].authHeader === false);
    expect('填写了 Key 时发送 Authorization 头', provider.authHeader === true);
  } catch (err) {
    console.error('ERROR:', err.stack || err.message);
    fail++;
  } finally {
    agent.dispose();
    server.close();
    fs.rmSync(storage, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('pi custom provider tests passed');
});
