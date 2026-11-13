#!/usr/bin/env node
/**
 * 假 Pi CLI：实现 RPC 模式的最小协议子集，用于测试 PiAdapter 的 RPC 传输。
 * 支持命令：prompt / abort / new_session / get_state
 */
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
const log = (...args) => process.stderr.write('[fake-pi] ' + args.join(' ') + '\n');

function send(record) {
  process.stdout.write(JSON.stringify(record) + '\n');
}

let streaming = false;

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    send({ type: 'response', command: 'parse', success: false, error: 'bad json' });
    return;
  }

  if (cmd.type === 'prompt') {
    if (streaming && !cmd.streamingBehavior) {
      send({
        id: cmd.id,
        type: 'response',
        command: 'prompt',
        success: false,
        error: 'agent is streaming'
      });
      return;
    }
    send({
      id: cmd.id,
      type: 'response',
      command: 'prompt',
      success: true,
      data: { disposition: 'started' }
    });

    streaming = true;
    send({ type: 'agent_start', sessionId: 'fake-1' });
    const chunks = ['已读取上下文。', '\n\n建议先检查 ', '`UserService.cs` 的校验逻辑。'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        send({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: chunks[i++], contentIndex: 0 }
        });
        return;
      }
      clearInterval(timer);
      streaming = false;
      send({
        type: 'agent_end',
        sessionId: 'fake-1',
        messages: [{ role: 'assistant', content: chunks.join('') }]
      });
      send({ type: 'agent_settled', sessionId: 'fake-1' });
    }, 10);
    return;
  }

  if (cmd.type === 'abort') {
    streaming = false;
    send({ id: cmd.id, type: 'response', command: 'abort', success: true });
    send({ type: 'agent_settled', sessionId: 'fake-1' });
    return;
  }

  if (cmd.type === 'new_session') {
    send({ id: cmd.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
    return;
  }

  if (cmd.type === 'get_state') {
    send({
      id: cmd.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: { isStreaming: streaming, messageCount: 0 }
    });
    return;
  }

  send({ id: cmd.id, type: 'response', command: cmd.type, success: false, error: 'unsupported' });
});

rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

log('started', process.argv.slice(2).join(' '));
