#!/usr/bin/env node
// Helvetia local parser (jobs-json-v1).
//
// jobs.helvetia.com is a prospective.ch careercenter SPA; its list comes from a
// public JSON endpoint (ohws.prospective.ch/public/v1/medium/<id>/jobs) that no
// providers/ module parses. Pages through offset/limit and fails loudly if the
// collected rows do not match `total`, so a truncated read never passes as
// "these are all the open roles".
//
// Usage: node scripts/parsers/helvetia-jobs.mjs

const BASE = 'https://ohws.prospective.ch/public/v1/medium/1005736/jobs';
const LIMIT = 100;

const rows = [];
let total = null;
for (let page = 0; page < 50; page++) {
  const url = `${BASE}?lang=de&limit=${LIMIT}&offset=${rows.length}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.json();
  if (!Array.isArray(body.jobs) || typeof body.total !== 'number') throw new Error('unexpected payload shape');
  total = body.total;
  rows.push(...body.jobs);
  if (rows.length >= total || body.jobs.length === 0) break;
}
if (rows.length !== total) throw new Error(`truncated read: got ${rows.length} of ${total}`);

const decode = s => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

const jobs = rows
  .filter(j => j && (j.szas?.sza_title || j.title) && j.links?.directlink)
  .map(j => ({
    title: decode(j.szas?.sza_title || j.title),
    url: j.links.directlink,
    location: [j.szas?.['sza_location.city'] || j.szas?.['sza_workplace.city'], j.szas?.['sza_location.country']]
      .filter(Boolean).join(', '),
  }));
if (jobs.length === 0) throw new Error('no jobs parsed');

process.stdout.write(JSON.stringify(jobs));
