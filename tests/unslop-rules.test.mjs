// tests/unslop-rules.test.mjs — the slop rules are data (templates/unslop-rules.yml),
// and the data must keep the contract unslop.mjs loads it under.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { loadUnslopRules, SKILLS, UNSLOP_DETECTORS } from '../unslop.mjs';

const { rules, cannotCatch } = loadUnslopRules();

const sandboxes = [];
after(() => { for (const d of sandboxes) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

test('the shipped rules file loads and every rule carries the contract fields', () => {
  assert.ok(rules.length >= 9, `expected at least the 9 reading-check rules, got ${rules.length}`);
  for (const rule of rules) {
    assert.equal(typeof rule.id, 'string', `rule id ${rule.id} must be a string`);
    assert.ok(rule.name, `rule ${rule.id} needs a name`);
    assert.ok(SKILLS.includes(rule.source?.skill), `rule ${rule.id} source.skill must be one of ${SKILLS.join(', ')}`);
    assert.ok(rule.source?.rule, `rule ${rule.id} source.rule is missing`);
    assert.ok(String(rule.must_not_flag ?? '').trim(), `rule ${rule.id} needs must_not_flag`);
  }
});

test('null rules carry unimplemented_because and severity none', () => {
  const nullRules = rules.filter((r) => r.detect === null);
  assert.deepEqual(nullRules.map((r) => r.id), ['10', '11', '14', '16', '17', '27', '28', '32', '33c']);
  for (const rule of nullRules) {
    assert.ok(String(rule.unimplemented_because ?? '').trim(), `rule ${rule.id} needs unimplemented_because`);
    assert.equal(rule.severity, 'none', `rule ${rule.id} is a reading check, so its severity is none`);
  }
});

test('cannot_catch lists what the scanner cannot see', () => {
  assert.deepEqual(cannotCatch.map((c) => c.id), ['meaning', 'tone', 'rhythm', 'drafting-facts', 'other-languages']);
  for (const entry of cannotCatch) assert.ok(String(entry.summary ?? '').trim(), `cannot_catch ${entry.id} needs a summary`);
});

/** A valid one-rule document, mutated, dumped to a throwaway file; returns the load call. */
function loading(mutate) {
  const doc = {
    rules: [{
      id: '10',
      name: 'Rule of three',
      source: { skill: 'cursor/plugins@unslop', rule: '10' },
      severity: 'none',
      detect: null,
      unimplemented_because: 'a judgement',
      scope: 'prose',
      kinds: 'all',
      lang: 'all',
      must_not_flag: 'a list of three real items',
    }],
  };
  mutate(doc);
  const dir = mkdtempSync(join(tmpdir(), 'unslop-rules-'));
  sandboxes.push(dir);
  const path = join(dir, 'rules.yml');
  writeFileSync(path, yaml.dump(doc));
  return () => loadUnslopRules(path);
}

test('loadUnslopRules names the rule and field it rejects', () => {
  const cases = [
    ['an empty rules list', (d) => { d.rules = []; }, /defines no rules/],
    ['no id', (d) => { delete d.rules[0].id; }, /rule 0: needs an id/],
    ['a numeric id', (d) => { d.rules[0].id = 10; }, /id must be a quoted string/],
    ['a duplicate id', (d) => { d.rules.push(structuredClone(d.rules[0])); }, /duplicate rule id "10"/],
    ['an unknown severity', (d) => { d.rules[0].severity = 'error'; }, /severity must be block or warn/],
    ['an unregistered detector', (d) => { d.rules[0].detect = 'nope'; }, /detect must name a registered detector/],
    ['detector: written for detect:', (d) => { delete d.rules[0].detect; d.rules[0].detector = 'match-list'; }, /detect must name a registered detector/],
    ['a null detector without a reason', (d) => { delete d.rules[0].unimplemented_because; }, /unimplemented_because/],
    ['a null detector with severity block', (d) => { d.rules[0].severity = 'block'; }, /severity must be none/],
    ['an unknown source skill', (d) => { d.rules[0].source.skill = 'someone/else'; }, /source\.skill must be one of/],
    ['an unknown kind', (d) => { d.rules[0].kinds = ['memo']; }, /kinds/],
    ['an unknown language', (d) => { d.rules[0].lang = ['de']; }, /lang/],
    ['no must_not_flag', (d) => { delete d.rules[0].must_not_flag; }, /must_not_flag/],
    ['an unknown scope', (d) => { d.rules[0].scope = 'page'; }, /scope must be text or prose/],
    ['a pattern that does not compile', (d) => { d.rules[0].patterns = { all: ['('] }; }, /does not compile/],
  ];
  for (const [label, mutate, pattern] of cases) {
    assert.throws(loading(mutate), pattern, label);
  }
});

const sortedIds = (list) => list.map((r) => r.id).sort();
const idsWhere = (predicate) => sortedIds(rules.filter(predicate));

test('the catalogue matches the spec', () => {
  assert.equal(rules.length, 38);

  const bases = [...new Set(rules.filter((r) => parseInt(r.id, 10) <= 33).map((r) => parseInt(r.id, 10)))].sort((a, b) => a - b);
  assert.deepEqual(bases, [3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]);
  for (const rule of rules.filter((r) => parseInt(r.id, 10) <= 33)) {
    assert.equal(rule.source.skill, 'cursor/plugins@unslop', `rule ${rule.id} cites cursor`);
    assert.equal(rule.source.rule, String(parseInt(rule.id, 10)), `rule ${rule.id} cites cursor rule ${parseInt(rule.id, 10)}`);
  }
  for (const rule of rules.filter((r) => parseInt(r.id, 10) >= 34)) {
    assert.notEqual(rule.source.skill, 'cursor/plugins@unslop', `rule ${rule.id} comes from another source`);
  }

  assert.deepEqual(idsWhere((r) => r.severity === 'block'), ['13', '15', '18', '19', '20', '22', '33', '34', '35', '36', '39', '40', '7', '9'].sort());
  assert.deepEqual(idsWhere((r) => r.severity === 'warn'), ['12', '23', '24', '25', '26', '29', '3', '30', '31', '33b', '37', '38', '5', '7b', '8'].sort());
  assert.deepEqual(idsWhere((r) => r.severity === 'none'), ['10', '11', '14', '16', '17', '27', '28', '32', '33c'].sort());
});

test('the catalogue kinds and languages match the spec', () => {
  const kindsOf = (id) => rules.find((r) => r.id === id).kinds;
  assert.deepEqual(kindsOf('12'), ['letter', 'email', 'message', 'answer', 'text']);
  assert.deepEqual(kindsOf('29'), ['letter', 'email', 'message', 'answer', 'text']);
  assert.deepEqual(kindsOf('15'), ['letter', 'email', 'message', 'text']);
  assert.deepEqual(kindsOf('34'), ['letter', 'email', 'message', 'text']);
  for (const id of ['33', '33b', '33c']) assert.deepEqual(kindsOf(id), ['letter', 'email', 'answer', 'text']);
  assert.deepEqual(idsWhere((r) => r.kinds !== 'all'), ['12', '15', '29', '33', '33b', '33c', '34'].sort());

  assert.deepEqual(idsWhere((r) => Array.isArray(r.lang) && r.lang.length === 2), ['19', '20', '22', '23', '25', '3', '39', '5', '9'].sort());
  assert.deepEqual(
    idsWhere((r) => r.lang === 'all' && r.detect !== null),
    ['13', '15', '18', '33', '33b', '34', '35', '40'].sort(),
  );
  assert.ok(rules.filter((r) => r.lang === 'all' && r.detect === null).length === 9, 'the 9 reading checks apply to every language');
  const englishOnly = rules.filter((r) => Array.isArray(r.lang) && r.lang.length === 1);
  for (const rule of englishOnly) assert.deepEqual(rule.lang, ['en'], `rule ${rule.id} has an English list only`);
});

test('the French lists carry at least 20 entries and cannot_catch has 5', () => {
  let french = 0;
  for (const rule of rules) {
    french += (rule.terms?.fr ?? []).length + (rule.patterns?.fr ?? []).length + Object.keys(rule.map?.fr ?? {}).length;
  }
  assert.ok(french >= 20, `expected at least 20 French entries, got ${french}`);
  assert.equal(cannotCatch.length, 5);
});

/** Every regex source string a rule carries: patterns and except, per language. */
function patternSources(rule) {
  const out = [];
  for (const list of Object.values(rule.patterns ?? {})) out.push(...list);
  out.push(...(rule.except ?? []));
  return out;
}

test('detector map and rules file name exactly the same detectors', () => {
  const named = new Set(rules.filter((r) => r.detect !== null).map((r) => r.detect));
  const registered = new Set(Object.keys(UNSLOP_DETECTORS));
  assert.deepEqual([...named].filter((d) => !registered.has(d)), [], 'rules name a detector that is not registered');
  assert.deepEqual([...registered].filter((d) => !named.has(d)), [], 'a registered detector no rule uses');
});

test('no pattern uses the word-boundary escape', () => {
  // Under the u flag it treats accented letters as non-word, so French terms would misfire.
  const wordBoundary = String.raw`\b`;
  for (const rule of rules) {
    for (const source of patternSources(rule)) {
      assert.ok(!source.includes(wordBoundary), `rule ${rule.id} uses the word-boundary escape: ${source}`);
    }
  }
});

test('every pattern compiles', () => {
  for (const rule of rules) {
    for (const source of patternSources(rule)) {
      assert.doesNotThrow(() => new RegExp(source, 'giu'), `rule ${rule.id} pattern does not compile: ${source}`);
    }
  }
});
