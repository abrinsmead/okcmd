// Deprecated: serve logic has moved to build.js + run.js
const { build } = require('./build');
const { run } = require('./run');

async function serve(filename, opts) {
  await build(filename, opts);
  await run(opts);
}

module.exports = { serve };
