import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import * as ui from '../ui';
import type { Runtime, RunOpts } from '../runtime';

const LABEL_KEY = 'ok-spec';
const APP_DIR = '/home/daytona/app';
const BACKUP_DIR = '/home/daytona/app.bak';
const RUNTIME_ENV = 'Ubuntu sandbox — Node.js is available, install anything else via apt/npm';

export class DaytonaRuntime implements Runtime {
  private getDaytona() {
    const { Daytona } = require('@daytonaio/sdk');

    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      ui.error('Missing DAYTONA_API_KEY');
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

  private async readRemoteFile(sandbox: any, remotePath: string): Promise<string | null> {
    try {
      const result = await sandbox.process.executeCommand(`cat ${remotePath}`);
      return result.exitCode === 0 ? result.result : null;
    } catch {
      return null;
    }
  }

  private async ensureClaude(sandbox: any): Promise<void> {
    const check = await sandbox.process.executeCommand('which claude');
    if (check.exitCode === 0) return;

    ui.bar();
    ui.step('Installing Claude Code in sandbox');
    const install = await sandbox.process.executeCommand('npm install -g @anthropic-ai/claude-code');
    if (install.exitCode !== 0) {
      ui.error('Failed to install Claude Code');
      if (install.result) console.error(install.result);
      process.exit(1);
    }
    ui.stepDone('Claude Code installed');
  }

  async build(specName: string, specContent: string): Promise<void> {
    if (!process.env.ANTHROPIC_API_KEY) {
      ui.error('Missing ANTHROPIC_API_KEY in .env');
      process.exit(1);
    }

    ui.intro(`ok build ${chalk.bold(specName)} ${chalk.dim('(daytona)')}`);

    // Ensure sandbox exists
    const daytona = this.getDaytona();
    let sandbox = await this.findSandbox(daytona, specName);

    if (!sandbox) {
      ui.step(`Creating sandbox for ${chalk.bold(specName)}`);
      sandbox = await daytona.create({ labels: { [LABEL_KEY]: specName } });
      ui.stepDone(`Sandbox created: ${sandbox.id}`);
    } else {
      ui.stepDone(`Using existing sandbox: ${sandbox.id}`);
      await sandbox.start();
    }
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
    ui.bar();

    // Ensure Claude Code is installed
    await this.ensureClaude(sandbox);

    // Backup existing app for rollback
    if (isUpdate) {
      ui.bar();
      ui.step('Backing up existing app');
      await sandbox.process.executeCommand(`rm -rf ${BACKUP_DIR} && cp -r ${APP_DIR} ${BACKUP_DIR}`);
      ui.stepDone('Backup created');
    }

    // Ensure app dir exists and upload spec + builder
    await sandbox.process.executeCommand(`mkdir -p ${APP_DIR}`);

    const builderSrc = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'src', 'builder.mjs'),
      'utf-8'
    );
    await sandbox.fs.uploadFile(Buffer.from(specContent), `${APP_DIR}/spec.md`);
    await sandbox.fs.uploadFile(Buffer.from(builderSrc), `${APP_DIR}/builder.mjs`);

    // Write API key to temp file (avoid shell interpolation issues)
    await sandbox.fs.uploadFile(
      Buffer.from(process.env.ANTHROPIC_API_KEY),
      '/tmp/.ok-api-key'
    );

    // Run builder in a session so we can stream logs
    ui.bar();
    ui.step(`${isUpdate ? 'Updating' : 'Building'} ${chalk.bold(specName)} in sandbox`);
    ui.bar();

    const sessionId = `ok-build-${specName}`;
    try { await sandbox.process.deleteSession(sessionId); } catch { /* no existing session */ }
    await sandbox.process.createSession(sessionId);

