import path from 'path';
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), debug: false, quiet: true });
import { program } from 'commander';
import { build, deriveSpecName } from './build';
import { run } from './run';
import { lint } from './lint';
import { createRuntime, RuntimeName } from './runtime';

program
  .name('ok')
  .description('ok CLI — turn a spec into a running app')
  .version('1.0.0');

program
  .command('build')
  .description('Generate an app from a spec and build it')
  .argument('<filename>', 'path to specification file')
  .option('-r, --runtime <name>', 'runtime to use (docker, daytona, blaxel)', 'docker')
  .action(build);

program
  .command('run')
  .description('Run a previously built app')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port to expose on host', '3000')
  .option('-e, --env <vars...>', 'environment variables to pass (KEY=VALUE)')
  .option('--env-file <path>', 'path to env file to pass')
  .option('-r, --runtime <name>', 'runtime to use (docker, daytona, blaxel)', 'docker')
  .action(run);

program
  .command('serve')
  .description('Generate, build, and run an app from a spec file')
  .argument('<filename>', 'path to specification file')
  .option('-p, --port <number>', 'port to run the app on', '3000')
  .option('-e, --env <vars...>', 'environment variables to pass (KEY=VALUE)')
  .option('--env-file <path>', 'path to env file to pass')
  .option('-r, --runtime <name>', 'runtime to use (docker, daytona, blaxel)', 'docker')
  .action(async (filename: string, opts: Record<string, unknown>) => {
    await build(filename, opts as Parameters<typeof build>[1]);
    await run(filename, opts as Parameters<typeof run>[1]);
  });

program
  .command('lint')
  .description('Check a spec for ambiguity and issues')
  .argument('<filename>', 'path to specification file')
  .option('--fix', 'automatically apply suggested fixes to the spec')
  .action(lint);

program
  .command('stop')
  .description('Stop a running app')
  .argument('<filename>', 'path to specification file')
  .option('-r, --runtime <name>', 'runtime to use (docker, daytona, blaxel)', 'docker')
  .action(async (filename: string, opts: { runtime?: RuntimeName }) => {
    const specName = deriveSpecName(filename);
    const runtime = createRuntime(opts.runtime || 'docker');
    await runtime.stop(specName);
  });

program
  .command('destroy')
  .description('Destroy a built app (remove image/sandbox)')
  .argument('<filename>', 'path to specification file')
  .option('-r, --runtime <name>', 'runtime to use (docker, daytona, blaxel)', 'docker')
  .action(async (filename: string, opts: { runtime?: RuntimeName }) => {
    const specName = deriveSpecName(filename);
    const runtime = createRuntime(opts.runtime || 'docker');
    await runtime.destroy(specName);
  });

program.parse();
