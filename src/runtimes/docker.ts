import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
import * as ui from '../ui';
import type { Runtime, RunOpts } from '../runtime';

const okDir = path.resolve('.ok');
const BUILDER_BASE = 'ok-builder-base:latest';

export class DockerRuntime implements Runtime {
  imageExists(imageTag: string): boolean {
    return spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' }).status === 0;
  }

  extractSpec(imageTag: string): string | null {
    const cid = spawnSync('docker', ['create', imageTag], { encoding: 'utf-8' });
    if (cid.status !== 0) return null;

    const containerId = cid.stdout.trim();
    const tmpSpec = path.join(okDir, '.tmp-spec.md');
    fs.mkdirSync(okDir, { recursive: true });
    spawnSync('docker', ['cp', `${containerId}:/app/spec.md`, tmpSpec]);
    spawnSync('docker', ['rm', containerId], { stdio: 'ignore' });

    try {
      const spec = fs.readFileSync(tmpSpec, 'utf-8');
      fs.unlinkSync(tmpSpec);
      return spec;
    } catch {
      return null;
    }
  }

  private async ensureBuilderBase(): Promise<void> {
    if (this.imageExists(BUILDER_BASE)) return;
    ui.step('Building base image (one-time)');
    ui.bar();
    const tmpDir = path.join(okDir, '.base');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), `FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code
RUN adduser -D builder
RUN mkdir -p /app && chown builder /app
WORKDIR /app
USER builder
`);
    const proc = spawn('docker', ['build', '-t', BUILDER_BASE, tmpDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    ui.prefixStream(proc.stdout);
    ui.prefixStream(proc.stderr);

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on('close', resolve);
    });

    fs.rmSync(tmpDir, { recursive: true, force: true });

    if (exitCode !== 0) {
      ui.error('Failed to build base image');
      process.exit(1);
    }
    ui.stepDone('Base image ready');
    ui.bar();
  }

  private generateDockerfile(isUpdate: boolean, imageTag: string): string {
    const builderFrom = isUpdate
      ? `FROM ${imageTag} AS prev
FROM ${BUILDER_BASE} AS builder
COPY --from=prev /app/ .`
      : `FROM ${BUILDER_BASE} AS builder`;

    return `# syntax=docker/dockerfile:1
${builderFrom}
COPY --chown=builder spec.md .
COPY --chown=builder builder.mjs .
RUN --mount=type=secret,id=api_key,mode=0444 \\
    ANTHROPIC_API_KEY=$(cat /run/secrets/api_key) \\
    node builder.mjs

# Clean runtime image
FROM node:lts-alpine
WORKDIR /app
COPY --from=builder /app/ .
RUN rm -f builder.mjs
EXPOSE 3000
CMD ["sh", "start.sh"]
`;
  }

  async build(specName: string, specContent: string): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) {
      ui.error('Missing ANTHROPIC_API_KEY in .env');
      process.exit(1);
    }

    const imageTag = `ok-${specName}:latest`;

    ui.intro(`ok build ${chalk.bold(specName)}`);

    // Check existing image
    ui.step('Checking for existing image');
    const hasImage = this.imageExists(imageTag);
    if (hasImage) {
      const oldSpec = this.extractSpec(imageTag);
      if (oldSpec === specContent) {
        ui.stepDone('Spec unchanged — skipping build');
        ui.outro(chalk.dim('Nothing to do'));
        return;
      }
      ui.info('Spec changed — rebuilding');
    } else {
      ui.info('No existing image found');
    }
    ui.bar();

    // Ensure builder base image exists
    await this.ensureBuilderBase();

    // Stage build context
    ui.step('Staging build context');
    fs.mkdirSync(okDir, { recursive: true });
    fs.writeFileSync(path.join(okDir, 'spec.md'), specContent);
    fs.copyFileSync(path.resolve(__dirname, '..', '..', 'src', 'builder.mjs'), path.join(okDir, 'builder.mjs'));
    fs.writeFileSync(path.join(okDir, 'Dockerfile'), this.generateDockerfile(hasImage, imageTag));

    const keyFile = path.join(okDir, '.api_key');
    fs.writeFileSync(keyFile, process.env.ANTHROPIC_API_KEY, { mode: 0o600 });
    ui.stepDone('Build context staged');
    ui.bar();

    // Build
    ui.step(`${hasImage ? 'Updating' : 'Building'} ${chalk.bold(imageTag)}`);
    ui.bar();

    const buildProc = spawn('docker', [
      'build',
      '--secret', `id=api_key,src=${keyFile}`,
      '-t', imageTag,
      okDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    ui.prefixStream(buildProc.stdout);
    ui.prefixStream(buildProc.stderr);

    const exitCode = await new Promise<number | null>((resolve) => {
      buildProc.on('close', resolve);
    });

    ui.bar();

    if (exitCode !== 0) {
      ui.error(`Docker build failed (exit ${exitCode})`);
      fs.rmSync(okDir, { recursive: true, force: true });
      process.exit(1);
    }

    // Clean up
    fs.rmSync(okDir, { recursive: true, force: true });

    ui.outro(`${chalk.green('Done!')} Built ${chalk.bold(imageTag)}`);
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const port = opts.port || '3000';
    const imageTag = `ok-${specName}:latest`;

    const result = spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' });
    if (result.status !== 0) {
      ui.error(`Image ${imageTag} not found. Run \`ok build\` first.`);
      process.exit(1);
    }

    const containerName = imageTag.replace(':latest', '').replace(/[^a-zA-Z0-9_.-]/g, '-');

    // Find any running containers for this image
    const running = spawnSync('docker', ['ps', '-q', '--filter', `ancestor=${imageTag}`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const runningIds = running.status === 0 ? running.stdout.trim().split('\n').filter(Boolean) : [];

    if (runningIds.length > 0) {
      const named = spawnSync('docker', ['inspect', '--format', '{{.Image}}', containerName], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const imageId = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (named.status === 0 && imageId.status === 0 && named.stdout.trim() === imageId.stdout.trim()) {
        ui.info(`Already running ${imageTag} on :${port}`);
        return;
      }
      ui.info('Stopping old container...');
      spawnSync('docker', ['rm', '-f', ...runningIds], { stdio: 'ignore' });
    }

    // Also remove named container if it exists but isn't running
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

    ui.intro(`ok run ${chalk.bold(specName)}`);
    ui.step(`Starting on port ${chalk.bold(port)}`);
    ui.bar();

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

    function stopContainer() {
      spawnSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
    }

    process.on('SIGINT', stopContainer);
    process.on('SIGTERM', stopContainer);
    child.on('exit', (code) => process.exit(code ?? 0));
  }

  async stop(specName: string): Promise<void> {
    const containerName = `ok-${specName}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const result = spawnSync('docker', ['stop', '-t', '2', containerName], { stdio: 'ignore' });
    if (result.status === 0) {
      ui.success(`Stopped ${containerName}`);
    } else {
      ui.info(`${containerName} is not running`);
    }
  }

  async destroy(specName: string): Promise<void> {
    const imageTag = `ok-${specName}:latest`;
    const containerName = `ok-${specName}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

    // Stop and remove any running containers first
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

    const result = spawnSync('docker', ['rmi', imageTag], { stdio: 'ignore' });
    if (result.status === 0) {
      ui.success(`Removed image ${imageTag}`);
    } else {
      ui.info(`Image ${imageTag} not found`);
    }
  }
}
