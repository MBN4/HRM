/**
 * The one `{{placeholder}}` substitution mechanism used across this
 * codebase — originally written for `NotificationTemplateRenderer` (step
 * 0.8), promoted here in step 0.9 so the web apps' UI message catalog (see
 * `messages.ts`) can share it instead of re-implementing the same regex.
 * Deliberately simple string substitution, not a template *language* —
 * there is no conditional/loop syntax, and there never should be:
 * `NotificationTemplate.body`/`subject` are vendor-authored data (see
 * /CLAUDE.md § Conventions → Notifications → Templates), and giving them
 * anything more expressive than substitution would start to resemble the
 * sandboxed-expression problem the rules/workflow engines exist to solve
 * safely — out of scope for what is meant to stay plain copy.
 */
export function interpolateTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) =>
    vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : '',
  );
}
