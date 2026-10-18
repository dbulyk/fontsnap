import { describe, expect, it } from 'vitest';
import { pickMode } from '../../src/welcome/mode';

describe('pickMode: manual choice > live toolbar state > ?pinned from the service worker > pin', () => {
  it('shows the pin instructions when nothing says otherwise', () => {
    expect(pickMode({ hash: '', live: null, search: '' })).toBe('pin');
  });

  it('follows ?pinned=1 (usage) and anything else (pin)', () => {
    expect(pickMode({ hash: '', live: null, search: '?pinned=1' })).toBe('usage');
    expect(pickMode({ hash: '', live: null, search: '?pinned=0' })).toBe('pin');
    expect(pickMode({ hash: '', live: null, search: '?pinned=yes' })).toBe('pin');
  });

  it('prefers the live toolbar state over the query', () => {
    expect(pickMode({ hash: '', live: 'pin', search: '?pinned=1' })).toBe('pin');
    expect(pickMode({ hash: '', live: 'usage', search: '?pinned=0' })).toBe('usage');
  });

  it('prefers a manual #pin / #usage choice over everything', () => {
    expect(pickMode({ hash: '#usage', live: 'pin', search: '?pinned=0' })).toBe('usage');
    expect(pickMode({ hash: '#pin', live: 'usage', search: '?pinned=1' })).toBe('pin');
  });

  it('ignores any other hash', () => {
    expect(pickMode({ hash: '#other', live: 'usage', search: '' })).toBe('usage');
    expect(pickMode({ hash: '#USAGE', live: null, search: '' })).toBe('pin');
    expect(pickMode({ hash: 'usage', live: null, search: '' })).toBe('pin');
  });
});
