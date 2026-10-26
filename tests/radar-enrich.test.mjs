import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichRow, githubLogin, mergeHints, registerOnly, selectForEnrichment, siteDomains, siteProbeRow } from '../radar/enrich.mjs';
import { probeRows } from '../radar-enrich.mjs';
import { RADAR_COLUMNS, serializeRegistry } from '../radar/registry.mjs';
import { SITE_USER_AGENT } from '../radar/site.mjs';
import { loadZoneTable } from '../radar/zones.mjs';

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

test('selectForEnrichment with sites keeps register-only tier 1 Prospects in zone, untouched, not yet probed', () => {
  const rows = [
    row('reg'),
    row('dash', { portals_ref: '—' }),
    row('gh', { aliases: '#github:gh' }),
    row('portal', { portals_ref: 'Portal' }),
    row('src'),
    row('checked', { hints: 'checked:2026-10-20' }),
    row('zc', { sites: 'Zurich:C' }),
    row('t2', { tier: '2' }),
    row('marked', { spontaneous: 'skipped:2026-10-21' }),
  ];
  const hasSource = (p) => p.key === 'src';
  const opts = { zones: ['B'], sites: true, hasSource };
  assert.deepEqual(selectForEnrichment(rows, rules, opts).map((p) => p.key).sort(), ['dash', 'reg']);
  assert.ok(selectForEnrichment(rows, rules, { ...opts, refresh: true }).some((p) => p.key === 'checked'));
  assert.equal(selectForEnrichment(rows, rules, { ...opts, limit: 1 }).length, 1);
  assert.deepEqual(selectForEnrichment(rows, rules, { ...opts, keys: ['gh'] }).map((p) => p.key), ['gh']);
  assert.equal(registerOnly(row('x', { aliases: '#github:x' })), false);
  assert.equal(registerOnly(row('y', { portals_ref: '—' })), true);
});

test('siteDomains guesses joined spellings first, then hyphenated, trimmed names included, at most 6', () => {
  assert.deepEqual(siteDomains('Kobold Software AG'), [
    'koboldsoftware.ch', 'koboldsoftware.com', 'kobold.ch', 'kobold.com', 'kobold-software.ch', 'kobold-software.com',
  ]);
  assert.deepEqual(siteDomains('Acme Software Solutions GmbH'), [
    'acmesoftwaresolutions.ch', 'acmesoftwaresolutions.com', 'acmesoftware.ch', 'acmesoftware.com', 'acme.ch', 'acme.com',
  ]);
  const security = siteDomains('Acme IT Security GmbH');
  assert.ok(security.includes('acme.ch'));
  assert.equal(security.length, 6);
  assert.deepEqual(siteDomains('Kobold Games GmbH'), ['koboldgames.ch', 'koboldgames.com', 'kobold-games.ch', 'kobold-games.com']);
  assert.ok(siteDomains('Acme Group AG').includes('acme.ch'));
  assert.deepEqual(siteDomains('Data services'), []);
  assert.deepEqual(siteDomains('One Two Three Four'), []);
});

test('mergeHints drops a stale web: token and keeps anything else', () => {
  assert.equal(
    mergeHints('web:old.ch;site:none;checked:2026-10-01;custom:x', ['web:new.ch'], '2026-10-26', { checked: true }),
    'checked:2026-10-26;custom:x;web:new.ch',
  );
});

// --- Site probe: a register-only Prospect's own website ---

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-enrich-')), codeRoot: ROOT });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const dnsError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
const nx = () => dnsError('ENOTFOUND');
const down = () => dnsError('EAI_AGAIN');

