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

**Brief**:
The registration one-pager the candidate sends a Cabinet, generated only from `cv.md`, `config/profile.yml` and `modes/_profile.md`.
_Avoid_: profile, candidate summary, dossier

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
