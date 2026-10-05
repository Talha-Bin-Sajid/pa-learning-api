import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import type { Cell, SheetSpec, WorkbookReader, WorkbookWriter } from '../../application/ports/workbook.js';
import { UnsupportedMediaError, ValidationError } from '../../shared/errors/app-errors.js';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7FB' } } as const;

/** exceljs-backed workbook writer/reader. */
export class ExcelWorkbook implements WorkbookWriter, WorkbookReader {
  async write(sheets: SheetSpec[], meta: { title?: string } = {}): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Project Accountants Learning Platform';
    wb.company = 'Project Accountants';
    wb.title = meta.title ?? '';
    wb.created = new Date();

    for (const spec of sheets) {
      const ws = wb.addWorksheet(spec.name.slice(0, 31));
      for (const row of spec.rows) ws.addRow(row.map((c) => (c === null ? '' : c)));
      spec.columnWidths?.forEach((w, i) => {
        ws.getColumn(i + 1).width = w;
      });
      for (const t of spec.titleRows ?? []) ws.getRow(t + 1).font = { bold: true, size: 13 };
      if (spec.headerRow !== undefined) {
        const r = spec.headerRow + 1;
        const header = ws.getRow(r);
        header.font = { bold: true };
        header.eachCell((cell) => {
          cell.fill = HEADER_FILL;
          cell.border = { bottom: { style: 'thin', color: { argb: 'FF97AAC6' } } };
        });
        ws.views = [{ state: 'frozen', ySplit: r }];
        const width = spec.rows[spec.headerRow]?.length ?? 0;
        if (width > 0 && spec.rows.length > spec.headerRow + 1) {
          ws.autoFilter = { from: { row: r, column: 1 }, to: { row: spec.rows.length, column: width } };
        }
      }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async readRows(bytes: Uint8Array, fileName: string): Promise<{ rowNumber: number; values: Record<string, string> }[]> {
    const lower = fileName.toLowerCase();
    const wb = new ExcelJS.Workbook();
    try {
      if (lower.endsWith('.csv')) {
        await wb.csv.read(Readable.from(Buffer.from(bytes)));
      } else if (lower.endsWith('.xlsx')) {
        await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
      } else {
        throw new UnsupportedMediaError('Upload an .xlsx or .csv file.', 'UNSUPPORTED_SPREADSHEET');
      }
    } catch (err) {
      if (err instanceof UnsupportedMediaError) throw err;
      throw new ValidationError('That file could not be read as a spreadsheet.', undefined, 'UNREADABLE_SPREADSHEET');
    }

    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col] = cellText(cell.value).trim().toLowerCase().replace(/\s+/g, '_');
    });

    const rows: { rowNumber: number; values: Record<string, string> }[] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values: Record<string, string> = {};
      let any = false;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const key = headers[col];
        if (!key) return;
        const text = cellText(cell.value).trim();
        if (text) any = true;
        values[key] = text;
      });
      if (any) rows.push({ rowNumber, values });
    });
    return rows;
  }
}

/** Plain text of any exceljs cell value (dates → YYYY-MM-DD). */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text; // hyperlink
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula
    if ('error' in v) return '';
  }
  return String(v as Cell);
}
