import assert from "node:assert/strict";
import { test } from "node:test";
import { convert, isCurrency } from "../src/money.ts";

test("convert keeps the amount when the currencies match", () => {
  assert.equal(convert(1234, "GBP", "GBP"), 1234);
  assert.equal(convert(1, "USD", "USD"), 1);
});

test("convert uses the fixed rates", () => {
  assert.equal(convert(100, "EUR", "GBP"), 85);
  assert.equal(convert(100, "USD", "GBP"), 80);
  assert.equal(convert(80, "USD", "EUR"), 75);
});

test("convert rounds half up", () => {
  assert.equal(convert(10, "EUR", "GBP"), 9);
  assert.equal(convert(100, "GBP", "EUR"), 118);
  assert.equal(convert(3125, "USD", "GBP"), 2500);
  assert.equal(convert(3126, "USD", "GBP"), 2501);
});

test("isCurrency accepts only GBP, EUR and USD", () => {
  for (const c of ["GBP", "EUR", "USD"]) assert.equal(isCurrency(c), true);
  for (const c of ["JPY", "gbp", 1, undefined]) assert.equal(isCurrency(c), false);
});
