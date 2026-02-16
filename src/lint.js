const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const chalk = require('chalk');

const TOOL = {
  name: 'report_findings',
  description: 'Report all findings from analyzing the spec. Call this exactly once with the complete list of findings.',
  input_schema: {
    type: 'object',
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['severity', 'type', 'line', 'message', 'suggestion'],
          properties: {
            severity: { type: 'string', enum: ['error', 'warning'] },
            type: { type: 'string', enum: ['ambiguity', 'missing-detail', 'contradiction', 'underspecified-ui', 'underspecified-data', 'underspecified-behavior'] },
            line: { type: 'integer', description: 'Line number in the spec (1-indexed)' },
            message: { type: 'string', description: 'What the problem is' },
            suggestion: { type: 'string', description: 'How to fix it' },
          },
        },
      },
    },
  },
};

async function callClaude(messages, tools) {
  const body = {
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = { type: 'tool', name: 'report_findings' };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  return res.json();
}

function buildPrompt(spec) {
  return `You are a spec linter for "ok", a CLI that turns markdown specs into containerized web apps.

Runtime constraints the generated app must satisfy:
- Runtime image is node:lts-alpine (Node.js available, other runtimes via apk/npm)
- Entrypoint is /app/start.sh
- Single HTTP server on PORT env var
- Frontend: Vite (React template). Backend: Express. No Next.js/Remix/heavy frameworks.
- No native npm packages (no node-gyp/Python). For SQLite use sql.js, not better-sqlite3.

Analyze this spec for issues that would cause bad or ambiguous code generation. Focus on:
- Ambiguous requirements that could be interpreted multiple ways
- Missing details that a developer would need to ask about
- Contradictions between different parts of the spec
- Underspecified UI (layout, interactions, states not described)
- Underspecified data (schema, relationships, constraints not defined)
- Underspecified behavior (edge cases, error handling, flows not described)

Be pragmatic — only flag things that would genuinely cause problems. Don't flag things that have obvious reasonable defaults.

Severity rules:
- error: ONLY for contradictions — where two parts of the spec directly conflict
- warning: everything else (ambiguity, missing details, underspecified areas)

<spec>
${spec}
</spec>`;
}

function printFinding(finding, filename) {
  const sev = finding.severity === 'error'
    ? chalk.red(finding.severity.padEnd(7))
    : chalk.yellow(finding.severity.padEnd(7));
  const type = finding.type.padEnd(24);
  const loc = chalk.dim(`${filename}:${finding.line}`);

  console.log(`  ${sev}  ${type}  ${loc}`);
  console.log(`    ${finding.message}`);
  if (finding.suggestion) {
    console.log(`    ${chalk.dim(finding.suggestion)}`);
  }
}

function summarizeFindings(findings) {
  if (findings.length === 0) {
    console.log(chalk.green('No issues found.'));
    return;
  }
  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.filter(f => f.severity === 'warning').length;
  const parts = [];
  if (errors) parts.push(`${errors} error${errors > 1 ? 's' : ''}`);
  if (warnings) parts.push(`${warnings} warning${warnings > 1 ? 's' : ''}`);
  console.log(`${findings.length} issue${findings.length > 1 ? 's' : ''} (${parts.join(', ')})`);
}

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (buf) => {
      const key = buf.toString();
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (key === '\u0003') { process.stdout.write('\n'); process.exit(130); } // ctrl-c
      const accept = key === 'y' || key === 'Y' || key === '\r';
      process.stdout.write(accept ? 'y\n' : 'n\n');
      resolve(accept ? 'y' : 'n');
    });
  });
}

function prompt(question) {
  const { createInterface } = require('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(message) {
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r${chalk.hex('#FF9900')(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])} ${message}`);
  }, 80);
  return { stop: () => { clearInterval(id); process.stdout.write('\r\x1b[K'); } };
}

function fixFinding(specPath, finding, userInstructions) {
  let fixPrompt = `Fix this issue in ${specPath}:

[${finding.severity}] Line ${finding.line} (${finding.type}): ${finding.message}
Suggestion: ${finding.suggestion}`;

  if (userInstructions) {
    fixPrompt += `\n\nUser instructions: ${userInstructions}`;
  }

  fixPrompt += `\n\nEdit the spec file to address this finding. Keep the same style. Only change what's needed.
Output a single short sentence describing what you changed. Nothing else — no thinking, no preamble.`;

  const result = spawnSync('claude', [
    '-p', fixPrompt,
    '--allowedTools', 'Edit,Read',
    '--dangerously-skip-permissions',
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  if (result.status !== 0) {
    console.error(chalk.red('  claude failed:'), (result.stderr || '').trim());
    return false;
  }

  const output = (result.stdout || '').trim();
  if (output) console.log(`    ${chalk.green(output)}`);
  return true;
}

async function lint(filename, opts) {
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
  const displayName = path.basename(filename);

  // Analyze
  const spin = startSpinner(`Linting ${displayName}...`);

  const response = await callClaude(
    [{ role: 'user', content: buildPrompt(spec) }],
    [TOOL],
  );

  spin.stop();

  const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'report_findings');
  if (!toolBlock) {
    console.error(chalk.red('Unexpected response from API (no tool call)'));
    process.exit(1);
  }

  const { findings } = toolBlock.input;

  if (findings.length === 0) {
    console.log();
    console.log(chalk.green('No issues found.'));
    return;
  }

  let fixed = 0;

  console.log();
  for (const finding of findings) {
    printFinding(finding, displayName);

    if (opts.fix) {
      const answer = await ask(`    ${chalk.hex('#FF9900')('Fix with Claude Code?')} ${chalk.dim('(Y/n)')} `);
      if (answer === 'y') {
        const userInstructions = await prompt(`    ${chalk.dim('Instructions (Enter to skip):')} `);
        const spin = startSpinner('Fixing...');
        const ok = fixFinding(specPath, finding, userInstructions || undefined);
        spin.stop();
        if (ok) fixed++;
      }
    }

    console.log();
  }

  summarizeFindings(findings);

  if (opts.fix && fixed > 0) {
    console.log(chalk.green(`Fixed ${fixed} issue${fixed > 1 ? 's' : ''} in ${displayName}`));
  } else if (!opts.fix) {
    const errors = findings.filter(f => f.severity === 'error').length;
    if (errors > 0) process.exit(1);
  }
}

module.exports = { lint };
