# Bundled fonts

`DejaVuSans.ttf`/`DejaVuSans-Bold.ttf` — used by `PayslipPdfService`
(step 2.1, Payroll) to render payslip PDFs via `pdfkit`. Bundled directly
in the repo (rather than relying on the deployment environment having a
system font installed) so PDF generation is portable across any Docker
base image, including minimal ones with no fonts at all.

Chosen specifically because DejaVu Sans has real Arabic-script glyph
coverage — needed for the Qatar reference pack's `payslipTemplate`
(`language: 'ar'`). It does **not** perform Arabic contextual shaping/
joining or bidi reordering (pdfkit has no complex-text-layout engine) —
glyphs render individually rather than joined cursive script, a known,
accepted limitation of this reference implementation. See
docs/conventions/payroll.md.

License: Bitstream Vera License (permissive, explicitly allows
redistribution as part of a larger software package) — see
https://dejavu-fonts.github.io/License.html. Source:
https://dejavu-fonts.github.io/.
