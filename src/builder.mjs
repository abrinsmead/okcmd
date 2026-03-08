import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const appDir = process.env.APP_DIR || '/app';
const runtimeEnv = process.env.RUNTIME_ENV || 'node:lts-alpine — Node.js is available, anything else must be installed via apk/npm';

const spec = readFileSync(join(appDir, 'spec.md'), 'utf-8');

const requirements = `Rules:
- All files go under ${appDir}/
- Entrypoint: ${appDir}/start.sh — a shell script that installs deps, builds if needed, and starts the server
- Single HTTP server listening on the port from the PORT env var
- The runtime is ${runtimeEnv}
- Use ESM ("type": "module" in package.json, import/export everywhere)
- No native compilation packages (no node-gyp, no Python). Use sql.js not better-sqlite3
- No heavy frameworks (no Next.js, Remix, Nuxt)

Architecture (follow this exactly):
- Frontend: write React/JSX files by hand under src/. Create a vite.config.js. Do NOT use \`npx create-vite\` or any scaffolding tool
- Build frontend: \`npx vite build\` (outputs to dist/)
- Backend: single Express server (server.js) that serves dist/ as static files and handles API routes
- start.sh pattern:
  cd ${appDir}
  npm install --omit=dev
  npx vite build
  node server.js

Validation (do this after writing all files):
1. Run: PORT=3000 sh ${appDir}/start.sh
2. Wait a few seconds, then: curl -s http://localhost:3000
3. If curl succeeds, kill the server process and you're done
4. If it fails, read the error output, fix, and retry (max 3 attempts)
5. Always kill the server before finishing — do NOT leave processes running

Style: Be terse. No planning. No TodoWrite. Write files, then validate.`;

// Check if there's an existing app to update
const isUpdate = existsSync(join(appDir, 'start.sh'));
let prompt;

if (isUpdate) {
  const skip = new Set(['spec.md', 'builder.mjs', '.prompt.txt']);
  const appFiles = listFiles(appDir).filter(f => !skip.has(f));

  prompt = `The spec for this app has changed. Update it to match.

<new-spec>
${spec}
</new-spec>

The existing app is in ${appDir}/ with these files:
${appFiles.join('\n')}

Read the files you need, then make only the changes required by the new spec.

${requirements}`;

  console.log(`Updating existing app (${appFiles.length} files)...`);
} else {
  prompt = `Build a web app matching this spec.

<spec>
${spec}
</spec>

${requirements}`;
}

// Write prompt to file and pipe via stdin to avoid E2BIG on large prompts
const promptFile = join(appDir, '.prompt.txt');
writeFileSync(promptFile, prompt);

const proc = spawn('claude', [
  '-p',
  '--allowedTools', 'Write,Edit,Read,Bash',
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
], { stdio: [openSync(promptFile, 'r'), 'pipe', 'inherit'] });

const rl = createInterface({ input: proc.stdout });

for await (const line of rl) {
  if (!line.trim()) continue;
  try {
    const msg = JSON.parse(line);
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          console.log(`Session: ${msg.session_id}`);
        }
        break;
      case 'assistant': {
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              console.log(block.text);
            }
            if (block.type === 'tool_use') {
              const input = block.input || {};
              let desc = block.name;
              if (block.name === 'Write' || block.name === 'Read' || block.name === 'Edit') {
                desc += ` ${input.file_path || ''}`;
              } else if (block.name === 'Bash') {
                const cmd = (input.command || '').split('\n')[0].slice(0, 80);
                desc += ` ${cmd}`;
              }
              console.log(`> ${desc}`);
            }
          }
        }
        break;
      }
      case 'result': {
        const secs = (msg.duration_ms / 1000).toFixed(1);
        const cost = msg.total_cost_usd?.toFixed(2) ?? '?';
        console.log(`Done: ${secs}s | ${msg.num_turns} turns | $${cost}`);
        if (msg.is_error) {
          console.error('Build failed:', msg.result);
          process.exit(1);
        }
        break;
      }
    }
  } catch {
    // skip non-JSON lines
  }
}

const code = await new Promise(resolve => proc.on('close', resolve));
try { unlinkSync(promptFile); } catch { /* ignore */ }
if (code !== 0) {
  console.error(`claude exited with code ${code}`);
  process.exit(1);
}

// Verify start.sh was created
try {
  statSync(join(appDir, 'start.sh'));
} catch {
  console.error('builder: start.sh was not generated');
  process.exit(1);
}

function listFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') {
        files = files.concat(listFiles(join(dir, e.name), rel));
      }
    } else if (e.isFile()) {
      files.push(rel);
    }
  }
  return files;
}
