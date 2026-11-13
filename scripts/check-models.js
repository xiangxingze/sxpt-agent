const path = require('path');
const { parseModelList, fetchModels, testConnection, toFriendlyError } = require(path.join(__dirname, '..', 'out', 'modelCheck.js'));
const { createModelServer, listen } = require('./fake-model');

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ---- 解析：三种常见响应形态 ----
  expect('OpenAI 形态 {data:[{id}]}', eq(parseModelList({ data: [{ id: 'b' }, { id: 'a' }] }), ['a', 'b']));
  expect('Ollama/部分网关 {models:[{name}]}', eq(parseModelList({ models: [{ name: 'qwen2.5-coder' }, { model: 'llama3' }] }), ['llama3', 'qwen2.5-coder']));
  expect('纯数组（字符串或对象）', eq(parseModelList(['x', { id: 'y' }]), ['x', 'y']));
  expect('去重并排序', eq(parseModelList({ data: [{ id: 'm' }, { id: 'm' }, { id: 'a' }] }), ['a', 'm']));
  expect('过滤嵌入/语音/绘图模型', eq(parseModelList({ data: [{ id: 'gpt-4o' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'dall-e-3' }] }), ['gpt-4o']));
  expect('全是非对话模型时保留原列表', eq(parseModelList({ data: [{ id: 'text-embedding-x' }] }), ['text-embedding-x']));
  expect('空或非法输入', parseModelList(undefined).length === 0 && parseModelList({}).length === 0 && parseModelList('x').length === 0);
  expect('忽略没有 id 的条目', eq(parseModelList({ data: [{}, { id: '' }, { id: 'ok' }, null] }), ['ok']));

  // ---- fetchModels：按学生填写的地址请求 ----
  {
    const { server, seen } = createModelServer([], { models: ['sl/gpt-6.1-sol', 'deepseek-chat', 'text-embedding-3'] });
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/v1`;
    const r = await fetchModels(base, 'my-key');
    expect('从配置的地址获取模型列表', r.ok && eq(r.models, ['deepseek-chat', 'sl/gpt-6.1-sol']), JSON.stringify(r));
    expect('带上 Bearer Key', seen.listAuth === 'Bearer my-key', seen.listAuth);
    const noKey = await fetchModels(base, undefined);
    expect('没有 Key 时不发送 Authorization', noKey.ok && seen.listAuth === undefined, String(seen.listAuth));
    server.close();
  }
  {
    const { server } = createModelServer([], {});
    const port = await listen(server);
    const r = await fetchModels(`http://127.0.0.1:${port}/v1`, 'k');
    expect('接口没有 /models 时给出手动输入提示', !r.ok && /手动输入/.test(r.message), JSON.stringify(r));
    server.close();
  }
  {
    const { server } = createModelServer([], { modelsStatus: 401 });
    const port = await listen(server);
    const r = await fetchModels(`http://127.0.0.1:${port}/v1`, 'bad');
    expect('401 提示检查 Key', !r.ok && /Key/.test(r.message), JSON.stringify(r));
    server.close();
  }
  {
    const { server } = createModelServer([], { models: [] });
    const port = await listen(server);
    const r = await fetchModels(`http://127.0.0.1:${port}/v1`, 'k');
    expect('列表为空时提示手动输入', !r.ok && /手动输入/.test(r.message), JSON.stringify(r));
    server.close();
  }
  {
    const r = await fetchModels('http://127.0.0.1:9/v1', 'k');
    expect('连接被拒绝时给出可读错误', !r.ok && r.message && r.message.length > 0, JSON.stringify(r));
    const empty = await fetchModels('', 'k');
    expect('地址为空时提示先填写', !empty.ok && /API 地址/.test(empty.message));
  }

  // ---- testConnection ----
  {
    const { server } = createModelServer([{ text: 'pong' }]);
    const port = await listen(server);
    const base = `http://127.0.0.1:${port}/v1`;
    const ok = await testConnection(base, 'test-model', 'k');
    expect('连接测试成功', ok.ok && /test-model/.test(ok.message), JSON.stringify(ok));
    const missing = await testConnection(base, '', 'k');
    expect('缺少模型名时提示', !missing.ok && /模型/.test(missing.message));
    server.close();
  }
  {
    const { server } = createModelServer([{ status: 401, message: 'Invalid API key' }]);
    const port = await listen(server);
    const r = await testConnection(`http://127.0.0.1:${port}/v1`, 'm', 'bad');
    expect('401 给出鉴权失败提示', !r.ok && /鉴权失败/.test(r.message), JSON.stringify(r));
    server.close();
  }

  // ---- 错误友好化 ----
  expect('友好化：鉴权', /鉴权失败/.test(toFriendlyError(new Error('401 Unauthorized'))));
  expect('友好化：模型不存在', /不存在/.test(toFriendlyError(new Error('404 model not found'))));
  expect('友好化：限流', /频率|额度/.test(toFriendlyError(new Error('429 Too Many Requests'))));
  expect('友好化：连接被拒', /连接被拒绝/.test(toFriendlyError(new Error('connect ECONNREFUSED 127.0.0.1:1'))));
  expect('友好化：未知错误原样返回', toFriendlyError(new Error('boom')) === 'boom');

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('model check tests passed');
}

main().catch((err) => {
  console.error('FATAL', err.stack || err.message);
  process.exit(1);
});
