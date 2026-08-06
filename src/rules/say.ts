import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SaySound } from '../schema/index.js';
import type { RuleImpl } from './types.js';

const execFileAsync = promisify(execFile);

// say: macOS text-to-speech as a build rule. Local and hermetic — no keys,
// no network — so it belongs in the graph, unlike voice generation (a
// deliberate generate sound on the other side of the determinism
// boundary). Reproducibility is same-machine, like supercollider's: an OS or voice-data
// update may change the rendered bytes, and the action key deliberately
// does not chase OS versions — the contract is recipe-reproducibility
// (build-graph.md "Determinism policy").

type ExecError = Error & { code?: string; stderr?: string };

function formatSayError(err: ExecError, what: string): Error {
  if (err.code === 'ENOENT') {
    return new Error(`${what} not found — the say rule needs macOS`);
  }
  const stderr = (err.stderr ?? '').trim();
  return new Error(`${what} failed: ${stderr !== '' ? stderr : err.message}`);
}

// Installed voice names from `say -v ?`: a name (which may contain
// spaces) padded to a column, then the locale — the 2+ space run is the
// separator.
async function listVoices(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('say', ['-v', '?']);
    return new Set(
      stdout
        .split('\n')
        .map((line) => /^(.*?)\s{2,}/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined && name !== ''),
    );
  } catch (err) {
    throw formatSayError(err as ExecError, 'say -v ?');
  }
}

export const sayRule: RuleImpl<SaySound> = {
  version: 1,
  wiringFields: [],

  sources() {
    return [];
  },

  validate() {
    // text/voice/rate are self-contained; nothing references the project.
    // The voice is verified at execute time, not here — enumerating
    // installed voices at check time would make check's verdict depend on
    // this machine's voice inventory.
  },

  async execute(sound, _inputPaths, outputPath, ctx) {
    // `say` never rejects a voice name — it silently renders with the
    // user's default voice, which is exactly the under-specified-recipe
    // failure a required `voice` exists to prevent. So the rule verifies
    // the name against `say -v ?` itself, exact match: a typo is an
    // error, never someone else's voice under the same action key.
    //
    // `Siri` is the recorded exception: the system-selected Siri voices
    // are not nameable via -v (only a few Siri-branded regional voices
    // ever list) — the system default is the only way to reach them — so
    // voice: Siri omits -v and renders with the machine's Spoken Content
    // voice. That deliberately widens the same-machine caveat (the bytes
    // follow a Settings toggle, not just OS updates; cached renders keep
    // pre-toggle bytes until the key changes); the alternative is the
    // best voices on the machine being unreachable by any recipe.
    const siri = sound.voice === 'Siri';
    if (!siri) {
      const voices = await listVoices();
      if (!voices.has(sound.voice)) {
        throw new Error(
          `voice "${sound.voice}" is not installed — say -v '?' lists voices ` +
            `(names are exact; "Siri" selects the system voice)`,
        );
      }
    }
    // The text goes through a file (-f): text is data, never argv — a
    // line starting with "-" must not become a flag.
    const dir = mkdtempSync(join(tmpdir(), 'bloom-say-'));
    try {
      const textPath = join(dir, 'text.txt');
      const aiffPath = join(dir, 'say.aiff');
      writeFileSync(textPath, sound.text);
      try {
        await execFileAsync(
          'say',
          [
            ...(siri ? [] : ['-v', sound.voice]),
            ...(sound.rate !== undefined ? ['-r', String(sound.rate)] : []),
            '-o',
            aiffPath,
            '-f',
            textPath,
          ],
          { timeout: 120_000 },
        );
      } catch (err) {
        throw formatSayError(err as ExecError, `say (voice "${sound.voice}")`);
      }
      // say renders at the voice's native rate; the graph expects the
      // project rate and Bloom never resamples implicitly downstream, so
      // the rule hands over a WAV at the project rate, like normalize.
      try {
        await execFileAsync('afconvert', [
          '-f',
          'WAVE',
          '-d',
          `LEI16@${ctx.sampleRate}`,
          aiffPath,
          outputPath,
        ]);
      } catch (err) {
        throw formatSayError(err as ExecError, 'afconvert');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
