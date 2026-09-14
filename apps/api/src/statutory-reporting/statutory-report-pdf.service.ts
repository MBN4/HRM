import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { isRtlLanguage } from '@hrm/shared';
import type { StatutoryReportData } from './statutory-report-generator.interface';

const FONT_REGULAR = `${__dirname}/../../assets/fonts/DejaVuSans.ttf`;
const FONT_BOLD = `${__dirname}/../../assets/fonts/DejaVuSans-Bold.ttf`;

export interface StatutoryReportPdfRenderInput {
  data: StatutoryReportData;
  tenantName: string;
  branchName: string;
  /** This report definition's own VERIFY-style compliance note (see `packages/db/src/seed-statutory-report-definitions.ts`) — printed directly on the PDF so a downloaded/shared/printed copy still carries the "verify before filing" warning, not only the portal UI around it. */
  complianceNote: string;
}

/**
 * Renders one generated statutory report as a PDF — reuses the SAME
 * `pdfkit` + bundled-DejaVu-font approach `PayslipPdfService` (2.1)
 * established (see docs/conventions/payroll.md's font note; the same
 * Arabic/Urdu complex-text-shaping limitation applies here). RTL alignment
 * follows the resolved pack's own `language`, the SAME `isRtlLanguage`
 * mechanism payslips already use — this is the first PDF renderer in this
 * codebase to lay out a genuine per-employee TABLE rather than a flat line
 * list, so column headers/rows are drawn manually (no PDF table library is
 * available in this environment, consistent with `PayslipPdfService`'s own
 * "no PDF-generation skill available" note).
 */
@Injectable()
export class StatutoryReportPdfService {
  async render(input: StatutoryReportPdfRenderInput): Promise<Buffer> {
    const { data } = input;
    const rtl = isRtlLanguage(data.language);
    const align = rtl ? 'right' : 'left';

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 40, layout: 'landscape' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', FONT_REGULAR);
      doc.registerFont('bold', FONT_BOLD);

      doc.font('bold').fontSize(16).text(data.reportName, { align });
      doc
        .font('body')
        .fontSize(10)
        .text(`${input.tenantName} — ${input.branchName} (${data.countryCode})`, { align })
        .text(`Period: ${data.periodLabel}`, { align })
        .moveDown(0.5);

      const identityHeaders = ['Employee', 'Code', 'CNIC', 'NTN'];
      const headers = [...identityHeaders, ...data.columns.map((c) => c.label)];
      const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / headers.length;

      const drawRow = (cells: string[], font: 'body' | 'bold') => {
        const y = doc.y;
        doc.font(font).fontSize(9);
        cells.forEach((cell, i) => {
          doc.text(cell, doc.page.margins.left + i * colWidth, y, { width: colWidth, align });
        });
        doc.moveDown(0.3);
      };

      drawRow(headers, 'bold');
      for (const row of data.rows) {
        drawRow(
          [
            row.identity.employeeName,
            row.identity.employeeCode,
            row.identity.cnic ?? '—',
            row.identity.ntn ?? '—',
            ...data.columns.map((c) => `${(row.values[c.key] ?? 0).toFixed(2)}`),
          ],
          'body',
        );
      }

      drawRow(['TOTAL', '', '', '', ...data.columns.map((c) => `${(data.totals[c.key] ?? 0).toFixed(2)} ${data.currencyCode}`)], 'bold');

      doc.moveDown(1);
      doc.font('bold').fontSize(9).text('Compliance notice', { align });
      doc.font('body').fontSize(8).text(input.complianceNote, { align });

      doc.end();
    });
  }
}
