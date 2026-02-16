# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ok` is a CLI that turns a markdown specification into a running, containerized web app. All agentic code generation happens inside a Docker build — the CLI is a thin wrapper around `docker build`.

## Commands

```bash
npm install && npm link   # Install deps and register the `ok` global command
ok build <spec.md>        # Build Docker image (generation happens inside Docker)
ok run <spec.md>          # Run a previously built image
ok serve <spec.md>        # Build + run in one step
ok stop <spec.md>         # Stop a running container
ok clean                  # Remove .ok/ build artifacts
```

Run/serve options:

```bash
ok run <spec.md> -p 8080                        # Custom port
ok serve <spec.md> -e DATABASE_URL=postgres://…  # Pass env vars to the app
ok serve <spec.md> --env-file .env.app           # Pass env file to the app
```

Requires `ANTHROPIC_API_KEY` in `.env` (loaded via dotenv). The key is passed as a Docker secret mount and only exists in the builder stage — it's discarded in the final image.

## Architecture

**Runtime split:** The CLI runs on Node.js (CommonJS). Code generation runs inside Docker via `src/builder.mjs` (Node.js ESM). Generated apps run on `node:lts-alpine` and can use any language/framework available in that image.

**Source modules:**

- `bin/ok.js` — Shebang entry point, just requires `src/cli.js`
- `src/cli.js` — Commander command definitions, dotenv setup
- `src/build.js` — Thin orchestrator: validates inputs, checks for existing image (extracts spec to compare), stages `.ok/` build context, runs `docker build` with secret mount for API key
- `src/builder.mjs` — Node.js ESM script that runs inside Docker during build. Calls `claude -p` (headless mode), reads `/app/spec.md`, generates the app under `/app/`
- `src/run.js` — Derives image tag from spec filename, runs `docker run` with port mapping, env vars, and signal forwarding

**Build flow:**

1. CLI validates inputs, derives image tag (`ok-{specName}:latest`)
2. Checks for existing image — extracts spec via `docker create`/`docker cp`, compares to current spec
3. If unchanged: skip. If changed or new: stage `.ok/` with spec.md, builder.mjs, Dockerfile
4. `docker build` runs a multi-stage build:
   - Stage 1 (builder): `node:lts-alpine` + Claude Code, runs `builder.mjs` which calls `claude -p` to generate the app
   - Stage 2 (runtime): Clean `node:lts-alpine` image with the generated app files
5. Cleans up `.ok/`

**Key generation constraints** (in `builder.mjs` `requirements` string):

- Entrypoint must be `/app/start.sh`
- Single HTTP server on port from `PORT` env var
- Runtime is `node:lts-alpine` — Node.js available, other runtimes via apk/npm
- Simple MVP architecture — Vite for frontend, Express for backend
- No heavy frameworks (Next.js, Remix, etc.)

## Conventions

- All CLI source is CommonJS (`require`/`module.exports`), module type set in package.json
- `builder.mjs` is Node.js ESM — it only runs inside Docker
- `.ok/` is gitignored — it's a temporary staging directory cleaned up after build
- Docker image naming: `ok-{specname}:latest`
- Example specs live in `examples/`
- No test suite exists currently
