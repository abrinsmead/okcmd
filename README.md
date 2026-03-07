# ok

Spec in, app out.

```
ok serve spec.md
```

Software engineering is moving up an abstraction layer — from code to prose. The spec becomes the source; code becomes the build artifact.

`ok` is a CLI that turns a markdown specification into a running app. Describe what you want in plain English*, and `ok` handles the rest: code generation via [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview) produces a clean app from your spec. Run it locally in Docker or in a cloud sandbox.

<sub>*Or any written language you prefer.</sub>

## Quick start

```bash
npm install -g okcmd
```

Set your API key:

```bash
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
```

Write a spec:

```markdown
# Counter App

A single-page app with a number displayed in large text and two buttons:
increment (+1) and decrement (-1). The count persists across page reloads
using localStorage.
```

Build and run:

```bash
ok serve counter.md
```

That's it. Open `http://localhost:3000`.

## How it works

```
spec.md → ok build → app artifact → ok run → accessible URL
```

`ok` supports pluggable runtimes. The default is Docker (local containers); you can also use cloud sandbox providers like Daytona.

### Docker (default)

1. **`ok build`** stages your spec into a temporary build context and runs `docker build`
2. Inside Docker, Claude Code reads your spec and generates the entire app — source files, dependencies, startup script
3. A multi-stage build produces a clean `node:lts-alpine` runtime image (no API keys, no build tools)
4. **`ok run`** starts a container from the image with port mapping

On subsequent runs, `ok` compares your spec against the one baked into the existing image. If nothing changed, the build is skipped entirely. If the spec changed, `ok` runs an incremental build — existing app files are carried into the builder stage and only the necessary changes are applied.

### Daytona (cloud sandbox)

1. **`ok build --runtime daytona`** creates a cloud sandbox, installs Claude Code, uploads your spec, and runs the builder
2. The sandbox persists — rebuilds compare the spec and only regenerate if changed
3. **`ok run --runtime daytona`** starts the app inside the sandbox and prints a signed URL you can open in your browser

## Commands

```bash
ok build <spec.md>      # Generate app and build it
ok run <spec.md>        # Run a previously built app
ok serve <spec.md>      # Build + run in one step
ok stop <spec.md>       # Stop a running app
ok destroy <spec.md>    # Remove the image/sandbox entirely
ok lint <spec.md>       # Check spec for issues before building
ok lint <spec.md> --fix # Interactively fix issues
```

Options:

```bash
ok serve <spec.md> -r daytona                    # Use Daytona cloud sandbox
ok run <spec.md> -p 8080                         # Expose on a different port
ok serve <spec.md> -e DATABASE_URL=postgres://…   # Pass env vars to the app
ok serve <spec.md> --env-file .env.app            # Pass env file to the app
```

### Linting

`ok lint` checks your spec for problems that would lead to bad or ambiguous code generation — missing details, underspecified UI/data/behavior, and contradictions.

Findings are either **errors** or **warnings**. Only contradictions (where two parts of the spec directly conflict) are errors. Everything else is a warning. If any errors are found, `ok lint` exits with code 1.

Use `--fix` to walk through each finding interactively. For each issue, you can accept the suggested fix or provide your own instructions for how to fix it. This requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to be installed.

## Writing specs

A spec is just a markdown file that describes your app. The more detail you provide, the closer the output matches your intent. A good spec includes:

- **What the app does** — features, user interactions
- **Data model** — if it has a backend, describe the schema
- **API endpoints** — routes, request/response shapes
- **UI details** — layout, styling preferences, specific behaviors

Minimal specs work too — `ok` will make reasonable choices for anything you don't specify.

### Example: Todo app

```markdown
# Todo App

A web-based todo list.

## Features
- Add, edit, and delete todos
- Mark todos as complete
- Optional due dates with overdue highlighting
- Dark mode toggle (persisted to localStorage)

## Tech
- Backend: Express + SQLite (sql.js)
- Frontend: React served as static files
```

### What gets generated

- A complete working app under `/app/` in the container
- `start.sh` as the entrypoint
- Frontend built with Vite, served as static files
- Express backend (or just static serving if no API is needed)
- Single HTTP server on the `PORT` env var

## Requirements

- **Node.js** >= 18
- **Anthropic API key** with access to Claude Code
- **Docker** runtime (default): Docker running locally (OrbStack and other OCI-compliant runtimes work too)
- **Daytona** runtime: `DAYTONA_API_KEY` in `.env` (optionally `DAYTONA_API_URL`, `DAYTONA_TARGET`)

## Architecture

```mermaid
flowchart TD
    spec["spec.md"] --> cli["ok CLI"]

    cli --> lint["ok lint"]
    cli --> build["ok build"]
    cli --> run["ok run"]
    cli --> serve["ok serve"]
    cli --> destroy["ok destroy"]

    serve -->|"1. build"| build
    serve -->|"2. run"| run

    lint -->|Anthropic API| analyze["Analyze spec for issues"]
    analyze -->|"--fix"| claude_code_fix["Claude Code fixes spec"]

    build --> runtime_choice{"--runtime"}

    runtime_choice -->|"docker (default)"| docker_build["docker build"]
    runtime_choice -->|"daytona"| daytona_build["Create/update sandbox"]

    subgraph Docker["Docker runtime"]
        docker_builder["Stage 1: builder\nnode:lts-alpine + Claude Code\nAPI key (secret mount)"]
        docker_builder -->|"claude -p"| docker_generate["Generate app files"]
        docker_generate --> docker_runtime["Stage 2: runtime\nClean node:lts-alpine\n/app/ + start.sh"]
    end

    subgraph Daytona["Daytona runtime"]
        daytona_sandbox["Cloud sandbox\nClaude Code CLI"]
        daytona_sandbox -->|"node builder.mjs"| daytona_generate["Generate app files"]
        daytona_generate --> daytona_app["/app/ + start.sh\nSigned preview URL"]
    end

    docker_build --> docker_builder
    daytona_build --> daytona_sandbox

    run --> runtime_choice2{"--runtime"}
    runtime_choice2 -->|"docker"| container["Docker container\nlocalhost:PORT"]
    runtime_choice2 -->|"daytona"| sandbox_url["Sandbox\npublic URL"]

    docker_runtime -.-> container
    daytona_app -.-> sandbox_url

    destroy -->|"docker"| rmi["Remove image"]
    destroy -->|"daytona"| delete_sandbox["Delete sandbox"]
```

For Docker, the API key is mounted as a Docker secret — it exists only during the builder stage and is never baked into the final image. For Daytona, the key is passed as an environment variable to the sandbox during build only.

## Project structure

```
bin/ok.js               Entry point (shebang)
src/cli.ts              Command definitions, --runtime flag
src/build.ts            Input validation, delegates to runtime
src/run.ts              Input validation, delegates to runtime
src/runtime.ts          Runtime interface + factory
src/runtimes/docker.ts  Docker runtime — image builds, containers
src/runtimes/daytona.ts Daytona runtime — cloud sandboxes
src/lint.ts             Spec linter — calls Anthropic API to find issues
src/builder.mjs         Runs inside Docker/sandbox — calls Claude Code to generate the app
```

## FAQ

**Why is the command called `ok`?** 

Because it's easy to type.

## License

MIT
