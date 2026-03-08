import chalk from 'chalk';

const S_BAR = '\u2502';
const S_STEP = '\u25C7';
const S_STEP_ACTIVE = '\u25C6';
const S_STEP_ERROR = '\u25A0';
const S_BAR_END = '\u2514';

export function intro(title: string) {
  console.log();
  console.log(chalk.cyan(S_STEP_ACTIVE) + '  ' + chalk.bold(title));
}

export function step(message: string) {
  console.log(`${chalk.cyan(S_STEP_ACTIVE)}  ${message}`);
}

export function stepDone(message: string) {
  console.log(`${chalk.green(S_STEP)}  ${chalk.dim(message)}`);
}

export function info(message: string) {
  console.log(`${chalk.dim(S_BAR)}  ${chalk.dim(message)}`);
}

export function success(message: string) {
  console.log(`${chalk.green(S_STEP)}  ${chalk.green(message)}`);
}

export function error(message: string) {
  console.log(`${chalk.red(S_STEP_ERROR)}  ${chalk.red(message)}`);
}

export function outro(message: string) {
  console.log();
  console.log(`${chalk.dim(S_BAR_END)}  ${message}`);
  console.log();
}

export function bar() {
  console.log(chalk.dim(S_BAR));
}

export function prefixLines(text: string) {
  const prefix = chalk.dim(`${S_BAR}  `);
  for (const line of text.split('\n')) {
    if (line) process.stderr.write(prefix + chalk.dim(line) + '\n');
  }
}

export function prefixStream(stream: NodeJS.ReadableStream) {
  const prefix = chalk.dim(`${S_BAR}  `);
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    for (const line of lines) {
      process.stderr.write(prefix + chalk.dim(line) + '\n');
    }
  });
  stream.on('end', () => {
    if (buffer) {
      process.stderr.write(prefix + chalk.dim(buffer) + '\n');
    }
  });
}
