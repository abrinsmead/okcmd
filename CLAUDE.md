# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ok` is a CLI that turns a markdown specification into a running, containerized web app. It uses the Claude Agent SDK to generate a single-file Deno/TypeScript application, builds a Docker image, and runs it.

## Commands

```bash
npm install && npm link   # Install deps and register the `ok` global command
ok build <spec.md>        # Generate app from spec + build Docker image
ok run                    # Run a previously built image
ok serve <spec.md>        # build + run in one step
ok clean                  # Remove .ok/ dir and Docker image
```

Requires `ANTHROPIC_API_KEY` in `.env` (loaded via dotenv).

## Architecture

**Runtime split:** The CLI itself runs on Node.js (CommonJS). The generated apps run on Deno (TypeScript).

**Source modules:**

- `bin/ok.js` — Shebang entry point, just requires `src/cli.js`
- `src/cli.js` — Commander command definitions, dotenv setup
- `src/agent.js` — Wrapper around `@anthropic-ai/claude-agent-sdk`'s `query()` with streaming output formatting
- `src/assertions.js` — Exports `extractAssertions(spec)`: uses a text-only agent call with structured output to extract testable behavioral assertions from a spec. Returns `string[]`, gracefully degrades to empty array on failure
- `src/build.js` — Core generation logic: extracts assertions from spec, sends spec + assertions to Claude Agent, writes `.ok/app.ts` + `.ok/test.ts`, generates Dockerfile, runs `docker build`. Has smart diffing — if spec hasn't changed, skips regeneration; if spec changed, re-extracts assertions and sends a diff-based update prompt
- `src/run.js` — Reads image name from `.ok/name`, runs `docker run` with port mapping and signal forwarding

**Build output (`.ok/` directory):**

- `spec.md` — Saved copy of input spec (used for change detection)
- `app.ts` — Generated Deno application
- `test.ts` — Generated Deno test file that verifies behavioral assertions (created when assertions are extracted)
- `assertions.json` — Extracted behavioral assertions from the spec (array of strings)
- `name` — Spec name (used for Docker image tag: `ok-{name}:latest`)
- `Dockerfile` — Generated, always uses `denoland/deno:latest`

**Key generation constraints** (in `build.js` `requirements` string):

- Port from `PORT` env var
- `npm:` prefix for npm imports in Deno
- `jsr:@db/sqlite` for persistence (not `npm:better-sqlite3`)
- No backticks in embedded frontend JS (breaks outer template literal)
- Single-file architecture — frontend is embedded HTML/JS in the TypeScript server

## Conventions

- All source is CommonJS (`require`/`module.exports`), module type set in package.json
- The agent SDK is the one async import (`await import(...)`) because it's ESM-only
- `.ok/` is gitignored — it's a build artifact directory
- Docker image naming: `ok-{specname}:latest`
- No test suite exists currently
