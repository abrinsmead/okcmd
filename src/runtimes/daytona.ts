import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import type { Runtime, RunOpts } from '../runtime';
import { DockerRuntime } from './docker';

const LABEL_KEY = 'ok-spec';
const APP_DIR = '/home/daytona/app';

export class DaytonaRuntime implements Runtime {
  private docker = new DockerRuntime();

  private getDaytona() {
    const { Daytona } = require('@daytonaio/sdk');

    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      console.error(chalk.red('Missing DAYTONA_API_KEY'));
      process.exit(1);
    }

    const opts: Record<string, string> = { apiKey };
    if (process.env.DAYTONA_API_URL) opts.apiUrl = process.env.DAYTONA_API_URL;
    if (process.env.DAYTONA_TARGET) opts.target = process.env.DAYTONA_TARGET;

    return new Daytona(opts);
  }

  private async findSandbox(daytona: any, specName: string): Promise<any | null> {
    try {
      return await daytona.findOne({ labels: { [LABEL_KEY]: specName } });
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
      // Stop any running app first
      console.log(chalk.dim('Stopping existing app...'));
      await sandbox.process.executeCommand('fuser -k 3000/tcp || true');

      // Clean existing app dir and recreate
      console.log(chalk.dim('Uploading app files...'));
      await sandbox.process.executeCommand(`rm -rf ${APP_DIR} && mkdir -p ${APP_DIR}`);

      // Upload all extracted files, rewriting /app paths for sandbox
      const files = this.listFiles(extractDir);
      for (const file of files) {
        let content = fs.readFileSync(path.join(extractDir, file));
        if (file === 'start.sh') {
          content = Buffer.from(content.toString('utf-8').replace(/\/app\b/g, APP_DIR));
        }
        await sandbox.fs.uploadFile(content, `${APP_DIR}/${file}`);
      }
      console.log(chalk.dim(`Uploaded ${files.length} files.`));

      // Install npm dependencies if package.json exists
      if (files.includes('package.json')) {
        console.log(chalk.dim('Installing dependencies...'));
        const installResult = await sandbox.process.executeCommand(
          'npm install --production',
          APP_DIR
        );
        if (installResult.exitCode !== 0) {
          console.error(chalk.red('npm install failed:'), installResult.result);
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
    const daytona = this.getDaytona();
    let sandbox = await this.findSandbox(daytona, specName);
    const isNewSandbox = !sandbox;

    if (!sandbox) {
      console.log(chalk.cyan(`Creating sandbox for ${specName}...`));
      sandbox = await daytona.create({
        labels: { [LABEL_KEY]: specName },
      });
      console.log(chalk.dim(`Sandbox created: ${sandbox.id}`));
    } else {
      console.log(chalk.dim(`Using existing sandbox: ${sandbox.id}`));
      await sandbox.start();
    }

    // Step 3: Deploy if spec changed or sandbox is new
    if (specChanged || isNewSandbox) {
      await this.deploy(sandbox, imageTag, specName);
    }
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (!sandbox) {
      console.error(chalk.red(`No sandbox found for ${specName}. Run \`ok build\` first.`));
      process.exit(1);
    }

    console.log(chalk.dim(`Starting sandbox ${sandbox.id}...`));
    await sandbox.start();
    const port = opts.port || '3000';

    // Check if app is already running
    const check = await sandbox.process.executeCommand(`fuser ${port}/tcp 2>/dev/null`);
    if (check.exitCode === 0) {
      try {
        const preview = await sandbox.getSignedPreviewUrl(parseInt(port, 10));
        console.log(chalk.cyan(`${specName} already running on ${preview.url}`));
      } catch {
        console.log(chalk.cyan(`${specName} already running on port ${port}`));
      }
      return;
    }

    // Build env vars for the command
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

    // Start app in background
    const sessionId = `ok-run-${specName}`;
    try { await sandbox.process.deleteSession(sessionId); } catch { /* no existing session */ }
    await sandbox.process.createSession(sessionId);

    const envExports = Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join(' && ');
    const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
      command: `${envExports} && cd ${APP_DIR} && sh start.sh`,
      runAsync: true,
    });

    // Poll until port is listening or the process exits
    console.log(chalk.dim('Starting app...'));
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if process is still running
      const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
        // Process exited — fetch logs and show error
        const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
        console.error(chalk.red('App failed to start:'));
        if (logs.stderr) console.error(logs.stderr);
        else if (logs.stdout) console.error(logs.stdout);
        process.exit(1);
      }

      // Check if port is listening
      const check = await sandbox.process.executeCommand(`fuser ${port}/tcp 2>/dev/null`);
      if (check.exitCode === 0) {
        try {
          const preview = await sandbox.getSignedPreviewUrl(parseInt(port, 10));
          console.log(chalk.cyan(`Running ${specName} on ${preview.url}`));
        } catch {
          console.log(chalk.cyan(`Running ${specName} on port ${port}`));
        }
        return;
      }
    }

    console.error(chalk.red('Timed out waiting for app to start'));
    process.exit(1);
  }

  async stop(specName: string): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (!sandbox) {
      console.log(chalk.dim(`No sandbox found for ${specName}`));
      return;
    }

    console.log(chalk.dim(`Stopping app in sandbox ${sandbox.id}...`));
    await sandbox.process.executeCommand('fuser -k 3000/tcp || true');
    console.log(chalk.green(`Stopped ${specName}`));
  }

  async destroy(specName: string): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (sandbox) {
      console.log(chalk.dim(`Deleting sandbox ${sandbox.id}...`));
      await sandbox.delete();
      console.log(chalk.green(`Deleted sandbox for ${specName}`));
    } else {
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
