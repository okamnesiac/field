import { WorkerClient, workerAvailable } from '../workers/client.js';
import type { WorkerSpec } from '../workers/protocol.js';
import type { VoiceGenerateJob } from './protocol.js';

// field-voiced: the second generation worker, and the one that turned
// src/aced/client.ts's "tolerated until a third daemon" note into a
// change. Its own process, its own socket and log, so model memory and
// lifecycle stay independent of ACE's (voice-generation.md §1.4).

export const VOICED_SPEC: WorkerSpec = {
  name: 'field-voiced',
  packageDir: 'voiced',
  module: 'field_voiced',
  script: 'field-voiced',
  socketRelative: '.field/voiced.sock',
  logRelative: '.field/voiced.log',
  pythonOverrideEnv: 'FIELD_VOICED_PYTHON',
};

export function voicedAvailable(): { ok: boolean; reason?: string } {
  return workerAvailable(VOICED_SPEC);
}

export class VoicedClient extends WorkerClient {
  static connect(root: string): Promise<VoicedClient> {
    return WorkerClient.connectTo(root, VOICED_SPEC, VoicedClient);
  }

  generate(job: VoiceGenerateJob) {
    return this.requestGenerate({ ...job });
  }
}
