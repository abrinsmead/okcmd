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
  .description('Generate an app from a spec and build a Docker image')
  .argument('<filename>', 'path to specification file')
  .action(build);

program
  .command('run')
  .description('Run a previously built app in Docker')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port to expose on host', '3000')
  .option('-e, --env <vars...>', 'environment variables to pass to the container (KEY=VALUE)')
  .option('--env-file <path>', 'path to env file to pass to the container')
  .action(run);

program
  .command('serve')
  .description('Generate, build, and run an app from a spec file')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port to run the app on', '3000')
  .option('-e, --env <vars...>', 'environment variables to pass to the container (KEY=VALUE)')
  .option('--env-file <path>', 'path to env file to pass to the container')
  .action(async (filename, opts) => {
    await build(filename, opts);
    await run(filename, opts);
  });

program
  .command('stop')
  .description('Stop a running app')
  .argument('<filename>', 'path to specification file')
  .action((filename) => {
    const { spawnSync } = require('child_process');
    const { deriveSpecName } = require('./build');
    const chalk = require('chalk');
    const containerName = `ok-${deriveSpecName(filename)}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const result = spawnSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
    if (result.status === 0) {
      console.log(chalk.dim(`Stopped ${containerName}`));
    } else {
      console.log(chalk.dim(`${containerName} is not running`));
    }
  });

program
  .command('clean')
  .description('Remove build artifacts and Docker images')
  .action(() => {
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    const okBase = path.resolve('.ok');

    if (fs.existsSync(okBase)) {
      fs.rmSync(okBase, { recursive: true });
      console.log('Cleaned .ok/');
    }
  });

program.parse();
