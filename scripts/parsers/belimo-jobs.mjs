#!/usr/bin/env node
// Belimo local parser (jobs-json-v1).
//
// belimo.com 403s every non-browser client (Akamai), but its postings live on a
// public SAP SuccessFactors career-site-builder host, jobsredirect.belimo.com,
// that no providers/ module claims. Pages /search/?startrow=N (25 per page),
// reads title + href from the tiles, and fails loudly if the collected count
// does not match the page's own "Showing a to b of N Jobs" total.
//
// The tiles carry no location, so it is derived from the job slug
// (/job/<City>-<Title>-<Region>-<Zip>/<id>/): the segment before the title.
//
// Usage: node scripts/parsers/belimo-jobs.mjs

const HOST = 'https://jobsredirect.belimo.com';
const PAGE = 25;

const decodeEntities = s => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function cityFromSlug(href, title) {
  try {
    const slug = decodeURIComponent(href.split('/job/')[1].split('/')[0]);
    const first = title.split(/[\s/(,]+/).find(w => /\w/.test(w));
    if (!first) return '';
    const idx = slug.toLowerCase().indexOf('-' + first.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
    return idx > 0 ? slug.slice(0, idx).replace(/-/g, ' ') : '';
  } catch { return ''; }
}

const jobs = [];
const seen = new Set();
let total = null;
for (let start = 0; start < 2000; start += PAGE) {
  const url = `${HOST}/search/?q=&startrow=${start}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  const m = html.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+(\d+)\s+Jobs/i);
  if (!m) throw new Error('result count banner not found');
  total = Number(m[1]);
  let added = 0;
  const re = /<a[^>]*class="jobTitle-link[^"]*"[^>]*href="(\/job\/[^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/a>/g;
  for (let t; (t = re.exec(html));) {
    const href = decodeEntities(t[1]);
    if (seen.has(href)) continue;
    seen.add(href);
    const title = decodeEntities(t[2]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    jobs.push({ title, url: HOST + href, location: cityFromSlug(href, title) });
    added++;
  }
  if (jobs.length >= total || added === 0) break;
}
if (jobs.length !== total) throw new Error(`truncated read: got ${jobs.length} of ${total}`);

process.stdout.write(JSON.stringify(jobs));
