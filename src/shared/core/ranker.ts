import { at } from './at';

/** model/meta.json: families, display names, popularity ranks and merge rules. */
export interface Meta {
  fams: string[];
  display: string[];
  inGF: boolean[];
  category: string[];
  rank: number[];
  classFam: number[];
  merge: Record<string, string>;
  keepNoto: string[];
}

export interface RankedFont {
  key: string;
  name: string;
  inGF: boolean;
  category: string;
  score: number;
  conf: number;
}

export interface RankOptions {
  alpha?: number;
  merge?: boolean;
  k?: number;
}

export function makeRanker(meta: Meta): {
  rank: (probList: ArrayLike<number>[], options?: RankOptions) => RankedFont[];
  mg: (f: string) => string;
} {
  const keep = meta.keepNoto;
  const merges = new Map(Object.entries(meta.merge));
  const mg = (f: string): string =>
    f.startsWith('notosans') && !keep.some((k) => f.startsWith(k))
      ? 'notosans'
      : (merges.get(f) ?? f);
  const idx = new Map(meta.fams.map((f, i) => [f, i]));
  function rank(
    probList: ArrayLike<number>[],
    { alpha = 0.5, merge = true, k = 5 }: RankOptions = {},
  ): RankedFont[] {
    const nf = meta.fams.length;
    const fp = new Float64Array(nf);
    for (const p of probList) {
      for (let i = 0; i < p.length; i++) {
        const f = at(meta.classFam, i);
        fp[f] = at(fp, f) + at(p, i) / probList.length;
      }
    }
    if (alpha) for (let i = 0; i < nf; i++) fp[i] = at(fp, i) * at(meta.rank, i) ** -alpha;
    const order = [...fp.keys()].sort((a, b) => at(fp, b) - at(fp, a) || a - b).slice(0, 40);
    const out: Omit<RankedFont, 'conf'>[] = [];
    for (const i of order) {
      const f = merge ? mg(at(meta.fams, i)) : at(meta.fams, i);
      if (out.some((o) => o.key === f)) continue;
      const j = idx.get(f) ?? i;
      out.push({
        key: f,
        name: at(meta.display, j),
        inGF: at(meta.inGF, j),
        category: at(meta.category, j),
        score: at(fp, i),
      });
    }
    const top = out.slice(0, k);
    const tot = top.reduce((a, o) => a + o.score, 0) || 1;
    return top.map((o) => ({ ...o, conf: o.score / tot }));
  }
  return { rank, mg };
}
