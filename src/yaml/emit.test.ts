import { describe, expect, it } from 'vitest';
import { canonicalText, stringifyCanonical, type KeyOrder } from './emit.js';

const order: KeyOrder = {
  keys: ['name', 'type', 'clips'],
  children: { clips: { items: { keys: ['id', 'asset', 'position'] } } },
};

describe('stringifyCanonical', () => {
  it('orders keys per schema regardless of input order', () => {
    const text = stringifyCanonical({ type: 'audio', clips: [], name: 'lead-vocal' }, order);
    expect(text).toBe('name: lead-vocal\ntype: audio\nclips: []\n');
  });

  it('orders nested sequence items', () => {
    const text = stringifyCanonical(
      { name: 't', type: 'audio', clips: [{ position: 0, id: 'a-1', asset: 'x.wav' }] },
      order,
    );
    expect(text).toContain('- id: a-1\n    asset: x.wav\n    position: 0\n');
  });

  it('keeps unknown keys after known ones in original order', () => {
    const text = stringifyCanonical({ zebra: 1, name: 'x', apple: 2 }, { keys: ['name'] });
    expect(text).toBe('name: x\nzebra: 1\napple: 2\n');
  });
});

describe('canonicalText', () => {
  it('is idempotent', () => {
    const once = canonicalText('type: audio\nname: x\nclips: []\n', order);
    expect(canonicalText(once, order)).toBe(once);
  });

  it('preserves comments while reordering', () => {
    const input = '# the lead vocal\ntype: audio\nname: lead-vocal # renamed 2026\nclips: []\n';
    const out = canonicalText(input, order);
    expect(out).toContain('# the lead vocal');
    expect(out).toContain('# renamed 2026');
    expect(out.indexOf('name:')).toBeLessThan(out.indexOf('type:'));
  });

  it('rejects invalid YAML', () => {
    expect(() => canonicalText('a: [unclosed', order)).toThrow();
  });

  it('converts flow style to block style (§3.6)', () => {
    const out = canonicalText(
      'name: t\ntype: audio\nclips: [{id: a-1, asset: x, position: 0}]\n',
      order,
    );
    expect(out).toBe(
      'name: t\ntype: audio\nclips:\n  - id: a-1\n    asset: x\n    position: 0\n',
    );
  });

  it('keeps empty collections inline', () => {
    const out = canonicalText('name: t\ntype: audio\nclips: []\n', order);
    expect(out).toBe('name: t\ntype: audio\nclips: []\n');
  });
});
