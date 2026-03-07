export interface Runtime {
  build(specName: string, specContent: string): Promise<void>;
  run(specName: string, opts: RunOpts): Promise<void>;
  stop(specName: string): Promise<void>;
  destroy(specName: string): Promise<void>;
}

export interface RunOpts {
  port?: string;
  env?: string[];
  envFile?: string;
}

export type RuntimeName = 'docker' | 'daytona' | 'blaxel';

export function createRuntime(name: RuntimeName): Runtime {
  switch (name) {
    case 'docker': {
      const { DockerRuntime } = require('./runtimes/docker');
      return new DockerRuntime();
    }
    case 'daytona': {
      try {
        const { DaytonaRuntime } = require('./runtimes/daytona');
        return new DaytonaRuntime();
      } catch (e: any) {
        if (e.code === 'MODULE_NOT_FOUND') {
          throw new Error(
            'Daytona runtime requires @daytonaio/sdk. Install it with: npm install @daytonaio/sdk'
          );
        }
        throw e;
      }
    }
    case 'blaxel': {
      try {
        const { BlaxelRuntime } = require('./runtimes/blaxel');
        return new BlaxelRuntime();
      } catch (e: any) {
        if (e.code === 'MODULE_NOT_FOUND') {
          throw new Error(
            'Blaxel runtime requires @blaxel/core. Install it with: npm install @blaxel/core'
          );
        }
        throw e;
      }
    }
    default:
      throw new Error(`Unknown runtime: ${name}`);
  }
}
