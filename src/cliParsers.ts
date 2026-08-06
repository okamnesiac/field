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

export function parseVariants(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new InvalidArgumentError('variants must be an integer in [1, 8]');
  }
  return n;
}

export function parseBpm(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 30 || n > 300) {
    throw new InvalidArgumentError('bpm must be in [30, 300]');
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
