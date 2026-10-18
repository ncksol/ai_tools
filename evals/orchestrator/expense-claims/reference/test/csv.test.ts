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
