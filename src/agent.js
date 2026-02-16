const path = require('path');
const chalk = require('chalk');

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function createSpinner(text) {
  let i = 0;
  let current = text;
  const timer = setInterval(() => {
    const frame = chalk.cyan(SPINNER[i % SPINNER.length]);
    process.stderr.write(`\r\x1b[K${frame} ${chalk.dim(current)}`);
    i++;
  }, 80);
  return {
    update(text) { current = text; },
    stop() {
      clearInterval(timer);
      process.stderr.write('\r\x1b[K');
    },
  };
}

async function runAgent(prompt, opts = {}) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const { allowedTools: customAllowed, quiet, ...extraOpts } = opts;
  const allowedTools = customAllowed !== undefined ? customAllowed : ['Write', 'Edit', 'Read', 'Bash'];
  let result = null;
  const spinner = createSpinner('Thinking...');
  let lastToolId = null;

  for await (const message of query({
    prompt,
    options: {
      tools: { type: 'preset', preset: 'claude_code' },
      allowedTools,
      permissionMode: 'bypassPermissions',
      ...extraOpts,
    },
  })) {
    switch (message.type) {
      case 'assistant': {
        if (message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text' && !quiet) {
              spinner.stop();
              const text = block.text.trim();
              if (text) {
                process.stdout.write(`  ${chalk.dim(text)}\n`);
              }
              spinner.update('Thinking...');
            } else if (block.type === 'tool_use') {
              lastToolId = block.id;
              spinner.update(formatToolUse(block));
            }
          }
        }
        if (message.error) {
          spinner.stop();
          console.error(chalk.red(`  Error: ${message.error}`));
        }
        break;
      }

      case 'tool_progress': {
        // spinner already running — just let it spin
        break;
      }

      case 'result': {
        spinner.stop();
        result = message;
        if (message.is_error) {
          console.error(chalk.red(`Error: ${message.errors?.join('\n') || message.subtype}`));
        }
        const secs = (message.duration_ms / 1000).toFixed(1);
        const cost = message.total_cost_usd.toFixed(2);
        console.log(chalk.dim(`  ${secs}s | ${message.num_turns} turns | $${cost}`));
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
      return `Writing ${rel(input.file_path)}`;
    case 'Read':
      return `Reading ${rel(input.file_path)}`;
    case 'Edit':
      return `Editing ${rel(input.file_path)}`;
    case 'Bash': {
      const full = input.command || '';
      const cmd = full.split('\n')[0].slice(0, 60);
      return cmd + (cmd.length < full.length ? '...' : '');
    }
    default:
      return block.name;
  }
}

function rel(filePath) {
  if (!filePath) return '';
  const cwd = process.cwd();
  return filePath.startsWith(cwd + path.sep) ? filePath.slice(cwd.length + 1) : filePath;
}

module.exports = { runAgent };
