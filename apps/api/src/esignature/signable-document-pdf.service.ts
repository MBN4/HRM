import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { isRtlLanguage } from '@hrm/shared';

const FONT_REGULAR = `${__dirname}/../../assets/fonts/DejaVuSans.ttf`;
const FONT_BOLD = `${__dirname}/../../assets/fonts/DejaVuSans-Bold.ttf`;

export interface RenderTextDocumentInput {
  title: string;
  paragraphs: string[];
  /** Drives RTL alignment — see docs/conventions/i18n-timezone-rtl.md. Defaults to `'en'` when the caller has no resolved pack language to hand (a bare uploaded/custom document has none). */
  language?: string;
}

/**
 * A generic text-document PDF renderer — reuses `PayslipPdfService`'s OWN
 * approach byte-for-byte (same `pdfkit` choice, same bundled DejaVu fonts
 * for Arabic glyph coverage, same RTL-alignment-via-`isRtlLanguage`
 * posture — see docs/conventions/payroll.md for the original rationale).
 * Renders an offer letter, a policy's `title`/`body`, or a free-form
 * "CUSTOM" HR document from the SAME small function — this module has no
 * per-document-type rendering logic, only different CALLERS assembling
 * different paragraph lists (see `SignatureRequestService.resolveDocument`).
 */
@Injectable()
export class SignableDocumentPdfService {
  async renderTextDocument(input: RenderTextDocumentInput): Promise<Buffer> {
    const rtl = isRtlLanguage(input.language ?? 'en');

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', FONT_REGULAR);
      doc.registerFont('bold', FONT_BOLD);

      const align = rtl ? 'right' : 'left';

      doc.font('bold').fontSize(16).text(input.title, { align }).moveDown();
      doc.font('body').fontSize(11);
      for (const paragraph of input.paragraphs) {
        doc.text(paragraph, { align }).moveDown(0.5);
      }

      doc.end();
    });
  }
}
