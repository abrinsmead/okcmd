const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createTwoFilesPatch } = require('diff');
const { runAgent } = require('./agent');

const okDir = path.resolve('.ok');

const requirements =
  `Requirements:\n` +
  `- The app must read its port from the PORT environment variable (e.g. const port = parseInt(Deno.env.get("PORT") || "3000"))\n` +
  `- Use the npm: prefix in Deno to import npm modules (e.g. import express from "npm:express")\n` +
  `- If the spec requires a front end, serve a React application from the Deno server\n` +
  `- If the spec requires persistence, use Deno-native @db/sqlite (import { Database } from "jsr:@db/sqlite") and store data in "data.db" (relative path — the app will run from its own working directory). Do NOT use npm:better-sqlite3 — it requires native bindings that won't work in Deno.\n` +
  `- IMPORTANT: The entire app is a single .ts file. The HTML/JS frontend is embedded in a TypeScript template literal string. Do NOT use backticks inside the embedded JavaScript — they will break the outer template literal. Use string concatenation (e.g. "/api/todos/" + id) instead of nested template literals.\n`;

async function build(filename, opts) {
  const port = opts.port || '3000';

  // 1. Validate
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const specPath = path.resolve(filename);
  if (!fs.existsSync(specPath)) {
    console.error(`Error: File not found: ${specPath}`);
    process.exit(1);
  }

  const spec = fs.readFileSync(specPath, 'utf-8');
  const specName = path.basename(filename, path.extname(filename));

  // 2. Set up .ok/ directory
  fs.mkdirSync(okDir, { recursive: true });

  const savedSpecPath = path.join(okDir, 'spec.md');
  const appPath = path.join(okDir, 'app.ts');

  // 3. Check for existing build
  const hasExistingBuild = fs.existsSync(savedSpecPath) && fs.existsSync(appPath);

  if (hasExistingBuild) {
    const oldSpec = fs.readFileSync(savedSpecPath, 'utf-8');

    if (oldSpec === spec) {
      console.log('Spec unchanged, skipping generation.');
    } else {
      const diff = createTwoFilesPatch('spec.md (old)', 'spec.md (new)', oldSpec, spec);
      const existingApp = fs.readFileSync(appPath, 'utf-8');

      fs.writeFileSync(savedSpecPath, spec);

      const prompt =
        `The spec for this app has changed. Here is the diff:\n\n` +
        `\`\`\`diff\n${diff}\n\`\`\`\n\n` +
        `Here is the current app source:\n\n` +
        `<file path="${appPath}">\n${existingApp}\n</file>\n\n` +
        `Update ${appPath} to reflect the spec changes. Only modify what's necessary.\n\n` +
        requirements +
        `- After editing, validate by running: PORT=${port} deno run --allow-all ${appPath}\n` +
        `- If there are errors, fix them and retry (up to 3 attempts)\n` +
        `- Once it starts successfully, stop the process (kill it) — the CLI will handle the final run\n\n` +
        `Progress: Print a short status message before each step (e.g. "Setting up database schema...", "Building REST API routes...", "Adding frontend components...", "Validating app..."). Keep the user informed of what you are doing.`;

      console.log('Spec changed, updating app...');
      await runAgent(prompt);
    }
  } else {
    // Full build
    fs.writeFileSync(savedSpecPath, spec);

    const prompt = `<spec>\n${spec}\n</spec>\n\n` +
      `Given the input specification above, build a TypeScript app in a single file ` +
      `that can be run from Deno. Write the file to: ${appPath}\n\n` +
      requirements +
      `- After writing the file, validate it by running: PORT=${port} deno run --allow-all ${appPath}\n` +
      `- If there are errors, fix them and retry (up to 3 attempts)\n` +
      `- Once it starts successfully, stop the process (kill it) — the CLI will handle the final run\n\n` +
      `Progress: Print a short status message before each step (e.g. "Setting up database schema...", "Building REST API routes...", "Adding frontend components...", "Validating app..."). Keep the user informed of what you are doing.`;

    console.log('Generating app from spec...');
    await runAgent(prompt);
  }

  // 4. Verify app.ts was created
  if (!fs.existsSync(appPath)) {
    console.error('Error: Agent failed to generate app.ts');
    process.exit(1);
  }

  // 5. Generate Dockerfile
  const dockerfile = [
    'FROM denoland/deno:latest',
    'WORKDIR /app',
    'COPY app.ts .',
    'EXPOSE 3000',
    'CMD ["run", "--allow-all", "app.ts"]',
  ].join('\n') + '\n';

  fs.writeFileSync(path.join(okDir, 'Dockerfile'), dockerfile);

  // 6. Save image name so `ok run` knows what to run
  const imageName = `ok-${specName}`;
  const imageTag = `${imageName}:latest`;
  fs.writeFileSync(path.join(okDir, 'name'), specName);

  // 7. Build Docker image
  console.log(`\nBuilding Docker image ${imageTag}...`);

  const buildResult = spawnSync('docker', ['build', '-t', imageTag, okDir], {
    stdio: 'inherit',
  });

  if (buildResult.status !== 0) {
    console.error(`Error: Docker build failed (exit code ${buildResult.status})`);
    process.exit(1);
  }

  console.log(`Image ${imageTag} built successfully.`);
}

module.exports = { build };
