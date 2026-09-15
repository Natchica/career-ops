#!/usr/bin/env node
// Bitcoin Suisse local parser (jobs-json-v1).
//
// Bitcoin Suisse runs its ATS on onlyfy (bitcoin-suisse.onlyfy.jobs), which no
// providers/ module claims. Their own site exposes the same board as plain JSON
// at bitcoinsuisse.com/api/careers, so read that instead of scraping the SPA.
//
// Usage: node scripts/parsers/bitcoinsuisse-jobs.mjs

const API = 'https://bitcoinsuisse.com/api/careers';

const res = await fetch(API, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const body = await res.json();
if (!Array.isArray(body)) throw new Error('unexpected payload shape');

const jobs = body
  .filter(j => j && j.title && j.url)
  .map(j => ({
    title: j.title,
    url: j.url,
    // The feed carries no location field; departments[] holds the legal entity
    // and, for the international sales roles, the country. Join it so
    // location_filter has something to read rather than an empty string.
    location: Array.isArray(j.departments) ? j.departments.join(', ') : '',
  }));

process.stdout.write(JSON.stringify(jobs));
