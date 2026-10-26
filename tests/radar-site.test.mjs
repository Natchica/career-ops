import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadZoneTable } from '../radar/zones.mjs';
import { needleFor } from '../radar/resolve.mjs';
import {
  SITE_USER_AGENT, SITE_PACE_MS, SITE_TIMEOUT_MS, MAX_HOPS, WEBMAIL,
  decodeEntities, pageLines, titleOf, countryHint, guessDomains, impressumLink, addressPairs, legalNameNear,
  readSite, siteResolve, nameMatches, fetchSitePage,
} from '../radar/site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const table = loadZoneTable({ dataRoot: mkdtempSync(join(tmpdir(), 'radar-site-')), codeRoot: ROOT });

const httpError = (status, location) => Object.assign(new Error(`HTTP ${status}`), { status, location });

function fakeCtx(routes) {
  const requests = [];
  const sleeps = [];
  const logs = [];
  const ctx = {
    table,
    log: (m) => logs.push(m),
    sleep: async (ms) => { sleeps.push(ms); },
    http: {
      sleep: async () => {},
      fetchText: async (url, opts) => {
        requests.push({ url, opts });
        const r = await routes(url, opts);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { ctx, requests, sleeps, logs };
}

const HOME = `<html><head><title>Kobold Games | Home</title></head><body>
<a href="/impressum">Impressum</a><a href="https://elsewhere.com/kontakt">Kontakt</a>
<p>Welcome</p></body></html>`;
const IMPRESSUM = `<html><body><h1>Impressum</h1><p>Kobold Games GmbH</p>
<p>Hauptstrasse 1</p><p>4123 Allschwil</p></body></html>`;
const site = (over = {}) => (url) => {
  const path = new URL(url).pathname;
  if (path === '/robots.txt') return over.robots ?? httpError(404);
  if (path === '/') return over.home ?? HOME;
  if (path === '/impressum') return over.impressum ?? IMPRESSUM;
  return httpError(404);
};

test('constants', () => {
  assert.equal(SITE_USER_AGENT, 'career-ops-radar (personal job-search census, reads company pages only)');
  assert.equal(SITE_PACE_MS, 1000);
  assert.equal(SITE_TIMEOUT_MS, 10_000);
  assert.equal(MAX_HOPS, 3);
  assert.ok(WEBMAIL.has('gmail.com'));
  assert.ok(!WEBMAIL.has('sunrise.ch'));
});

test('guessDomains: 2 tokens give 4, 1 token gives 2, 4 tokens, generic and null give none', () => {
  assert.deepEqual(guessDomains(needleFor('Kobold Games')), ['koboldgames.ch', 'koboldgames.com', 'kobold-games.ch', 'kobold-games.com']);
  assert.deepEqual(guessDomains(needleFor('Kobold')), ['kobold.ch', 'kobold.com']);
  assert.deepEqual(guessDomains(needleFor('One Two Three Four')), []);
  assert.deepEqual(guessDomains(null), []);
  assert.deepEqual(guessDomains({ server: 'data services', base: 'data services' }), []);
});

test('countryHint reads the top-level domain', () => {
  assert.deepEqual(['a.ch', 'a.fr', 'a.de', 'a.com'].map(countryHint), ['CH', 'FR', 'DE', null]);
});

test('decodeEntities and pageLines keep the line structure', () => {
  assert.equal(decodeEntities('Z&uuml;rich &#252; &#xFC; &amp; Caf&eacute;'), 'Zürich ü ü & Café');
  const lines = pageLines('<script>x()</script><p>Z&uuml;rich</p><div>a<br>b&#252;</div><style>p{}</style>');
  assert.deepEqual(lines, ['Zürich', 'a', 'bü']);
});

test('titleOf cuts at a separator and caps at 80 characters', () => {
  assert.equal(titleOf('<title>Kobold Games | Home</title>'), 'Kobold Games');
  assert.equal(titleOf('<title>Acme - Software</title>'), 'Acme');
  assert.equal(titleOf('<title>' + 'x'.repeat(200) + '</title>').length, 80);
  assert.equal(titleOf('<p>none</p>'), '');
});

test('impressumLink prefers Impressum over an earlier Kontakt and ignores off-site links', () => {
  const html = `<a href="https://other.com/impressum">Impressum</a><a href="/kontakt">Kontakt</a><a href="/impressum.html">Legal notice</a>`;
  assert.equal(impressumLink(html, 'https://acme.ch/'), 'https://acme.ch/impressum.html');
});

test('impressumLink reads the label and the path words', () => {
  assert.equal(impressumLink('<a href="/ueber-uns">x</a>', 'https://acme.ch/'), 'https://acme.ch/ueber-uns');
  assert.equal(impressumLink('<a href="/de/Universitaet/Kontakt-Anfahrt.html">Anfahrt</a>', 'https://www.unibe.ch/'), 'https://www.unibe.ch/de/Universitaet/Kontakt-Anfahrt.html');
  assert.equal(impressumLink('<a href="/mentions-legales">x</a><a href="/about">About</a>', 'https://acme.fr/'), 'https://acme.fr/mentions-legales');
  assert.equal(impressumLink('<a href="/products">Products</a>', 'https://acme.ch/'), null);
  assert.equal(impressumLink('<a href="mailto:a@b.ch">Kontakt</a>', 'https://acme.ch/'), null);
});

test('addressPairs rejects words after a number and accepts real postcode and place pairs', () => {
  const pairs = (line, country = null) => addressPairs([line], { table, country });
  assert.deepEqual(pairs('2025 Kommissionen'), []);
  assert.deepEqual(pairs('3402 Prüfung'), []);
  assert.deepEqual(pairs('4000 Mitarbeitende'), []);
  assert.deepEqual(pairs('Hauptstrasse 1, 4123 Allschwil'), [{ postcode: '4123', place: 'Allschwil', zone: 'B', country: 'CH', line: 0 }]);
  assert.equal(pairs('CH-8005 Zürich')[0].zone, 'C');
  assert.equal(pairs('68000 Colmar')[0].country, 'FR');
  assert.deepEqual(pairs('Hauptstrasse 1, 4123 Allschwil', 'FR'), []);
});

test('legalNameNear takes the nearest line with a legal form and strips the copyright prefix', () => {
  const lines = ['Welcome', '© 2024 Kobold Games GmbH. All rights reserved', 'Hauptstrasse 1', '4123 Allschwil', 'Other Corp AG'];
  assert.equal(legalNameNear(lines, 3), 'Other Corp AG');
  assert.equal(legalNameNear(lines.slice(0, 4), 3), 'Kobold Games GmbH');
  assert.equal(legalNameNear(['Hello', '4123 Allschwil'], 1), '');
});

test('readSite fetches robots, then at most 2 pages, each after a 1000 ms sleep with the User-Agent, timeoutMs 10000 and redirect manual', async () => {
  const { ctx, requests, sleeps } = fakeCtx(site());
  const r = await readSite('koboldgames.ch', ctx);
  assert.deepEqual(requests.map((q) => new URL(q.url).pathname), ['/robots.txt', '/', '/impressum']);
  assert.equal(r.pages, 2);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
  for (const q of requests) {
    assert.equal(q.opts.headers['User-Agent'], SITE_USER_AGENT);
    assert.equal(q.opts.timeoutMs, 10_000);
    assert.equal(q.opts.redirect, 'manual');
  }
  assert.equal(r.legalName, 'Kobold Games GmbH');
  assert.equal(r.title, 'Kobold Games');
  assert.deepEqual([r.pair.postcode, r.pair.place, r.pair.zone], ['4123', 'Allschwil', 'B']);
  assert.equal(r.note, '');
});

test('a robots.txt that disallows / reads no page', async () => {
  const { ctx, requests } = fakeCtx(site({ robots: 'User-agent: *\nDisallow: /' }));
  const r = await readSite('koboldgames.ch', ctx);
  assert.equal(requests.length, 1);
  assert.equal(r.pages, 0);
  assert.equal(r.note, 'robots.txt disallows /');
  assert.equal(r.pair, null);
});

test('a robots.txt that is unreachable on both hosts skips the site', async () => {
  const { ctx, requests } = fakeCtx(() => httpError(500));
  const r = await readSite('koboldgames.ch', ctx);
  assert.deepEqual(requests.map((q) => q.url), ['https://koboldgames.ch/robots.txt', 'https://www.koboldgames.ch/robots.txt']);
  assert.equal(r.pages, 0);
  assert.equal(r.note, 'robots.txt unreachable');
});

test('a 301 to www is followed, an off-site redirect is a note', async () => {
  const followed = fakeCtx((url) => {
    const u = new URL(url);
    if (u.hostname === 'acme.ch') return httpError(301, `https://www.acme.ch${u.pathname}`);
    return site()(url);
  });
  const r = await readSite('acme.ch', followed.ctx);
  assert.equal(r.pages, 2);
  assert.equal(r.pair.place, 'Allschwil');
  assert.ok(followed.requests.some((q) => q.url === 'https://www.acme.ch/robots.txt'));
  assert.ok(followed.sleeps.every((ms) => ms === 1000));
  assert.equal(followed.sleeps.length, followed.requests.length);

  const off = fakeCtx((url) => (new URL(url).pathname === '/robots.txt' ? '' : httpError(302, 'https://evil.com/')));
  const o = await readSite('acme.ch', off.ctx);
  assert.equal(o.pages, 0);
  assert.match(o.note, /redirects off-site to evil\.com/);
});

test('a failing home page becomes a note and nothing throws', async () => {
  const { ctx } = fakeCtx((url) => (new URL(url).pathname === '/robots.txt' ? '' : httpError(500)));
  const r = await readSite('acme.ch', ctx);
  assert.equal(r.pages, 0);
  assert.equal(r.note, 'HTTP 500');
});

test('a page without an in-zone address says so', async () => {
  const { ctx } = fakeCtx(site({ impressum: '<p>Kobold GmbH</p><p>8000 Nowhere</p>', home: '<p>hi</p>' }));
  const r = await readSite('koboldgames.ch', ctx);
  assert.equal(r.pair, null);
  assert.equal(r.note, 'no in-zone address');
});

test('siteResolve accepts a known domain without a name match', async () => {
  const { ctx, logs } = fakeCtx(site());
  const out = await siteResolve('Kobold', { domain: 'koboldgames.ch', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.deepEqual(out, {
    verdict: 'site', country: 'CH', legal_name: 'Kobold Games GmbH', entity_id: 'site:koboldgames.ch', place: 'Allschwil', postcode: '4123', size_band: '?',
    candidates: 'Kobold Games GmbH @ Allschwil (4123) #site:koboldgames.ch',
  });
  assert.ok(logs.includes('candiboost: site koboldgames.ch: 4123 Allschwil'), logs.join('|'));
});

test('siteResolve rejects a guessed domain whose legal name does not match and tries the next guess', async () => {
  const { ctx, requests } = fakeCtx((url) => {
    const u = new URL(url);
    if (u.hostname === 'koboldgames.ch') return site({ impressum: '<p>Other Corp AG</p><p>4123 Allschwil</p>', home: HOME.replace('Kobold Games', 'Other') })(url);
    if (u.hostname === 'koboldgames.com') return site()(url);
    return httpError(500);
  });
  const out = await siteResolve('Kobold Games', { domain: '', needle: needleFor('Kobold Games'), variants: [] }, ctx);
  assert.equal(out.verdict, 'site');
  assert.equal(out.entity_id, 'site:koboldgames.com');
  assert.ok(requests.some((q) => q.url.startsWith('https://koboldgames.ch/')));
});

test('siteResolve with a guessed domain whose legal name matches by prefix is accepted', async () => {
  const { ctx } = fakeCtx((url) => (new URL(url).hostname === 'kobold.ch' ? site()(url) : httpError(404)));
  const out = await siteResolve('Kobold', { domain: '', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.equal(out.entity_id, 'site:kobold.ch');
});

test('siteResolve returns no site when nothing answers, and null without targets', async () => {
  const { ctx } = fakeCtx(() => httpError(404));
  const none = await siteResolve('Kobold', { domain: '', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.deepEqual(none, { verdict: 'unresolved', candidates: 'no site' });
  assert.equal(await siteResolve('Data services', { domain: '', needle: null, variants: [] }, ctx), null);
});

test('siteResolve keeps the note of a site that served a page or refused by robots', async () => {
  const { ctx } = fakeCtx(site({ robots: 'User-agent: *\nDisallow: /' }));
  const out = await siteResolve('Kobold', { domain: 'koboldgames.ch', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.deepEqual(out, { verdict: 'unresolved', candidates: 'site:koboldgames.ch: robots.txt disallows /' });
});

test('siteResolve ignores a webmail domain and guesses instead', async () => {
  const { ctx, requests } = fakeCtx(() => httpError(404));
  await siteResolve('Kobold', { domain: 'gmail.com', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.ok(requests.every((q) => !q.url.includes('gmail.com')));
  assert.ok(requests.some((q) => q.url.startsWith('https://kobold.ch/')));
});

test('siteResolve sanitises ; and # in the legal name', async () => {
  const { ctx } = fakeCtx(site({ impressum: '<p>Kobold; #Games GmbH</p><p>4123 Allschwil</p>' }));
  const out = await siteResolve('Kobold', { domain: 'koboldgames.ch', needle: needleFor('Kobold'), variants: [] }, ctx);
  assert.equal(out.legal_name, 'Kobold, ,Games GmbH');
  assert.doesNotMatch(out.candidates.replace(' #site:', ''), /#/);
  assert.doesNotMatch(out.legal_name, /[;#]/);
});

test('nameMatches: the legal name or title must carry the needle as a whole name', () => {
  assert.equal(nameMatches('Kobold Games GmbH', [needleFor('Kobold Games')]), true);
  assert.equal(nameMatches('Kobold', [needleFor('Kobold Games')]), false);
  assert.equal(nameMatches('', [needleFor('Kobold')]), false);
});

test('readSite with keepText returns the page texts and the robots text, and without it neither', async () => {
  const kept = fakeCtx(site());
  const r = await readSite('koboldgames.ch', kept.ctx, { keepText: true });
  assert.deepEqual(r.texts, [
    { url: 'https://koboldgames.ch/', html: HOME },
    { url: 'https://koboldgames.ch/impressum', html: IMPRESSUM },
  ]);
  assert.equal(r.robots, '');
  assert.deepEqual(kept.requests.map((q) => new URL(q.url).pathname), ['/robots.txt', '/', '/impressum']);

  const plain = fakeCtx(site());
  const p = await readSite('koboldgames.ch', plain.ctx);
  assert.equal(Object.hasOwn(p, 'texts'), false);
  assert.equal(Object.hasOwn(p, 'robots'), false);
  assert.equal(Object.hasOwn(p, 'nxdomain'), false);

  const blocked = fakeCtx(site({ robots: 'User-agent: *\nDisallow: /' }));
  const b = await readSite('koboldgames.ch', blocked.ctx, { keepText: true });
  assert.deepEqual(b.texts, []);
});

test('readSite with keepText tells a domain that does not exist from an outage', async () => {
  const dns = (code) => () => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  const gone = await readSite('nowhere.ch', fakeCtx(dns('ENOTFOUND')).ctx, { keepText: true });
  assert.equal(gone.nxdomain, true);
  assert.equal(gone.robots, null);
  assert.equal(gone.note, 'robots.txt unreachable');
  assert.equal(gone.pages, 0);
  const outage = await readSite('nowhere.ch', fakeCtx(dns('EAI_AGAIN')).ctx, { keepText: true });
  assert.equal(outage.nxdomain, false);
  const plain = await readSite('nowhere.ch', fakeCtx(dns('ENOTFOUND')).ctx);
  assert.equal(Object.hasOwn(plain, 'nxdomain'), false);
});

test('fetchSitePage follows a same-site redirect politely and refuses an off-site one', async () => {
  const hop = fakeCtx((url) => (new URL(url).hostname === 'acme.ch' ? httpError(301, 'https://www.acme.ch/karriere') : '<p>Jobs</p>'));
  const page = await fetchSitePage('https://acme.ch/karriere', 'acme.ch', hop.ctx);
  assert.equal(page.url.href, 'https://www.acme.ch/karriere');
  assert.equal(page.text, '<p>Jobs</p>');
  assert.deepEqual(hop.sleeps, [1000, 1000]);
  for (const q of hop.requests) {
    assert.equal(q.opts.headers['User-Agent'], SITE_USER_AGENT);
    assert.equal(q.opts.timeoutMs, 10_000);
    assert.equal(q.opts.redirect, 'manual');
  }
  const off = fakeCtx(() => httpError(302, 'https://evil.com/x'));
  await assert.rejects(fetchSitePage('https://acme.ch/karriere', 'acme.ch', off.ctx), /redirects off-site to evil\.com/);
});
