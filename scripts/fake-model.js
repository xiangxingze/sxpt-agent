/** 脚本化的假 OpenAI 兼容模型服务：按请求序号依次返回预设步骤（工具调用/文本/HTTP 错误） */
const http = require('http');

function chunk(delta, finish) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish ?? null }]
  };
}

/** 创建一个按「请求序号」依次返回脚本步骤的假模型服务 */
function createModelServer(steps) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const toolMsgs = parsed.messages.filter((m) => m.role === 'tool');
      const lastTool = toolMsgs.length ? toolMsgs[toolMsgs.length - 1] : undefined;
      const n = seen.length;
      seen.push({
        toolNames: (parsed.tools || []).map((t) => t.function.name),
        lastToolContent: lastTool ? String(typeof lastTool.content === 'string' ? lastTool.content : JSON.stringify(lastTool.content)) : undefined,
        system: parsed.messages.find((m) => m.role === 'system')?.content
      });
      const step = steps[Math.min(n, steps.length - 1)];
      if (step.status) {
        res.writeHead(step.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.message || 'error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (step.tool) {
        send(
          chunk({
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                index: 0,
                id: 'call_' + n,
                type: 'function',
                function: { name: step.tool, arguments: JSON.stringify(step.args) }
              }
            ]
          })
        );
        send(chunk({}, 'tool_calls'));
      } else {
        send(chunk({ role: 'assistant', content: step.text }));
        send(chunk({}, 'stop'));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, seen };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

module.exports = { createModelServer, listen };
