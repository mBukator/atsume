import { describe, expect, it } from 'vitest';
import { baseHeaders, type RequestOptions } from './http';

const options = (overrides: Partial<RequestOptions> = {}): RequestOptions => ({
  userAgent: 'Atsume/0.1',
  timeoutMs: 10_000,
  ...overrides,
});

describe('baseHeaders', () => {
  it('always identifies itself and takes the caller\'s accept', () => {
    expect(baseHeaders(options(), '*/*')).toEqual({
      'user-agent': 'Atsume/0.1',
      accept: '*/*',
    });
    expect(baseHeaders(options({ accept: 'image/*' }), '*/*')['accept']).toBe('image/*');
  });

  it('sends a referer only when one was given', () => {
    // Hotlink protection comes both ways round: some hosts reject a foreign
    // referer, others reject a missing one. Sending an empty header would be
    // the worst of both, so absence has to stay absence.
    expect(baseHeaders(options(), '*/*')).not.toHaveProperty('referer');
    expect(baseHeaders(options({ referer: undefined }), '*/*')).not.toHaveProperty('referer');

    const headers = baseHeaders(options({ referer: 'https://a.test/album/' }), '*/*');
    expect(headers['referer']).toBe('https://a.test/album/');
  });
});
