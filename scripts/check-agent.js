/**
 * Agent 端到端自检：真实 Pi SDK + 脚本化的假 OpenAI 兼容服务 + 假宿主（审批/快照）。
 * 验证 tool_call 拦截链路：路径围栏、敏感文件、Diff 预览、审批、快照、命令分级、自定义工具、取消。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const { PiAgent } = require(path.join(__dirname, '..', 'out', 'agent', 'piAgent.js'));
const { createModelServer, listen } = require('./fake-model');

let fail = 0;
function expect(name, cond, extra) {
  if (cond) console.log('ok ' + name);
  else {
    console.error('FAIL ' + name + (extra !== undefined ? ' -> ' + extra : ''));
    fail++;
  }
}

function makeSettings(port, cwd, overrides) {
  return Object.assign(
    {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      apiKey: 'test-key',
      cwd,
      roots: [cwd],
      approvalMode: 'ask',
      allowedCommands: [],
      commandTimeoutMs: 20000,
      runTimeoutMs: 60000,
      contextWindow: 128000,
      maxOutputTokens: 4096,
      systemPromptExtra: ''
    },
    overrides || {}
  );
}

function makeHost(decisions) {
  const calls = { approvals: [], snapshots: [], plans: [], diag: [] };
  const host = {
    calls,
    requestApproval: async (req, signal) => {
      calls.approvals.push(req);
      const d = decisions.shift() || 'allow';
      if (d === 'hang') {
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve('deny')));
      }
      return d;
    },
    beforeWrite: async (p) => {
      calls.snapshots.push(p);
    },
    isDirty: (p) => !!host.dirty && host.dirty.includes(p),
    getDiagnostics: async (p) => {
      calls.diag.push(p);
      return 'a.txt:1:1 [error] fake diagnostic';
    },
    onPlan: (steps) => calls.plans.push(steps)
  };
  return host;
}

function collectEvents() {
  const ev = { text: '', tools: [], ends: [], status: [], resets: 0 };
  return {
    ev,
    handlers: {
      onTextDelta: (t) => (ev.text += t),
      onTextReset: () => ev.resets++,
      onToolStart: (i) => ev.tools.push(i),
      onToolEnd: (i) => ev.ends.push(i),
      onStatus: (s) => ev.status.push(s)
    }
  };
}

async function main() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-agent-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-agent-out-'));
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-agent-store-'));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hello world\nsecond line\n');
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=abcdefgh12345\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.mkdirSync(path.join(ws, '.git'));
  fs.writeFileSync(path.join(ws, '.git', 'config'), '[core]\n');

  // ================= 场景 1：完整的多步工具链 =================
  const steps = [
    { tool: 'read', args: { path: 'a.txt' } }, // 0
    { tool: 'read', args: { path: '.env' } }, // 1 敏感文件
    { tool: 'read', args: { path: path.join(outside, 'secret.txt') } }, // 2 工作区外
    { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'hello world', newText: 'hi there' }] } }, // 3 批准
    { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'NOT PRESENT', newText: 'x' }] } }, // 4 找不到
    { tool: 'write', args: { path: 'b.txt', content: 'new file\n' } }, // 5 拒绝
    { tool: 'write', args: { path: '.git/config', content: 'evil' } }, // 6 .git
    { tool: 'bash', args: { command: 'rm -rf /' } }, // 7 高危
    { tool: 'bash', args: { command: 'node -e "console.log(6*7)"' } }, // 8 批准并执行
    { tool: 'get_diagnostics', args: { path: 'a.txt' } }, // 9
    { tool: 'update_plan', args: { steps: [{ step: '读取', status: 'completed' }, { step: '修改', status: 'in_progress' }] } }, // 10
    { tool: 'write', args: { path: 'c.txt', content: 'c\n' } }, // 11 allowAllEdits
    { tool: 'write', args: { path: 'd.txt', content: 'd\n' } }, // 12 之后自动放行
    { text: '全部完成' } // 13
  ];
  const { server, seen } = createModelServer(steps);
  const port = await listen(server);
  // 审批依次：edit a.txt=allow；write b.txt=deny；bash node=allow；write c.txt=allowAllEdits
  const host = makeHost(['allow', 'deny', 'allow', 'allowAllEdits']);
  const agent = new PiAgent(host, () => undefined, storage);
  const { ev, handlers } = collectEvents();

  let result;
  try {
    result = await agent.run(
      { prompt: '做一些事', history: [], settings: makeSettings(port, ws), signal: new AbortController().signal },
      handlers
    );
  } catch (err) {
    console.error('ERROR', err.stack || err.message);
    fail++;
  }

  if (result) {
    expect('最终文本', result.text === '全部完成', result.text);
    expect('工具调用计数', result.toolCalls === 13, String(result.toolCalls));
    expect('文本被流式推送', ev.text.includes('全部完成'), ev.text);
    expect('向模型声明了编辑与命令工具', ['edit', 'write', 'bash', 'get_diagnostics', 'update_plan'].every((n) => seen[0].toolNames.includes(n)), seen[0].toolNames.join(','));
    expect('系统提示词是我们的教学提示词', /PTN AI Coding Agent/.test(seen[0].system || '') && !/running inside pi/.test(seen[0].system || ''), (seen[0].system || '').slice(0, 60));

    const toolEnd = (i) => ev.ends[i];
    expect('读取普通文件成功', toolEnd(0).ok === true);
    expect('读取 .env 被拦截', toolEnd(1).ok === false && /密钥|凭据/.test(toolEnd(1).summary), JSON.stringify(toolEnd(1)));
    expect('工作区外路径被拦截', toolEnd(2).ok === false && /工作区之外/.test(toolEnd(2).summary), JSON.stringify(toolEnd(2)));

    expect('edit 经审批后写入', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8') === 'hi there\nsecond line\n', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'));
    expect('edit 前保存了快照', host.calls.snapshots.includes(path.join(ws, 'a.txt')));
    const editReq = host.calls.approvals[0];
    expect('审批请求携带 Diff 内容', editReq.kind === 'edit' && editReq.original.startsWith('hello world') && editReq.proposed.startsWith('hi there') && editReq.added === 1 && editReq.removed === 1, JSON.stringify({ k: editReq.kind, a: editReq.added, r: editReq.removed }));

    expect('找不到 oldText 的 edit 被拦截且未请求审批', toolEnd(4).ok === false && host.calls.approvals.filter((r) => r.kind === 'edit').length === 1, JSON.stringify(toolEnd(4)));
    expect('write 被拒绝后文件未创建', !fs.existsSync(path.join(ws, 'b.txt')));
    expect('拒绝理由回传给模型', /拒绝/.test(seen[6].lastToolContent || ''), seen[6].lastToolContent);
    expect('写 .git 被拦截', toolEnd(6).ok === false && /\.git/.test(toolEnd(6).summary) && fs.readFileSync(path.join(ws, '.git', 'config'), 'utf8') === '[core]\n', JSON.stringify(toolEnd(6)));
    expect('高危命令被拦截且未请求审批', toolEnd(7).ok === false && /拒绝|高危/.test(toolEnd(7).summary) && !host.calls.approvals.some((r) => r.command === 'rm -rf /'), JSON.stringify(toolEnd(7)));
    expect('命令经审批后执行', toolEnd(8).ok === true && /42/.test(seen[9].lastToolContent || ''), seen[9].lastToolContent);
    const bashReq = host.calls.approvals.find((r) => r.kind === 'bash');
    expect('命令审批请求携带命令与目录', bashReq && /6\*7/.test(bashReq.command) && bashReq.cwd === ws);
    expect('get_diagnostics 工具可用', host.calls.diag[0] === 'a.txt' && /fake diagnostic/.test(seen[10].lastToolContent || ''), seen[10].lastToolContent);
    expect('update_plan 工具可用', host.calls.plans.length === 1 && host.calls.plans[0].length === 2);
    expect('allowAllEdits 后写入 c.txt', fs.existsSync(path.join(ws, 'c.txt')));
    expect('allowAllEdits 后 d.txt 不再请求审批', fs.existsSync(path.join(ws, 'd.txt')) && host.calls.approvals.filter((r) => r.kind === 'write').length === 2, String(host.calls.approvals.length));
    expect('自动放行的写入也保存了快照', host.calls.snapshots.includes(path.join(ws, 'd.txt')));
    expect('autoEdits 状态可读', agent.autoEditsEnabled === true);
  }

  // 新建会话后「本次会话自动允许」被清除
  await agent.reset();
  expect('reset 清除自动允许状态', agent.autoEditsEnabled === false);
  agent.dispose();
  server.close();

  // ================= 场景 2：只读模式 =================
  {
    const { server: s2, seen: seen2 } = createModelServer([
      { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'hi there', newText: 'HACK' }] } },
      { text: '好的' }
    ]);
    const p2 = await listen(s2);
    const h2 = makeHost([]);
    const a2 = new PiAgent(h2, () => undefined, storage);
    const c2 = collectEvents();
    await a2.run(
      { prompt: '改它', history: [], settings: makeSettings(p2, ws, { approvalMode: 'readOnly' }), signal: new AbortController().signal },
      c2.handlers
    );
    expect('只读模式不向模型声明写入工具', !['edit', 'write', 'bash'].some((n) => seen2[0].toolNames.includes(n)), seen2[0].toolNames.join(','));
    expect('只读模式文件未被改动', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8').startsWith('hi there'));
    expect('只读模式没有审批请求', h2.calls.approvals.length === 0);
    a2.dispose();
    s2.close();
  }

  // ================= 场景 3：autoEdit 模式 + 编辑器有未保存修改 =================
  {
    const { server: s3, seen: seen3 } = createModelServer([
      { tool: 'edit', args: { path: 'a.txt', edits: [{ oldText: 'second line', newText: '第二行' }] } },
      { text: 'done' }
    ]);
    const p3 = await listen(s3);
    const h3 = makeHost([]);
    const a3 = new PiAgent(h3, () => undefined, storage);
    const c3 = collectEvents();
    await a3.run(
      { prompt: '改它', history: [], settings: makeSettings(p3, ws, { approvalMode: 'autoEdit' }), signal: new AbortController().signal },
      c3.handlers
    );
    expect('autoEdit 不请求审批但仍保存快照', h3.calls.approvals.length === 0 && h3.calls.snapshots.length >= 1);
    expect('autoEdit 修改已应用', fs.readFileSync(path.join(ws, 'a.txt'), 'utf8').includes('第二行'));
    // 第二次：标记为未保存
    h3.dirty = [path.join(ws, 'a.txt')];
    const { server: s3b, seen: seen3b } = createModelServer([
      { tool: 'write', args: { path: 'a.txt', content: 'dirty overwrite' } },
      { text: 'done' }
    ]);
    const p3b = await listen(s3b);
    const c3b = collectEvents();
    await a3.run(
      { prompt: '再改', history: [], settings: makeSettings(p3b, ws, { approvalMode: 'autoEdit' }), signal: new AbortController().signal },
      c3b.handlers
    );
    expect('编辑器有未保存修改时拒绝写入', c3b.ev.ends[0].ok === false && /未保存/.test(c3b.ev.ends[0].summary) && !fs.readFileSync(path.join(ws, 'a.txt'), 'utf8').includes('dirty overwrite'), JSON.stringify(c3b.ev.ends[0]));
    a3.dispose();
    s3.close();
    s3b.close();
  }

  // ================= 场景 4：停止（审批挂起时取消） =================
  {
    const { server: s4 } = createModelServer([
      { tool: 'write', args: { path: 'never.txt', content: 'x' } },
      { text: 'unreachable' }
    ]);
    const p4 = await listen(s4);
    const h4 = makeHost(['hang']);
    const a4 = new PiAgent(h4, () => undefined, storage);
    const c4 = collectEvents();
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 2500);
    let r4;
    let err4;
    try {
      r4 = await a4.run({ prompt: '写文件', history: [], settings: makeSettings(p4, ws), signal: ctl.signal }, c4.handlers);
    } catch (e) {
      err4 = e;
    }
    expect('审批挂起时可被停止', r4 && r4.aborted === true && !err4, err4 && err4.message);
    expect('停止后文件未写入', !fs.existsSync(path.join(ws, 'never.txt')));
    a4.dispose();
    s4.close();
  }

  // ================= 场景 5：模型接口报错应抛出可读错误 =================
  {
    const { server: s5 } = createModelServer([{ status: 401, message: 'Invalid API key' }]);
    const p5 = await listen(s5);
    const a5 = new PiAgent(makeHost([]), () => undefined, storage);
    const c5 = collectEvents();
    let msg = '';
    try {
      await a5.run({ prompt: 'hi', history: [], settings: makeSettings(p5, ws), signal: new AbortController().signal }, c5.handlers);
      msg = 'no-error';
    } catch (e) {
      msg = e.message;
    }
    expect('接口 401 时抛出带原因的错误', msg !== 'no-error' && /401|Invalid API key|auth/i.test(msg), msg);
    a5.dispose();
    s5.close();
  }

  // ================= 场景 6：多轮会话 & 重建时补全历史 =================
  {
    const { server: s6, seen: seen6 } = createModelServer([{ text: '第一轮' }, { text: '第二轮' }]);
    const p6 = await listen(s6);
    const a6 = new PiAgent(makeHost([]), () => undefined, storage);
    const c6 = collectEvents();
    const st = makeSettings(p6, ws);
    await a6.run({ prompt: '问题一', history: [{ role: 'user', content: '更早的问题' }, { role: 'assistant', content: '更早的回答' }], settings: st, signal: new AbortController().signal }, c6.handlers);
    await a6.run({ prompt: '问题二', history: [], settings: st, signal: new AbortController().signal }, c6.handlers);
    expect('多轮会话成功', c6.ev.text.includes('第二轮'));
    a6.dispose();
    s6.close();
  }

  for (const d of [ws, outside, storage]) {
    fs.rmSync(d, { recursive: true, force: true });
  }

  if (fail > 0) {
    console.error(fail + ' check(s) failed');
    process.exit(1);
  }
  console.log('agent end-to-end tests passed');
}

main().catch((err) => {
  console.error('FATAL', err.stack || err.message);
  process.exit(1);
});
