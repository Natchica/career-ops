# career-ops — Job Search Context

Vocabulary for the job-search pipeline in this checkout, with the intermediary channel added on 2026-10-05. Modes, reports, tracker notes and design docs use the bold terms below; the words under _Avoid_ are the ones that caused confusion.

## Language

### Channels

**Direct**:
An application the candidate submits to the end employer's own ATS or careers page.
_Avoid_: organic, own application

**Cabinet**:
A search firm paid a fee by the end employer to find a hire, where the end employer signs the candidate's contract.
_Avoid_: agency (overloaded), headhunter (one kind of Cabinet), recruiter (a person, not a firm); keep "cabinet de recrutement" and "Personalberatung" as market vocabulary only

**Body-shop**:
An intermediary that employs the candidate itself and bills a client for the candidate's time.
_Avoid_: agency, staffing, ESN, SSII, Arbeitnehmerüberlassung, portage, régie (all are Body-shop forms, never Cabinets)

**Via**:
The tracker column naming the channel an application went through: `—` for Direct, otherwise the Cabinet or marketplace name.
_Avoid_: source, channel column

### People

**Consultant**:
The named person at a Cabinet who handles the candidate, stored in `data/contacts.tsv` as `type: recruiter` with the Cabinet in the company column.
_Avoid_: headhunter, agent, recruiter (unqualified)

**In-house recruiter**:
A talent-acquisition employee of the end employer.
_Avoid_: recruiter (unqualified)

### Work items

**Mandate**:
One opening a Cabinet is working and has presented to the candidate, recorded as a tracker row whose Via is that Cabinet.
_Avoid_: mission, mandat, Suchauftrag, opportunity, lead