/** A fake ctx: `hosts` maps a registrable host to a handler `(path) => html | Error`; any other host does not exist. */
function siteCtx(hosts, { fallback = nx } = {}) {
  const requests = [];
  const sleeps = [];
  const ctx = {
    table,
    sleep: async (ms) => { sleeps.push(ms); },
    http: {
      fetchText: async (url, opts) => {
        requests.push({ url, opts });
        const u = new URL(url);
        const handler = hosts[u.hostname.replace(/^www\./, '')];
        const r = handler ? handler(u.pathname) : fallback();
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  const pathsOn = (host) => requests.filter((q) => new URL(q.url).hostname.replace(/^www\./, '') === host).map((q) => new URL(q.url).pathname);
  return { ctx, requests, sleeps, pathsOn };
}
const page = (routes) => (path) => (path === '/robots.txt' ? (routes.robots ?? httpError(404)) : routes[path] ?? httpError(404));
const koboldRow = (extra = {}) => row('kobold games', { name: 'Kobold Games GmbH', sites: 'Allschwil:B', ...extra });

test('siteProbeRow verifies a guessed domain by its page title and stops at the first one', async () => {
  const { ctx, requests } = siteCtx({ 'koboldgames.ch': page({ '/': '<title>Kobold Games | Home</title><p>Welcome</p>' }) });
  const out = await siteProbeRow(koboldRow(), ctx);
  assert.ok(out.tokens.includes('web:koboldgames.ch'));
  assert.equal(out.answered, true);
  assert.ok(!requests.some((q) => new URL(q.url).hostname.endsWith('koboldgames.com')));
});

test('siteProbeRow verifies by the full name plus the registered place in the page text, and needs both', async () => {
  const home = '<title>Home</title><p>Kobold Games entwickelt Spiele in Allschwil.</p>';
  const ok = await siteProbeRow(koboldRow(), siteCtx({ 'koboldgames.ch': page({ '/': home }) }).ctx);
  assert.ok(ok.tokens.includes('web:koboldgames.ch'));
  const elsewhere = await siteProbeRow(koboldRow({ sites: 'Liestal:B' }), siteCtx({ 'koboldgames.ch': page({ '/': home }) }).ctx);
  assert.deepEqual(elsewhere.tokens, ['site:none']);
});

test('siteProbeRow tries a trimmed-name domain but never verifies a namesake', async () => {
  const soft = koboldRow({ name: 'Kobold Software AG', key: 'kobold software' });
  const namesake = siteCtx({ 'kobold.ch': page({ '/': '<title>Kobold</title><p>Kobold Spielwaren, Allschwil</p>' }) });
  const out = await siteProbeRow(soft, namesake.ctx);
  assert.deepEqual(out.tokens, ['site:none']);
  assert.equal(out.answered, true);
  assert.ok(namesake.pathsOn('kobold.ch').includes('/'));
  const real = siteCtx({ 'kobold.ch': page({ '/': '<title>Home</title><p>Kobold Software AG, Allschwil</p>' }) });
  assert.ok((await siteProbeRow(soft, real.ctx)).tokens.includes('web:kobold.ch'));
});

test('siteProbeRow: a domain that does not exist answers, an outage does not', async () => {
  const gone = await siteProbeRow(koboldRow(), siteCtx({}).ctx);
  assert.deepEqual({ tokens: gone.tokens, answered: gone.answered }, { tokens: ['site:none'], answered: true });
  const outage = await siteProbeRow(koboldRow(), siteCtx({}, { fallback: down }).ctx);
  assert.deepEqual(outage.tokens, []);
  assert.equal(outage.answered, false);
  assert.ok(outage.notes.length >= 1);
});

test('siteProbeRow reads at most 2 pages per domain, politely, and takes software, java and careers tokens from them', async () => {
  const withImpressum = siteCtx({
    'koboldgames.ch': page({
      '/': '<title>Kobold Games</title><a href="/impressum">Impressum</a><a href="/karriere">Karriere</a><p>Individuelle Softwareentwicklung mit Java</p>',
      '/impressum': '<p>Kobold Games GmbH</p><p>4123 Allschwil</p>',
    }),
  });
  const full = await siteProbeRow(koboldRow(), withImpressum.ctx);
  assert.deepEqual([...full.tokens].sort(), ['site:careers', 'site:java', 'site:software', 'web:koboldgames.ch']);
  assert.deepEqual(withImpressum.pathsOn('koboldgames.ch'), ['/robots.txt', '/', '/impressum']);

  const careers = siteCtx({
    'koboldgames.ch': page({ '/': '<title>Kobold Games</title><a href="/karriere">Karriere</a>', '/karriere': '<p>Initiativbewerbung willkommen</p>' }),
  });
  const second = await siteProbeRow(koboldRow(), careers.ctx);
  assert.ok(second.tokens.includes('site:open-apps') && second.tokens.includes('site:careers'));
  assert.deepEqual(careers.pathsOn('koboldgames.ch'), ['/robots.txt', '/', '/karriere']);
  assert.ok(careers.sleeps.length > 0 && careers.sleeps.every((ms) => ms === 1000));
  for (const q of careers.requests) assert.equal(q.opts.headers['User-Agent'], SITE_USER_AGENT);

  const blocked = siteCtx({
    'koboldgames.ch': page({ robots: 'User-agent: *\nDisallow: /karriere', '/': '<title>Kobold Games</title><a href="/karriere">Karriere</a>' }),
  });
  const forbidden = await siteProbeRow(koboldRow(), blocked.ctx);
  assert.ok(!blocked.pathsOn('koboldgames.ch').includes('/karriere'));
  assert.ok(forbidden.tokens.includes('site:careers'));

  const failing = siteCtx({
    'koboldgames.ch': page({ '/': '<title>Kobold Games</title><a href="/karriere">Karriere</a>', '/karriere': httpError(500) }),
  });
  const survived = await siteProbeRow(koboldRow(), failing.ctx);
  assert.ok(survived.tokens.includes('web:koboldgames.ch'));
  assert.ok(survived.notes.some((n) => n.includes('karriere')));
});

test('siteProbeRow: a name with nothing to guess is site:none without a request', async () => {
  for (const name of ['Data services', 'One Two Three Four']) {
    const { ctx, requests } = siteCtx({});
    const out = await siteProbeRow(row('x', { name }), ctx);
    assert.deepEqual({ tokens: out.tokens, answered: out.answered }, { tokens: ['site:none'], answered: true });
    assert.equal(requests.length, 0);
  }
});

// --- radar-enrich.mjs: the batch loop and the --sites flag ---

test('probeRows persists every 8 rows, merges the checked date, and leaves an unanswered row to a later run', async () => {
  const rows = Array.from({ length: 17 }, (_, i) => row(`p${i}`));
  const batches = [];
  const done = await probeRows(rows, {
    probe: async () => ({ tokens: ['site:none'], answered: true, notes: [] }),
    ctx: {},
    today: '2026-10-26',
    persist: async (batch) => { batches.push(batch.length); },
  });
  assert.deepEqual(batches, [8, 8, 1]);
  assert.equal(done.length, 17);
  assert.ok(done.every((r) => r.hints === 'checked:2026-10-26;site:none'));

  const offline = await probeRows([row('off')], {
    probe: async () => ({ tokens: [], answered: false, notes: ['x'] }),
    ctx: {},
    today: '2026-10-26',
    persist: async () => {},
  });
  assert.equal(offline[0].hints, '');
  assert.equal(selectForEnrichment([row('off', { hints: offline[0].hints })], rules, { zones: ['B'], sites: true }).length, 1);
});

test('radar-enrich --sites reads the registry only: zones default to B, a dry run never writes, bad zones fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'radar-enrich-cli-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    const full = (r) => Object.fromEntries(RADAR_COLUMNS.map((c) => [c, r[c] ?? '']));
    const checked = { hints: 'checked:2026-10-20' };
    const rows = [
      row('b-register', checked), row('b-github', { ...checked, aliases: '#github:x' }), row('a-register', { ...checked, sites: 'Basel:A' }),
    ].map(full);
    const file = join(root, 'data', 'radar.tsv');
    writeFileSync(file, serializeRegistry({ columns: [...RADAR_COLUMNS], rows }));
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    const run = (args) => spawnSync(process.execPath, [join(ROOT, 'radar-enrich.mjs'), ...args], {
      cwd: root, encoding: 'utf-8', timeout: 60_000,
      env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_DATA_DIR: '', CAREER_OPS_PORTALS: '', GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    });
    const sites = run(['--sites', '--dry-run']);
    assert.equal(sites.status, 0, sites.stderr);
    const out = JSON.parse(sites.stdout);
    assert.deepEqual({ mode: out.mode, zones: out.zones, selected: out.selected, probed: out.probed }, { mode: 'sites', zones: ['B'], selected: 0, probed: 0 });
    const hints = JSON.parse(run(['--dry-run']).stdout);
    assert.deepEqual({ mode: hints.mode, zones: hints.zones }, { mode: 'hints', zones: ['A', 'B'] });
    assert.equal(run(['--sites', '--zones', 'Z']).status, 1);
    assert.match(run(['--help']).stdout, /--sites/);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), before);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('siteProbeRow: a site that forbids reading is neither verified nor "no site found"', async () => {
  const blocked = siteCtx({ 'koboldgames.ch': (path) => (path === '/robots.txt' ? 'User-agent: *\nDisallow: /' : httpError(404)) });
  const out = await siteProbeRow(koboldRow(), blocked.ctx);
  assert.deepEqual({ tokens: out.tokens, answered: out.answered }, { tokens: [], answered: true });
  assert.ok(out.notes.some((n) => n.includes('robots.txt disallows')));
  assert.deepEqual(blocked.pathsOn('koboldgames.ch'), ['/robots.txt']);
});
