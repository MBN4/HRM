import { translate, DEFAULT_LOCALE, SUPPORTED_LOCALES, UI_MESSAGES } from '../messages';

describe('translate()', () => {
  it('renders a known key in the requested locale', () => {
    expect(translate('en', 'action.save')).toBe('Save');
    expect(translate('ar', 'action.save')).toBe('حفظ');
  });

  it('interpolates {{placeholder}} vars', () => {
    expect(translate('en', 'dashboard.greeting', { name: 'Sam' })).toBe('Welcome back, Sam');
  });

  it('falls back to DEFAULT_LOCALE when the requested locale is missing the key', () => {
    // Simulate a translation gap: 'ar' catalog missing a key 'en' has.
    const key = '__test_only_missing_from_ar__';
    (UI_MESSAGES.en as Record<string, string>)[key] = 'English only';
    expect(translate('ar', key)).toBe('English only');
    delete (UI_MESSAGES.en as Record<string, string>)[key];
  });

  it('renders [[key]] when a key is missing from every locale', () => {
    expect(translate('en', 'this.key.does.not.exist')).toBe('[[this.key.does.not.exist]]');
  });

  it('both supported locales define every key the DEFAULT_LOCALE catalog defines', () => {
    const defaultKeys = Object.keys(UI_MESSAGES[DEFAULT_LOCALE]);
    for (const locale of SUPPORTED_LOCALES) {
      const keys = Object.keys(UI_MESSAGES[locale]);
      expect(keys.sort()).toEqual(defaultKeys.sort());
    }
  });
});
