#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { validateAdr } from './adr-contract.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node validate-adr.mjs <adr.md> [more-adrs.md ...]');
  process.exitCode = 1;
}

for (const file of files) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    console.error(`${file}: ${error.message}`);
    process.exitCode = 1;
    continue;
  }
  const errors = validateAdr(text);
  if (errors.length) {
    for (const error of errors) console.error(`${file}: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`${file}: structure passed (evidence and style not evaluated)`);
  }
}
