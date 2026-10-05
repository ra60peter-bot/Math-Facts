// Isolated, local-only design review. No .env files, APIs, or arbitrary file serving.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const root = __dirname;
const web = path.resolve(root, '../web');
const bundled = require(path.join(web, 'node_modules/next/dist/compiled/webpack/webpack.js'));
if (typeof bundled.init === 'function') bundled.init();
const webpack = bundled.webpack;
const onlyBaseline = process.argv.includes('--baseline-only');
const buildOnly = process.argv.includes('--build-only');
const portArg = process.argv.find(value => value.startsWith('--port='));
const port = portArg ? Number(portArg.slice(7)) : 4173;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');

const buildRoot = path.join(root, '.build');
const modelPath = path.join(web, 'public/models/english-numbers-0.15.tar.gz');
if (!onlyBaseline && !fs.existsSync(modelPath)) {
  throw new Error('The existing number model is missing: web/public/models/english-numbers-0.15.tar.gz. Prepare the app\'s pinned model before running the voice preview.');
}

// Each page has a separate compilation. Only the current-interface replay uses
// fake recognition; the proposed design imports the real, unchanged local engine.
function pageConfig(name, baseline) {
  const entryPath = path.join(root, baseline ? 'baseline.tsx' : 'app.tsx');
  if (!fs.existsSync(entryPath)) throw new Error(`${entryPath} is not ready yet.`);
  return {
  name,
  mode: 'development',
  target: 'web',
  devtool: false,
  entry: { [name]: entryPath },
  output: {
    path: buildRoot, filename: '[name].js', publicPath: '/.build/',
    chunkFilename: `${name}/[name].[contenthash:8].js`,
    uniqueName: `auto-math-facts-review-${name}`,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js'],
    modules: [path.join(web, 'node_modules'), 'node_modules'],
    alias: baseline ? {
      [path.join(web, 'lib/number-speech.ts')]: path.join(root, 'baseline-speech.ts'),
      [path.join(web, 'lib/safari-number-audio.ts')]: path.join(root, 'baseline-safari.ts'),
    } : {},
  },
  module: { rules: [{ test: /\.[jt]sx?$/, exclude: /node_modules/, use: path.join(root, 'tsx-loader.cjs') }] },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.NEXT_PUBLIC_SUPABASE_URL': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY': JSON.stringify(''),
      'process.env.NODE_ENV': JSON.stringify('development'),
    }),
    ...(baseline ? [
      new webpack.NormalModuleReplacementPlugin(/(^|[\\/])number-speech$/, resource => { resource.request = path.join(root, 'baseline-speech.ts'); }),
      new webpack.NormalModuleReplacementPlugin(/(^|[\\/])safari-number-audio$/, resource => { resource.request = path.join(root, 'baseline-safari.ts'); }),
    ] : []),
  ],
  performance: { hints: false },
  };
}

const configs = [pageConfig('current', true)];
if (!onlyBaseline) configs.push(pageConfig('mockup', false));
const compiler = webpack(configs);
let server;
let compiledAssets = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gz': 'application/gzip' };
const routes = {
  '/': path.join(root, 'index.html'),
  '/index.html': path.join(root, 'index.html'),
  '/current.html': path.join(root, 'current.html'),
  '/report.html': path.join(root, 'report.html'),
  '/sizes.html': path.join(root, 'sizes.html'),
  '/sizes.js': path.join(root, 'sizes.js'),
  '/styles.css': path.join(root, 'styles.css'),
  '/current.css': path.join(web, 'app/globals.css'),
  '/redesign.css': path.join(web, 'app/redesign.css'),
  '/number-capture.worklet.js': path.join(web, 'public/number-capture.worklet.js'),
  '/models/english-numbers-0.15.tar.gz': modelPath,
};
for (const name of ['party-blob', 'laughing-blob', 'cool-blob']) routes[`/celebration/${name}.svg`] = path.join(web, `public/celebration/${name}.svg`);

function serve() {
  server = http.createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end('This review server has no write endpoints.'); return; }
    const host = request.headers.host || '';
    if (![`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host)) { response.writeHead(403); response.end('Local review only.'); return; }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname); }
    catch { response.writeHead(400); response.end('Invalid path.'); return; }
    // Dynamic import chunks must have been emitted by these compilations;
    // never turn an arbitrary /.build/ request into a filesystem path.
    let filename = routes[pathname] || compiledAssets.get(pathname);
    if (!filename && pathname.startsWith('/assets/')) {
      const assets = path.join(root, 'assets');
      const candidate = path.resolve(assets, pathname.slice('/assets/'.length));
      if (candidate.startsWith(assets + path.sep) && Object.keys(mime).includes(path.extname(candidate))) filename = candidate;
    }
    if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { response.writeHead(404); response.end('Not found in this design review.'); return; }
    const proposedPage = pathname === '/' || pathname === '/index.html';
    const sharedPolicy = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'";
    // vosk-browser 0.0.8 embeds a blob worker and WASM. Its Emscripten bindings
    // use new Function, requiring unsafe-eval as well as the worker allowance.
    // These permissions apply only to the isolated proposed page, never replay.
    const speechPolicy = "script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:; connect-src 'self'";
    const replayPolicy = "script-src 'self'; worker-src 'none'; connect-src 'none'";
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': fs.statSync(filename).size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `${sharedPolicy}; ${proposedPage ? speechPolicy : replayPolicy}`,
      'Permissions-Policy': `microphone=${proposedPage ? '(self)' : '()'}, camera=(), geolocation=()`,
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(filename).pipe(response);
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; compiler.close(() => process.exit(1)); });
  server.listen(port, '127.0.0.1', () => console.log(`Local design review: http://localhost:${port}/\nCurrent-interface replay: http://localhost:${port}/current.html\nProposed design: real local microphone recognition. Replay: simulated speech. Fictional progress; no production connection.`));
}
function onBuild(error, stats) {
  if (error || stats?.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    if (buildOnly) { compiler.close(() => { process.exitCode = 1; }); }
    return;
  }
  const nextAssets = new Map();
  for (const pageStats of stats.stats || [stats]) {
    for (const asset of pageStats.compilation.getAssets()) {
      const filename = path.resolve(buildRoot, asset.name);
      if (filename.startsWith(buildRoot + path.sep) && ['.js', '.wasm'].includes(path.extname(filename))) {
        nextAssets.set(`/.build/${asset.name.replaceAll('\\', '/')}`, filename);
      }
    }
  }
  compiledAssets = nextAssets;
  console.log(`Built ${configs.map(config => config.name).join(' and ')}.`);
  if (buildOnly) compiler.close(() => {});
  else if (!server) serve();
}
if (buildOnly) compiler.run(onBuild);
else compiler.watch({ ignored: /node_modules/ }, onBuild);
process.on('SIGINT', () => { server?.close(); compiler.close(() => process.exit(0)); });
