# secrets/ (gitignored)

Drop these two files here. Nothing in this folder is committed.

- `appstore.p8` — App Store Connect API private key (downloaded once from App Store Connect → Users and Access → Integrations → Team Keys).
- `googleplay.json` — Google Play service account JSON key (GCP → IAM → Service Accounts → Keys).

Vibe Central reads them only when you add the App Store Connect or Google Play account in Connections (the dashboard reads the file contents you paste or upload; the sync functions store them encrypted in the database). They are never pushed to git.
