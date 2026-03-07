import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import type { Runtime, RunOpts } from '../runtime';
import { DockerRuntime } from './docker';

const APP_DIR = '/blaxel/app';
const APP_PROCESS = 'ok-app';
const PREVIEW_NAME = 'ok-preview';

export class BlaxelRuntime implements Runtime {
  private docker = new DockerRuntime();

  private async getSandbox(specName: string, create = false) {
    const { SandboxInstance } = require('@blaxel/core');
    const name = `ok-${specName}`;

    if (create) {
      return await SandboxInstance.createIfNotExists({
        name,
        image: 'blaxel/base-image:latest',
        memory: 4096,
        ports: [{ target: 3000, protocol: 'HTTP' }],
        region: process.env.BL_REGION || 'us-pdx-1',
      });
    }

    try {
      return await SandboxInstance.get(name);
    } catch {
      return null;
    }
  }

  private extractAppFiles(imageTag: string): string {
    const tmpDir = path.join('.ok', '.extract');
    fs.mkdirSync(tmpDir, { recursive: true });

    const cid = spawnSync('docker', ['create', imageTag], { encoding: 'utf-8' });
    if (cid.status !== 0) {
      throw new Error('Failed to create container for extraction');
    }
    const containerId = cid.stdout.trim();

    spawnSync('docker', ['cp', `${containerId}:/app/.`, tmpDir], { stdio: 'ignore' });
    spawnSync('docker', ['rm', containerId], { stdio: 'ignore' });

    return tmpDir;
  }

  private async deploy(sandbox: any, imageTag: string, specName: string): Promise<void> {
    console.log(chalk.cyan(`Deploying ${specName} to sandbox...`));
    const extractDir = this.extractAppFiles(imageTag);

    try {
      // Stop any running app
      try {
        console.log(chalk.dim('Stopping existing app...'));
        await sandbox.process.kill(APP_PROCESS);
      } catch { /* no existing process */ }

      // Clean and recreate app dir
      console.log(chalk.dim('Uploading app files...'));
      await sandbox.process.exec({
        command: `rm -rf ${APP_DIR} && mkdir -p ${APP_DIR}`,
        waitForCompletion: true,
      });

      // Build file tree for batch upload
      const files = this.listFiles(extractDir);
      const textFiles: { path: string; content: string }[] = [];
      const binaryFiles: { rel: string; abs: string }[] = [];

      for (const file of files) {
        const absPath = path.join(extractDir, file);
        const buf = fs.readFileSync(absPath);

        // Check for binary content
        if (buf.includes(0)) {
          binaryFiles.push({ rel: file, abs: absPath });
        } else {
          let content = buf.toString('utf-8');
          if (file === 'start.sh') {
            content = content.replace(/\/app\b/g, APP_DIR);
          }
          textFiles.push({ path: file, content });
        }
      }

      // Batch upload text files
      if (textFiles.length > 0) {
        await sandbox.fs.writeTree(textFiles, APP_DIR);
      }

      // Upload binary files individually
      for (const { rel, abs } of binaryFiles) {
        const data = fs.readFileSync(abs);
        await sandbox.fs.writeBinary(`${APP_DIR}/${rel}`, data);
      }

      console.log(chalk.dim(`Uploaded ${files.length} files.`));

      // Install npm dependencies if package.json exists
      if (files.includes('package.json')) {
        console.log(chalk.dim('Installing dependencies...'));
        const result = await sandbox.process.exec({
          command: 'npm install --production',
          workingDir: APP_DIR,
          waitForCompletion: true,
          timeout: 120000,
        });
        if (result.exitCode !== 0) {
          console.error(chalk.red('npm install failed:'), result.logs?.stderr || '');
          process.exit(1);
        }
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true });
    }

