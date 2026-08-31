import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { isRtlLanguage } from '@hrm/shared';
import type { PayrollComponentLine } from '../engine/payroll-engine.service';

const FONT_REGULAR = `${__dirname}/../../../assets/fonts/DejaVuSans.ttf`;
const FONT_BOLD = `${__dirname}/../../../assets/fonts/DejaVuSans-Bold.ttf`;

export interface PayslipRenderInput {
  tenantName: string;
  employeeName: string;
  employeeCode: string;
  periodYear: number;
  periodMonth: number;
  currencyCode: string;
  language: string;
  /** `{ key -> label }` from the resolved pack's own `payslipTemplate.lineItems` — the ONLY source of payslip copy, never hardcoded English/Arabic strings here. */
  lineItemLabels: Record<string, string>;
  componentBreakdown: PayrollComponentLine[];
}

/**
 * Renders one payslip PDF from the resolved pack's OWN `payslipTemplate`
 * (language + ordered line items, already-existing 0.5 pack data — this
 * service adds nothing new to the pack schema) via `pdfkit` — see
 * docs/conventions/payroll.md for why `pdfkit` (no PDF-generation skill
 * was actually available in this environment) and the bundled-font/
 * Arabic-shaping limitation note. Uploaded via 1.1's `StorageService` by
 * the caller (`PayrollRunService`) — this class only produces bytes, it
 * has no knowledge of storage or the DB.
 */
@Injectable()
export class PayslipPdfService {
  async render(input: PayslipRenderInput): Promise<Buffer> {
    const rtl = isRtlLanguage(input.language);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', FONT_REGULAR);
      doc.registerFont('bold', FONT_BOLD);

      const align = rtl ? 'right' : 'left';

      doc.font('bold').fontSize(18).text(input.tenantName, { align });
      doc
        .font('body')
        .fontSize(11)
        .text(`${input.employeeName} (${input.employeeCode})`, { align })
        .text(`${input.periodYear}-${String(input.periodMonth).padStart(2, '0')}`, { align })
        .moveDown();

      for (const line of input.componentBreakdown) {
        const label = input.lineItemLabels[line.key] ?? line.label;
        const font = line.type === 'SUBTOTAL' ? 'bold' : 'body';
        doc.font(font).fontSize(11).text(`${label}: ${line.amount.toFixed(2)} ${input.currencyCode}`, { align });
      }

      doc.end();
    });
  }
}
