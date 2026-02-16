# ok — Functional Spec

## Overview

`ok` is a CLI tool that turns a written specification into a running application. You give it a markdown spec file, and it uses the Claude Agent SDK to generate a single-file Deno/TypeScript app, then runs it.

## Installation

```
npm install
npm link
```

Requires `ANTHROPIC_API_KEY` environment variable to be set.

## Commands

### `ok serve <filename>`

Reads a specification file and generates a runnable Deno application from it.

**Arguments:**
- `filename` (required) — path to a specification file (typically markdown)

**Behavior:**

1. **Read** the spec file from `<filename>`.
2. **Create** a `.ok/` directory in the current working directory.
3. **Copy** the spec file into `.ok/spec.md` (preserving a record of what was used to generate the app).
4. **Call the Claude Agent SDK** with the spec contents and the following prompt:

   > Given the input specification, build a TypeScript app in a single file (app.ts) that can be run from Deno. Use the `npm:` prefix in Deno to import npm modules at runtime. If the specification requires a front end, the Deno server shall serve a React application. If the specification requires persistence, use SQLite via `npm:better-sqlite3` and store data in `data.db`.

5. **Write** the generated code to `.ok/app.ts`. If the agent produces a seed/schema file, write it to `.ok/data.ts`.
6. **Validate** the generated app by running it with Deno. If Deno reports errors, feed the errors back to the Claude agent and regenerate. Repeat until the app starts cleanly (up to a reasonable retry limit).
7. **Run** the app: `deno run --allow-all .ok/app.ts`.

**Output directory structure:**
```
.ok/
├── spec.md     # Copy of the input specification
├── app.ts      # Generated Deno/TypeScript application
└── data.db     # SQLite database (created at runtime, only if persistence is needed)
```

**Errors:**
- Missing `filename` → Commander prints an error and exits with code 1
- File not found → print error message and exit with code 1
- `ANTHROPIC_API_KEY` not set → print error message and exit with code 1
- Agent generation fails after max retries → print last error and exit with code 1

### `ok --version`

Prints the current version (`1.0.0`).

### `ok --help`

Prints usage information listing all available commands and options.

## Project Structure

```
ok/
├── bin/
│   └── ok.js           # CLI entry point (Commander setup, serve command)
├── node_modules/
├── package.json
├── package-lock.json
└── ok.md               # This spec
```

## Dependencies

- **commander** — CLI argument parsing
- **@anthropic-ai/claude-code** — Claude Agent SDK for code generation

## Technical Details

- **CLI runtime:** Node.js (CommonJS)
- **Generated app runtime:** Deno (TypeScript, npm: imports)
- **Authentication:** `ANTHROPIC_API_KEY` environment variable
- **Entry point:** `bin/ok.js`
- **Global binary name:** `ok`