    console.log(chalk.green(`Deployed ${specName} to sandbox.`));
  }

  async build(specName: string, specContent: string): Promise<void> {
    // Step 1: Docker build (handles spec diff, code generation)
    const imageTag = `ok-${specName}:latest`;
    const imageExisted = this.docker.imageExists(imageTag);
    const oldSpec = imageExisted ? this.docker.extractSpec(imageTag) : null;
    const specChanged = oldSpec !== specContent;

    if (specChanged) {
      console.log(chalk.cyan(imageExisted ? 'Spec changed, rebuilding...' : 'Building...'));
      await this.docker.build(specName, specContent);
    } else {
      console.log(chalk.dim('No changes detected.'));
    }

    // Step 2: Ensure sandbox exists
    console.log(chalk.dim(`Connecting to sandbox ok-${specName}...`));
    const sandbox = await this.getSandbox(specName, true);

    // Step 3: Deploy if spec changed or first build
    if (specChanged || !imageExisted) {
      await this.deploy(sandbox, imageTag, specName);
    }
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const sandbox = await this.getSandbox(specName);

    if (!sandbox) {
      console.error(chalk.red(`No sandbox found for ${specName}. Run \`ok build\` first.`));
      process.exit(1);
    }

    const port = opts.port || '3000';

    // Check if already running
    try {
      const proc = await sandbox.process.get(APP_PROCESS);
      if (proc.status === 'running') {
        const preview = await sandbox.previews.createIfNotExists({
          metadata: { name: PREVIEW_NAME },
          spec: { port: parseInt(port, 10), public: true },
        });
        console.log(chalk.cyan(`${specName} already running on ${preview.spec?.url}`));
        return;
      }
    } catch { /* process doesn't exist yet */ }

    // Build env vars
    const env: Record<string, string> = { PORT: port };
    if (opts.env) {
      for (const v of opts.env) {
        const eq = v.indexOf('=');
        if (eq > 0) env[v.slice(0, eq)] = v.slice(eq + 1);
      }
    }
    if (opts.envFile) {
      const envFileContent = fs.readFileSync(path.resolve(opts.envFile), 'utf-8');
      for (const line of envFileContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
      }
    }

    // Start app
    const envExports = Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join(' && ');
    console.log(chalk.dim('Starting app...'));

    await sandbox.process.exec({
      name: APP_PROCESS,
      command: `${envExports} && cd ${APP_DIR} && sh start.sh`,
    });

    // Poll until the app is listening or the process exits
    const portNum = parseInt(port, 10);
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      try {
        const proc = await sandbox.process.get(APP_PROCESS);
        if (proc.status !== 'running') {
          console.error(chalk.red(`App failed to start (status: ${proc.status}, exit: ${proc.exitCode})`));
          // Try to get logs
          try {
            if (proc.logs?.stderr) console.error(proc.logs.stderr);
            else if (proc.logs?.stdout) console.error(proc.logs.stdout);
            else console.error(chalk.dim(JSON.stringify(proc, null, 2)));
          } catch { /* no logs available */ }
          process.exit(1);
        }
      } catch { /* can't check status — keep polling */ }

      // Try creating preview — if port is listening it should work
      try {
        const preview = await sandbox.previews.createIfNotExists({
          metadata: { name: PREVIEW_NAME },
          spec: { port: portNum, public: true },
        });
        if (preview.spec?.url) {
          console.log(chalk.cyan(`Running ${specName} on ${preview.spec.url}`));
          return;
        }
      } catch { /* port not ready yet */ }
    }

    console.error(chalk.red('Timed out waiting for app to start'));
    process.exit(1);
  }

  async stop(specName: string): Promise<void> {
    const sandbox = await this.getSandbox(specName);

    if (!sandbox) {
      console.log(chalk.dim(`No sandbox found for ${specName}`));
      return;
    }

    try {
      console.log(chalk.dim(`Stopping app...`));
      await sandbox.process.kill(APP_PROCESS);
      console.log(chalk.green(`Stopped ${specName}`));
    } catch {
      console.log(chalk.dim(`${specName} is not running`));
    }
  }

  async destroy(specName: string): Promise<void> {
    const { SandboxInstance } = require('@blaxel/core');
    const name = `ok-${specName}`;

    try {
      console.log(chalk.dim(`Deleting sandbox ${name}...`));
      await SandboxInstance.delete(name);
      console.log(chalk.green(`Deleted sandbox for ${specName}`));
    } catch {
      console.log(chalk.dim(`No sandbox found for ${specName}`));
    }

    // Also clean up the Docker image
    await this.docker.destroy(specName);
  }

  private listFiles(dir: string, prefix = ''): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        files = files.concat(this.listFiles(path.join(dir, e.name), rel));
      } else if (e.isFile()) {
        files.push(rel);
      }
    }
    return files;
  }
}
