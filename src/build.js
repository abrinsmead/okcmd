const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk');

const okDir = path.resolve('.ok');

function deriveSpecName(filename) {
  return path.basename(filename, path.extname(filename));
}

function imageExists(imageTag) {
  return spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' }).status === 0;
}

function extractSpec(imageTag) {
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

const BUILDER_BASE = 'ok-builder-base:latest';

function ensureBuilderBase() {
  if (imageExists(BUILDER_BASE)) return;
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

function generateDockerfile(isUpdate, imageTag) {
  // For updates: start from the existing app image, add builder tools
  // For fresh builds: start from the builder base
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

async function build(filename, opts) {
  // 1. Validate
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(chalk.red('Missing ANTHROPIC_API_KEY'));
    process.exit(1);
  }

  const specPath = path.resolve(filename);
  if (!fs.existsSync(specPath)) {
    console.error(chalk.red(`File not found: ${specPath}`));
    process.exit(1);
  }

  const spec = fs.readFileSync(specPath, 'utf-8');
  const specName = deriveSpecName(filename);
  const imageTag = `ok-${specName}:latest`;

  // 2. Check existing image
  const hasImage = imageExists(imageTag);
  if (hasImage) {
    const oldSpec = extractSpec(imageTag);
    if (oldSpec === spec) {
      console.log(chalk.dim('Spec unchanged, skipping.'));
      return;
    }
  }

  // 3. Ensure builder base image exists
  ensureBuilderBase();

  // 4. Stage build context
  fs.mkdirSync(okDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, 'spec.md'), spec);
  fs.copyFileSync(path.resolve(__dirname, 'builder.mjs'), path.join(okDir, 'builder.mjs'));
  fs.writeFileSync(path.join(okDir, 'Dockerfile'), generateDockerfile(hasImage, imageTag));

  const keyFile = path.join(okDir, '.api_key');
  fs.writeFileSync(keyFile, process.env.ANTHROPIC_API_KEY, { mode: 0o600 });

  // 5. Build
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

  // 6. Clean up
  fs.rmSync(okDir, { recursive: true });

  console.log(chalk.green(`${imageTag} built.`));
}

module.exports = { build, deriveSpecName };
