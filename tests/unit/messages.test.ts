import { describe, expect, it } from 'vitest';
import { allowedSenders, isKnownType, isResponse, parseRequest } from '../../src/shared/messages';
import { PROTOTYPE_NAMES } from './helpers/media';

const rect = { x: 10, y: 20, w: 300, h: 40 };
const message = { type: 'fontsnap-rect', rect, dpr: 2, text: 'Hello' };

describe('parseRequest', () => {
  it('accepts a fontsnap-rect request and ignores extra keys', () => {
    expect(parseRequest(message)).toEqual({ ok: true, request: message });
    expect(parseRequest({ ...message, extra: 1 })).toEqual({ ok: true, request: message });
  });

  it.each([
    null,
    undefined,
    'fontsnap-rect',
    42,
    [],
    {},
    { type: 42 },
    { type: 'nope' },
    { type: 'count-page' },
  ])('rejects %j', (raw) => {
    expect(parseRequest(raw).ok).toBe(false);
  });

  it.each([
    ['no rect', { type: 'fontsnap-rect', dpr: 1, text: '' }],
    ['a rect without size', { ...message, rect: { x: 0, y: 0, w: 0, h: 10 } }],
    ['a negative size', { ...message, rect: { x: 0, y: 0, w: 10, h: -1 } }],
    ['a non-finite coordinate', { ...message, rect: { x: Infinity, y: 0, w: 10, h: 10 } }],
    ['string coordinates', { ...message, rect: { x: '0', y: '0', w: '10', h: '10' } }],
    ['a rect that is not an object', { ...message, rect: 'rect' }],
  ])('rejects %s', (_name, raw) => {
    expect(parseRequest(raw)).toEqual({ ok: false, error: 'Invalid "fontsnap-rect" request' });
  });

  it('keeps a non-numeric dpr as NaN and a non-string text as empty, for the handler to normalise', () => {
    const parsed = parseRequest({ ...message, dpr: 'two', text: 7 });
    expect(parsed.ok && parsed.request.text).toBe('');
    expect(parsed.ok && Number.isNaN(parsed.request.dpr)).toBe(true);
  });
});

describe('isKnownType', () => {
  it('recognizes only declared request types', () => {
    expect(isKnownType({ type: 'fontsnap-rect' })).toBe(true);
    expect(isKnownType({ type: 'toString' })).toBe(false);
    expect(isKnownType('fontsnap-rect')).toBe(false);
  });

  // The type comes from a message any web page can send; the table must not answer for inherited names.
  it.each(PROTOTYPE_NAMES)('does not know the inherited name %s as a request type', (name) => {
    const raw = JSON.parse(`{"type":"${name}"}`) as unknown;
    expect(isKnownType(raw), name).toBe(false);
    expect(parseRequest(raw), name).toEqual({ ok: false, error: 'Unknown message type' });
  });
});

describe('isResponse', () => {
  it('accepts well-formed success and error envelopes', () => {
    expect(isResponse('fontsnap-rect', { ok: true, data: { opened: true } })).toBe(true);
    expect(isResponse('fontsnap-rect', { ok: false, error: 'x' })).toBe(true);
  });

  it.each([
    undefined,
    null,
    'ok',
    { ok: true },
    { ok: true, data: { opened: false } },
    { ok: true, data: 'opened' },
    { ok: false },
    { ok: false, error: 5 },
  ])('rejects %j', (raw) => {
    expect(isResponse('fontsnap-rect', raw)).toBe(false);
  });
});

describe('allowedSenders', () => {
  it('declares who may send each request type: only a content script may send the selection', () => {
    expect(allowedSenders('fontsnap-rect')).toEqual(['content-script']);
  });
});
