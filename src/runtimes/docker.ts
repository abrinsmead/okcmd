import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import chalk from 'chalk';
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

  private ensureBuilderBase(): void {
    if (this.imageExists(BUILDER_BASE)) return;
    console.log(chalk.dim('Building base image (one-time)...'));
    const tmpDir = path.join(okDir, '.base');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'Dockerfile'), `FROM node:lts-alpine
RUN npm install -g @anthropic-ai/claude-code
RUN adduser -D builder
RUN mkdir -p /app && chown builder /app
WORKDIR /app
USER builder
`);
    const result = spawnSync('docker', ['build', '-t', BUILDER_BASE, tmpDir], { stdio: 'inherit' });
    fs.rmSync(tmpDir, { recursive: true });
    if (result.status !== 0) {
      console.error(chalk.red('Failed to build base image'));
      process.exit(1);
    }
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
      console.error(chalk.red('Missing ANTHROPIC_API_KEY'));
      process.exit(1);
    }

    const imageTag = `ok-${specName}:latest`;

    // Check existing image
    const hasImage = this.imageExists(imageTag);
    if (hasImage) {
      const oldSpec = this.extractSpec(imageTag);
      if (oldSpec === specContent) {
        console.log(chalk.dim('Spec unchanged, skipping.'));
        return;
      }
    }

    // Ensure builder base image exists
    this.ensureBuilderBase();

    // Stage build context
    fs.mkdirSync(okDir, { recursive: true });
    fs.writeFileSync(path.join(okDir, 'spec.md'), specContent);
    fs.copyFileSync(path.resolve(__dirname, '..', '..', 'src', 'builder.mjs'), path.join(okDir, 'builder.mjs'));
    fs.writeFileSync(path.join(okDir, 'Dockerfile'), this.generateDockerfile(hasImage, imageTag));

    const keyFile = path.join(okDir, '.api_key');
    fs.writeFileSync(keyFile, process.env.ANTHROPIC_API_KEY, { mode: 0o600 });

    // Build
    console.log(chalk.cyan(`${hasImage ? 'Updating' : 'Building'} ${imageTag}...`));

    const buildResult = spawnSync('docker', [
      'build',
      '--secret', `id=api_key,src=${keyFile}`,
      '-t', imageTag,
      okDir,
    ], { stdio: 'inherit' });

    if (buildResult.status !== 0) {
      console.error(chalk.red(`Docker build failed (exit ${buildResult.status})`));
      process.exit(1);
    }

    // Clean up
    fs.rmSync(okDir, { recursive: true });

    console.log(chalk.green(`${imageTag} built.`));
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const port = opts.port || '3000';
    const imageTag = `ok-${specName}:latest`;

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
      const named = spawnSync('docker', ['inspect', '--format', '{{.Image}}', containerName], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      const imageId = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageTag], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (named.status === 0 && imageId.status === 0 && named.stdout.trim() === imageId.stdout.trim()) {
        console.log(chalk.dim(`Already running ${imageTag} on :${port}`));
        return;
      }
      console.log(chalk.dim('Stopping old container...'));
      spawnSync('docker', ['rm', '-f', ...runningIds], { stdio: 'ignore' });
    }

    // Also remove named container if it exists but isn't running
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
      console.log(chalk.dim(`Stopped ${containerName}`));
    } else {
      console.log(chalk.dim(`${containerName} is not running`));
    }
  }

  async destroy(specName: string): Promise<void> {
    const imageTag = `ok-${specName}:latest`;
    const containerName = `ok-${specName}`.replace(/[^a-zA-Z0-9_.-]/g, '-');

    // Stop and remove any running containers first
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });

    const result = spawnSync('docker', ['rmi', imageTag], { stdio: 'ignore' });
    if (result.status === 0) {
      console.log(chalk.dim(`Removed image ${imageTag}`));
    } else {
      console.log(chalk.dim(`Image ${imageTag} not found`));
    }
  }
}
