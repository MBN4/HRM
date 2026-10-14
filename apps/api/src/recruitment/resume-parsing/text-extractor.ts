import { strFromU8, unzipSync } from 'fflate';
import { UnparseableResumeError } from './resume-parser.interface';

import { Worker } from 'worker_threads';

const MIN_EXTRACTED_CHARS = 30;
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;

/** `.doc`/OLE2 magic — recognised only to give a clear "convert it" error rather than garbage text. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  return bytes.every((b, i) => buffer[i] === b);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Runs inline in a `worker_threads` Worker (a plain-JS string, so there is no
 * extra file to ship/copy into `dist`). Why a worker at all: a PDF is
 * UNTRUSTED input and pdf.js parsing is CPU-heavy — isolating it keeps a
 * pathological upload from blocking the event loop of the process it shares
 * with other jobs, lets us hard-cap its memory (`resourceLimits`) and time
 * (`terminate()` on timeout), and sidesteps pdf.js' dynamic-import worker
 * bootstrap, which doesn't work inside Jest's module sandbox.
 */
const PDF_WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { PDFParse } = require(workerData.modulePath);
(async () => {
  const parser = new PDFParse({ data: new Uint8Array(workerData.data) });
  try {
    const result = await parser.getText();
    parentPort.postMessage({ ok: true, text: result.text });
  } catch (error) {
    parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
})();
`;

const PDF_PARSE_TIMEOUT_MS = 30_000;
const PDF_WORKER_MEMORY_MB = 256;

/** pdf-parse v2 (a current pdf.js) — the older v1 line bundled a 2018 pdf.js that rejected many modern PDFs ("bad XRef entry"). */
function extractPdfText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const unreadable = () => new UnparseableResumeError('The PDF could not be read (it may be corrupt or password-protected).');
    const worker = new Worker(PDF_WORKER_SOURCE, {
      eval: true,
      workerData: { modulePath: require.resolve('pdf-parse'), data: buffer },
      resourceLimits: { maxOldGenerationSizeMb: PDF_WORKER_MEMORY_MB },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new UnparseableResumeError('The PDF took too long to read and was skipped.'));
    }, PDF_PARSE_TIMEOUT_MS);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    worker.once('message', (m: { ok: boolean; text?: string }) =>
      done(() => (m.ok ? resolve((m.text ?? '').replace(/^-- \d+ of \d+ --$/gm, '')) : reject(unreadable()))),
    );
    worker.once('error', () => done(() => reject(unreadable())));
    worker.once('exit', () => done(() => reject(unreadable())));
  });
}

function extractDocxText(buffer: Buffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), { filter: (f) => f.name === 'word/document.xml' && f.originalSize <= MAX_DOCX_XML_BYTES });
  } catch {
    throw new UnparseableResumeError('The file is not a readable DOCX document.');
  }
  const xmlBytes = files['word/document.xml'];
  if (!xmlBytes) {
    throw new UnparseableResumeError('The file is not a readable DOCX document (no document body found).');
  }
  const xml = strFromU8(xmlBytes);
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<w:(br|cr)\s*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/**
 * Plain-text extraction for the default parser. PDF via `pdf-parse`
 * (v2 — wraps a current pdf.js), DOCX via `fflate` (unzip) + a tag-strip of
 * `word/document.xml`, TXT as UTF-8. Type is detected from magic bytes first
 * and the file name/content-type second, so a mislabelled upload still works.
 * Image-only (scanned) PDFs yield no text and are reported as unparseable —
 * OCR is explicitly out of scope for the built-in parser.
 */
export async function extractResumeText(buffer: Buffer, fileName: string, contentType?: string | null): Promise<string> {
  const lowerName = fileName.toLowerCase();
  let text: string;

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    text = await extractPdfText(buffer);
  } else if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    text = extractDocxText(buffer);
  } else if (startsWith(buffer, OLE2_MAGIC)) {
    throw new UnparseableResumeError('Legacy .doc files are not supported — please upload a PDF or DOCX.');
  } else if (lowerName.endsWith('.txt') || contentType?.startsWith('text/')) {
    text = buffer.toString('utf8');
  } else {
    throw new UnparseableResumeError('Unsupported file type — please upload a PDF, DOCX or TXT resume.');
  }

  const normalised = text.replace(/\r\n?/g, '\n').replace(/[ \t\u00A0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (normalised.length < MIN_EXTRACTED_CHARS) {
    throw new UnparseableResumeError('No readable text was found in the file (is it a scanned image?).');
  }
  return normalised;
}
