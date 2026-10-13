#!/usr/bin/env node
// Sensirion local parser (jobs-json-v1).
//
// Sensirion's site serves its job board as a paginated JSON API
// (sensirion.com/en/api/v2/jobs/, DRF-style {count, next, results}) that no
// providers/ module parses. Follows `next` until exhausted and fails loudly if
// the collected rows do not match `count`, so a truncated read never passes as
// "these are all the open roles".
//
// Usage: node scripts/parsers/sensirion-jobs.mjs

const START = 'https://www.sensirion.com/en/api/v2/jobs/';

const rows = [];
let next = START;
let count = null;
for (let page = 0; next && page < 50; page++) {
  const res = await fetch(next, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${next}`);
  const body = await res.json();
  if (!Array.isArray(body.results)) throw new Error('unexpected payload shape');
  count = body.count;
  rows.push(...body.results);
  next = body.next;
}
if (typeof count === 'number' && rows.length !== count) {
  throw new Error(`truncated read: got ${rows.length} of ${count}`);
}

const jobs = rows
  .filter(j => j && j.sza_title && j.links_direct_link)
  .map(j => ({
    title: j.sza_title,
    url: j.links_direct_link,
    location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
  }));

process.stdout.write(JSON.stringify(jobs));
