const Module = require('module');
const path = require('path');
const http = require('http');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};

let requestCount = 0;
const stub = {
  workspace: { workspaceFolders: [{ name: 'demo-workspace' }] }
};
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: stub
};

const { PlatformClient, courseContextToPrompt } = require(
  path.join(__dirname, '..', 'out', 'platform', 'client.js')
);

const output = { appendLine: () => {} };
const secrets = { getPlatformToken: async () => 'tok-123' };

let fail = 0;
function expect(name, cond) {
  if (cond) {
    console.log('ok ' + name);
  } else {
    console.error('FAIL ' + name);
    fail++;
  }
}

const server = http.createServer((req, res) => {
  requestCount++;
  res.setHeader('Content-Type', 'application/json');

  if (req.url.startsWith('/flat/api/agent/context')) {
    res.end(
      JSON.stringify({
        courseId: 'c1',
        courseTitle: 'C# Web API 实训',
        projectName: 'user-service',
        stage: '实现阶段',
        goals: ['掌握参数校验', 123, ''],
        guidelines: ['使用 ASP.NET Core 约定'],
        knowledge: ['ModelState 的作用'],
        allowedCommands: ['dotnet build']
      })
    );
    return;
  }
  if (req.url.startsWith('/nested/api/agent/context')) {
    res.end(JSON.stringify({ context: { courseTitle: '嵌套结构课程', goals: ['目标A'] } }));
    return;
  }
  if (req.url.startsWith('/broken/api/agent/context')) {
    res.statusCode = 500;
    res.end('{"error":"boom"}');
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const client = new PlatformClient(secrets, output);

  const flat = await client.getContext(`${base}/flat`);
  expect('解析扁平结构', !!flat && flat.courseTitle === 'C# Web API 实训');
  expect('过滤非字符串目标', JSON.stringify(flat.goals) === JSON.stringify(['掌握参数校验']));
  expect('白名单透传', Array.isArray(flat.allowedCommands) && flat.allowedCommands[0] === 'dotnet build');

  const prompt = courseContextToPrompt(flat);
  expect('生成上下文提示词', prompt.includes('C# Web API 实训') && prompt.includes('实训平台上下文'));

  const cached = await client.getContext(`${base}/flat`);
  expect('命中缓存', cached.fromCache === true);
  expect('缓存不重复请求', requestCount === 1);

  const nested = await client.getContext(`${base}/nested`, true);
  expect('解析嵌套结构', !!nested && nested.courseTitle === '嵌套结构课程');

  const broken = await client.getContext(`${base}/broken`, true);
  expect('错误时回退缓存', !!broken && broken.fromCache === true);
  expect('记录错误信息', typeof client.lastErrorMessage === 'string');

  const unknown = await client.getContext('', true);
  expect('未配置返回 undefined', unknown === undefined);

  server.close();
  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('platform client tests passed');
});
