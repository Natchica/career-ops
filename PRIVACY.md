# Privacy Policy

Last updated: 2026-10-26

This policy covers the personal OAuth client used by the `candiboost-sync.mjs` script in this repository (the "app"). The app is a command-line tool that its owner runs on their own computer. It is not a hosted service and has no other users.

## What the app accesses

With the owner's consent, the app reads Gmail through the read-only scope `https://www.googleapis.com/auth/gmail.readonly`. It reads the owner's Sent folder and the replies and bounce notices in the threads of spontaneous job applications. It never sends, labels, archives or deletes any mail.

## What the app does with the data

- The data is processed locally on the owner's computer.
- It records the send date, the recipient's company and domain, and the thread status in local files, and uses it to match applications in the owner's own job-search tracker.
- It does not transmit Google user data to any server, third party or analytics service.
- It does not use Google user data for advertising or to train any model.
- It stores nothing outside the owner's computer, and the owner can delete the local files at any time.

## Credentials

The OAuth client ID, client secret and refresh token are stored in a local file on the owner's computer and are never committed to this repository. The owner can revoke access at any time at https://myaccount.google.com/permissions.

## Contact

Questions: open an issue at https://github.com/Natchica/career-ops/issues.

This app's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.
