const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), debug: false, quiet: true });
const { program } = require('commander');
const { build } = require('./build');
const { run } = require('./run');

program
  .name('ok')
  .description('ok CLI — turn a spec into a running app')
  .version('1.0.0');

program
  .command('build')
  .description('Generate a Deno app from a spec and build a Docker image')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port for validation', '3000')
  .action(build);

program
  .command('run')
  .description('Run a previously built app in Docker')
  .option('-p, --port <number>', 'port to expose on host', '3000')
  .action(run);

program
  .command('serve')
  .description('Generate, build, and run a Deno app from a spec file')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port to run the app on', '3000')
  .action(async (filename, opts) => {
    await build(filename, opts);
    await run(opts);
  });

program
  .command('clean')
  .description('Remove build artifacts and Docker images')
  .action(() => {
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const okBase = path.resolve('.ok');

    // Read name before deleting
    const nameFile = path.join(okBase, 'name');
    let name = null;
    if (fs.existsSync(nameFile)) {
      name = fs.readFileSync(nameFile, 'utf-8').trim();
    }

    if (fs.existsSync(okBase)) {
      fs.rmSync(okBase, { recursive: true });
      console.log('Cleaned .ok/');
    }

    if (name) {
      const imageTag = `ok-${name}:latest`;
      const result = spawnSync('docker', ['rmi', imageTag], { stdio: 'ignore' });
      if (result.status === 0) {
        console.log(`Removed image ${imageTag}`);
      }
    }
  });

program.parse();
