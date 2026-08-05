import { Document, parseDocument, visit, isMap, isSeq, isScalar, type Node, type Pair } from 'yaml';

// Deterministic YAML emission (project-core.md §3.6): schema-defined key
// order, 2-space indent, block style, no anchors/aliases, minimal quoting,
// trailing newline. Comments must survive programmatic edits, which is why
// canonicalization reorders an existing Document instead of rebuilding it.

export interface KeyOrder {
  keys?: string[];
  children?: Record<string, KeyOrder>;
  items?: KeyOrder; // applied to each element of a sequence
}

const STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 80,
  aliasDuplicateObjects: false,
} as const;

function keyName(pair: Pair): string | undefined {
  return isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined;
}

function orderNode(node: Node | null, order: KeyOrder | undefined): void {
  if (!order || node == null) return;
  if (isMap(node)) {
    const keys = order.keys ?? [];
    const rank = new Map(keys.map((k, i) => [k, i]));
    const indexed = node.items.map((pair, i) => ({ pair, i }));
    indexed.sort((a, b) => {
      const ra = rank.get(keyName(a.pair) ?? '') ?? keys.length + a.i;
      const rb = rank.get(keyName(b.pair) ?? '') ?? keys.length + b.i;
      return ra - rb || a.i - b.i;
    });
    node.items = indexed.map((e) => e.pair);
    for (const pair of node.items) {
      const child = order.children?.[keyName(pair) ?? ''];
      if (child) orderNode(pair.value as Node | null, child);
    }
  } else if (isSeq(node) && order.items) {
    for (const item of node.items) orderNode(item as Node | null, order.items);
  }
}

// Block style is canonical (project-core.md §3.6): clear flow flags on all
// non-empty collections so `a: [1, 2]` formats as a block sequence. Empty
// collections keep their inline `[]` / `{}` rendering.
function clearFlow(doc: Document): void {
  const block = (_key: unknown, node: { items: unknown[]; flow?: boolean }) => {
    if (node.items.length > 0) node.flow = false;
    return undefined;
  };
  visit(doc, { Map: block, Seq: block });
}

// Reorder a parsed document in place to canonical key order, keeping
// comments attached to their pairs.
export function canonicalizeDocument(doc: Document, order: KeyOrder): void {
  clearFlow(doc);
  orderNode(doc.contents, order);
}

export function stringifyDocument(doc: Document): string {
  return doc.toString(STRINGIFY_OPTIONS);
}

// Canonical emission of a fresh value (no comments to preserve).
export function stringifyCanonical(value: unknown, order?: KeyOrder): string {
  const doc = new Document(value);
  if (order) canonicalizeDocument(doc, order);
  return stringifyDocument(doc);
}

// Anchors and aliases are banned from checked-in files (project-core.md
// §3.6): an alias makes one logical edit mean N textual things, which
// breaks the diffable-YAML contract.
export function hasAnchorsOrAliases(doc: Document): boolean {
  let found = false;
  const flagAnchor = (_key: unknown, node: { anchor?: string | undefined }) => {
    if (node.anchor) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  };
  visit(doc, {
    Alias: () => {
      found = true;
      return visit.BREAK;
    },
    Scalar: flagAnchor,
    Map: flagAnchor,
    Seq: flagAnchor,
  });
  return found;
}

// Canonical form of existing YAML text: parse, reorder, restringify.
// Comments and blank-line structure survive; formatting becomes canonical.
export function canonicalText(text: string, order: KeyOrder): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]!.message);
  }
  canonicalizeDocument(doc, order);
  return stringifyDocument(doc);
}
