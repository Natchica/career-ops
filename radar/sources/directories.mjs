/**
 * radar/sources/directories.mjs — startup and cluster directories.
 *
 * No site is enabled. Each candidate was checked on 2026-10-18 for a company
 * list a crawler may read, and none qualified, so this module documents the
 * result and yields nothing. It exists so the Radar page shows the source
 * family honestly, and so a future site has one place to be added to.
 *
 * A site is added only after three checks: its robots.txt allows the paths the
 * source would fetch, its terms allow automated reading, and a company list
 * actually exists there. An unreachable site is never read as permission.
 * To enable one: add a `built` entry below, implement `fetch`, and remove
 * `disabled`.
 */

export const VETTING = [
  {
    site: 'BaselArea.swiss',
    verdict: 'not-built',
    checked: '2026-10-18',
    note: 'robots.txt allows all, but the sitemaps hold posts, pages, events and programmes only: there is no company list to read.',
  },
  {
    site: 'Alsace Digitale',
    verdict: 'not-built',
    checked: '2026-10-18',
    note: 'robots.txt allows all, but the sitemap holds events and projects only: no company list.',
  },
  {
    site: 'BioValley France',
    verdict: 'not-built',
    checked: '2026-10-18',
    note: 'The sitemap and robots.txt both timed out on a second attempt, so the rules could not be checked. An unreachable site is not permission. Re-check if it comes back.',
  },
  {
    site: 'FWTM Freiburg',
    verdict: 'not-built',
    checked: '2026-10-18',
    note: 'robots.txt allows reading with a 10 second crawl delay, but the pages describe clusters and networks, not firms: no company list.',
  },
  {
    site: 'WSW Lörrach',
    verdict: 'not-built',
    checked: '2026-10-18',
    note: 'robots.txt allows all, but the sitemap has no firm directory.',
  },
];

export default {
  id: 'directories',
  family: 'directory',
  auth: { kind: 'none', vars: [] },
  disabled: 'no vetted site: none of the 5 candidates offers a company list a crawler may read (see VETTING)',

  // eslint-disable-next-line require-yield
  async *fetch() {
    return;
  },
};
