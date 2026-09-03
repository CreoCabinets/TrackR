# TrackR current hardening and reliability report

## Scope

This report supersedes the old pre-Railway status report for the current codebase. The historical report is preserved separately as `HARDENING_REPORT_2026_PRE_RAILWAY.md`.

## Current architecture

TrackR remains a Flask + SQLite internal production-planning application. The supported production topology is:

- one TrackR service
- one Railway replica
- one Gunicorn worker (threads are allowed)
- one persistent Railway volume

Do not horizontally scale the current SQLite/whole-workspace-JSON architecture.

## Reliability changes in this pass

- Railway's mounted volume now takes priority over `TRACKR_DB_PATH`; a stale local DB override cannot move the Railway live database onto ephemeral application storage.
- The old Git/bundled `flow.sqlite3` seed-copy deployment path has been removed. A genuinely new database is initialized by the application and bootstrap accounts come from environment variables.
- Startup schema maintenance is committed before recovery backups are attempted.
- Corrupt or semantically invalid stored workspace state is backed up and startup fails clearly rather than silently replacing operational data with the default workspace.
- `/health` is now a lightweight availability/database read. Deep SQLite integrity checking moved to the admin-only `/api/database-integrity` endpoint.
- Frontend workspace saves keep a last-known persisted snapshot. Failed saves roll unsaved workspace mutations back; revision conflicts reload the latest saved server state instead of leaving the browser showing changes that were never committed.
- Browser unload protection now covers dirty/debounced state as well as active requests.

## Validation and scheduling changes

- Validated text values are normalized back into persisted state instead of being checked and then discarded.
- Non-custom generated/job-linked tasks must reference an existing job.
- `custom:true` standalone tasks remain valid and can keep a quick-fix description in the Job field without requiring a matching job record.
- Malformed free-text hour entries no longer silently become zero when saving tasks, employee rosters or overtime.
- Generated workflow business-day calculations now skip company-wide Calendar Events as well as weekends.
- Existing semantics are preserved: Factory Closure, Public Holiday and Company Event all block production capacity.

## Authentication and read-only changes

- Login throttling now uses Flask's proxy-resolved `request.remote_addr` rather than reading raw `X-Forwarded-For` itself.
- Throttling applies both per account and per IP, with bounded/expired in-memory buckets. The Railway deployment still intentionally uses one Gunicorn process; counters reset on restart/deploy and are therefore a pragmatic internal-app control rather than a distributed security service.
- Login/password fields now reflect backend length limits and auth errors are announced with `role="alert"`.
- Password-change wording now accurately says the new password must differ from the current password; TrackR does not maintain password-history records.
- Read-only users opening Calendar/Schedule tasks now receive a dedicated read-only details panel rather than an edit form that could never persist changes.

## Backup model

TrackR keeps up to 10 rolling SQLite backups beside the live database and admins can download a consistent backup. Same-volume backups protect against bad saves/migrations but not complete Railway volume loss. Keep downloaded backups outside Railway and periodically test restoration/integrity.

## Test expectations

The current repository includes backend regression tests plus frontend logic/static checks. Before deployment, run:

```text
python -m py_compile app.py
python -m unittest discover -s tests -p "test_*.py"
node tests/frontend_logic_test.js
```

A Railway smoke test is still required after deploy because local automated tests cannot reproduce the hosted proxy/volume/runtime exactly.

## Frontend modularisation

The main UI has now been split into a small structural `templates/index.html`, `static/css/trackr.css`, and focused classic JavaScript files for core state, Home, Jobs, Calendar, Schedule, task/day panels, Settings and startup/event wiring. Inline HTML event handlers were replaced with delegated `data-*` actions so executable JavaScript no longer needs an inline-script CSP exception.

The Content Security Policy now uses `script-src 'self'` with no `unsafe-inline`. `style-src` still permits `unsafe-inline` because TrackR deliberately uses runtime element styles for schedule geometry/progress and a small number of presentation-only inline styles. The existing two-pass visual CSS cascade was moved intact into `trackr.css` rather than aggressively rewritten, so this refactor changes structure/security without intentionally changing the approved UI. A later purely visual CSS consolidation can be done separately if desired.
