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
5. Do **not** set `TRACKR_DB_PATH` on Railway. When `RAILWAY_VOLUME_MOUNT_PATH` is present, TrackR always uses `<mount>/trackr.sqlite3`.
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

## Backups and recovery

Admins can download a consistent SQLite backup from **Settings → User Admin → Download backup**. TrackR also keeps up to 10 rolling automatic backups beside the live database, with normal automatic backups throttled to avoid excessive copies.

Backups beside the live database protect against bad saves/migrations but are on the same Railway volume. They are **not** sufficient protection against complete volume loss. Keep downloaded copies outside Railway.

If stored workspace JSON is corrupt or fails semantic validation at startup, TrackR creates a recovery backup and refuses to replace the damaged operational state with default data. Restore a known-good backup instead.

Admins can run the deliberate deep SQLite check at `GET /api/database-integrity`. Railway's `/health` endpoint is intentionally lightweight and only checks that the workspace database is available.

## Important files

- `app.py` — Flask application, API, validation, SQLite handling and PDF import
- `templates/index.html` — main TrackR interface and scheduling logic
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
