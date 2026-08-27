import { interpolateTemplate } from './interpolate';

/**
 * The static UI message catalog for `apps/portal`/`apps/admin` — DIFFERENT
 * from `NotificationTemplate` (0.8): that table is tenant-facing,
 * vendor-authored, DB-stored, versioned COPY (emails, in-app notification
 * text) editable without a deploy. This catalog is application CHROME
 * (button labels, nav items, generic error text) — ordinary UI strings
 * that ship with the code, translated at build/commit time like any other
 * source file, not tenant- or admin-editable data. Both share the SAME
 * `{{placeholder}}` substitution mechanism (`interpolateTemplate`) so
 * there is exactly one templating syntax in this codebase, not two.
 *
 * See /CLAUDE.md § Conventions → i18n / timezone / RTL for the full
 * write-up of when to add to this catalog vs. a `NotificationTemplate`
 * row.
 */
export const SUPPORTED_LOCALES = ['en', 'ar'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export type MessageKey = keyof typeof UI_MESSAGES.en;

export const UI_MESSAGES: Record<SupportedLocale, Record<string, string>> = {
  en: {
    'app.name': 'HRM',
    'nav.dashboard': 'Dashboard',
    'nav.settings': 'Settings',
    'nav.signOut': 'Sign out',
    'action.save': 'Save',
    'action.cancel': 'Cancel',
    'common.loading': 'Loading…',
    'common.welcome': 'Welcome, {{name}}',
    'error.generic': 'Something went wrong. Please try again.',
  },
  ar: {
    'app.name': 'نظام الموارد البشرية',
    'nav.dashboard': 'لوحة التحكم',
    'nav.settings': 'الإعدادات',
    'nav.signOut': 'تسجيل الخروج',
    'action.save': 'حفظ',
    'action.cancel': 'إلغاء',
    'common.loading': 'جارٍ التحميل…',
    'common.welcome': 'مرحبًا، {{name}}',
    'error.generic': 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  },
};

/**
 * Looks up `key` in `locale`'s catalog, falling back to `DEFAULT_LOCALE`
 * ("en") if that locale is missing the key entirely (a translation gap,
 * not an error — unlike `NotificationTemplateRenderer`'s server-side
 * fallback, a missing UI string must never crash rendering). A key
 * missing from EVERY locale renders visibly as `[[key]]` rather than
 * silently as empty text, so a translation gap is obvious in the UI
 * instead of invisible.
 */
export function translate(locale: SupportedLocale, key: string, vars: Record<string, unknown> = {}): string {
  const template = UI_MESSAGES[locale]?.[key] ?? UI_MESSAGES[DEFAULT_LOCALE][key];
  if (template === undefined) {
    return `[[${key}]]`;
  }
  return interpolateTemplate(template, vars);
}
