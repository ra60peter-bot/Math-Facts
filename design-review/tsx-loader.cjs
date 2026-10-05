const path = require('node:path');
const ts = require(path.join(__dirname, '../web/node_modules/typescript'));

module.exports = function transpile(source) {
  const result = ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      sourceMap: false,
    },
  });
  return result.outputText;
};
