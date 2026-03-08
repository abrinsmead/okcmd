import fs from 'fs';
import path from 'path';
import * as ui from './ui';
import { createRuntime, RuntimeName } from './runtime';

export function deriveSpecName(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

export async function build(filename: string, opts?: { runtime?: RuntimeName }): Promise<void> {
  const specPath = path.resolve(filename);
  if (!fs.existsSync(specPath)) {
    ui.error(`File not found: ${specPath}`);
    process.exit(1);
  }

  const spec = fs.readFileSync(specPath, 'utf-8');
  const specName = deriveSpecName(filename);
  const runtime = createRuntime(opts?.runtime || 'docker');
  await runtime.build(specName, spec);
}
