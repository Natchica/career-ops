// tests/unslop-gate-wiring.test.mjs — the Outbound text gate is wired into every text-writing mode,
// and only those: modes/_writing.md holds the loop once, each mode ends its text step by pointing at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf-8');

const KINDS = ['letter', 'email', 'message', 'answer', 'cv', 'text'];

test('_writing.md carries the gate loop, the kind table and the repair contract', () => {
  const writing = read('modes/_writing.md');
  assert.match(writing, /^## Outbound text gate$/m);
  for (const needle of ['node unslop.mjs --diff', 'never shown as clean', 'Outbound text gate not run', '### Repair contract', '### Reading checklist']) {
    assert.ok(writing.includes(needle), `_writing.md is missing: ${needle}`);
  }
  assert.match(writing, /at most 2 repair passes/i);
  for (const kind of KINDS) {
    assert.match(writing, new RegExp(`^\\| \`${kind}\` \\|`, 'm'), `the kind table has no row for ${kind}`);
  }
});

test('the Tier 2 line defers to voice-dna.md with no example list', () => {
  const line = read('modes/_writing.md').split('\n').find((l) => /^- \*\*Tier 2/.test(l));
  assert.ok(line, 'the Tier 2 line is missing');
  assert.ok(line.includes('`voice-dna.md` §1-2'), 'the Tier 2 line must point at voice-dna.md §1-2');
  assert.doesNotMatch(line, /contractions|And\/But|I think|maybe|parenthetical/);
});

test('excluded files never mention the gate', () => {
  const excluded = ['modes/oferta.md', 'modes/interview-prep.md', 'modes/interview.md', 'modes/interview-redflag.md', 'modes/_shared.md']
    .concat(readdirSync(join(ROOT, 'modes', 'interview')).filter((f) => f.endsWith('.md')).map((f) => `modes/interview/${f}`));
  for (const path of excluded) {
    assert.ok(!read(path).includes('Outbound text gate'), `${path} must not mention the Outbound text gate`);
  }
});

// [file, the kinds it names, whether it must carry its own read directive for modes/_writing.md]
const GATED = [
  ['modes/cover.md', ['letter'], false],
  ['modes/email.md', ['email'], false],
  ['modes/spontaneous.md', ['email'], true],
  ['modes/contacto.md', ['message'], true],
  ['modes/followup.md', ['message'], true],
  ['modes/apply.md', ['answer'], true],
  ['modes/cabinet.md', ['cv', 'message'], true],
  ['modes/pdf.md', ['cv'], true],
];

for (const [path, kinds, ownRead] of GATED) {
  test(`${path} ends its text step with the Outbound text gate for kind ${kinds.join(' and ')}`, () => {
    const text = read(path);
    for (const kind of kinds) {
      assert.match(text, new RegExp(`Run the Outbound text gate \\(\`modes/_writing\\.md\`\\), kind \`${kind}\``, 'i'), `${path} must run the gate with kind ${kind}`);
    }
    if (ownRead) {
      assert.match(text, /^\s*(?:[-*]\s+)?Read `modes\/_writing\.md`/m, `${path} does not load _writing.md, so it must read it explicitly`);
    }
    // The loop, the kind table and the repair contract live in _writing.md only.
    assert.ok(!text.includes('### Repair contract'), `${path} must not copy the repair contract`);
    assert.ok(!text.includes('| Kind | Texts |'), `${path} must not copy the kind table`);
  });
}
