import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const spec = readFileSync('/app/spec.md', 'utf-8');

const requirements = `Requirements:
- Entrypoint must be /app/start.sh (a shell script that starts the app)
- Single HTTP server on the port from PORT env var (only one port is exposed)
- The runtime image is node:lts-alpine — Node.js is available, anything else must be installed via apk/npm
- Do NOT use npm packages that require native compilation (no node-gyp, no Python). For SQLite use sql.js (pure JS/WASM), not better-sqlite3
- Build a simple MVP — minimal architecture, no over-engineering
- For web apps with a frontend: use Vite (npm create vite@latest my-app -- --template react)
  - Build the frontend to static files, serve them from the backend
- For the backend: a single Express server is fine (or just serve static files if no API needed)
- Do NOT use Next.js, Remix, or heavy frameworks
- Keep it simple: flat file structure, minimal dependencies, no unnecessary abstractions`;

// Check if there's an existing app to update
const isUpdate = existsSync('/app/start.sh');
let prompt;

if (isUpdate) {
  // Read existing app files (skip spec.md and builder.mjs)
  const skip = new Set(['spec.md', 'builder.mjs']);
  const appFiles = listFiles('/app').filter(f => !skip.has(f));
  let filesContext = '';
  for (const f of appFiles) {
    const content = readFileSync(join('/app', f), 'utf-8');
    filesContext += `<file path="/app/${f}">\n${content}\n</file>\n\n`;
  }

  prompt = `The spec for this app has changed.

<new-spec>
${spec}
</new-spec>

Here are the current app files:

${filesContext}
Update the app to match the new spec. Only modify what's necessary.

${requirements}

After updating, validate: PORT=3000 sh /app/start.sh
If errors, fix and retry (up to 3 attempts).
Once it starts successfully, stop the process.

Output style: Be terse.`;

  console.log(`Updating existing app (${appFiles.length} files)...`);
} else {
  prompt = `<spec>
${spec}
</spec>

Build a web app matching this spec. All files go under /app/.

${requirements}

After writing, validate: PORT=3000 sh /app/start.sh
If errors, fix and retry (up to 3 attempts).
Once it starts successfully, stop the process.

Output style: Be terse.`;
}

const proc = spawn('claude', [
  '-p', prompt,
  '--allowedTools', 'Write,Edit,Read,Bash',
  '--dangerously-skip-permissions',
  '--output-format', 'stream-json',
  '--verbose',
], { stdio: ['ignore', 'pipe', 'inherit'] });

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
if (code !== 0) {
  console.error(`claude exited with code ${code}`);
  process.exit(1);
}

// Verify start.sh was created
try {
  statSync('/app/start.sh');
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
      files = files.concat(listFiles(join(dir, e.name), rel));
    } else if (e.isFile()) {
      files.push(rel);
    }
  }
  return files;
}
