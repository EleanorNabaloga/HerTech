// Checks lib/translations.json against the phrases the app uses.
//
//   npm run i18n:check
//
// Fails when:
//   - a text('...') phrase in app/ has no entry in translations.json
//   - an entry is missing a language or is empty
//   - a translation drops or invents a {placeholder}
//   - a text(`...${x}...`) call builds the phrase at runtime (it can never
//     match the dictionary; use text('... {x} ...', { x }) instead)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const LANGUAGES = ['LUG', 'SW', 'AR', 'FR'];

// Phrases chosen at runtime, e.g. text(name) or text(error.message).
// List them here so the check still covers them.
const DYNAMIC_KEYS = [
  'Record', 'Ledgers', 'Debts & Dues', 'Reports',
  'Unknown customer', 'Recorded transaction', 'Credit balance',
  'Daily', 'Weekly', 'Monthly',
  'Uganda', 'Kenya', 'Tanzania', 'Rwanda', 'Burundi', 'South Sudan',
  'Democratic Republic of the Congo', 'Nigeria', 'Ghana', 'South Africa',
  'United Kingdom', 'United States',
  'Could not create your account. Please try again.',
  'Could not log in. Please try again.',
];

const translations = JSON.parse(
  readFileSync(join(root, 'lib', 'translations.json'), 'utf8'),
);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function unescape(body) {
  return body
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(['"`\\])/g, '$1');
}

function placeholders(text) {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
}

const problems = [];
const used = new Map();

// Every text('...') call: the first argument is the dictionary key.
for (const file of walk(join(root, 'app'))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\btext\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const [, quote, raw] = match;
    const line = source.slice(0, match.index).split('\n').length;
    const where = `${relative(root, file)}:${line}`;
    if (quote === '`' && raw.includes('${')) {
      problems.push(`${where} builds a phrase at runtime: text(\`${raw.slice(0, 60)}...\`)`);
      continue;
    }
    const key = unescape(raw);
    if (!used.has(key)) used.set(key, where);
  }
}

for (const key of DYNAMIC_KEYS) {
  if (!used.has(key)) used.set(key, 'DYNAMIC_KEYS');
}

for (const [key, where] of used) {
  if (!(key in translations)) {
    problems.push(`${where} missing translation for: "${key}"`);
  }
}

for (const [key, entry] of Object.entries(translations)) {
  const expected = placeholders(key);
  for (const language of LANGUAGES) {
    const value = entry?.[language];
    if (typeof value !== 'string' || !value.trim()) {
      problems.push(`"${key}" has no ${language} translation`);
      continue;
    }
    if (placeholders(value) !== expected) {
      problems.push(
        `"${key}" ${language} placeholders {${placeholders(value)}} differ from {${expected}}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`Translation check failed (${problems.length} problems):\n`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `Translations OK: ${used.size} phrases used, ${Object.keys(translations).length} in dictionary, ${LANGUAGES.length} languages.`,
);
