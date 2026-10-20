import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsv } from "../src/csv.ts";

test("parses simple rows with line numbers", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [
    { line: 1, fields: ["a", "b"] },
    { line: 2, fields: ["1", "2"] },
  ]);
});

test("accepts CRLF line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
    { line: 1, fields: ["a", "b"] },
    { line: 2, fields: ["1", "2"] },
  ]);
});

test("a quoted field may contain a comma", () => {
  assert.deepEqual(parseCsv('a,"b,c",d'), [{ line: 1, fields: ["a", "b,c", "d"] }]);
});

test("doubled quotes stand for one quote", () => {
  assert.deepEqual(parseCsv('"say ""hi""",x'), [{ line: 1, fields: ['say "hi"', "x"] }]);
});

test("a quoted line break makes the row span lines", () => {
  assert.deepEqual(parseCsv('h1,h2\n"one\ntwo",x\nlast,y\n'), [
    { line: 1, fields: ["h1", "h2"] },
    { line: 2, fields: ["one\ntwo", "x"] },
    { line: 4, fields: ["last", "y"] },
  ]);
});

test("an empty line is skipped but still counted", () => {
  assert.deepEqual(parseCsv("a\n\nb\n"), [
    { line: 1, fields: ["a"] },
    { line: 3, fields: ["b"] },
  ]);
});

test("the last row needs no line ending", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [
    { line: 1, fields: ["a", "b"] },
    { line: 2, fields: ["1", "2"] },
  ]);
});

test("empty input gives no rows", () => {
  assert.deepEqual(parseCsv(""), []);
});

// Each row's line and whether it has a syntax error, so tests don't depend on the error's wording.
const lines = (text: string) => parseCsv(text).map((row) => [row.line, typeof row.error === "string"]);

test("a lone CR in an unquoted field is a syntax error, not a line break", () => {
  assert.deepEqual(lines("h1,h2\na\rb,x\nc,d\n"), [
    [1, false],
    [2, true],
    [3, false],
  ]);
  assert.deepEqual(parseCsv("h1,h2\na\rb,x\nc,d\n")[2].fields, ["c", "d"]);
  assert.deepEqual(lines("a,b\r"), [[1, true]]);
});

test("a quote inside an unquoted field is a syntax error and the next line is a new row", () => {
  const rows = parseCsv('h1,h2\nBob"s,x\nc,d');
  assert.deepEqual(lines('h1,h2\nBob"s,x\nc,d'), [
    [1, false],
    [2, true],
    [3, false],
  ]);
  assert.deepEqual(rows[2].fields, ["c", "d"]);
});

test("text after a closing quote is a syntax error", () => {
  const rows = parseCsv('"a"x,b\nc,d\n');
  assert.equal(typeof rows[0].error, "string");
  assert.deepEqual(rows[1], { line: 2, fields: ["c", "d"] });
});

test("an unclosed quote runs to the end of the input and is a syntax error", () => {
  assert.deepEqual(lines('h\nok\n"open\nmore\n'), [
    [1, false],
    [2, false],
    [3, true],
  ]);
});

test("quoted CR, CRLF, quotes and empty fields stay valid", () => {
  assert.deepEqual(parseCsv('"a\r\nb","c\rd","""",""\r\n"x",y\r\n'), [
    { line: 1, fields: ["a\r\nb", "c\rd", '"', ""] },
    { line: 3, fields: ["x", "y"] },
  ]);
});

test('a line holding only "" is a row with one empty field', () => {
  assert.deepEqual(parseCsv('a\n""\nb'), [
    { line: 1, fields: ["a"] },
    { line: 2, fields: [""] },
    { line: 3, fields: ["b"] },
  ]);
});
