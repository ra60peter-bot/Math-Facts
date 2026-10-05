// Strict no-emit checking of the isolated prototype, including imported real code.
const path = require('node:path');
const ts = require('../web/node_modules/typescript');
const root = __dirname;
const config = ts.parseJsonConfigFileContent({
  compilerOptions: {
    target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], strict: true,
    module: 'ESNext', moduleResolution: 'Bundler', jsx: 'react-jsx',
    esModuleInterop: true, skipLibCheck: true, noEmit: true,
    typeRoots: ['../web/node_modules/@types'],
    baseUrl: '.', paths: {
      react: ['../web/node_modules/@types/react/index.d.ts'],
      'react/*': ['../web/node_modules/@types/react/*'],
      'react-dom': ['../web/node_modules/@types/react-dom/index.d.ts'],
      'react-dom/*': ['../web/node_modules/@types/react-dom/*'],
    },
  },
  include: ['*.ts', '*.tsx'],
}, ts.sys, root);
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => path.resolve(root, '..'),
    getNewLine: () => '\n',
  }));
  process.exitCode = 1;
} else console.log('Design review strict TypeScript check passed (no files emitted).');