    const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
      command: `ANTHROPIC_API_KEY=$(cat /tmp/.ok-api-key) APP_DIR=${APP_DIR} RUNTIME_ENV='${RUNTIME_ENV}' node ${APP_DIR}/builder.mjs`,
      runAsync: true,
    });

    // Stream logs in background
    sandbox.process.getSessionCommandLogs(
      sessionId,
      cmdId,
      (stdout: string) => ui.prefixLines(stdout),
      (stderr: string) => ui.prefixLines(stderr),
    ).catch(() => {});

    // Poll for command completion
    let buildExitCode: number | null = null;
    while (buildExitCode === null) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
        buildExitCode = cmd.exitCode;
      }
    }

    // Kill any processes left behind by validation (start.sh, node server.js, etc.)
    await sandbox.process.executeCommand('pkill -f "node server" || true; pkill -f "start.sh" || true');

    // Clean up session
    try { await sandbox.process.deleteSession(sessionId); } catch { /* ignore */ }

    ui.bar();

    // Clean up secrets and builder script
    await sandbox.process.executeCommand(`rm -f /tmp/.ok-api-key ${APP_DIR}/builder.mjs ${APP_DIR}/.prompt.txt`);

    if (buildExitCode !== 0) {
      ui.error('Build failed in sandbox');

      if (isUpdate) {
        ui.info('Rolling back...');
        await sandbox.process.executeCommand(`rm -rf ${APP_DIR} && mv ${BACKUP_DIR} ${APP_DIR}`);
      } else {
        await sandbox.process.executeCommand(`rm -rf ${APP_DIR}`);
      }
      process.exit(1);
    }

    // Success — clean up backup
    if (isUpdate) {
      await sandbox.process.executeCommand(`rm -rf ${BACKUP_DIR}`);
    }

    ui.outro(`${chalk.green('Done!')} Built ${chalk.bold(specName)} in sandbox`);
  }

  async run(specName: string, opts: RunOpts): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (!sandbox) {
      ui.error(`No sandbox found for ${specName}. Run \`ok build\` first.`);
      process.exit(1);
    }

    ui.step(`Starting sandbox ${chalk.bold(sandbox.id)}`);
    await sandbox.start();
    const port = opts.port || '3000';

    // Check if app is already running
    const check = await sandbox.process.executeCommand(`fuser ${port}/tcp 2>/dev/null`);
    if (check.exitCode === 0) {
      try {
        const preview = await sandbox.getSignedPreviewUrl(parseInt(port, 10));
        ui.success(`${specName} already running on ${preview.url}`);
      } catch {
        ui.success(`${specName} already running on port ${port}`);
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
    ui.info('Starting app...');
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Check if process is still running
      const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      if (cmd.exitCode !== undefined && cmd.exitCode !== null) {
        const logs = await sandbox.process.getSessionCommandLogs(sessionId, cmdId);
        ui.error('App failed to start:');
        if (logs.stderr) console.error(logs.stderr);
        else if (logs.stdout) console.error(logs.stdout);
        process.exit(1);
      }

      // Check if port is listening
      const portCheck = await sandbox.process.executeCommand(`fuser ${port}/tcp 2>/dev/null`);
      if (portCheck.exitCode === 0) {
        try {
          const preview = await sandbox.getSignedPreviewUrl(parseInt(port, 10));
          ui.outro(`Running ${chalk.bold(specName)} on ${chalk.cyan(preview.url)}`);
        } catch {
          ui.outro(`Running ${chalk.bold(specName)} on port ${chalk.bold(port)}`);
        }
        return;
      }
    }

    ui.error('Timed out waiting for app to start');
    process.exit(1);
  }

  async stop(specName: string): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (!sandbox) {
      ui.info(`No sandbox found for ${specName}`);
      return;
    }

    ui.step('Stopping app...');
    await sandbox.process.executeCommand('fuser -k 3000/tcp || true');
    ui.success(`Stopped ${specName}`);
  }

  async destroy(specName: string): Promise<void> {
    const daytona = this.getDaytona();
    const sandbox = await this.findSandbox(daytona, specName);

    if (sandbox) {
      ui.step(`Deleting sandbox ${chalk.bold(sandbox.id)}`);
      await sandbox.delete();
      ui.success(`Deleted sandbox for ${specName}`);
    } else {
      ui.info(`No sandbox found for ${specName}`);
    }
  }
}
