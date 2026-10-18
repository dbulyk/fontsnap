import { describe, expect, it } from 'vitest';
import { findUnpinnedUses } from '../../scripts/lib/workflow-lint';

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';

describe('findUnpinnedUses', () => {
  it('accepts a full SHA with a version comment', () => {
    expect(
      findUnpinnedUses(`jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n`),
    ).toEqual([]);
  });

  it.each([
    ['a tag', 'actions/checkout@v4'],
    ['a branch', 'actions/cache@main'],
    ['a short SHA', 'actions/checkout@3d3c42e'],
    ['a docker image', 'docker://alpine:3'],
    ['no version at all', 'actions/checkout'],
  ])('rejects %s', (_name, uses) => {
    expect(findUnpinnedUses(`steps:\n  - uses: ${uses} # v1.2.3\n`)).toHaveLength(1);
  });

  it('rejects a SHA without a version comment or with a wrong one', () => {
    expect(findUnpinnedUses(`- uses: actions/checkout@${SHA}\n`)).toHaveLength(1);
    expect(findUnpinnedUses(`- uses: actions/checkout@${SHA} # latest\n`)).toHaveLength(1);
  });

  it('finds uses in flow-style YAML and in composite actions', () => {
    expect(findUnpinnedUses('steps:\n  - { uses: actions/checkout@v4 }\n')).toHaveLength(1);
    expect(
      findUnpinnedUses('runs:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v6\n'),
    ).toHaveLength(1);
  });

  it('follows YAML aliases and merge keys to the anchored value', () => {
    const hidden = `x-checkout: &co actions/checkout@v4\njobs:\n  a:\n    steps:\n      - uses: *co\n`;
    expect(findUnpinnedUses(hidden).length).toBeGreaterThan(0);
    const merged = `x-step: &step\n  uses: actions/checkout@v4\njobs:\n  a:\n    steps:\n      - <<: *step\n`;
    expect(findUnpinnedUses(merged).length).toBeGreaterThan(0);
    const pinned = `x: &co actions/checkout@${SHA} # v7.0.1\njobs:\n  a:\n    steps:\n      - uses: *co\n`;
    expect(findUnpinnedUses(pinned)).toEqual([]);
  });

  it('leaves local actions to the guard snapshot', () => {
    expect(findUnpinnedUses('steps:\n  - uses: ./.github/actions/setup\n')).toEqual([]);
  });

  it('requires container and service images to be pinned by digest', () => {
    expect(findUnpinnedUses('jobs:\n  a:\n    container:\n      image: node:22\n')).toHaveLength(1);
    expect(
      findUnpinnedUses('jobs:\n  a:\n    services:\n      db:\n        image: postgres:17\n'),
    ).toHaveLength(1);
    expect(
      findUnpinnedUses(`jobs:\n  a:\n    container:\n      image: node@sha256:${'a'.repeat(64)}\n`),
    ).toEqual([]);
  });
});
