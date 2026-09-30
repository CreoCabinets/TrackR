# TrackR

TrackR is a Flask + SQLite production scheduling application for a single internal team. The current deployment model is intentionally one Railway service, one replica, one Gunicorn worker and one persistent volume.

## Local setup

PowerShell example:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:TRACKR_SECRET_KEY = "local-development-secret-change-me"
$env:TRACKR_DB_PATH = ".\flow.sqlite3"
$env:TRACKR_BOOTSTRAP_ADMIN_USERNAME = "admin"
$env:TRACKR_BOOTSTRAP_ADMIN_PASSWORD = "temporary-local-password"
python app.py
```

Open `http://127.0.0.1:5050`.

TrackR does not auto-load `.env` files. `.env.example` is a reference for values that must be exported by your shell/IDE or configured in Railway.

If the selected local database has no users, TrackR creates the bootstrap admin. If no local bootstrap password was supplied, TrackR generates one and writes it to the application log. Bootstrap accounts are forced to change their temporary password after first sign-in.

## Railway deployment

TrackR is configured through `railway.toml` and runs with one Gunicorn worker and four threads. One worker/one replica is intentional because the workspace is stored in a single SQLite database.

Before making the service public:

1. Attach a Railway persistent volume mounted at `/data`.
2. Set `TRACKR_SECRET_KEY` to a long random value of at least 32 characters.
3. Set `TRACKR_BOOTSTRAP_ADMIN_USERNAME` and `TRACKR_BOOTSTRAP_ADMIN_PASSWORD` for a brand-new database.
4. Optionally set both `TRACKR_BOOTSTRAP_FACTORY_USERNAME` and `TRACKR_BOOTSTRAP_FACTORY_PASSWORD` to create the first read-only account.
5. TrackR ignores `TRACKR_DB_PATH` on Railway and always uses `<RAILWAY_VOLUME_MOUNT_PATH>/trackr.sqlite3`. Remove `TRACKR_DB_PATH` from Railway variables when convenient to avoid confusion. The volume mount path must be non-empty, absolute and point to an existing directory; TrackR refuses to start otherwise.
6. Keep the service at exactly one replica.
7. Deploy and confirm `/health` passes.
8. Sign in with each bootstrap account and change its temporary password.
9. Create a test job, redeploy once, and confirm the test job still exists.
10. Download an admin backup and store a copy outside Railway.

A new empty Railway volume creates a fresh TrackR database from the application's current default workspace state. A SQLite database is no longer copied from the Git repository as a deployment seed.

## Calendar and scheduling behaviour

- Capacity tasks can optionally appear on Calendar while still consuming Schedule capacity.
- Milestones are Calendar-only and never consume production capacity.
- Unassigned capacity tasks are valid and remain visible in Schedule's **Unassigned** row until an employee is selected.
- Factory Closure, Public Holiday and Company Event entries are company-wide non-production days. Generated workflow dates skip them as well as weekends.

### Single-day absence override

Click an employee's RDO, Away, Holiday or Sick day in Schedule and choose **Work this day** in the existing day panel. The original absence and its full date range remain unchanged. Only the selected employee/date regains its normal rostered capacity, and tasks recalculate and spill forward as usual. The panel shows the original status/range and the active override; **Restore Holiday** (or the applicable status) removes the override. Read-only users can open the panel and see these details but cannot change them.

For an absence record, the override uses the employee's standard or repeating two-week roster for that exact date. This behaviour is unchanged, including zero hours if the absence falls on a rostered day off.

Roster-generated RDOs and days off without a `dayStatuses` record also offer **Work this day**. For a custom roster, TrackR first uses positive hours for the same weekday in the other roster week, then positive same-weekday hours in the standard/base week. If neither supplies hours, it uses the existing `defaultDailyCapacity(person)` rule: the largest positive daily hours across the stored weeks, or 7h40 if none exist. Thus an alternate Friday off becomes 5h40 when the employee's working Friday is 5h40, even if other weekdays are 7h40. The panel previews the hours before activation; there is no manual hours field.

Roster work is stored in the employee's existing per-date `capacityOverrides` map, leaving all roster patterns unchanged. **Restore RDO** deletes that date's capacity override and returns it to zero hours. A positive per-date capacity already entered through Overtime on a rostered day off is also shown as working, and Restore RDO clears it. Company-wide Factory Closure, Public Holiday and Company Event days always block usable capacity, including when either kind of work override or overtime exists.

Workspace version 10 stores absence-record overrides separately in `absenceOverrides`, including snapshots of every absence covering that employee/date. Changed, removed or newly overlapping absences invalidate the override; stale entries are ignored and pruned during save/load validation. Employee renames preserve the link, and employee removal clears it. Existing workspaces without this optional collection load with no absence-record overrides. Saves use the normal admin/CSRF/revision checks and rollback/conflict recovery. Refresh already-open browser tabs after deploying this version.

## Backups and recovery

Admins can download a consistent SQLite backup from **Settings → User Admin → Download backup**. TrackR also keeps up to 10 rolling automatic backups beside the live database, with normal automatic backups throttled to avoid excessive copies.

Backups beside the live database protect against bad saves/migrations but are on the same Railway volume. They are **not** sufficient protection against complete volume loss. Keep downloaded copies outside Railway.

Before schema maintenance, startup validates the required `app_state` table, row, JSON object, and workspace contents. A readable database gets a standalone SQLite recovery backup before any schema or state migration. A missing state table or row, non-object or invalid state, or an existing empty database fails closed; TrackR will not create defaults or repair that database. Restore a known-good backup instead. If SQLite cannot read the database well enough to create a consistent backup, TrackR preserves a clearly labeled raw database copy and any available SQLite sidecars for recovery.

Admins can run the deliberate deep SQLite check at `GET /api/database-integrity`. Railway's `/health` endpoint checks that the workspace database and required `app_state` contents are available and valid, without running the deep integrity check.

## Important files

- `app.py` — Flask application, API, validation, SQLite handling and PDF import
- `templates/index.html` — main TrackR page structure
- `static/css/trackr.css` — main TrackR styles
- `static/js/` — frontend state, jobs, calendar, schedule, task, settings and startup modules
- `templates/login.html` — login page
- `templates/change_password.html` — forced/manual password-change page
- `railway.toml` — production start command and healthcheck
- `.env.example` — environment-variable reference
- `DEPLOYMENT_CHECKLIST.md` — production deployment checklist
- `tests/` — current regression tests

## Checks before pushing

```powershell
python -m py_compile app.py
python -m unittest discover -s tests -p "test_*.py"
node tests\frontend_logic_test.js
```

The Python test suite requires the pinned dependencies from `requirements.txt` to be installed first.
