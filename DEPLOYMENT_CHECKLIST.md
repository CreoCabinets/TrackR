# TrackR Railway deployment checklist

## First deployment / new volume

- [ ] Create or select the Railway service for this TrackR repository.
- [ ] Attach one persistent volume mounted at `/data`.
- [ ] Set a long random `TRACKR_SECRET_KEY` (minimum 32 characters).
- [ ] Set `TRACKR_BOOTSTRAP_ADMIN_USERNAME` and a temporary `TRACKR_BOOTSTRAP_ADMIN_PASSWORD` (12–200 characters).
- [ ] If a first read-only account is wanted, set both `TRACKR_BOOTSTRAP_FACTORY_USERNAME` and `TRACKR_BOOTSTRAP_FACTORY_PASSWORD`.
- [ ] Confirm `TRACKR_DB_PATH` is **not** set on Railway. The live DB must resolve to `<RAILWAY_VOLUME_MOUNT_PATH>/trackr.sqlite3`.
- [ ] Confirm the service has exactly one replica.
- [ ] Confirm `railway.toml` launches the packaged one-worker Gunicorn command.
- [ ] Deploy and confirm the `/health` check passes.
- [ ] Generate/confirm the Railway public domain.
- [ ] Sign in with the bootstrap admin and change the temporary password.
- [ ] If a factory/read-only bootstrap account was created, sign in and change that temporary password too.
- [ ] Create a test job and verify Jobs, Calendar and Schedule.
- [ ] Redeploy once and verify the test job still exists. This confirms the DB is on the persistent volume.
- [ ] From an admin session, run `/api/database-integrity` and confirm the result is `ok`.
- [ ] Download an admin database backup and store it **outside Railway**.

## Normal release

- [ ] Run `python -m py_compile app.py`.
- [ ] Run `python -m unittest discover -s tests -p "test_*.py"` with the pinned dependencies installed.
- [ ] Run `node tests/frontend_logic_test.js`.
- [ ] Deploy with one replica / one Gunicorn worker.
- [ ] Confirm `/health` passes after deployment.
- [ ] Smoke-test login, Jobs, Calendar, Schedule and a normal save.
- [ ] Download an off-Railway backup after any migration/recovery-sensitive release.

## Periodic recovery check

- [ ] Keep at least one recent downloaded backup outside Railway.
- [ ] Periodically verify a downloaded backup opens and passes `PRAGMA quick_check` in a safe test environment.
