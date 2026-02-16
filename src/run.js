const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const okDir = path.resolve('.ok');

function readName() {
  const nameFile = path.join(okDir, 'name');
  if (!fs.existsSync(nameFile)) {
    console.error('Error: No build found. Run `ok build` first.');
    process.exit(1);
  }
  return fs.readFileSync(nameFile, 'utf-8').trim();
}

async function run(opts) {
  const port = opts.port || '3000';
  const name = readName();
  const imageTag = `ok-${name}:latest`;

  const result = spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' });
  if (result.status !== 0) {
    console.error(`Error: Image ${imageTag} not found. Run \`ok build\` first.`);
    process.exit(1);
  }

  console.log(`Running ${imageTag} on port ${port}...`);

  const child = spawn('docker', [
    'run', '--rm',
    '-p', `${port}:3000`,
    imageTag,
  ], {
    stdio: 'inherit',
  });

  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  child.on('exit', (code) => process.exit(code ?? 0));
}

module.exports = { run };
