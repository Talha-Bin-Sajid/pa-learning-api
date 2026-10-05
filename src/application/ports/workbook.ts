/** Spreadsheet generation and parsing, independent of the Excel library used. */

export type Cell = string | number | boolean | null;

export interface SheetSpec {
  name: string;
  rows: Cell[][];
  /** Column widths in characters. */
  columnWidths?: number[];
  /** Row index (0-based) of the header row: bold, frozen and filterable. Omit for none. */
  headerRow?: number;
  /** Rows (0-based) rendered as titles (bold, larger). */
  titleRows?: number[];
}

export interface WorkbookWriter {
  write(sheets: SheetSpec[], meta?: { title?: string }): Promise<Buffer>;
}

export interface WorkbookReader {
  /**
   * Reads the first sheet of an .xlsx or .csv file into objects keyed by
   * normalised header (trimmed, lower-case, spaces → underscores). Empty rows are skipped.
   */
  readRows(bytes: Uint8Array, fileName: string): Promise<{ rowNumber: number; values: Record<string, string> }[]>;
}
