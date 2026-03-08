import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import * as ui from '../ui';
import type { Runtime, RunOpts } from '../runtime';

const APP_DIR = '/blaxel/app';
const BACKUP_DIR = '/blaxel/app.bak';
const APP_PROCESS = 'ok-app';
const BUILD_PROCESS = 'ok-build';
const PREVIEW_NAME = 'ok-preview';
const RUNTIME_ENV = 'Linux sandbox — Node.js is available, install anything else via apt/npm';

export class BlaxelRuntime implements Runtime {
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

  private async readRemoteFile(sandbox: any, remotePath: string): Promise<string | null> {
    try {
      const result = await sandbox.process.exec({
        command: `cat ${remotePath}`,
        waitForCompletion: true,
      });
      if (result.exitCode !== 0) return null;
      return result.logs?.stdout ?? result.stdout ?? null;
    } catch {
      return null;
    }
  }

  private async ensureClaude(sandbox: any): Promise<void> {
    const check = await sandbox.process.exec({
      command: 'which claude',
      waitForCompletion: true,
    });
    if (check.exitCode === 0) return;

    ui.bar();
    ui.step('Installing Claude Code in sandbox');
    const install = await sandbox.process.exec({
      command: 'npm install -g @anthropic-ai/claude-code',
      waitForCompletion: true,
      timeout: 120000,
    });
    if (install.exitCode !== 0) {
      ui.error('Failed to install Claude Code');
      process.exit(1);
    }
    ui.stepDone('Claude Code installed');
  }

  async build(specName: string, specContent: string): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) {
      ui.error('Missing ANTHROPIC_API_KEY in .env');
      process.exit(1);
    }

    ui.intro(`ok build ${chalk.bold(specName)} ${chalk.dim('(blaxel)')}`);

    // Ensure sandbox exists
    ui.step(`Connecting to sandbox ${chalk.bold(`ok-${specName}`)}`);
    const sandbox = await this.getSandbox(specName, true);
    ui.stepDone('Sandbox ready');
    ui.bar();

    // Check if spec changed
    ui.step('Checking for changes');
    const existingSpec = await this.readRemoteFile(sandbox, `${APP_DIR}/spec.md`);
    if (existingSpec === specContent) {
      ui.stepDone('Spec unchanged — skipping build');
      ui.outro(chalk.dim('Nothing to do'));
      return;
    }

    const isUpdate = existingSpec !== null;
    ui.info(isUpdate ? 'Spec changed — rebuilding' : 'No existing app found');

    // Ensure Claude Code is installed
    await this.ensureClaude(sandbox);

    // Backup existing app for rollback
    if (isUpdate) {
      ui.bar();
      ui.step('Backing up existing app');
      await sandbox.process.exec({
        command: `rm -rf ${BACKUP_DIR} && cp -r ${APP_DIR} ${BACKUP_DIR}`,
        waitForCompletion: true,
      });
      ui.stepDone('Backup created');
    }

    // Ensure app dir exists
    await sandbox.process.exec({
      command: `mkdir -p ${APP_DIR}`,
      waitForCompletion: true,
    });

    // Upload spec and builder
    const builderSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'builder.mjs'),
      'utf-8'
    );
    await sandbox.fs.writeTree([
      { path: 'spec.md', content: specContent },
      { path: 'builder.mjs', content: builderSrc },
    ], APP_DIR);

    // Write API key to temp file (avoid shell interpolation issues)
    await sandbox.fs.writeTree([
      { path: '.ok-api-key', content: process.env.ANTHROPIC_API_KEY },
    ], '/tmp');

    // Run builder with log streaming
    ui.bar();
    ui.step(`${isUpdate ? 'Updating' : 'Building'} ${chalk.bold(specName)} in sandbox`);
    ui.bar();

    // Start builder async so we can stream logs
    await sandbox.process.exec({
      name: BUILD_PROCESS,
      command: `IS_SANDBOX=1 ANTHROPIC_API_KEY=$(cat /tmp/.ok-api-key) APP_DIR=${APP_DIR} RUNTIME_ENV='${RUNTIME_ENV}' node ${APP_DIR}/builder.mjs`,
      workingDir: APP_DIR,
    });

    // Stream logs in background
    const stream = sandbox.process.streamLogs(BUILD_PROCESS, {
      onLog: (log: any) => {
        const text = typeof log === 'string' ? log : log?.message ?? log?.stdout ?? '';
        if (text) ui.prefixLines(text);
      },
    });

    // Wait for build to complete
    await sandbox.process.wait(BUILD_PROCESS, { maxWait: 600000, interval: 2000 });
    stream.close();

    // Get final result
    const buildInfo = await sandbox.process.get(BUILD_PROCESS);
    const buildExitCode = buildInfo.exitCode;

    // Kill any processes left behind by validation (start.sh, node server.js, etc.)
    await sandbox.process.exec({
      command: 'pkill -f "node server" || true; pkill -f "start.sh" || true',
      waitForCompletion: true,
    });

    ui.bar();

    // Clean up secrets and builder script
    await sandbox.process.exec({
      command: `rm -f /tmp/.ok-api-key ${APP_DIR}/builder.mjs ${APP_DIR}/.prompt.txt`,
      waitForCompletion: true,
    });

    if (buildExitCode !== 0) {
      ui.error('Build failed in sandbox');

      if (isUpdate) {
        ui.info('Rolling back...');
        await sandbox.process.exec({
          command: `rm -rf ${APP_DIR} && mv ${BACKUP_DIR} ${APP_DIR}`,
          waitForCompletion: true,
        });
      } else {
        await sandbox.process.exec({
          command: `rm -rf ${APP_DIR}`,
          waitForCompletion: true,
        });
      }
      process.exit(1);
    }

    // Success — clean up backup
    if (isUpdate) {
      await sandbox.process.exec({
        command: `rm -rf ${BACKUP_DIR}`,
        waitForCompletion: true,
      });
    }

    ui.outro(`${chalk.green('Done!')} Built ${chalk.bold(specName)} in sandbox`);
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const sandbox = await this.getSandbox(specName);

    if (!sandbox) {
      ui.error(`No sandbox found for ${specName}. Run \`ok build\` first.`);
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
        ui.success(`${specName} already running on ${preview.spec?.url}`);
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
    ui.step('Starting app...');

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
          ui.error(`App failed to start (status: ${proc.status}, exit: ${proc.exitCode})`);
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
          ui.outro(`Running ${chalk.bold(specName)} on ${chalk.cyan(preview.spec.url)}`);
          return;
        }
      } catch { /* port not ready yet */ }
    }

    ui.error('Timed out waiting for app to start');
    process.exit(1);
  }

  async stop(specName: string): Promise<void> {
    const sandbox = await this.getSandbox(specName);

    if (!sandbox) {
      ui.info(`No sandbox found for ${specName}`);
      return;
    }

    try {
      ui.step('Stopping app...');
      await sandbox.process.kill(APP_PROCESS);
      ui.success(`Stopped ${specName}`);
    } catch {
      ui.info(`${specName} is not running`);
    }
  }

  async destroy(specName: string): Promise<void> {
    const { SandboxInstance } = require('@blaxel/core');
    const name = `ok-${specName}`;

    try {
      ui.step(`Deleting sandbox ${chalk.bold(name)}`);
      await SandboxInstance.delete(name);
      ui.success(`Deleted sandbox for ${specName}`);
    } catch {
      ui.info(`No sandbox found for ${specName}`);
    }
  }
}
