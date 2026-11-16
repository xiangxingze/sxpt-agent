const Module = require('module');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, parent, ...options) {
  if (path.isAbsolute(request) && request.startsWith(path.join(root, 'out') + path.sep)) {
    const source = request.replace(path.join(root, 'out'), path.join(root, 'src')).replace(/\.js$/, '.ts');
    if (fs.existsSync(source)) return source;
  }
  return originalResolve.call(this, request, parent, ...options);
};
Module._extensions['.ts'] = function (module, filename) {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  });
  module._compile(result.outputText, filename);
};
