import { resolveRequestId } from './request-id';

describe('resolveRequestId', () => {
  it('reuses a well-formed incoming request id', () => {
    expect(resolveRequestId('client-request-1')).toBe('client-request-1');
  });

  it('generates a UUID when the header is missing', () => {
    const generated = resolveRequestId(undefined);
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('replaces unsafe incoming values', () => {
    const generated = resolveRequestId('bad id with spaces');
    expect(generated).not.toBe('bad id with spaces');
  });
});
