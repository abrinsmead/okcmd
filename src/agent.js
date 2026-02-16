const path = require('path');

async function runAgent(prompt, opts = {}) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const allowedTools = opts.allowedTools || ['Write', 'Edit', 'Read', 'Bash'];
  const progressTimers = new Map();
  let result = null;

  for await (const message of query({
    prompt,
    options: {
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools,
      permissionMode: 'bypassPermissions',
    },
  })) {
    switch (message.type) {
      case 'assistant': {
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text') {
              const text = block.text.endsWith('\n') ? block.text : block.text + '\n';
              process.stdout.write(`\x1b[32m\u25CF\x1b[0m ${text}`);
            } else if (block.type === 'tool_use') {
              console.log(`\x1b[32m\u25CF\x1b[0m ${formatToolUse(block)}`);
            }
          }
        }
        if (message.error) {
          console.error(`\nAgent error: ${message.error}`);
        }
        break;
      }

      case 'tool_progress': {
        const elapsed = Math.floor(message.elapsed_time_seconds);
        const last = progressTimers.get(message.tool_use_id) || 0;
        if (elapsed >= 10 && elapsed - last >= 10) {
          progressTimers.set(message.tool_use_id, elapsed);
          console.log(`    ${elapsed}s elapsed`);
        }
        break;
      }

      case 'result': {
        result = message;
        console.log();
        if (message.is_error) {
          console.error(`Error: ${message.errors?.join('\n') || message.subtype}`);
        }
        const secs = (message.duration_ms / 1000).toFixed(1);
        const cost = message.total_cost_usd.toFixed(2);
        console.log(`Completed in ${secs}s | ${message.num_turns} turns | $${cost}`);
        break;
      }
    }
  }

  return result;
}

function formatToolUse(block) {
  const input = block.input || {};
  switch (block.name) {
    case 'Write':
      return `  > Write ${rel(input.file_path)}`;
    case 'Read':
      return `  > Read ${rel(input.file_path)}`;
    case 'Edit':
      return `  > Edit ${rel(input.file_path)}`;
    case 'Bash': {
      const full = input.command || '';
      const cmd = full.split('\n')[0].slice(0, 80);
      return `  > Run ${cmd}${cmd.length < full.length ? '...' : ''}`;
    }
    default:
      return `  > ${block.name}`;
  }
}

function rel(filePath) {
  if (!filePath) return '';
  const cwd = process.cwd();
  return filePath.startsWith(cwd + path.sep) ? filePath.slice(cwd.length + 1) : filePath;
}

module.exports = { runAgent };
