import { isAlias, isScalar, parseDocument, visit, type Document } from 'yaml';

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;

interface Reference {
  value: string;
  comment: string;
}

/** The text and trailing comment of a scalar, following a YAML alias (`uses: *checkout`) to its anchor. */
function scalar(node: unknown, doc: Document): Reference | undefined {
  const target = isAlias(node) ? node.resolve(doc) : node;
  return isScalar(target)
    ? { value: String(target.value), comment: (target.comment ?? '').trim() }
    : undefined;
}

/**
 * `uses:` entries of a workflow or composite action that are not pinned to a full commit SHA with a
 * `# vX.Y.Z` comment (tags, branches, docker images, missing comments), and `image:` entries
 * (container, services) that are not pinned by digest. Local `./` actions are in the guard
 * snapshot, which also pins everything else about a workflow.
 */
export function findUnpinnedUses(source: string): string[] {
  const doc = parseDocument(source, { merge: true });
  const found: string[] = [];
  visit(doc, {
    Pair(_key, pair) {
      const key = scalar(pair.key, doc)?.value;
      const reference = scalar(pair.value, doc);
      if (!reference) return;
      if (key === 'uses' && !reference.value.startsWith('./')) {
        if (!PINNED.test(reference.value) || !VERSION_COMMENT.test(reference.comment)) {
          found.push(
            `${reference.value}${reference.comment === '' ? '' : ` # ${reference.comment}`}`,
          );
        }
      } else if (key === 'image' && !reference.value.includes('@sha256:')) {
        found.push(`image ${reference.value} is not pinned by digest`);
      }
    },
  });
  return found;
}
