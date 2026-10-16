#!/usr/bin/env node
// Euro-Information / Crédit Mutuel group recruitment parser (jobs-json-v1).
//
// recrutement.creditmutuel.fr lists 15 offers per page and loads more through a
// form postback ("Plus de résultats", _FID_PlusDoffres) that carries the page's
// hidden state — there is no query-string pager, so html-listing.mjs only ever
// sees the first 15 of ~500. This parser replays that postback until every
// offer is collected and exits 1 if the emitted count is below the total the
// page states ("N offres affichées sur TOTAL"), so a truncated read never
// passes as full coverage.
//
// Usage: node scripts/parsers/euroinformation-jobs.mjs [--url URL]

const argUrl = process.argv.indexOf('--url') !== -1 ? process.argv[process.argv.indexOf('--url') + 1] : null;
const START = argUrl || 'https://recrutement.creditmutuel.fr/fr/nos_offres.html';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
// The card shows only an entity logo, never a name, so the group is the honest label.
const COMPANY = 'Euro-Information';
const MAX_PAGES = 80;

const decode = s => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const clean = s => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

const jar = new Map();
async function request(url, body) {
  const headers = { 'user-agent': UA, accept: 'text/html' };
  if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method: body ? 'POST' : 'GET', headers, body, redirect: 'follow' });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { html: await res.text(), url: res.url };
}

// Re-submit the page's own form state with the "more results" button pressed.
function nextRequest(html, pageUrl) {
  const form = html.match(/<form id="RHEC:P:F"[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/);
  if (!form) return null;
  const params = new URLSearchParams();
  for (const m of form[2].matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const attr = n => { const a = tag.match(new RegExp(`\\s${n}="([^"]*)"`)); return a ? decode(a[1]) : null; };
    const name = attr('name'); const type = (attr('type') || 'text').toLowerCase();
    if (!name || type === 'submit' || type === 'image') continue;
    if ((type === 'checkbox' || type === 'radio') && !/\schecked\b/.test(tag)) continue;
    params.append(name, attr('value') ?? '');
  }
  params.append('_FID_PlusDoffres', '');
  return { url: new URL(decode(form[1]), pageUrl).href, body: params.toString() };
}

const byUrl = new Map();
let total = null;
let page = await request(START);
for (let i = 0; i < MAX_PAGES; i++) {
  const stated = page.html.match(/(\d+)\s+offres\s+affich(?:&#233;|é)es\s+sur\s+(\d+)/);
  if (stated) total = Number(stated[2]);
  const before = byUrl.size;
  for (const card of page.html.matchAll(/<a[^>]*href="(\/fr\/offre\.html\?annonce=\d+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<ul[^>]*ei_listdescription[^>]*>\s*<li>([\s\S]*?)<\/li>/g)) {
    const url = new URL(card[1], page.url).href;
    if (!byUrl.has(url)) byUrl.set(url, { title: clean(card[2]), url, location: clean(card[3]), company: COMPANY });
  }
  if (total !== null && byUrl.size >= total) break;
  if (byUrl.size === before) break; // no progress: stop instead of looping
  const next = nextRequest(page.html, page.url);
  if (!next) break;
  page = await request(next.url, next.body);
}

const jobs = [...byUrl.values()].filter(j => j.title);
if (total === null) { process.stderr.write('euroinformation: stated total not found on page\n'); process.exit(1); }
if (jobs.length < total) {
  process.stderr.write(`euroinformation: truncated read, emitted ${jobs.length} of ${total}\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify(jobs));
