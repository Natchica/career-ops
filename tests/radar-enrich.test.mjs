import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichRow, githubLogin, mergeHints, selectForEnrichment } from '../radar/enrich.mjs';

const rules = { poolZones: ['A', 'B', 'C', 'D'], order: { zones: ['A', 'B', 'C', 'D'], countries: [['CH'], ['FR', 'DE']], sizeBands: ['?'] } };
const row = (key, extra = {}) => ({
  key, name: key, aliases: '', sites: 'Basel:B', country: 'CH', signals: '1', size_band: '?',
  tier: '1', spontaneous: '', hints: '', portals_ref: '', ...extra,
});
const NOW = new Date('2026-10-22T00:00:00Z');

test('githubLogin reads the #github alias', () => {
  assert.equal(githubLogin(row('a', { aliases: 'Acme AG;#uid:CHE1;#github:Acme-GmbH' })), 'Acme-GmbH');
  assert.equal(githubLogin(row('b')), null);
});

test('selectForEnrichment keeps tier 1, untouched, in zone, with a source, not yet checked', () => {
  const rows = [
    row('ok', { aliases: '#github:ok' }),
    row('tier2', { aliases: '#github:t2', tier: '2' }),
    row('marked', { aliases: '#github:m', spontaneous: 'sent:2026-10-21:#1' }),
    row('far', { aliases: '#github:f', sites: 'Zurich:C' }),
    row('nosource'),
    row('checked', { aliases: '#github:c', hints: 'checked:2026-10-20' }),
    row('portal', { portals_ref: 'Portal' }),
  ];
  const hasSource = (p) => p.portals_ref === 'Portal';
  const keys = selectForEnrichment(rows, rules, { hasSource }).map((p) => p.key);
  assert.deepEqual(keys.sort(), ['ok', 'portal']);
  assert.ok(selectForEnrichment(rows, rules, { hasSource, refresh: true }).some((p) => p.key === 'checked'));
});

test('selectForEnrichment orders like the picker and honours the limit and --key', () => {
  const rows = [
    row('plain', { aliases: '#github:plain' }),
    row('hinted', { aliases: '#github:hinted', hints: 'site:open-apps;gh:java' }),
  ];
  assert.equal(selectForEnrichment(rows, rules, { limit: 1 })[0].key, 'hinted');
  assert.deepEqual(selectForEnrichment(rows, rules, { keys: ['plain'] }).map((p) => p.key), ['plain']);
});

function fakeHttp({ org, repos, robots = '', pages = {} }) {
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      if (/\/repos\?/.test(url)) return repos;
      return org;
    },
    fetchText: async (url) => {
      calls.push(url);
      if (url.endsWith('/robots.txt')) {
        if (robots === null) { const e = new Error('HTTP 404'); e.status = 404; throw e; }
        return robots;
      }
      if (pages[url] === undefined) { const e = new Error('HTTP 500'); e.status = 500; throw e; }
      return pages[url];
    },
  };
}
const sleep = async () => {};

test('enrichRow combines GitHub repository hints with the careers page hints', async () => {
  const http = fakeHttp({
    org: { blog: 'https://acme.ch' },
    repos: [{ name: 'java-exam', language: null, fork: false, archived: false, pushed_at: '2026-06-01T00:00:00Z', topics: [] }],
    pages: {
      'https://acme.ch/': '<a href="/karriere">Karriere</a><p>Willkommen</p>',
      'https://acme.ch/karriere': '<p>Keine offene Stelle? Schick uns deine Initiativbewerbung. Wir nutzen Rust.</p>',
    },
  });
  const out = await enrichRow(row('acme', { aliases: '#github:acme' }), { http, token: 't', sleep, now: NOW });
  assert.deepEqual(out.tokens.sort(), ['gh:java', 'site:open-apps', 'site:rust']);
  assert.equal(out.answered, true);
});

test('enrichRow reads a portals.yml careers URL first and skips a site that robots.txt forbids', async () => {
  const http = fakeHttp({ org: {}, repos: [], robots: 'User-agent: *\nDisallow: /', pages: {} });
  const out = await enrichRow(row('acme', { portals_ref: 'Acme' }), { http, sleep, careersUrlFor: () => 'https://acme.ch/jobs' });
  assert.deepEqual(out.tokens, []);
  assert.equal(out.answered, false);
  assert.match(out.notes.join(' '), /robots\.txt disallows acme\.ch/);
  assert.ok(!http.calls.some((u) => u === 'https://acme.ch/jobs'));
});

test('enrichRow treats a missing robots.txt as no rules and a failing page as not answered', async () => {
  const ok = fakeHttp({ robots: null, pages: { 'https://acme.ch/jobs': '<p>Java developer wanted</p>' } });
  const found = await enrichRow(row('acme'), { http: ok, sleep, careersUrlFor: () => 'https://acme.ch/jobs' });
  assert.deepEqual(found.tokens, ['site:java']);
  const bad = fakeHttp({ robots: null, pages: {} });
  const failed = await enrichRow(row('acme'), { http: bad, sleep, careersUrlFor: () => 'https://acme.ch/jobs' });
  assert.equal(failed.answered, false);
});

test('enrichRow without a GitHub token notes it and never throws', async () => {
  const http = fakeHttp({});
  const out = await enrichRow(row('acme', { aliases: '#github:acme' }), { http, sleep });
  assert.deepEqual(out.tokens, []);
  assert.match(out.notes.join(' '), /no token/);
});

test('mergeHints replaces probe tokens and the checked date, keeps anything else', () => {
  assert.equal(mergeHints('gh:rust;checked:2026-10-01;custom:x', ['site:java'], '2026-10-22', { checked: true }),
    'site:java;checked:2026-10-22;custom:x');
  assert.equal(mergeHints('', [], '2026-10-22', { checked: false }), '');
});

test('enrichRow falls back to the www spelling when the apex host does not connect', async () => {
  const calls = [];
  const http = {
    fetchJson: async () => ({}),
    fetchText: async (url) => {
      calls.push(url);
      if (url.startsWith('https://acme.ch')) throw new Error('fetch failed');
      if (url.endsWith('/robots.txt')) return '';
      return '<p>Initiativbewerbung willkommen, Java</p>';
    },
  };
  const out = await enrichRow(row('acme'), { http, sleep, careersUrlFor: () => 'https://acme.ch/' });
  assert.deepEqual(out.tokens.sort(), ['site:java', 'site:open-apps']);
  assert.ok(calls.some((u) => u.startsWith('https://www.acme.ch')));
});
