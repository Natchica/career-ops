#!/usr/bin/env node
// Generic server-rendered listing parser (jobs-json-v1).
//
// For career pages that ship their full posting list in the HTML response but
// sit on an ATS no providers/ module claims (Umantis, Zoho Recruit, bespoke
// Next.js pages). Extracts every anchor whose href matches --link-pattern and
// uses the anchor's text as the title.
//
// Usage:
//   node scripts/parsers/html-listing.mjs --url URL --link-pattern REGEX
//        [--exclude REGEX] [--cookies] [--title-from-heading] [--location TEXT]
//
//   --cookies    replay Set-Cookie from a first request (servers that reject
//                cookieless clients with a "Cookie not accepted" interstitial)
//   --location   fixed location for every row; omit when postings differ in
//                location, so location_filter sees an empty value and passes
//                rather than acting on a wrong one
//
// Deliberately does NOT paginate: it reads exactly the page it is given. A
// board whose later pages are reachable only by JS postback must not be wired
// here — a parser that silently returns page 1 of N reads as "these are all the
// open roles", which is the truncated-read failure scan.md warns about.

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const url = arg('url');
const linkPattern = arg('link-pattern');
if (!url || !linkPattern) {
  process.stderr.write('usage: --url URL --link-pattern REGEX [--exclude REGEX] [--cookies] [--location TEXT]\n');
  process.exit(2);
}
const include = new RegExp(linkPattern, 'i');
const exclude = arg('exclude') ? new RegExp(arg('exclude'), 'i') : null;
const fixedLocation = arg('location', '');

// Follows redirects by hand so cookies set on an intermediate hop are replayed
// on the next one. fetch's own redirect:'follow' drops them, which is exactly
// the case some servers use to gate access ("Cookie not accepted, cannot
// continue!"): hop 1 sets the cookie, hop 2 tests for it.
async function getHtml(target) {
  const jar = new Map();
  let current = target;

  for (let hop = 0; hop < 10; hop++) {
    const headers = { 'user-agent': UA, accept: 'text/html' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const res = await fetch(current, { headers, redirect: 'manual' });

    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
    return { html: await res.text(), finalUrl: current };
  }
  throw new Error(`too many redirects from ${target}`);
}

const { html, finalUrl } = await getHtml(url);

const stripTags = s => s.replace(/<[^>]*>/g, ' ');
const decode = s => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const clean = s => decode(stripTags(s)).replace(/\s+/g, ' ').trim();

// Some boards link out with a generic control ("Apply Now") and carry the real
// title in a heading above it. --title-from-heading takes the nearest preceding
// h1-h4 instead of the anchor text.
const titleFromHeading = flag('title-from-heading');
const headings = titleFromHeading
  ? [...html.matchAll(/<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map(h => ({ at: h.index, text: clean(h[1]) }))
  : [];
const headingBefore = at => {
  let found = '';
  for (const h of headings) {
    if (h.at > at) break;
    if (h.text) found = h.text;
  }
  return found;
};

const jobs = [];
const seen = new Set();
for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
  const href = decode(m[1]);
  if (!include.test(href)) continue;
  if (exclude && exclude.test(href)) continue;
  const title = titleFromHeading ? headingBefore(m.index) : clean(m[2]);
  if (!title) continue;
  const abs = new URL(href, finalUrl).toString();
  if (seen.has(abs)) continue;
  seen.add(abs);
  jobs.push({ title, url: abs, location: fixedLocation });
}

process.stdout.write(JSON.stringify(jobs));
