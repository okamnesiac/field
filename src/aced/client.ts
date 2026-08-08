import { WorkerClient, workerAvailable } from '../workers/client.js';
import type { WorkerSpec } from '../workers/protocol.js';
import type { AceGenerateJob } from './protocol.js';

// field-aced is one WorkerSpec now (src/workers/client.ts). What was
// specific to it turned out to be seven strings and a job type; the
// spawn, handshake, correlation and event forwarding are the same
// interaction every generation worker has.

export const ACED_SPEC: WorkerSpec = {
  name: 'field-aced',
  packageDir: 'aced',
  module: 'field_aced',
  script: 'field-aced',
  socketRelative: '.field/aced.sock',
  logRelative: '.field/aced.log',
  pythonOverrideEnv: 'FIELD_ACED_PYTHON',
};

export function acedAvailable(): { ok: boolean; reason?: string } {
  return workerAvailable(ACED_SPEC);
}

export class AcedClient extends WorkerClient {
  static connect(root: string): Promise<AcedClient> {
    return WorkerClient.connectTo(root, ACED_SPEC, AcedClient);
  }

  generate(job: AceGenerateJob) {
    return this.requestGenerate({ ...job });
  }
}
