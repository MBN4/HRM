import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

const FONT_REGULAR = `${__dirname}/../../assets/fonts/DejaVuSans.ttf`;
const FONT_BOLD = `${__dirname}/../../assets/fonts/DejaVuSans-Bold.ttf`;

export interface CertificateSignerLine {
  displayName: string;
  displayEmail: string | null;
  signerType: 'INTERNAL' | 'EXTERNAL';
  signingMethod: string;
  signedAtUtc: string;
  ipAddress: string | null;
  userAgent: string | null;
  documentHash: string;
}

export interface RenderCertificateInput {
  tenantName: string;
  requestTitle: string;
  documentHash: string;
  completedAtUtc: string;
  signers: CertificateSignerLine[];
}

/**
 * Renders the signature CERTIFICATE — the "who signed what, when, hashes"
 * evidentiary summary this step's brief asks for, attachable to the final
 * document — as its own PDF, the SAME `pdfkit`/bundled-DejaVu-font approach
 * `PayslipPdfService`/`SignableDocumentPdfService` both use. Deliberately
 * always LTR/English: this is a system-generated legal-evidentiary record,
 * not tenant-facing UI copy, so it doesn't go through the pack-driven
 * i18n path the signed document itself does — see
 * docs/conventions/e-signatures.md for the honest compliance-boundary
 * framing this certificate carries.
 */
@Injectable()
export class SignatureCertificatePdfService {
  async render(input: RenderCertificateInput): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.registerFont('body', FONT_REGULAR);
      doc.registerFont('bold', FONT_BOLD);

      doc.font('bold').fontSize(18).text('Signature Certificate');
      doc.font('body').fontSize(11).text(input.tenantName).moveDown();

      doc.font('bold').fontSize(12).text('Document');
      doc.font('body').fontSize(11).text(input.requestTitle);
      doc.font('body').fontSize(9).text(`SHA-256: ${input.documentHash}`).moveDown();
      doc.font('body').fontSize(11).text(`Completed at (UTC): ${input.completedAtUtc}`).moveDown();

      doc.font('bold').fontSize(12).text('Signers');
      for (const signer of input.signers) {
        doc.moveDown(0.3);
        doc
          .font('bold')
          .fontSize(11)
          .text(`${signer.displayName}${signer.displayEmail ? ` <${signer.displayEmail}>` : ''} (${signer.signerType})`);
        doc
          .font('body')
          .fontSize(9)
          .text(`Signed at (UTC): ${signer.signedAtUtc}`)
          .text(`Signing method: ${signer.signingMethod}`)
          .text(`IP address: ${signer.ipAddress ?? 'unknown'}`)
          .text(`User agent: ${signer.userAgent ?? 'unknown'}`)
          .text(`Document hash at signing: ${signer.documentHash}`);
      }

      doc
        .moveDown()
        .font('body')
        .fontSize(8)
        .fillColor('#555555')
        .text(
          'This certificate records a tamper-evident trail of the signing activity captured by this ' +
            'system. It is not, by itself, a determination of legal sufficiency under any specific ' +
            "e-signature law (e.g. eIDAS, ESIGN, UETA) or country's requirements — that determination " +
            'is the responsibility of the contracting parties and their counsel.',
        );

      doc.end();
    });
  }
}
