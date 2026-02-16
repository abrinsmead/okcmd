const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk');
const { createTwoFilesPatch } = require('diff');
const { runAgent } = require('./agent');
const { extractAssertions, extractAssertionsFromDiff } = require('./assertions');

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
    console.error(chalk.red('Missing ANTHROPIC_API_KEY'));
    process.exit(1);
  }

  const specPath = path.resolve(filename);
  if (!fs.existsSync(specPath)) {
    console.error(chalk.red(`File not found: ${specPath}`));
    process.exit(1);
  }

  const spec = fs.readFileSync(specPath, 'utf-8');
  const specName = path.basename(filename, path.extname(filename));

  // 2. Set up .ok/ directory
  fs.mkdirSync(okDir, { recursive: true });

  const savedSpecPath = path.join(okDir, 'spec.md');
  const appPath = path.join(okDir, 'app.ts');
  const testPath = path.join(okDir, 'test.ts');
  const assertionsPath = path.join(okDir, 'assertions.json');

  // 3. Try to recover previous build from Docker image if not on disk
  const imageTag = `ok-${specName}:latest`;
  if (!fs.existsSync(savedSpecPath) || !fs.existsSync(appPath)) {
    const inspect = spawnSync('docker', ['image', 'inspect', imageTag], { stdio: 'ignore' });
    if (inspect.status === 0) {
      console.log(chalk.dim(`Recovering from ${imageTag}...`));
      const cid = spawnSync('docker', ['create', imageTag], { encoding: 'utf-8' });
      if (cid.status === 0) {
        const containerId = cid.stdout.trim();
        spawnSync('docker', ['cp', `${containerId}:/app/spec.md`, savedSpecPath]);
        spawnSync('docker', ['cp', `${containerId}:/app/app.ts`, appPath]);
        spawnSync('docker', ['cp', `${containerId}:/app/test.ts`, testPath], { stdio: 'ignore' });
        spawnSync('docker', ['cp', `${containerId}:/app/assertions.json`, assertionsPath], { stdio: 'ignore' });
        spawnSync('docker', ['rm', containerId], { stdio: 'ignore' });
      }
    }
  }

  const hasExistingBuild = fs.existsSync(savedSpecPath) && fs.existsSync(appPath);

  if (hasExistingBuild) {
    const oldSpec = fs.readFileSync(savedSpecPath, 'utf-8');

    const needsAssertions = !fs.existsSync(assertionsPath) || !fs.existsSync(testPath);

    if (oldSpec === spec && !needsAssertions) {
      console.log(chalk.dim('Spec unchanged, skipping.'));
    } else if (oldSpec === spec && needsAssertions) {
      // Spec matches but assertions/tests missing — extract from full spec
      console.log(chalk.cyan('Extracting assertions...'));
      const assertions = await extractAssertions(spec);
      if (assertions.length > 0) {
        console.log(chalk.green(`${assertions.length} assertions extracted.`));
        fs.writeFileSync(assertionsPath, JSON.stringify(assertions, null, 2));

        const existingApp = fs.readFileSync(appPath, 'utf-8');
        const prompt =
          `Here is an existing app:\n\n` +
          `<file path="${appPath}">\n${existingApp}\n</file>\n\n` +
          `Write ${testPath} — a Deno test file that verifies this app works correctly.\n\n` +
          `The app must satisfy these behavioral assertions:\n` +
          assertions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n\n' +
          `Test file requirements:\n` +
          `- Import nothing from app.ts — start the app as a subprocess using Deno.Command\n` +
          `- Pick a random available port, start the app with that port via PORT env var\n` +
          `- Run HTTP requests against the app to verify the assertions above\n` +
          `- Stop the subprocess when tests finish\n` +
          `- Use Deno.test() for each assertion or group of related assertions\n\n` +
          `Validation steps (you MUST follow all of these):\n` +
          `1. Write ${testPath}\n` +
          `2. Start the app in the background: PORT=${port} deno run --allow-all ${appPath} &\n` +
          `3. Wait for it to be ready: sleep 3\n` +
          `4. Run the tests: deno test --allow-all ${testPath}\n` +
          `5. Stop the app: kill %1 or kill the background process\n` +
          `6. If tests fail, fix the tests (not the app) and repeat steps 2-5 (up to 3 attempts)\n` +
          `7. Once tests pass, stop the app — the CLI will handle the final run\n\n` +
          `Output style: Be terse. Only print a few words when starting a major step or when something fails. No explanations, no summaries, no markdown headers.`;

        console.log(chalk.cyan('Generating tests...'));
        await runAgent(prompt);
      }
    } else {
      const diff = createTwoFilesPatch('spec.md (old)', 'spec.md (new)', oldSpec, spec);

      // Update assertions from diff
      const oldAssertions = fs.existsSync(assertionsPath)
        ? JSON.parse(fs.readFileSync(assertionsPath, 'utf-8'))
        : [];
      console.log(chalk.cyan('Updating assertions...'));
      const assertions = await extractAssertionsFromDiff(diff, oldAssertions);
      if (assertions.length > 0) {
        console.log(chalk.green(`${assertions.length} assertions (was ${oldAssertions.length}).`));
        fs.writeFileSync(assertionsPath, JSON.stringify(assertions, null, 2));
      }
      const existingApp = fs.readFileSync(appPath, 'utf-8');

      fs.writeFileSync(savedSpecPath, spec);

      let prompt =
        `The spec for this app has changed. Here is the diff:\n\n` +
        `\`\`\`diff\n${diff}\n\`\`\`\n\n` +
        `Here is the current app source:\n\n` +
        `<file path="${appPath}">\n${existingApp}\n</file>\n\n`;

      if (fs.existsSync(testPath)) {
        const existingTest = fs.readFileSync(testPath, 'utf-8');
        prompt += `Here is the current test file:\n\n` +
          `<file path="${testPath}">\n${existingTest}\n</file>\n\n`;
      }

      prompt += `Update ${appPath} to reflect the spec changes. Only modify what's necessary.\n\n` +
        requirements;

      if (assertions.length > 0) {
        prompt += `\nYou MUST update both files:\n` +
          `1. ${appPath} — the application\n` +
          `2. ${testPath} — the Deno test file that verifies the app\n\n` +
          `The app must satisfy these behavioral assertions:\n` +
          assertions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n\n' +
          `Validation steps (you MUST follow all of these):\n` +
          `1. Update both ${appPath} and ${testPath}\n` +
          `2. Start the app in the background: PORT=${port} deno run --allow-all ${appPath} &\n` +
          `3. Wait for it to be ready: sleep 3\n` +
          `4. Run the tests: deno test --allow-all ${testPath}\n` +
          `5. Stop the app: kill %1 or kill the background process\n` +
          `6. If tests fail, fix the app and/or tests and repeat steps 2-5 (up to 3 attempts)\n` +
          `7. Once tests pass, stop the app — the CLI will handle the final run\n`;
      } else {
        prompt += `- After editing, validate by running: PORT=${port} deno run --allow-all ${appPath}\n` +
          `- If there are errors, fix them and retry (up to 3 attempts)\n` +
          `- Once it starts successfully, stop the process (kill it) — the CLI will handle the final run\n`;
      }

      prompt += `\nOutput style: Be terse. Only print a few words when starting a major step or when something fails. No explanations, no summaries, no markdown headers.`;

      console.log(chalk.cyan('Updating app...'));
      await runAgent(prompt);
    }
  } else {
    // Full build
    fs.writeFileSync(savedSpecPath, spec);

    // Extract assertions
    console.log(chalk.cyan('Extracting assertions...'));
    const assertions = await extractAssertions(spec);
    if (assertions.length > 0) {
      console.log(chalk.green(`${assertions.length} assertions extracted.`));
      fs.writeFileSync(assertionsPath, JSON.stringify(assertions, null, 2));
    }

    let prompt = `<spec>\n${spec}\n</spec>\n\n` +
      `Given the input specification above, build a TypeScript app in a single file ` +
      `that can be run from Deno. Write the file to: ${appPath}\n\n` +
      requirements;

    if (assertions.length > 0) {
      prompt += `\nYou MUST produce two files:\n` +
        `1. ${appPath} — the application\n` +
        `2. ${testPath} — a Deno test file that verifies the app works correctly\n\n` +
        `The app must satisfy these behavioral assertions:\n` +
        assertions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n\n' +
        `Test file requirements for ${testPath}:\n` +
        `- Import nothing from app.ts — start the app as a subprocess using Deno.Command\n` +
        `- Pick a random available port, start the app with that port via PORT env var\n` +
        `- Run HTTP requests against the app to verify the assertions above\n` +
        `- Stop the subprocess when tests finish\n` +
        `- Use Deno.test() for each assertion or group of related assertions\n\n` +
        `Validation steps (you MUST follow all of these):\n` +
        `1. Write both ${appPath} and ${testPath}\n` +
        `2. Start the app in the background: PORT=${port} deno run --allow-all ${appPath} &\n` +
        `3. Wait for it to be ready: sleep 3\n` +
        `4. Run the tests: deno test --allow-all ${testPath}\n` +
        `5. Stop the app: kill %1 or kill the background process\n` +
        `6. If tests fail, fix the app and/or tests and repeat steps 2-5 (up to 3 attempts)\n` +
        `7. Once tests pass, stop the app — the CLI will handle the final run\n`;
    } else {
      prompt += `- After writing the file, validate it by running: PORT=${port} deno run --allow-all ${appPath}\n` +
        `- If there are errors, fix them and retry (up to 3 attempts)\n` +
        `- Once it starts successfully, stop the process (kill it) — the CLI will handle the final run\n`;
    }

    prompt += `\nOutput style: Be terse. Only print a few words when starting a major step or when something fails. No explanations, no summaries, no markdown headers.`;

    console.log(chalk.cyan('Generating app...'));
    await runAgent(prompt);
  }

  // 4. Verify app.ts was created
  if (!fs.existsSync(appPath)) {
    console.error(chalk.red('Agent failed to generate app.ts'));
    process.exit(1);
  }

  // 5. Generate Dockerfile
  const dockerLines = [
    'FROM denoland/deno:latest',
    'WORKDIR /app',
    'COPY app.ts .',
    'COPY spec.md .',
  ];
  if (fs.existsSync(testPath)) {
    dockerLines.push('COPY test.ts .');
  }
  if (fs.existsSync(assertionsPath)) {
    dockerLines.push('COPY assertions.json .');
  }
  dockerLines.push('EXPOSE 3000', 'CMD ["run", "--allow-all", "app.ts"]');
  const dockerfile = dockerLines.join('\n') + '\n';

  fs.writeFileSync(path.join(okDir, 'Dockerfile'), dockerfile);

  // 6. Save image name so `ok run` knows what to run
  fs.writeFileSync(path.join(okDir, 'name'), specName);

  // 7. Build Docker image
  console.log(chalk.cyan(`\nBuilding image ${imageTag}...`));

  const buildResult = spawnSync('docker', ['build', '-t', imageTag, okDir], {
    stdio: 'inherit',
  });

  if (buildResult.status !== 0) {
    console.error(chalk.red(`Docker build failed (exit ${buildResult.status})`));
    process.exit(1);
  }

  console.log(chalk.green(`${imageTag} built.`));
}

module.exports = { build };
