/**
 * Byte-identical duplicate of `@hrm/shared/src/i18n/interpolate.ts` — see
 * src/constants/app.ts's doc comment for why this app duplicates rather
 * than imports the handful of `@hrm/shared` pieces it needs.
 */
export function interpolateTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : '',
  );
}
