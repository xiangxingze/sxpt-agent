const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode-stub';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode-stub'] = {
  id: 'vscode-stub',
  filename: 'vscode-stub',
  loaded: true,
  exports: { Uri: { file: (p) => ({ fsPath: p }) }, Range: class {}, WorkspaceEdit: class {} }
};

const { parsePatches, resolvePatch } = require(path.join(__dirname, '..', 'out', 'patch.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptn-'));
const file = path.join(tmpDir, 'Sample.cs');
fs.writeFileSync(
  file,
  ['class A', '{', '    void Run()', '    {', '        var user = new User();', '    }', '}'].join('\n'),
  'utf8'
);

const answer = [
  '```ptn-patch',
  'file: Sample.cs',
  '<<<<<<< SEARCH',
  '        var user = new User();',
  '=======',
  '        Validate(dto);',
  '        var user = new User();',
  '>>>>>>> REPLACE',
  '```'
].join('\n');

const patches = parsePatches(answer);
console.log('parsed:', patches.length);

const resolved = resolvePatch(tmpDir, patches[0]);
if (!resolved) {
  console.error('resolve failed');
  process.exit(1);
}
console.log('line range:', resolved.startLine, '-', resolved.endLine);
const expected = fs
  .readFileSync(file, 'utf8')
  .replace('        var user = new User();', '        Validate(dto);\n        var user = new User();');
if (resolved.proposedText !== expected) {
  console.error('proposed text mismatch');
  console.error('got:\n' + resolved.proposedText);
  process.exitCode = 1;
} else {
  console.log('resolve test passed');
}

const fuzzyPatch = {
  file: 'Sample.cs',
  search: 'void Run()\n{\nvar user = new User();',
  replace: 'void Run()\n{\n  Check();\n  var user = new User();'
};
const fuzzy = resolvePatch(tmpDir, fuzzyPatch);
console.log('fuzzy matched:', !!fuzzy, fuzzy ? `lines ${fuzzy.startLine}-${fuzzy.endLine}` : '');
if (!fuzzy) process.exitCode = 1;

fs.rmSync(tmpDir, { recursive: true, force: true });
