import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  careersLinkFrom, formatHints, hintScore, pageHints, parseHints, repoHints, robotsAllows, stripTags,
} from '../radar/hints.mjs';
import { compareProspects } from '../radar/tiers.mjs';

const NOW = new Date('2026-10-22T00:00:00Z');
const recent = '2026-06-01T00:00:00Z';
const old = '2022-01-01T00:00:00Z';

test('repoHints: a recent Java or Rust repo gives a token, an old or forked one does not', () => {
  const repos = [
    { name: 'a', language: 'Java', fork: false, archived: false, pushed_at: recent },
    { name: 'b', language: 'Rust', fork: true, archived: false, pushed_at: recent },
    { name: 'c', language: 'Rust', fork: false, archived: false, pushed_at: old },
    { name: 'd', language: 'Go', fork: false, archived: false, pushed_at: recent },
  ];
  assert.deepEqual(repoHints(repos, NOW), ['gh:java']);
});

test('repoHints: a repo named or tagged after the stack counts when its language is unset', () => {
  const repos = [{ name: 'java-exam', language: null, fork: false, archived: false, pushed_at: recent, topics: [] }];
  assert.deepEqual(repoHints(repos, NOW), ['gh:java']);
  const tagged = [{ name: 'engine', language: null, fork: false, archived: false, pushed_at: recent, topics: ['rust'] }];
  assert.deepEqual(repoHints(tagged, NOW), ['gh:rust']);
});

test('pageHints: finds an invitation for unsolicited applications in German, French and English', () => {
  assert.ok(pageHints('Du hast keine Stelle gefunden? Schicke uns deine Initiativbewerbung!').includes('site:open-apps'));
  assert.ok(pageHints('Envoyez votre candidature spontanée').includes('site:open-apps'));
  assert.ok(pageHints('We welcome unsolicited applications').includes('site:open-apps'));
  assert.deepEqual(pageHints('We are hiring a designer'), []);
});

test('pageHints: Java and Rust are whole words, JavaScript and trust are not', () => {
  assert.deepEqual(pageHints('Senior Java engineer, Spring Boot'), ['site:java']);
  assert.deepEqual(pageHints('JavaScript and TypeScript, trust and rusty tools'), []);
  assert.deepEqual(pageHints('Rust and Java').sort(), ['site:java', 'site:rust']);
});

test('parseHints and formatHints round-trip and drop duplicates', () => {
  assert.deepEqual(parseHints('gh:java;site:open-apps;gh:java'), ['gh:java', 'site:open-apps']);
  assert.equal(formatHints(['site:java', 'gh:java', 'site:java']), 'gh:java;site:java');
  assert.deepEqual(parseHints(''), []);
});

test('hintScore: one point for an open-applications invitation, one for a Java or Rust trace', () => {
  assert.equal(hintScore({ hints: '' }), 0);
  assert.equal(hintScore({ hints: 'checked:2026-10-22' }), 0);
  assert.equal(hintScore({ hints: 'gh:java;site:java' }), 1);
  assert.equal(hintScore({ hints: 'site:open-apps' }), 1);
  assert.equal(hintScore({ hints: 'site:open-apps;gh:rust' }), 2);
  assert.equal(hintScore({}), 0);
});

test('robotsAllows: honours the wildcard group and the longest matching rule', () => {
  const robots = 'User-agent: *\nDisallow: /karriere\nAllow: /karriere/offen\n\nUser-agent: other\nDisallow: /';
  assert.equal(robotsAllows(robots, '/'), true);
  assert.equal(robotsAllows(robots, '/karriere/team'), false);
  assert.equal(robotsAllows(robots, '/karriere/offen/1'), true);
  assert.equal(robotsAllows('', '/anything'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/jobs'), false);
});

test('careersLinkFrom: picks the first careers-like link on the same host', () => {
  const html = '<a href="/about">About</a><a href="/de/karriere">Karriere</a><a href="https://other.example/jobs">Jobs</a>';
  assert.equal(careersLinkFrom(html, 'https://acme.ch/'), 'https://acme.ch/de/karriere');
  assert.equal(careersLinkFrom('<a href="/about">About</a>', 'https://acme.ch/'), null);
});

test('stripTags drops scripts, styles and markup', () => {
  assert.equal(stripTags('<style>a{}</style><p>Hello <b>world</b></p><script>x()</script>'), 'Hello world');
});

const rules = { poolZones: ['A', 'B', 'C', 'D'], order: { zones: ['A', 'B', 'C', 'D'], countries: [['CH'], ['FR', 'DE']], sizeBands: ['?'] } };
const row = (key, extra = {}) => ({ key, sites: 'Basel:B', country: 'CH', signals: '1', size_band: '?', hints: '', ...extra });

test('compareProspects: inside a zone and country, a hinted Prospect ranks before an unhinted one with more signals', () => {
  const plain = row('aaa', { signals: '2' });
  const hinted = row('zzz', { signals: '1', hints: 'site:open-apps;gh:java' });
  assert.ok(compareProspects(hinted, plain, rules) < 0);
});

test('compareProspects: hints never beat a better zone', () => {
  const near = row('aaa', { sites: 'Basel:B' });
  const far = row('zzz', { sites: 'Zurich:C', hints: 'site:open-apps;gh:java' });
  assert.ok(compareProspects(near, far, rules) < 0);
});

test('pageHints: "apply on your own initiative" counts as an open-applications invitation', () => {
  assert.ok(pageHints('the option to apply on your own initiative').includes('site:open-apps'));
});

test('careersLinkFrom: "Schnittstellen" and "Stellen" inside another word are not a careers link', () => {
  const html = '<a href="/produkt/schnittstellenplattform">Schnittstellenplattform</a><a href="/ueber-uns/karriere">Karriere</a>';
  assert.equal(careersLinkFrom(html, 'https://acme.ch/'), 'https://acme.ch/ueber-uns/karriere');
  assert.equal(careersLinkFrom('<a href="/produkt/schnittstellenplattform">Schnittstellenplattform</a>', 'https://acme.ch/'), null);
});

test('careersLinkFrom: a blog post whose slug ends in "-job" is not a careers link', () => {
  const html = '<a href="/blog/interview-mit-oeko-job">Blog</a><a href="/jobs/">Jobs</a>';
  assert.equal(careersLinkFrom(html, 'https://acme.ch/'), 'https://acme.ch/jobs/');
});
