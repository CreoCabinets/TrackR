# TrackR pre-Railway hardening report

## Status

TrackR has been converted from the audited local development build into a hardened pre-Railway build. It has **not** been deployed to Railway yet.

The packaged seed database preserves the uploaded TrackR data:

- 10 employees
- 2 login accounts (`admin` and `factory`)
- 0 jobs
- 0 production tasks
- 0 day-status entries
- 0 calendar events

Both account passwords have been replaced with random temporary passwords. Both accounts must change their password after first sign-in. The credentials are supplied in a separate file and are not included in the deployment ZIP.

## Audit blockers fixed

### Production startup

- Added a Railway configuration file and a Gunicorn production start command.
- Disabled Flask debug mode by default.
- Added a `/health` endpoint that checks SQLite integrity.
- Pinned Python and application dependencies.
- Added deployment documentation and a checklist.

### Persistent database handling

- Added `TRACKR_DB_PATH` support.
- Added Railway volume support through `RAILWAY_VOLUME_MOUNT_PATH`.
- On a new empty Railway volume, TrackR copies the bundled `flow.sqlite3` seed database to `<mount>/trackr.sqlite3`.
- Enabled SQLite WAL mode, foreign keys, a busy timeout and transactional writes.
- Added rolling automatic SQLite backups and an admin backup-download endpoint.

### Login and session security

- Removed hardcoded default passwords.
- Replaced both existing passwords with random temporary passwords.
- Added forced password changes for temporary credentials.
- Added session-version revocation when passwords or roles change.
- Added login rate limiting.
- Added CSRF protection to all state-changing requests.
- Added secure production cookie settings, proxy handling and security headers.
- Production startup now requires a `TRACKR_SECRET_KEY` of at least 32 characters.

### Authorization

- Retained role-based UI restrictions.
- Enforced read-only Factory-user permissions on the backend, not only in the interface.
- Restricted user administration, backups, PDF import and workspace writes to admins.

### Data integrity and concurrency

- Added state-schema migration and semantic validation.
- Added input length and collection-size limits.
- Rejected unsafe angle-bracket content before it can be stored.
- Added optimistic revision locking; a stale browser receives a conflict instead of silently overwriting newer work.
- Serialized browser saves to prevent overlapping requests.
- Added database and state recovery safeguards.

### Scheduling consistency

- Unassigned capacity work can no longer be saved invisibly.
- Split-task allocation minutes must match the task duration.
- Admin employees cannot be assigned as production capacity.
- Admin calendar-only assignments are retained.
- Employee rename and deletion handling now accounts for split minutes, individual dates and admin references.
- Capacity tasks stay off Calendar; milestone and non-capacity items remain visible there.

### Frontend correctness

- Corrected the Home weekly calculations.
- Corrected current-month and current-date Calendar behaviour.
- Escaped dynamic job, employee, address and task values before inserting them into HTML.
- Removed deprecated reset/demo, old Sick/Away-page, unused status-list and obsolete toolbar code.
- Added safer state payload preparation so transient display properties are not persisted.

## Checks completed

### Static checks

- `app.py` compiles successfully.
- Extracted inline JavaScript passes `node --check`.
- The main HTML template contains no duplicate element IDs.
- No original default passwords, demo-reset endpoint or forced debug-mode pattern remains.

### Automated behaviour checks

Five automated test groups passed, covering:

1. Health endpoint, security headers, admin login and forced password change.
2. CSRF enforcement, stale-state conflict handling and state saves.
3. Stored-script payload rejection, unassigned-task rejection and split-allocation validation.
4. SQLite backup creation, account creation and exclusion of password hashes from API responses.
5. Factory read-only enforcement, password-reset session revocation and SQLite integrity.

The behaviour tests used the compatible Flask and pypdf versions already available in the isolated test environment. Railway will install the exact pinned versions from `requirements.txt`, so a final post-build Railway smoke test is still required.

### Production-environment simulation

- Production startup without `TRACKR_SECRET_KEY` fails as intended.
- A secret shorter than 32 characters is rejected.
- An empty mounted volume receives a copy of the seed database.
- `/health` returns success against the volume database.
- Secure cookies, HSTS and the Content Security Policy are enabled in production mode.

## Deployment constraints that remain

TrackR still stores its workspace as one JSON record inside SQLite. That is suitable for this small internal deployment only when Railway runs:

- one TrackR service,
- one replica,
- one Gunicorn worker,
- one persistent volume.

Do not horizontally scale this build. If TrackR later needs multiple simultaneous sites, replicas, high write concurrency or detailed database reporting, migrate the workspace to normalized relational tables in PostgreSQL.

The current Content Security Policy permits inline scripts and styles because the interface is still a single-file application. This is safer than having no policy, but moving the JavaScript and CSS into static files would allow a stricter policy in a future cleanup.

## Before making the Railway domain public

1. Attach a persistent volume at `/data`.
2. Set a long random `TRACKR_SECRET_KEY`.
3. Confirm one replica and the packaged one-worker start command.
4. Deploy and confirm `/health` passes.
5. Sign in with the separate temporary credentials and change both passwords.
6. Create one test job, redeploy once and confirm it persists.
7. Download a database backup from User Admin and store it safely.
