# TrackR

TrackR is a Flask and SQLite production scheduling application.

## Local setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5050`.

## Railway deployment

TrackR is configured for Railway through `railway.toml` and runs with one Gunicorn worker. One worker is intentional because the application uses a single SQLite database.

Before making the service public:

1. Add a Railway persistent volume and mount it at `/data`.
2. Set `TRACKR_SECRET_KEY` to a long random value.
3. Keep the service at one replica.
4. Deploy the repository or upload the project through your normal Railway workflow.
5. Sign in with the temporary credentials supplied separately and change both passwords immediately.

When Railway exposes `RAILWAY_VOLUME_MOUNT_PATH`, TrackR stores the live database at `<mount>/trackr.sqlite3`. On the first deployment to an empty volume, the bundled `flow.sqlite3` is copied there automatically.

## Important files

- `app.py` — web application and API
- `templates/` — user interface
- `flow.sqlite3` — seed database copied to a new Railway volume
- `railway.toml` — production start command and healthcheck
- `/health` — deployment health endpoint

## Backups

Admins can download a consistent SQLite backup from **Settings → User Admin → Download backup**. TrackR also keeps rolling automatic backups beside the live database.
