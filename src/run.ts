import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
import { deriveSpecName } from './build';

interface RunOpts {
  port?: string;
  env?: string[];
  envFile?: string;
}

export async function run(filename: string, opts: RunOpts): Promise<void> {
  if (!filename) {
    console.error(chalk.red('Usage: ok run <spec.md>'));
    process.exit(1);
  }

  const port = opts.port || '3000';
  const imageTag = `ok-${deriveSpecName(filename)}:latest`;

  const result = spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' });
  if (result.status !== 0) {
    console.error(chalk.red(`Image ${imageTag} not found. Run \`ok build\` first.`));
    process.exit(1);
  }

  const containerName = imageTag.replace(':latest', '').replace(/[^a-zA-Z0-9_.-]/g, '-');

  // Find any running containers for this image
  const running = spawnSync('docker', ['ps', '-q', '--filter', `ancestor=${imageTag}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const runningIds = running.status === 0 ? running.stdout.trim().split('\n').filter(Boolean) : [];

  if (runningIds.length > 0) {
    // Check if the named container is among them with the same image
    const named = spawnSync('docker', ['inspect', '--format', '{{.Image}}', containerName], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const imageId = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (named.status === 0 && imageId.status === 0 && named.stdout.trim() === imageId.stdout.trim()) {
      console.log(chalk.dim(`Already running ${imageTag} on :${port}`));
      return;
    }
    // Stop all containers for this image (catches old unnamed ones too)
    console.log(chalk.dim('Stopping old container...'));
    spawnSync('docker', ['rm', '-f', ...runningIds], { stdio: 'ignore' });
  }

  // Also remove named container if it exists but isn't running (e.g. crashed)
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

  console.log(chalk.cyan(`Running ${imageTag} on :${port}...`));

  const envArgs: string[] = [];
  if (opts.env) {
    for (const v of opts.env) envArgs.push('-e', v);
  }
  if (opts.envFile) {
    envArgs.push('--env-file', opts.envFile);
  }

  const child = spawn('docker', [
    'run', '--rm', '--init',
    '--name', containerName,
    '-p', `${port}:${port}`,
    '-e', `PORT=${port}`,
    ...envArgs,
    imageTag,
  ], {
    stdio: 'inherit',
  });

  function stop() {
    spawnSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
  }

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}
