import { isRtlLanguage, directionFor } from '../rtl';

describe('isRtlLanguage()', () => {
  it('recognizes the known RTL language codes, case-insensitively', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('AR')).toBe(true);
    expect(isRtlLanguage('he')).toBe(true);
    expect(isRtlLanguage('fa')).toBe(true);
    expect(isRtlLanguage('ur')).toBe(true);
  });

  it('returns false for LTR languages', () => {
    expect(isRtlLanguage('en')).toBe(false);
    expect(isRtlLanguage('fr')).toBe(false);
  });
});

describe('directionFor()', () => {
  it('maps a boolean to the literal rtl/ltr strings', () => {
    expect(directionFor(true)).toBe('rtl');
    expect(directionFor(false)).toBe('ltr');
  });
});
