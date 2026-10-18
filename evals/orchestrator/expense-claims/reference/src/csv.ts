export interface CsvRow {
  line: number; // the line of the file on which the row starts (1-based)
  fields: string[];
}

// RFC 4180: comma-separated fields, rows ending in \n or \r\n, double-quoted fields that may
// contain commas, line breaks and "" for one quote. Completely empty lines are skipped.
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let hasContent = false;
  let line = 1;
  let rowStart = 1;

  const endRow = () => {
    if (hasContent) {
      fields.push(field);
      rows.push({ line: rowStart, fields });
    }
    fields = [];
    field = "";
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      hasContent = true;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      endRow();
      line++;
      rowStart = line;
    } else {
      field += ch;
      hasContent = true;
    }
  }
  endRow();
  return rows;
}
