#!/usr/bin/env node
// Google Careers local parser (jobs-json-v1), Switzerland.
//
// google.com/about/careers/applications serves results server-side with the
// listing embedded in an AF_initDataCallback({key: 'ds:1', data: [...]}) blob
// (rows, null, total, pageSize). No public JSON API exists, so this reads that
// blob page by page and fails loudly if the shape changes or if the collected
// rows do not match the advertised total.
//
// Usage: node scripts/parsers/google-jobs.mjs [--location Switzerland]

const BASE = 'https://www.google.com/about/careers/applications/jobs/results';
const i = process.argv.indexOf('--location');
const LOCATION = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : 'Switzerland';

function extract(html) {
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:1'[\s\S]*?data:([\s\S]*?), sideChannel/);
  if (!m) throw new Error('listing blob (ds:1) not found');
  const data = JSON.parse(m[1]);
  if (!Array.isArray(data) || !Array.isArray(data[0]) || typeof data[2] !== 'number') {
    throw new Error('unexpected listing payload shape');
  }
  return { rows: data[0], total: data[2], pageSize: data[3] };
}

const slug = t => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const rows = [];
let total = null;
for (let page = 1; page <= 30; page++) {
  const url = `${BASE}?location=${encodeURIComponent(LOCATION)}&page=${page}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const got = extract(await res.text());
  total = got.total;
  rows.push(...got.rows);
  if (rows.length >= total || got.rows.length === 0) break;
}
if (rows.length !== total) throw new Error(`truncated read: got ${rows.length} of ${total}`);

const seen = new Set();
const jobs = [];
for (const r of rows) {
  const id = r?.[0];
  const title = r?.[1];
  if (!id || !title || seen.has(id)) continue;
  seen.add(id);
  const locs = Array.isArray(r[9]) ? r[9].map(l => l?.[0]).filter(Boolean) : [];
  jobs.push({
    title,
    url: `${BASE}/${id}-${slug(title)}`,
    location: locs.join(' / '),
  });
}
if (jobs.length === 0) throw new Error('no jobs parsed');
process.stdout.write(JSON.stringify(jobs));
