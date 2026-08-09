import { InvalidArgumentError } from 'commander';

// Option parsers mirroring the sc-render schema: on the command whose
// premise is seeded reproducibility, `--seed abc` must be an error, never a
// silent seed 0.

export function parseSeed(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError('seed must be a non-negative integer');
  }
  return n;
}

export function parseDurationSeconds(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 3600) {
    throw new InvalidArgumentError('duration must be seconds in (0, 3600]');
  }
  return n;
}

export function parseBars(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('bars must be a positive integer');
  }
  return n;
}

// Export's delivery formatting (multi-rate.md decision 1), bounded by the
// same sets the normalize schema accepts — the flags drive the identical
// daemon op, so they may not promise a value it would refuse.
const EXPORT_RATES = [44100, 48000, 88200, 96000, 176400, 192000];

export function parseExportRate(value: string): number {
  const n = Number(value);
  if (!EXPORT_RATES.includes(n)) {
    throw new InvalidArgumentError(`rate must be one of ${EXPORT_RATES.join(', ')}`);
  }
  return n;
}

export function parseExportBitDepth(value: string): 16 | 24 | 32 {
  const n = Number(value);
  if (n !== 16 && n !== 24 && n !== 32) {
    throw new InvalidArgumentError('bit depth must be 16, 24, or 32');
  }
  return n;
}

// Whether this invocation is asking for the version, by position.
// `argv.includes('--version')` matched the flag anywhere, so
// `field build --version` printed a version report and silently never
// built — substituting a different command where a parser would have
// complained (#70 review). argv[2] is the only position where this flag
// means the whole program; every other shape belongs to commander.
export function wantsVersion(argv: string[]): boolean {
  return argv[2] === '--version' || argv[2] === '-V';
}

export function parseVariants(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new InvalidArgumentError('variants must be an integer in [1, 8]');
  }
  return n;
}

// The two voice knobs. Fractional on purpose — unlike bpm and variants,
// these are continuous, and the useful moves are small ones (0.5 to 0.3
// slowed creek's line by a fifth). Bounds match the recipe schema's, so
// a value that would be rejected on the way to disk is rejected here,
// before the model runs.
export function parseExaggeration(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.25 || n > 2) {
    throw new InvalidArgumentError('exaggeration must be a number in [0.25, 2]');
  }
  return n;
}

export function parseConviction(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.1 || n > 1) {
    throw new InvalidArgumentError('conviction must be a number in [0.1, 1]');
  }
  return n;
}

export function parseBpm(value: string): number {
  const n = Number(value);
  // Integer, not merely in range: the recipe schema records integer bpm,
  // and a fractional value must fail here — not after the WAVs land.
  if (!Number.isInteger(n) || n < 30 || n > 300) {
    throw new InvalidArgumentError('bpm must be an integer in [30, 300]');
  }
  return n;
}

export function parseVariantNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError('variant must be a positive integer (1-based)');
  }
  return n;
}

export function parseChannels(value: string): 1 | 2 {
  const n = Number(value);
  if (n !== 1 && n !== 2) {
    throw new InvalidArgumentError('channels must be 1 or 2');
  }
  return n;
}
