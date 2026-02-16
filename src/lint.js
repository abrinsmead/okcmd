const fs = require('fs');
const path = require('path');
const { runAgent } = require('./agent');

async function lint(filename, opts) {
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

  if (opts.fix) {
    console.log('Analyzing spec for ambiguity and applying fixes...\n');
    await runFix(spec, specPath);
  } else {
    console.log('Analyzing spec for ambiguity...\n');
    await runCheck(spec);
  }
}

async function runCheck(spec) {
  const prompt =
    `<spec>\n${spec}\n</spec>\n\n` +
    `You are a specification linter. Analyze the spec above for ambiguity that would cause an AI to produce different applications on repeated runs.\n\n` +
    `Check for:\n` +
    `1. **Underspecified data models** — fields listed without types, sizes, constraints, or defaults\n` +
    `2. **Vague descriptions** — subjective language ("nice", "clean", "modern", "intuitive", "good") that different runs will interpret differently\n` +
    `3. **Missing API details** — mentions a REST API or endpoints without specifying all methods, paths, request bodies, or response shapes\n` +
    `4. **Unspecified technology choices** — needs a frontend but doesn't specify CSS approach, component style, or layout structure\n` +
    `5. **Incomplete CRUD** — defines a data model but only specifies some operations, leaving the AI to guess the rest\n` +
    `6. **Ambiguous relationships** — references between entities without specifying cardinality (one-to-many vs many-to-many), cascading behavior, or required vs optional\n` +
    `7. **Missing validation rules** — no constraints on user input (required fields, formats, min/max values)\n` +
    `8. **Implicit requirements** — things the spec assumes but doesn't state (e.g., ordering of lists, pagination, empty states)\n\n` +
    `For each issue, output exactly this format:\n\n` +
    `  warning  <Category> (<section or line reference>)\n` +
    `           <What is ambiguous and why it causes varying results>\n` +
    `           Fix: <Concrete suggestion to eliminate the ambiguity>\n\n` +
    `After listing all issues, print a summary line:\n\n` +
    `  X warnings found\n\n` +
    `If the spec is fully unambiguous, print:\n\n` +
    `  0 warnings found\n\n` +
    `Do NOT use any tools. Only output text.`;

  await runAgent(prompt, { allowedTools: [] });
}

async function runFix(spec, specPath) {
  const prompt =
    `The file at ${specPath} contains this specification:\n\n` +
    `<spec>\n${spec}\n</spec>\n\n` +
    `You are a specification linter with fix mode enabled. Your job:\n\n` +
    `1. First, analyze the spec for ambiguity that would cause an AI to produce different applications on repeated runs. Check for:\n` +
    `   - Underspecified data models (fields without types, sizes, constraints, defaults)\n` +
    `   - Vague descriptions (subjective language like "nice", "clean", "modern")\n` +
    `   - Missing API details (incomplete endpoint specs)\n` +
    `   - Unspecified technology choices\n` +
    `   - Incomplete CRUD operations\n` +
    `   - Ambiguous entity relationships (missing cardinality, cascade behavior)\n` +
    `   - Missing validation rules\n` +
    `   - Implicit requirements (ordering, pagination, empty states)\n\n` +
    `2. Then, rewrite the spec to resolve every ambiguity you found. Preserve the author's intent and don't add features they didn't ask for — just make what's there precise enough to produce the same application every time.\n\n` +
    `3. Write the fixed spec to ${specPath} using the Write tool.\n\n` +
    `4. After writing, print a summary of every change you made and why.`;

  await runAgent(prompt, { allowedTools: ['Write', 'Read'] });
}

module.exports = { lint };
