const http = require('http');
const path = require('path');

const { streamChat } = require(path.join(__dirname, '..', 'out', 'provider.js'));

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body);
    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = ['你好', '，这是', '流式输出'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
      } else {
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }
    }, 10);
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const config = {
    provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: 'test-model',
    temperature: 0.2,
    maxContextLines: 400,
    autoContext: true,
    requireDiffApproval: true,
    platformUrl: '',
    systemPromptExtra: ''
  };

  let streamed = '';
  try {
    const result = await streamChat(
      config,
      'sk-test',
      [{ role: 'user', content: 'hi' }],
      { onDelta: (d) => (streamed += d) }
    );
    console.log('result =', JSON.stringify(result));
    console.log('streamed =', JSON.stringify(streamed));
    if (result !== '你好，这是流式输出' || streamed !== result) {
      console.error('SSE 解析不一致');
      process.exitCode = 1;
    } else {
      console.log('stream test passed');
    }
  } catch (err) {
    console.error('stream test failed:', err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
