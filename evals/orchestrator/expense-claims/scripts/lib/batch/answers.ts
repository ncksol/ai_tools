// The answer sheet (answers.md) and the rules for picking its row. The reply text always comes
// from the sheet, word for word; this module never invents a reply.
import { readFileSync } from "node:fs";

export interface AnswerRow {
  row: number;
  type: string;
  reply: string;
}

export function parseAnswerSheet(markdown: string): AnswerRow[] {
  const rows: AnswerRow[] = [];
  let inTable = false;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
    if (!inTable) {
      inTable = cells[0]?.toLowerCase() === "question type";
      continue;
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (cells.length !== 2 || !cells[1]) throw new Error(`Unexpected answer sheet row: ${trimmed}`);
    rows.push({ row: rows.length + 1, type: cells[0], reply: cells[1] });
  }
  if (rows.length !== 4) throw new Error(`The answer sheet should have 4 rows, found ${rows.length}`);
  return rows;
}

export function readAnswerSheet(path: string): AnswerRow[] {
  return parseAnswerSheet(readFileSync(path, "utf8"));
}

// The orchestrators prefix every question to the user with "[unit=<unit> need=<kind>]".
export function questionTag(text: string): { unit: string; need: string | null } | null {
  const match = /^\s*\[unit=([^\]\s]*)(?:\s+need=([a-z]+))?\s*\]/i.exec(text);
  return match ? { unit: match[1], need: match[2]?.toLowerCase() ?? null } : null;
}

// need=plan is row 1 and need=pr is row 2. Any other question is the driver's call between rows 3
// (a question about the spec) and 4 (anything else).
export function rowForQuestion(text: string): { row: number | null; candidates: number[]; reason: string } {
  const tag = questionTag(text);
  if (tag?.need === "plan") return { row: 1, candidates: [1], reason: "tagged need=plan" };
  if (tag?.need === "pr") return { row: 2, candidates: [2], reason: "tagged need=pr" };
  return { row: null, candidates: [3, 4], reason: tag ? `tagged need=${tag.need ?? "question"}` : "no need=plan or need=pr tag" };
}

export function replyFor(sheet: AnswerRow[], row: number): string {
  const found = sheet.find((entry) => entry.row === row);
  if (!found) throw new Error(`The answer sheet has no row ${row}`);
  return found.reply;
}

// Settles the row for a question: the tag decides when it can; otherwise the driver's row, which
// must be one of the candidates.
export function settleRow(text: string, driverRow: number | undefined): number {
  const { row, candidates } = rowForQuestion(text);
  if (row !== null) {
    if (driverRow !== undefined && driverRow !== row) throw new Error(`The question's tag fixes row ${row}, not ${driverRow}`);
    return row;
  }
  if (driverRow === undefined) throw new Error(`Pass --row ${candidates.join(" or ")}: the question has no need=plan or need=pr tag`);
  if (!candidates.includes(driverRow)) throw new Error(`--row must be ${candidates.join(" or ")} for this question`);
  return driverRow;
}
