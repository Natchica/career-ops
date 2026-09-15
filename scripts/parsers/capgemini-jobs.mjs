#!/usr/bin/env node
// Capgemini local parser (jobs-json-v1).
//
// Capgemini's public careers site (capgemini.com/<cc>/careers/join-capgemini/job-search)
// is a JS front end over a plain JSON backend: cg-jobstream-api.azurewebsites.net.
// No supported ATS provider claims capgemini.com, and discover-ats.mjs cannot
// resolve it (the underlying board is a Radancy/TalentBrew feed reached only
// through careers.capgemini.com apply links), so this parser reads the JSON API
// directly and keeps the entry zero-token.
//
// Usage: node scripts/parsers/capgemini-jobs.mjs [country_code ...]
// Default country codes: ch-en fr-fr

const API = 'https://cg-jobstream-api.azurewebsites.net/api/job-search';
const PAGE_SIZE = 200;
const MAX_PAGES = 20;

const countryCodes = process.argv.slice(2).filter(a => !a.startsWith('-'));
const codes = countryCodes.length ? countryCodes : ['ch-en', 'fr-fr'];

async function fetchCountry(cc) {
  const jobs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API}?page=${page}&size=${PAGE_SIZE}&country_code=${encodeURIComponent(cc)}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${cc} page ${page}: HTTP ${res.status}`);
    const body = await res.json();
    const batch = Array.isArray(body.data) ? body.data : [];
    if (!batch.length) break;
    for (const j of batch) {
      const url = j.apply_job_url || j.wp_url;
      if (!url || !j.title) continue;
      jobs.push({ title: j.title, url, location: j.location || '' });
    }
    const total = Number(body.count) || 0;
    if (page * PAGE_SIZE >= total) break;
  }
  return jobs;
}

const all = [];
for (const cc of codes) {
  all.push(...await fetchCountry(cc));
}

// The same requisition is listed under several country feeds; dedupe on URL.
const seen = new Set();
const unique = all.filter(j => !seen.has(j.url) && seen.add(j.url));

process.stdout.write(JSON.stringify(unique));
