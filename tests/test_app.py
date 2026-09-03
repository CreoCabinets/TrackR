from __future__ import annotations

import copy
import json
import os
import re
import sqlite3
import tempfile
import unittest
import sys
from io import BytesIO
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Set deterministic local-test bootstrap values before importing app.py, which
# initializes its selected SQLite database at module import time.
_BOOT_DIR = tempfile.TemporaryDirectory()
os.environ.pop("RAILWAY_ENVIRONMENT", None)
os.environ.pop("RAILWAY_VOLUME_MOUNT_PATH", None)
os.environ["TRACKR_DB_PATH"] = str(Path(_BOOT_DIR.name) / "bootstrap.sqlite3")
os.environ["TRACKR_SECRET_KEY"] = "test-secret-" + ("x" * 48)
os.environ["TRACKR_BOOTSTRAP_ADMIN_USERNAME"] = "admin"
os.environ["TRACKR_BOOTSTRAP_ADMIN_PASSWORD"] = "temporary-admin-password"
os.environ.pop("TRACKR_BOOTSTRAP_FACTORY_USERNAME", None)
os.environ.pop("TRACKR_BOOTSTRAP_FACTORY_PASSWORD", None)

import app as trackr  # noqa: E402


class TrackRAppTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        trackr.DB_PATH = Path(self.tmp.name) / "trackr.sqlite3"
        trackr._login_attempts.clear()
        trackr.init_db()
        conn = trackr.get_db()
        conn.execute("UPDATE users SET must_change_password = 0 WHERE username = 'admin'")
        conn.commit()
        conn.close()
        trackr.app.config.update(TESTING=True)
        self.client = trackr.app.test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def _csrf_from_html(self, html: str) -> str:
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        self.assertIsNotNone(match)
        return match.group(1)

    def login_admin(self):
        response = self.client.get("/login")
        csrf = self._csrf_from_html(response.get_data(as_text=True))
        response = self.client.post(
            "/login",
            data={"username": "admin", "password": "temporary-admin-password", "csrf_token": csrf},
            follow_redirects=False,
        )
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as sess:
            return sess["csrf_token"]

    def test_health_is_lightweight_and_integrity_is_separate(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])

        csrf = self.login_admin()
        response = self.client.get("/api/database-integrity", headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["result"], "ok")

    def test_csrf_blocks_state_change(self):
        self.login_admin()
        response = self.client.post("/api/state", json={})
        self.assertEqual(response.status_code, 400)
        self.assertIn("Security token", response.get_json()["error"])

    def test_state_normalises_text_and_custom_task_can_be_standalone(self):
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        state["jobs"] = [{
            "id": " J123 ",
            "address": " 1 Test Street ",
            "builder": " Builder ",
            "notes": " note ",
            "status": "Active",
            "labourHours": {},
            "excludedStages": [],
        }]
        state["tasks"] = [{
            "id": "custom-1",
            "job": " quick fix ",
            "name": " Touch up ",
            "type": "capacity",
            "department": " Cabinet Making ",
            "duration": 60,
            "assigned": [],
            "assignmentMinutes": {},
            "assignmentDates": {},
            "scheduleOrder": {},
            "status": "Planned",
            "notes": " note ",
            "custom": True,
        }]
        validated = trackr.validate_state(state)
        self.assertEqual(validated["jobs"][0]["id"], "J123")
        self.assertEqual(validated["jobs"][0]["address"], "1 Test Street")
        self.assertEqual(validated["tasks"][0]["job"], "quick fix")
        self.assertEqual(validated["tasks"][0]["department"], "Cabinet Making")

    def test_generated_task_requires_existing_job(self):
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        state["tasks"] = [{
            "id": "generated-1",
            "job": "J404",
            "name": "Machining",
            "type": "capacity",
            "department": "Machining",
            "duration": 60,
            "assigned": [],
            "assignmentMinutes": {},
            "assignmentDates": {},
            "scheduleOrder": {},
            "status": "Planned",
            "custom": False,
        }]
        with self.assertRaisesRegex(ValueError, "missing job"):
            trackr.validate_state(state)

    def test_revision_conflict_returns_409(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        first_revision = state["_revision"]
        response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)

        state["_revision"] = first_revision
        response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.get_json()["conflict"])

    def test_read_only_user_cannot_write_workspace(self):
        conn = trackr.get_db()
        conn.execute(
            "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'user', 0)",
            ("factory", trackr.generate_password_hash("temporary-factory-password")),
        )
        conn.commit()
        conn.close()
        user_client = trackr.app.test_client()
        csrf = self._csrf_from_html(user_client.get("/login").get_data(as_text=True))
        response = user_client.post(
            "/login",
            data={"username": "factory", "password": "temporary-factory-password", "csrf_token": csrf},
        )
        self.assertEqual(response.status_code, 302)
        with user_client.session_transaction() as sess:
            csrf = sess["csrf_token"]
        state = user_client.get("/api/state").get_json()
        response = user_client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 403)

    def test_ip_rate_limit_survives_username_cycling(self):
        # Avoid expensive password hashing in this focused limiter unit test.
        original_now = trackr.time.time
        try:
            trackr._login_attempts.clear()
            with trackr.app.test_request_context("/login", environ_base={"REMOTE_ADDR": "203.0.113.10"}):
                for index in range(trackr.LOGIN_IP_MAX_FAILURES):
                    trackr.record_login_failure(trackr.login_keys(f"user{index}"))
                self.assertTrue(trackr.is_login_limited(trackr.login_keys("another-user")))
        finally:
            trackr.time.time = original_now

    def test_production_bootstrap_requires_admin_password_for_empty_db(self):
        previous_production = trackr.IS_PRODUCTION
        previous_password = os.environ.get("TRACKR_BOOTSTRAP_ADMIN_PASSWORD")
        previous_path = trackr.DB_PATH
        fresh_path = Path(self.tmp.name) / "production-empty.sqlite3"
        try:
            trackr.IS_PRODUCTION = True
            trackr.DB_PATH = fresh_path
            os.environ.pop("TRACKR_BOOTSTRAP_ADMIN_PASSWORD", None)
            with self.assertRaisesRegex(RuntimeError, "TRACKR_BOOTSTRAP_ADMIN_PASSWORD is required"):
                trackr.init_db()
            os.environ["TRACKR_BOOTSTRAP_ADMIN_PASSWORD"] = "temporary-production-password"
            trackr.init_db()
            conn = trackr.get_db()
            count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
            conn.close()
            self.assertEqual(count, 1)
        finally:
            trackr.IS_PRODUCTION = previous_production
            trackr.DB_PATH = previous_path
            if previous_password is None:
                os.environ.pop("TRACKR_BOOTSTRAP_ADMIN_PASSWORD", None)
            else:
                os.environ["TRACKR_BOOTSTRAP_ADMIN_PASSWORD"] = previous_password

    def test_railway_volume_wins_over_trackr_db_path(self):
        previous_volume = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
        previous_explicit = os.environ.get("TRACKR_DB_PATH")
        try:
            os.environ["RAILWAY_VOLUME_MOUNT_PATH"] = "/data"
            os.environ["TRACKR_DB_PATH"] = "./wrong.sqlite3"
            self.assertEqual(trackr.resolve_db_path(), Path("/data/trackr.sqlite3").resolve())
        finally:
            if previous_volume is None:
                os.environ.pop("RAILWAY_VOLUME_MOUNT_PATH", None)
            else:
                os.environ["RAILWAY_VOLUME_MOUNT_PATH"] = previous_volume
            if previous_explicit is None:
                os.environ.pop("TRACKR_DB_PATH", None)
            else:
                os.environ["TRACKR_DB_PATH"] = previous_explicit


    def test_backup_download_returns_sqlite_file(self):
        self.login_admin()
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data.startswith(b"SQLite format 3\x00"))
        self.assertIn("attachment", response.headers.get("Content-Disposition", "").lower())

    def test_pdf_import_endpoint_returns_extracted_payload(self):
        csrf = self.login_admin()
        expected = {"quote_no": "J123", "quote_name": "Test Job", "drafting_total_hours": 4}
        with mock.patch.object(trackr, "parse_estimate_pdf", return_value=expected):
            response = self.client.post(
                "/api/import-estimate",
                data={"estimate_pdf": (BytesIO(b"%PDF-1.4 test"), "estimate.pdf", "application/pdf")},
                headers={"X-CSRF-Token": csrf},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["extracted"], expected)

    def test_corrupt_state_is_backed_up_and_not_replaced(self):
        corrupt_path = Path(self.tmp.name) / "corrupt.sqlite3"
        conn = sqlite3.connect(corrupt_path)
        conn.execute(
            "CREATE TABLE app_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT)"
        )
        conn.execute("INSERT INTO app_state (id, state_json, revision, updated_at) VALUES (1, ?, 1, 'now')", ("{broken-json",))
        conn.commit()
        conn.close()

        trackr.DB_PATH = corrupt_path
        with self.assertRaisesRegex(RuntimeError, "corrupt"):
            trackr.init_db()

        conn = sqlite3.connect(corrupt_path)
        stored = conn.execute("SELECT state_json FROM app_state WHERE id = 1").fetchone()[0]
        conn.close()
        self.assertEqual(stored, "{broken-json")
        backups = list((corrupt_path.parent / "backups").glob("trackr-*-corrupt-state.sqlite3"))
        self.assertTrue(backups)


if __name__ == "__main__":
    unittest.main()
