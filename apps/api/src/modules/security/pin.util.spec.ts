import { assertPinFormat, generatePinPlaintext, computePinStatus } from './pin.util';

describe('pin.util', () => {
  it('generates fixed-length numeric PIN with leading zeros possible', () => {
    for (let i = 0; i < 20; i += 1) {
      const pin = generatePinPlaintext(6);
      expect(pin).toHaveLength(6);
      expect(assertPinFormat(pin)).toBe(true);
    }
  });

  it('rejects non-digit or wrong-length PIN', () => {
    expect(assertPinFormat('12345')).toBe(false);
    expect(assertPinFormat('1234567')).toBe(false);
    expect(assertPinFormat('12ab56')).toBe(false);
    expect(assertPinFormat('000001')).toBe(true);
  });

  it('computes pin status', () => {
    expect(computePinStatus({ pinEnabled: false, pinHash: null, pinLockedUntil: null })).toBe(
      'DISABLED',
    );
    expect(computePinStatus({ pinEnabled: true, pinHash: null, pinLockedUntil: null })).toBe(
      'NOT_SET',
    );
    expect(
      computePinStatus({
        pinEnabled: true,
        pinHash: 'x',
        pinLockedUntil: new Date(Date.now() + 60_000),
      }),
    ).toBe('TEMP_LOCKED');
    expect(computePinStatus({ pinEnabled: true, pinHash: 'x', pinLockedUntil: null })).toBe(
      'ACTIVE',
    );
  });
});
