export interface CsvRow {
  line: number; // the line of the file on which the row starts (1-based)
  fields: string[];
  error?: string; // set when the row is not valid RFC 4180; `fields` is then incomplete
}

// RFC 4180: comma-separated fields, rows ending in \n or \r\n, double-quoted fields that may
// contain commas, line breaks and "" for one quote. Completely empty lines are skipped.
// A quote inside an unquoted field, text after a closing quote, or a CR outside quotes that does not
// start \r\n is a syntax error: the row gets an `error` and the rest of its line is skipped. An
// unclosed quote is an error too; it runs to the end of the input.
export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterQuote = false; // just past a closing quote: only a comma or a line ending may follow
  let error: string | undefined;
  let hasContent = false;
  let line = 1;
  let rowStart = 1;

  const endRow = () => {
    if (hasContent) {
      fields.push(field);
      rows.push(error === undefined ? { line: rowStart, fields } : { line: rowStart, fields, error });
    }
    fields = [];
    field = "";
    afterQuote = false;
    error = undefined;
    hasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const lineEnd = ch === "\n" || (ch === "\r" && text[i + 1] === "\n");
    if (error !== undefined && !lineEnd) continue; // skip the rest of a malformed row's line
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
        afterQuote = true;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === ",") {
      fields.push(field);
      field = "";
      afterQuote = false;
      hasContent = true;
    } else if (lineEnd) {
      if (ch === "\r") i++;
      endRow();
      line++;
      rowStart = line;
    } else if (afterQuote) {
      error = "Only a comma or a line ending may follow a closing quote";
    } else if (ch === '"' && field === "") {
      inQuotes = true;
      hasContent = true;
    } else if (ch === '"') {
      error = "A double quote may only appear in a quoted field";
    } else if (ch === "\r") {
      error = "A CR outside quotes must be followed by LF";
      hasContent = true;
    } else {
      field += ch;
      hasContent = true;
    }
  }
  if (inQuotes) error = "A quoted field is not closed";
  endRow();
  return rows;
}
