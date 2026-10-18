import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../src/shared/errors';

describe('errorMessage', () => {
  it('uses the message of an Error', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(new TypeError('bad'))).toBe('bad');
  });

  it.each([
    ['text', 'text'],
    [42, '42'],
    [undefined, 'undefined'],
    [null, 'null'],
  ])('turns the non-Error %j into %j', (value, text) => {
    expect(errorMessage(value)).toBe(text);
  });
});
