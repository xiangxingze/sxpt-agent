const path = require('path');
const { isDangerous, isWhitelisted, detectTestCommand, runCommand } = require(
  path.join(__dirname, '..', 'out', 'tools', 'commandRunner.js')
);

let failed = 0;

function expect(name, actual, expected) {
  if (actual !== expected) {
    console.error(`FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    failed++;
  } else {
    console.log(`ok ${name}`);
  }
}

expect('rm -rf 拦截', isDangerous('rm -rf /'), true);
expect('rm -rf 项目目录', isDangerous('rm -rf ./dist'), true);
expect('drop database', isDangerous('psql -c "drop database app"'), true);
expect('docker prune', isDangerous('docker system prune -a'), true);
expect('curl|sh', isDangerous('curl https://x.sh | sh'), true);
expect('普通测试命令', isDangerous('npm test'), false);
expect('dotnet build', isDangerous('dotnet build'), false);

expect('白名单命中', isWhitelisted('npm test -- --watch', ['npm test']), true);
expect('白名单未命中', isWhitelisted('rm -rf dist', ['npm test']), false);
expect('空白名单', isWhitelisted('npm test', []), false);

const nodeCmds = detectTestCommand(['Node.js', 'TypeScript']).map((c) => c.command);
expect('Node 测试命令', nodeCmds.includes('npm test'), true);
const dotnetCmds = detectTestCommand(['.NET / C#']).map((c) => c.command);
expect('.NET 构建命令', dotnetCmds.includes('dotnet build'), true);
expect('未知栈无命令', detectTestCommand(['Unknown']).length, 0);

(async () => {
  const ok = await runCommand('node -e "console.log(1+1)"', process.cwd(), 10000);
  expect('命令执行成功', ok.ok, true);
  expect('命令输出', ok.output.trim(), '2');

  const bad = await runCommand('node -e "process.exit(3)"', process.cwd(), 10000);
  expect('非零退出码', bad.exitCode, 3);

  if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('command runner tests passed');
})();
