import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import type { ImportFileFormatKey } from '@hrm/shared';

export interface ParsedFileRow {
  rowNumber: number;
  /** Keyed by the CLIENT'S OWN original column headers, exactly as they appear in the file — not yet mapped to our field names. */
  raw: Record<string, string>;
}

/**
 * Parses an uploaded CSV or XLSX file into rows keyed by the file's OWN
 * column headers — mapping those headers onto our field names is a
 * SEPARATE step (`applyColumnMapping`), so this function has no opinion on
 * entity type at all. Both formats normalize to the same all-string-values
 * shape `csv-row.util.ts` (1.1) already established, so every downstream
 * coercion (`z.coerce.date()`, `z.coerce.number()`, ...) works identically
 * regardless of which format the client uploaded — XLSX cells are read with
 * `raw: false` specifically to get formatted strings, not the SheetJS
 * numeric/date-serial internal representation.
 */
export function parseImportFile(buffer: Buffer, format: ImportFileFormatKey): ParsedFileRow[] {
  const records: Record<string, string>[] = format === 'CSV' ? parseCsv(buffer) : parseXlsx(buffer);
  return records.map((raw, index) => ({ rowNumber: index + 2, raw }));
}

function parseCsv(buffer: Buffer): Record<string, string>[] {
  try {
    return parse(buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
  } catch (error) {
    throw new BadRequestException(`Could not parse CSV file: ${error instanceof Error ? error.message : 'invalid file.'}`);
  }
}

function parseXlsx(buffer: Buffer): Record<string, string>[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (error) {
    throw new BadRequestException(`Could not parse Excel file: ${error instanceof Error ? error.message : 'invalid file.'}`);
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new BadRequestException('The Excel file has no sheets.');
  }
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '', raw: false });
}

/** `{ [ourFieldKey]: value }` — a blank/absent source column maps to `''`, treated by every importer as "not provided." */
export function applyColumnMapping(raw: Record<string, string>, columnMapping: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [ourField, sourceHeader] of Object.entries(columnMapping)) {
    mapped[ourField] = (raw[sourceHeader] ?? '').toString().trim();
  }
  return mapped;
}

export function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