**Lead**:
A posting URL sitting in `data/pipeline.md` Pending that has not been evaluated yet, written there by the scanner or by an ingest plugin (`job-alerts`, `linkedin-alerts`). A Lead is not a Mandate: nobody presented it, and it carries no channel until it is evaluated.
_Avoid_: opportunity, match (the email sender's word), offer (reserved for an evaluated posting and for `data/outcomes/`)

**Prospect**:
A company recorded in the radar registry (`data/radar.tsv`) because it has at least one site in a target commute zone. A Prospect is not evaluated, not approached and not necessarily hiring; it may have no scannable board and no posting.
_Avoid_: lead (a posting URL), target (implies the candidate chose it), company entry, account

**Tier**:
The rank 1, 2, 3 or out that `radar-tiers.mjs` gives a Prospect from its zone, country, tech signals and size, with a recorded reason. A Tier decides which Prospects a Spontaneous application may start from; it says nothing about whether the company is hiring. A Prospect known only from a GitHub organisation is an unverified employer and is Tier 2 at most; one whose name marks a research group, lab or school is out.
_Avoid_: score (reserved for evaluated postings), priority, grade

**Radar**:
The census tool and registry that enumerates Prospects from registers, job-board employer mining, startup directories and GitHub orgs. It names companies and does nothing else with them.
_Avoid_: discover (the ATS board resolver `discover-ats.mjs`, which consumes names the Radar produces)

**Site probe**:
The zero-model read of a Prospect's own website by `radar-enrich.mjs --sites`, for a Prospect that no register, GitHub organisation or `portals.yml` entry gives a website: up to 6 guessed domains from the registered name are tried, one counts only when its page names the company (and its place), and the first verified site is read for hint tokens. The result is stored in the `hints` cell as `web:{domain}`, or `site:none` when no domain verified. It reads company pages only, never people, and never evaluates, approaches or excludes the Prospect.
_Avoid_: crawl, scrape, enrichment as a name for the whole Radar (the word is reserved for hints), lookup (a register query)

**Spontaneous application**:
A Direct application sent to a Prospect with no Lead behind it: no posting exists, so the CV is framed from the profile's no-JD row (`modes/_profile.md`, "Your Adaptive Framing") instead of being tailored to a JD.
_Avoid_: cold application (collides with cold outreach in `contacto`), unsolicited, speculative; keep "candidature spontanée" and "Initiativbewerbung" as market vocabulary only

**Candiboost send**:
A Spontaneous application that the Candiboost campaign sent from the candidate's own Gmail with the campaign's fixed template, to a named person it found at the company. It is read back from the Sent folder by `candiboost-sync.mjs` into `data/candiboost.tsv`, a tracker row and a contact; it is never written by the `spontaneous` mode. Its personalised mail is its first follow-up, drafted through the full spontaneous flow and sent as a reply in the same thread.
_Avoid_: blast, campaign mail (the template, not the send), import (the sync reads mail, not a file)

**Candiboost pending row**:
A company listed on the candidate's Candiboost campaign that has not been mailed yet ("En attente"), read from the campaign page into `data/candiboost-pending.tsv` with its domain. It becomes a Prospect only through a Resolution whose seat is in a zone; until then it is not in the Radar and cannot be picked.
_Avoid_: pending company (collides with tracker statuses), candidate (the person), target

**Resolution**:
The register lookup that turns a Candiboost spelling into one legal entity with a seat: Zefix (CH) or SIRENE (FR), by name, never guessed; when the registers fail, the company's own website, whose Impressum or contact page names an in-zone address. Recorded once per spelling in `data/candiboost-resolved.tsv` with a verdict: `resolved` (register entity in zone; a brand with several operating entities resolves to the brand), `site` (the website named an in-zone address), `out-of-zone`, `ambiguous` (the candidate picks the entity by hand), `unresolved` (nothing placed it) or `hand` (the candidate typed the place).
_Avoid_: match (the base-key index lookup in `lib/candiboost.mjs`), geocoding, enrichment (reserved for `radar-enrich.mjs` hints)

**Brief**:
The registration one-pager the candidate sends a Cabinet, generated only from `cv.md`, `config/profile.yml` and `modes/_profile.md`.
_Avoid_: profile, candidate summary, dossier

**Open items**:
The list of decisions attached to every letter or email draft that only the candidate can take: the motivation fact and its source, the objective sentence, the wording of a gap, the salutation name, the German sentence, the attached files. A draft is shown once, with its Open items; there is no confirmation before drafting.
_Avoid_: gates, prompts, questions (the pre-draft confirmations this replaced), TODOs

**Outbound text gate**:
The closing step of every text-writing workflow: the draft is scanned by `unslop.mjs`, repaired, checked for lost facts, and only then shown. It runs without any candidate action; what it cannot repair is listed under Open items, never presented as clean.
_Avoid_: unslop mode, humanizer, filter, lint pass

**Name-before-send**:
The consent rule that a Cabinet names the end employer before the candidate authorizes their CV to be sent, one authorization per Mandate.
_Avoid_: exclusivity, blanket authorization

**Check-in**:
A candidate-initiated touch with a Cabinet that has no live Mandate, due every 21 days while active and every 45 days while only registered.
_Avoid_: follow-up (reserved for applications in `data/follow-ups.md`)

## Relationships

- A **Cabinet** employs one or more **Consultants**
- A **Cabinet** presents zero or more **Mandates**; each **Mandate** is exactly one tracker row whose **Via** is that Cabinet
- A **Mandate** names at most one end employer; until named, the row's Company is `?` and no CV authorization exists
- **Name-before-send** gates every **Mandate** individually; registering with a Cabinet grants nothing
- A **Body-shop** is never a **Cabinet**: it fails vetting on the contract-signer test and becomes a `data/blacklist.md` suggestion
- The **Radar** produces **Prospects**; a **Prospect** may later resolve to a `portals.yml` board, at which point the scanner starts producing **Leads** for it
- A **Prospect** is one brand or group with its in-zone sites listed; legal entities are aliases, never separate Prospects
- A **Site probe** only reorders Prospects inside one zone and country group through the `hints` cell: a verified site with software, careers or stack traces ranks above an unprobed Prospect, and a probed Prospect with no verified site ranks below it; it never changes a **Tier**
- A **Spontaneous application** targets a **Prospect** directly; it has no **Lead**, its **Via** is `—` (Direct), and it enters the tracker only once it is actually sent
- A **Spontaneous application** starts from a **Prospect** of **Tier** 1 or 2, one per daily run, chosen by the candidate from the best untouched ones
- A **Candiboost send** is a **Spontaneous application** whose first mail was not written here: it has a tracker row and a contact from the day it is synced, and its company is excluded from the daily pick of first mails; its personalised mail is a follow-up, chosen 1-2 per day from the sends 7 days old or older, **Tier** 1 first
- A **Candiboost pending row** becomes a **Prospect** through a **Resolution** with an in-zone seat, carrying `candiboost` in its sources and the Candiboost spelling as an alias; the `candiboost` source token is never a tech signal
- The one daily list of first mails is `spontaneous next`: a **Candiboost pending row** that is a **Prospect** appears there like any other, in gate order, flagged with the row to delete after sending
- A **Brief** is versioned; the registry records which version each **Cabinet** holds

## Example dialogue

> **Dev:** "A firm on the blacklist is labelled 'recruitment agency'. Does the cabinet mode re-open it?"
> **Domain expert:** "No, if that firm employs you and bills the client, it is a **Body-shop**. A **Cabinet** never signs your contract; the end employer does. The vetting checklist's first question is who signs, and a Body-shop is `out` there."
> **Dev:** "A **Consultant** says they have a role that fits but will not say which company yet. Do I evaluate it?"
> **Domain expert:** "Record the **Mandate** with Company `?` and a descriptor. Nothing goes out: **Name-before-send** means no CV until they name the client, because the cross-channel check cannot run against `?`."

## Flagged ambiguities

- "agency" was used for both **Cabinet** and **Body-shop**; blacklist rows labelled "recruitment agency" usually mean Body-shop. Resolved: new text uses Cabinet or Body-shop; the existing `Via` and "agency confirmation" wording in system-layer modes reads as "any intermediary".
- "recruiter" meant both an **In-house recruiter** and a **Consultant**. Resolved: `data/contacts.tsv` keeps `type: recruiter` for both (system-layer enum); the company column disambiguates.
- "follow-up" vs **Check-in**. Resolved: follow-ups belong to applications (`data/follow-ups.md`, `followup` mode); check-ins belong to Cabinet relationships (`data/cabinets.md`, `cabinet status`).
