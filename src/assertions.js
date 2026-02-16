const { runAgent } = require('./agent');
const chalk = require('chalk');

const assertionSchema = {
  type: 'json',
  schema: {
    type: 'object',
    properties: {
      assertions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['assertions'],
    additionalProperties: false,
  },
};

const baseInstructions =
  `Extract concrete, testable behavioral assertions.\n\n` +
  `Focus on:\n` +
  `- API endpoints: method, path, expected status codes, response shape\n` +
  `- Data persistence: creating an item then retrieving it should work\n` +
  `- Frontend content: key text, elements, or UI components that must be present\n` +
  `- Core workflows: sequences of actions that must succeed end-to-end\n\n` +
  `Each assertion should be a single sentence describing one testable behavior.\n` +
  `Be specific — include HTTP methods, paths, status codes, and field names where applicable.\n` +
  `Do NOT include assertions about implementation details (which framework, file structure, etc).\n`;

async function extractAssertions(spec) {
  const prompt =
    `You are analyzing a web application specification.\n\n` +
    baseInstructions +
    `\n<spec>\n${spec}\n</spec>`;

  return await runExtraction(prompt);
}

async function extractAssertionsFromDiff(diff, existingAssertions) {
  const prompt =
    `You are updating behavioral assertions for a web application whose spec has changed.\n\n` +
    `Here are the existing assertions:\n` +
    existingAssertions.map((a, i) => `${i + 1}. ${a}`).join('\n') + '\n\n' +
    `Here is the spec diff:\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
    `Return the complete updated assertion list: keep unchanged assertions as-is, ` +
    `remove any that no longer apply, and add new ones for the changed/added behavior.\n\n` +
    baseInstructions;

  return await runExtraction(prompt);
}

async function runExtraction(prompt) {
  try {
    const result = await runAgent(prompt, {
      allowedTools: [],
      maxTurns: 1,
      outputFormat: assertionSchema,
      quiet: true,
    });

    if (result?.structured_output?.assertions) {
      return result.structured_output.assertions;
    }

    if (result?.result) {
      const match = result.result.match(/\{[\s\S]*"assertions"[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed.assertions)) {
          return parsed.assertions;
        }
      }
    }

    return [];
  } catch (err) {
    console.error(chalk.yellow(`Assertion extraction failed: ${err.message}`));
    return [];
  }
}

module.exports = { extractAssertions, extractAssertionsFromDiff };
