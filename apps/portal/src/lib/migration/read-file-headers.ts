import * as XLSX from 'xlsx';

/** Client-side extension sniff — the backend independently trusts the `fileFormat` field sent alongside the upload, this is only for a sensible UI default. */
export function inferFileFormat(file: File): 'CSV' | 'XLSX' {
  return file.name.toLowerCase().endsWith('.xlsx') ? 'XLSX' : 'CSV';
}

/**
 * Reads just the HEADER row of an uploaded file, client-side, so the
 * mapping step can offer a dropdown of the client's own column names
 * before anything is sent to the server — see docs/conventions/data-migration.md.
 * A minimal, good-enough-for-a-header-row CSV split (not a full RFC4180
 * parser — the real, authoritative parse happens server-side via
 * `csv-parse`); XLSX reuses the same SheetJS library the backend uses,
 * reading only the first row of the first sheet.
 */
export async function readFileHeaders(file: File): Promise<string[]> {
  if (inferFileFormat(file) === 'XLSX') {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, blankrows: false });
    return (rows[0] ?? []).map((cell) => String(cell ?? '').trim()).filter(Boolean);
  }
  const text = await file.text();
  const firstLine = text.split(/\r?\n/)[0] ?? '';
  return parseCsvHeaderLine(firstLine);
}

function parseCsvHeaderLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result.filter(Boolean);
}
