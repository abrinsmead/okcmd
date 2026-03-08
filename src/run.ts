import * as ui from './ui';
import { deriveSpecName } from './build';
import { createRuntime, RuntimeName, RunOpts } from './runtime';

interface RunCommandOpts extends RunOpts {
  runtime?: RuntimeName;
}

export async function run(filename: string, opts: RunCommandOpts): Promise<void> {
  if (!filename) {
    ui.error('Usage: ok run <spec.md>');
    process.exit(1);
  }

  const specName = deriveSpecName(filename);
  const runtime = createRuntime(opts.runtime || 'docker');
  await runtime.run(specName, opts);
}
