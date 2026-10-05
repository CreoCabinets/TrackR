from __future__ import annotations

import copy
import json
import os
import re
import sqlite3
import subprocess
import tempfile
import threading
import unittest
import sys
from datetime import datetime
from io import BytesIO
from unittest import mock
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# Set deterministic local-test bootstrap values before importing app.py, which
# initializes its selected SQLite database at module import time.
_BOOT_DIR = tempfile.TemporaryDirectory()
RAILWAY_ENV_MARKERS = (
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_PUBLIC_DOMAIN",
    "RAILWAY_PRIVATE_DOMAIN",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
    "RAILWAY_TCP_APPLICATION_PORT",
    "RAILWAY_PROJECT_NAME",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_ENVIRONMENT_ID",
    "RAILWAY_SERVICE_NAME",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_REPLICA_ID",
    "RAILWAY_REPLICA_REGION",
    "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_SNAPSHOT_ID",
    "RAILWAY_VOLUME_NAME",
    "RAILWAY_VOLUME_MOUNT_PATH",
)
for _railway_marker in RAILWAY_ENV_MARKERS:
    os.environ.pop(_railway_marker, None)
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

    def _insert_admin(self, username):
        conn = trackr.get_db()
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, role, session_version, must_change_password) VALUES (?, ?, 'admin', 1, 0)",
            (username, trackr.generate_password_hash("temporary-admin-password")),
        )
        conn.commit()
        user_id = cursor.lastrowid
        conn.close()
        return user_id

    def _admin_client(self, user_id):
        client = trackr.app.test_client()
        token = f"csrf-{user_id}-token"
        with client.session_transaction() as sess:
            sess.update(user_id=user_id, session_version=1, csrf_token=token)
        return client, token

    def _admin_count(self):
        conn = trackr.get_db()
        count = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]
        conn.close()
        return count

    def test_user_delete_last_admin_is_rejected(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        admin_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        response = self.client.delete(f"/api/users/{admin_id}", headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._admin_count(), 1)

    def test_user_demote_last_admin_is_rejected(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        admin_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        response = self.client.patch(f"/api/users/{admin_id}", json={"role": "user"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._admin_count(), 1)

    def test_combined_last_admin_demotion_and_password_reset_rolls_back(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        admin = conn.execute("SELECT id, password_hash, session_version FROM users WHERE username='admin'").fetchone()
        conn.close()
        response = self.client.patch(
            f"/api/users/{admin['id']}",
            json={"role": "user", "password": "replacement-temporary-password"},
            headers={"X-CSRF-Token": csrf},
        )
        self.assertEqual(response.status_code, 400)
        conn = trackr.get_db()
        saved = conn.execute("SELECT role, password_hash, session_version, must_change_password FROM users WHERE id=?", (admin["id"],)).fetchone()
        conn.close()
        self.assertEqual(tuple(saved), ("admin", admin["password_hash"], admin["session_version"], 0))

    def test_self_demotion_succeeds_with_another_admin_and_clears_session(self):
        second_admin = self._insert_admin("secondadmin")
        csrf = self.login_admin()
        conn = trackr.get_db()
        admin_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        response = self.client.patch(f"/api/users/{admin_id}", json={"role": "user"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        with self.client.session_transaction() as sess:
            self.assertNotIn("user_id", sess)
        conn = trackr.get_db()
        demoted = conn.execute("SELECT role, session_version FROM users WHERE id=?", (admin_id,)).fetchone()
        conn.close()
        self.assertEqual(tuple(demoted), ("user", 2))
        self.assertEqual(self._admin_count(), 1)
        self.assertIsNotNone(second_admin)

    def test_role_change_increments_session_version(self):
        self._insert_admin("secondadmin")
        csrf = self.login_admin()
        conn = trackr.get_db()
        target = conn.execute("SELECT id FROM users WHERE username='secondadmin'").fetchone()[0]
        conn.close()
        response = self.client.patch(f"/api/users/{target}", json={"role": "user"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        conn = trackr.get_db()
        row = conn.execute("SELECT role, session_version FROM users WHERE id=?", (target,)).fetchone()
        conn.close()
        self.assertEqual(tuple(row), ("user", 2))

    def test_password_reset_increments_version_and_requires_change_for_other_user(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        target = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        response = self.client.patch(f"/api/users/{target}", json={"password": "replacement-temporary-password"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        conn = trackr.get_db()
        row = conn.execute("SELECT session_version, must_change_password FROM users WHERE id=?", (target,)).fetchone()
        conn.close()
        self.assertEqual(tuple(row), (2, 0))

    def test_password_reset_for_other_user_forces_password_change(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        cursor = conn.execute("INSERT INTO users (username,password_hash,role,session_version,must_change_password) VALUES ('worker', 'unused', 'user', 1, 0)")
        target = cursor.lastrowid
        conn.commit()
        conn.close()
        response = self.client.patch(f"/api/users/{target}", json={"password": "replacement-temporary-password"}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        conn = trackr.get_db()
        row = conn.execute("SELECT session_version, must_change_password FROM users WHERE id=?", (target,)).fetchone()
        conn.close()
        self.assertEqual(tuple(row), (2, 1))

    def test_delete_admin_with_another_admin_is_allowed(self):
        second_admin = self._insert_admin("secondadmin")
        csrf = self.login_admin()
        response = self.client.delete(f"/api/users/{second_admin}", headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._admin_count(), 1)

    def test_self_delete_remains_rejected(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        admin_id = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        response = self.client.delete(f"/api/users/{admin_id}", headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self._admin_count(), 1)

    def _race_admin_reductions(self, operation_a, operation_b=None):
        operation_b = operation_b or operation_a
        conn = trackr.get_db()
        admin_a = conn.execute("SELECT id FROM users WHERE username='admin'").fetchone()[0]
        conn.close()
        admin_b = self._insert_admin("raceadminb")
        client_a, csrf_a = self._admin_client(admin_a)
        client_b, csrf_b = self._admin_client(admin_b)
        begin_barrier = threading.Barrier(2)
        begin_calls = []
        begin_lock = threading.Lock()
        responses = []
        errors = []

        class BeginBarrierConnection:
            def __init__(self, connection):
                self.connection = connection

            def execute(self, sql, *args, **kwargs):
                if sql.strip().upper() == "BEGIN IMMEDIATE":
                    with begin_lock:
                        begin_calls.append(threading.current_thread().name)
                    begin_barrier.wait(timeout=10)
                return self.connection.execute(sql, *args, **kwargs)

            def __getattr__(self, name):
                return getattr(self.connection, name)

        real_get_db = trackr.get_db

        def synchronized_get_db():
            return BeginBarrierConnection(real_get_db())

        def request(client, csrf, target_id, operation):
            try:
                if operation == "delete":
                    response = client.delete(f"/api/users/{target_id}", headers={"X-CSRF-Token": csrf})
                else:
                    response = client.patch(f"/api/users/{target_id}", json={"role": "user"}, headers={"X-CSRF-Token": csrf})
                responses.append((response.status_code, response.get_json()))
            except Exception as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=request, name="admin-reduction-a", args=(client_a, csrf_a, admin_b, operation_a)),
            threading.Thread(target=request, name="admin-reduction-b", args=(client_b, csrf_b, admin_a, operation_b)),
        ]
        with mock.patch.object(trackr, "get_db", side_effect=synchronized_get_db):
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(begin_calls), 2)
        self.assertEqual(len(responses), 2)
        self.assertEqual(sorted(status for status, _ in responses), [200, 400])
        rejected = next(body for status, body in responses if status == 400)
        self.assertIn("at least one admin", rejected["error"])
        self.assertEqual(self._admin_count(), 1)

    def test_concurrent_admin_deletes_leave_one_admin(self):
        self._race_admin_reductions("delete")

    def test_concurrent_admin_demotions_leave_one_admin(self):
        self._race_admin_reductions("demote")

    def test_concurrent_admin_delete_and_demotion_leave_one_admin(self):
        self._race_admin_reductions("delete", "demote")

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

    def test_iso_date_requires_exact_ascii_calendar_date(self):
        for value in ("2026-09-14", "0001-01-01", "2000-02-29"):
            with self.subTest(value=value):
                self.assertTrue(trackr.valid_iso_date(value))
        for value in (
            "20260914", "2026-W38-1", "2026-9-14", "2026-09-4",
            "2026-09-14T00:00:00", "2026-02-29", "1900-02-29",
            "2026-13-01", "2026-00-01", "2026-09-31", "0000-01-01",
            "２０２６-09-14", "٢٠٢٦-09-14", "2026-09-14\n", None, 20260914,
        ):
            with self.subTest(value=value):
                self.assertFalse(trackr.valid_iso_date(value))

    def test_workspace_rejects_nonfinite_numbers_without_database_change(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        conn = trackr.get_db()
        before = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
        before = (before["state_json"], before["revision"])
        conn.close()
        for token in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(token=token):
                invalid = copy.deepcopy(state)
                invalid["opaqueFutureField"] = {"nested": [token]}
                response = self.client.post("/api/state", json=invalid, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                conn = trackr.get_db()
                after = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
                conn.close()
                self.assertEqual((after["state_json"], after["revision"]), before)
                def reject_constant(value):
                    raise AssertionError(f"nonstandard numeric token persisted: {value}")
                json.loads(after["state_json"], parse_constant=reject_constant)

    def test_require_number_rejects_nonfinite_values(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    trackr.require_number(value, "test value")

    def test_numeric_overflow_returns_validation_error_without_database_change(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        conn = trackr.get_db()
        before = tuple(conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone())
        conn.close()
        cases = (
            ("numeric field", lambda payload: payload["people"][0]["week"].update(Mon=10 ** 1000)),
            ("positive infinite revision", lambda payload: payload.update(_revision=float("inf"))),
            ("negative infinite revision", lambda payload: payload.update(_revision=float("-inf"))),
        )
        for label, corrupt in cases:
            with self.subTest(field=label):
                payload = copy.deepcopy(state)
                corrupt(payload)
                response = self.client.post("/api/state", json=payload, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                conn = trackr.get_db()
                after = tuple(conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone())
                conn.close()
                self.assertEqual(after, before)

    def test_invalid_persisted_revision_returns_controlled_error_without_write(self):
        self.login_admin()
        conn = trackr.get_db()
        conn.execute("UPDATE app_state SET revision=? WHERE id=1", (float("inf"),))
        conn.commit()
        before = tuple(conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone())
        conn.close()
        self.assertEqual(self.client.get("/api/state").status_code, 500)
        self.assertEqual(self.client.get("/health").status_code, 503)
        conn = trackr.get_db()
        after = tuple(conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone())
        conn.close()
        self.assertEqual(after, before)

    def test_api_rejects_malformed_membership_fields_without_database_change(self):
        csrf = self.login_admin()
        base_state = self.client.get("/api/state").get_json()
        conn = trackr.get_db()
        row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
        original = (row["state_json"], row["revision"])
        conn.close()
        cases = (
            ("people", lambda state: state["people"][0].update(role=[])),
            ("workPattern", lambda state: state["people"][0].update(workPattern={})),
            ("task type", lambda state: state["tasks"].append({"id": "custom-t", "job": "Job", "name": "Task", "type": [], "custom": True, "assigned": []})),
            ("assigned element", lambda state: state["tasks"].append({"id": "custom-t", "job": "Job", "name": "Task", "type": "capacity", "custom": True, "assigned": [{}]})),
            ("day status type", lambda state: state["dayStatuses"].append({"person": "Lewis", "type": [], "startDate": "2026-09-14"})),
            ("calendar event type", lambda state: state["calendarEvents"].append({"id": "event-1", "name": "Event", "type": {}, "startDate": "2026-09-14"})),
        )
        for label, corrupt in cases:
            with self.subTest(field=label):
                state = copy.deepcopy(base_state)
                corrupt(state)
                response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                conn = trackr.get_db()
                row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
                conn.close()
                self.assertEqual((row["state_json"], row["revision"]), original)

    def test_user_create_and_patch_reject_nonstring_roles(self):
        csrf = self.login_admin()
        for role in ([], {}, None, 7):
            with self.subTest(role=role):
                response = self.client.post("/api/users", json={
                    "username": "bad-role-user", "password": "temporary-password-123", "role": role,
                }, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["error"], "Invalid role.")
        user_id = self._insert_admin("role-target")
        conn = trackr.get_db()
        before = conn.execute("SELECT role, session_version FROM users WHERE id=?", (user_id,)).fetchone()
        before = tuple(before)
        conn.close()
        for role in ([], {}, None, 7):
            with self.subTest(patch_role=role):
                response = self.client.patch(f"/api/users/{user_id}", json={"role": role}, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()["error"], "Invalid role.")
        conn = trackr.get_db()
        after = conn.execute("SELECT role, session_version FROM users WHERE id=?", (user_id,)).fetchone()
        conn.close()
        self.assertEqual(tuple(after), before)

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

    def _frontend_split_drag(self, state, *actions):
        result = subprocess.run(
            ["node", str(ROOT / "tests" / "frontend_logic_test.js"), "--emit-split-state", *actions],
            input=json.dumps(state), capture_output=True, text=True, cwd=ROOT, check=True,
        )
        return json.loads(result.stdout.strip().splitlines()[-1])

    def test_split_unassigned_real_frontend_save_reload(self):
        csrf = self.login_admin()
        for custom, minutes in ((True, 360), (False, 360), (True, 120), (True, 0)):
            with self.subTest(custom=custom, duration=minutes):
                state = self.client.get("/api/state").get_json()
                state["people"] = [{"name": name, "role": "Cabinet Making", "week": {day: 480 for day in ("Mon", "Tue", "Wed", "Thu", "Fri")}} for name in ("Ben", "Luke")]
                state["jobs"] = [{"id": "J1", "address": "Test", "status": "Active", "labourHours": {}, "excludedStages": []}]
                assigned = ["Ben", "Luke"] if minutes == 360 else ["Ben"]
                state["tasks"] = [{
                    "id": "split-e2e", "job": "J1", "name": "Assembly", "type": "capacity",
                    "custom": custom, "department": "Cabinet Making", "date": "2026-09-14",
                    "duration": minutes, "assigned": assigned,
                    "assignmentMinutes": {"Ben": 120, "Luke": 240} if minutes == 360 else {"Ben": minutes},
                    "assignmentDates": {name: "2026-09-14" for name in assigned},
                    "scheduleOrder": {name: index + 5 for index, name in enumerate(assigned)},
                    "status": "Planned",
                }]
                payload = self._frontend_split_drag(state)
                task = payload["tasks"][0]
                self.assertEqual(task["duration"], minutes)
                self.assertEqual(task["unassignedMinutes"], 120 if minutes else 0)
                self.assertEqual(task["assigned"], ["Luke"] if minutes == 360 else [])
                for key in ("assignmentMinutes", "assignmentDates", "scheduleOrder"):
                    self.assertNotIn("Ben", task[key])
                if minutes == 360:
                    self.assertEqual(task["assignmentMinutes"], {"Luke": 240})
                trackr.validate_state(payload)
                response = self.client.post("/api/state", json=payload, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 200, response.get_json())
                trackr.init_db()
                loaded = self.client.get("/api/state").get_json()
                self.assertEqual(loaded["tasks"][0], trackr.validate_state(payload)["tasks"][0])
                reassigned = self._frontend_split_drag(loaded, "--residual-to-employee")
                self.assertEqual(reassigned["tasks"][0]["duration"], minutes)
                self.assertEqual(sum(reassigned["tasks"][0]["assignmentMinutes"].values()), minutes)
                self.assertEqual(reassigned["tasks"][0]["unassignedMinutes"], 0)
                response = self.client.post("/api/state", json=reassigned, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 200, response.get_json())
                self.assertEqual(self.client.get("/api/state").get_json()["tasks"][0], trackr.validate_state(reassigned)["tasks"][0])

    def test_unassigned_explicit_balance_validation_and_legacy_compatibility(self):
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        task = {"id": "old-task", "job": "Test", "name": "Assembly", "custom": True,
                "type": "capacity", "date": "2026-09-14", "duration": 360,
                "assigned": ["Lewis"], "assignmentMinutes": {"Lewis": 360}}
        state["tasks"] = [task]
        self.assertNotIn("unassignedMinutes", trackr.validate_state(state)["tasks"][0])
        task["assigned"] = []
        task["assignmentMinutes"] = {}
        self.assertNotIn("unassignedMinutes", trackr.validate_state(state)["tasks"][0])
        for change in (
            {"unassignedMinutes": -1}, {"unassignedMinutes": 361}, {"unassignedMinutes": 120},
            {"unassignedMinutes": float("nan")}, {"unassignedMinutes": float("inf")},
            {"unassignedMinutes": 360, "unassignedDate": "2026-9-14"},
            {"unassignedDate": "2026-09-14"}, {"unassignedMinutes": 360, "type": "milestone"},
            {"unassignedMinutes": 120, "assigned": ["Lewis"], "assignmentMinutes": {}},
        ):
            with self.subTest(change=change):
                bad = copy.deepcopy(state)
                bad["tasks"][0].update(change)
                with self.assertRaises(ValueError):
                    trackr.validate_state(bad)

    def test_legacy_unassigned_drag_adds_coherent_prospective_balance(self):
        csrf = self.login_admin()
        for minutes in (120, 0):
            with self.subTest(minutes=minutes):
                state = self.client.get("/api/state").get_json()
                state["tasks"] = [{"id": "legacy-unassigned", "custom": True, "job": "Test", "name": "Assembly",
                                   "type": "capacity", "date": "2026-09-14", "duration": minutes, "assigned": []}]
                payload = self._frontend_split_drag(state, "--move-unassigned")
                self.assertEqual(payload["tasks"][0]["unassignedMinutes"], minutes)
                if not minutes:
                    self.assertNotIn("unassignedDate", payload["tasks"][0])
                response = self.client.post("/api/state", json=payload, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 200, response.get_json())

    def test_home_capacity_opt_out_keeps_schedule_assignments_and_persists(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        employee = next(person for person in state["people"] if person["name"] == "Lewis")
        employee["countsCapacity"] = False
        state["tasks"] = [{
            "id": "custom-home-opt-out",
            "job": "Schedule work",
            "name": "Assembly",
            "type": "capacity",
            "department": "Cabinet Making",
            "date": "2026-09-14",
            "duration": 120,
            "assigned": ["Lewis"],
            "assignmentMinutes": {"Lewis": 120},
            "assignmentDates": {"Lewis": "2026-09-14"},
            "scheduleOrder": {"Lewis": 1},
            "status": "Planned",
            "custom": True,
        }]
        response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        trackr.init_db()
        loaded = self.client.get("/api/state").get_json()
        saved_employee = next(person for person in loaded["people"] if person["name"] == "Lewis")
        self.assertFalse(saved_employee["countsCapacity"])
        self.assertEqual(loaded["tasks"][0]["assigned"], ["Lewis"])

    def test_delivery_ready_confirmation_accepts_calculated_schedule_date(self):
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        state["jobs"] = [{
            "id": "J123",
            "address": "1 Test Street",
            "builder": "Builder",
            "notes": "",
            "status": "Active",
            "labourHours": {},
            "excludedStages": [],
        }]
        delivery = {
            "id": "J123-delivery",
            "job": "J123",
            "name": "Delivery",
            "type": "capacity",
            "department": "Cabinet Making",
            "date": "2026-09-14",
            "duration": 0,
            "assigned": [],
            "assignmentMinutes": {},
            "assignmentDates": {},
            "scheduleOrder": {},
            "status": "Planned",
            "custom": False,
            "showOnCalendar": True,
            "deliveryReady": {
                "deliveryDate": "2026-09-15",
                "confirmedAt": "2026-09-10T01:02:03+00:00",
                "confirmedBy": "admin",
            },
        }
        state["tasks"] = [delivery]
        validated = trackr.validate_state(state)
        self.assertEqual(validated["tasks"][0]["deliveryReady"]["deliveryDate"], "2026-09-15")
        self.assertEqual(validated["tasks"][0]["deliveryReady"]["confirmedBy"], "admin")

        renamed = copy.deepcopy(state)
        renamed["tasks"][0]["name"] = "Loading"
        validated = trackr.validate_state(renamed)
        self.assertNotIn("deliveryReady", validated["tasks"][0])

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

    def absence_state(self, kind="Holiday"):
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        status = {"person": "Lewis", "type": kind, "startDate": "2026-09-14", "endDate": "2026-09-18"}
        state["dayStatuses"] = [status]
        state["absenceOverrides"] = [{"person": "Lewis", "date": "2026-09-16", "statuses": [
            {key: status[key] for key in ("type", "startDate", "endDate")}
        ]}]
        return state

    def test_absence_override_save_reload_restart_and_restore(self):
        csrf = self.login_admin()
        for kind in sorted(trackr.ALLOWED_DAY_STATUS_TYPES):
            with self.subTest(kind=kind):
                state = self.absence_state(kind)
                state["_revision"] = self.client.get("/api/state").get_json()["_revision"]
                response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 200)
                trackr.init_db()  # Same validation/load path used on process restart.
                loaded = self.client.get("/api/state").get_json()
                self.assertEqual(loaded["dayStatuses"], state["dayStatuses"])
                self.assertEqual(loaded["absenceOverrides"], state["absenceOverrides"])
                loaded["absenceOverrides"] = []
                response = self.client.post("/api/state", json=loaded, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 200)
                restored = self.client.get("/api/state").get_json()
                self.assertEqual(restored["absenceOverrides"], [])
                self.assertEqual(restored["dayStatuses"], state["dayStatuses"])

    def test_absence_override_stale_sources_are_pruned(self):
        for change in ("remove", "type", "range", "employee", "overlap"):
            with self.subTest(change=change):
                state = self.absence_state()
                if change == "remove":
                    state["dayStatuses"] = []
                elif change == "type":
                    state["dayStatuses"][0]["type"] = "Sick"
                elif change == "range":
                    state["dayStatuses"][0]["endDate"] = "2026-09-17"
                elif change == "employee":
                    state["absenceOverrides"][0]["person"] = "Missing"
                else:
                    state["dayStatuses"].append({**state["dayStatuses"][0], "type": "Away"})
                self.assertEqual(trackr.validate_state(state)["absenceOverrides"], [])

    def test_roster_rdo_capacity_override_save_reload_restart_restore(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        person = next(person for person in state["people"] if person["name"] == "Adrian")
        person["customStart"] = "2026-09-07"
        self.assertEqual(person["week1"]["Fri"], 340)
        self.assertEqual(person["week2"]["Fri"], 0)
        roster_keys = ("workPattern", "customStart", "week", "week1", "week2")
        roster = {key: copy.deepcopy(person[key]) for key in roster_keys}
        person["capacityOverrides"] = {"2026-09-18": 340}
        response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        trackr.init_db()
        loaded = self.client.get("/api/state").get_json()
        employee = next(person for person in loaded["people"] if person["name"] == "Adrian")
        self.assertEqual(employee["capacityOverrides"], {"2026-09-18": 340})
        self.assertEqual({key: employee[key] for key in roster_keys}, roster)
        self.assertEqual(loaded["dayStatuses"], [])
        self.assertEqual(loaded["absenceOverrides"], [])
        del employee["capacityOverrides"]["2026-09-18"]
        response = self.client.post("/api/state", json=loaded, headers={"X-CSRF-Token": csrf})
        self.assertEqual(response.status_code, 200)
        trackr.init_db()
        restored = next(person for person in self.client.get("/api/state").get_json()["people"] if person["name"] == "Adrian")
        self.assertEqual(restored["capacityOverrides"], {})
        self.assertEqual({key: restored[key] for key in roster_keys}, roster)

    def test_read_only_cannot_add_or_remove_roster_rdo_capacity_override(self):
        csrf = self.login_admin()
        state = self.client.get("/api/state").get_json()
        state["people"][4]["capacityOverrides"] = {"2026-09-18": 340}
        self.assertEqual(self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf}).status_code, 200)
        conn = trackr.get_db()
        cursor = conn.execute("INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('reader', 'unused', 'user', 0)")
        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        reader = trackr.app.test_client()
        with reader.session_transaction() as sess:
            sess.update(user_id=user_id, session_version=1, csrf_token="reader-csrf")
        saved = reader.get("/api/state").get_json()
        self.assertEqual(saved["people"][4]["capacityOverrides"], {"2026-09-18": 340})
        for overrides in ({}, {"2026-09-18": 340, "2026-10-02": 340}):
            changed = copy.deepcopy(saved)
            changed["people"][4]["capacityOverrides"] = overrides
            response = reader.post("/api/state", json=changed, headers={"X-CSRF-Token": "reader-csrf"})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(reader.get("/api/state").get_json(), saved)

    def test_absence_override_invalid_payloads_rejected_without_saving(self):
        csrf = self.login_admin()
        original = self.client.get("/api/state").get_json()
        valid = self.absence_state()["absenceOverrides"][0]
        invalid_values = [None, {}, [None], [{**valid, "date": "2026-02-30"}],
                          [{**valid, "date": "20260916"}], [{**valid, "statuses": []}],
                          [{**valid, "statuses": [None]}],
                          [{**valid, "statuses": [{"type": "Factory Closure", "startDate": "2026-09-14", "endDate": "2026-09-18"}]}],
                          [valid] * (trackr.MAX_DAY_STATUSES + 1)]
        for invalid in invalid_values:
            with self.subTest(value=str(invalid)[:80]):
                state = self.absence_state()
                state.update(_revision=original["_revision"], absenceOverrides=invalid)
                response = self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(self.client.get("/api/state").get_json(), original)

    def test_absence_override_legacy_state_and_duplicates(self):
        state = self.absence_state()
        state["absenceOverrides"] *= 2
        self.assertEqual(len(trackr.validate_state(state)["absenceOverrides"]), 1)
        state.pop("absenceOverrides")
        state["version"] = 9
        migrated, changed = trackr.migrate_state(state)
        self.assertTrue(changed)
        self.assertEqual(trackr.validate_state(migrated)["absenceOverrides"], [])

    def test_read_only_can_see_but_cannot_add_or_restore_absence_override(self):
        csrf = self.login_admin()
        state = self.absence_state()
        state["_revision"] = self.client.get("/api/state").get_json()["_revision"]
        self.assertEqual(self.client.post("/api/state", json=state, headers={"X-CSRF-Token": csrf}).status_code, 200)
        conn = trackr.get_db()
        cursor = conn.execute("INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('reader', 'unused', 'user', 0)")
        user_id = cursor.lastrowid
        conn.commit()
        conn.close()
        reader = trackr.app.test_client()
        with reader.session_transaction() as sess:
            sess.update(user_id=user_id, session_version=1, csrf_token="reader-csrf")
        loaded = reader.get("/api/state").get_json()
        self.assertEqual(loaded["absenceOverrides"], state["absenceOverrides"])
        for overrides in ([], [*loaded["absenceOverrides"], {**loaded["absenceOverrides"][0], "date": "2026-09-15"}]):
            response = reader.post("/api/state", json={**loaded, "absenceOverrides": overrides}, headers={"X-CSRF-Token": "reader-csrf"})
            self.assertEqual(response.status_code, 403)
        self.assertEqual(reader.get("/api/state").get_json(), loaded)

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
            self.assertFalse(fresh_path.exists())
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

    def test_colliding_bootstrap_usernames_leave_no_database_and_allow_retry(self):
        for index, factory_username in enumerate(("admin", "ADMIN")):
            with self.subTest(factory_username=factory_username):
                fresh_path = Path(self.tmp.name) / f"duplicate-bootstrap-{index}.sqlite3"
                with mock.patch.object(trackr, "DB_PATH", fresh_path), mock.patch.dict(os.environ, {
                    "TRACKR_BOOTSTRAP_ADMIN_USERNAME": "admin",
                    "TRACKR_BOOTSTRAP_FACTORY_USERNAME": factory_username,
                    "TRACKR_BOOTSTRAP_FACTORY_PASSWORD": "temporary-factory-password",
                }):
                    with self.assertRaisesRegex(RuntimeError, "usernames must be different"):
                        trackr.init_db()
                    self.assertFalse(fresh_path.exists())
                    self.assertFalse(Path(f"{fresh_path}-wal").exists())
                    self.assertFalse(Path(f"{fresh_path}-shm").exists())
                    os.environ["TRACKR_BOOTSTRAP_FACTORY_USERNAME"] = "factory"
                    trackr.init_db()
                    conn = trackr.get_db()
                    try:
                        self.assertEqual(conn.execute("SELECT COUNT(*) FROM app_state WHERE id=1").fetchone()[0], 1)
                        users = conn.execute("SELECT username, role FROM users ORDER BY id").fetchall()
                        self.assertEqual([tuple(row) for row in users], [("admin", "admin"), ("factory", "user")])
                    finally:
                        conn.close()

    def test_railway_volume_wins_over_trackr_db_path(self):
        previous_volume = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
        previous_explicit = os.environ.get("TRACKR_DB_PATH")
        volume = tempfile.TemporaryDirectory()
        try:
            os.environ["RAILWAY_VOLUME_MOUNT_PATH"] = volume.name
            os.environ["TRACKR_DB_PATH"] = "./wrong.sqlite3"
            self.assertEqual(trackr.resolve_db_path(), Path(volume.name).resolve() / "trackr.sqlite3")
        finally:
            volume.cleanup()
            if previous_volume is None:
                os.environ.pop("RAILWAY_VOLUME_MOUNT_PATH", None)
            else:
                os.environ["RAILWAY_VOLUME_MOUNT_PATH"] = previous_volume
            if previous_explicit is None:
                os.environ.pop("TRACKR_DB_PATH", None)
            else:
                os.environ["TRACKR_DB_PATH"] = previous_explicit

    def _run_app_subprocess(self, script: str, env_updates: dict[str, str | None]) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        for name in RAILWAY_ENV_MARKERS:
            env.pop(name, None)
        env.update(
            TRACKR_SECRET_KEY="subprocess-test-secret-" + ("x" * 40),
            TRACKR_BOOTSTRAP_ADMIN_USERNAME="admin",
            TRACKR_BOOTSTRAP_ADMIN_PASSWORD="temporary-subprocess-password",
        )
        for name, value in env_updates.items():
            if value is None:
                env.pop(name, None)
            else:
                env[name] = value
        return subprocess.run(
            [sys.executable, "-c", script],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_railway_startup_storage_guard_cases(self):
        # Each import runs in a fresh process because app.py initializes SQLite
        # at import time. All paths are temporary and isolated from live data.
        railway_markers = (
            "RAILWAY_ENVIRONMENT",
            "RAILWAY_PROJECT_ID",
            "RAILWAY_SERVICE_ID",
            "RAILWAY_ENVIRONMENT_ID",
            "RAILWAY_DEPLOYMENT_ID",
            "RAILWAY_REPLICA_ID",
        )
        script = "import app"
        for marker in railway_markers:
            with self.subTest(missing_mount_for=marker):
                result = self._run_app_subprocess(script, {marker: "test-marker", "TRACKR_DB_PATH": str(Path(self.tmp.name) / "fallback.sqlite3")})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Persistent Railway storage unavailable", result.stderr)
                self.assertIn("refusing start", result.stderr)
                self.assertFalse((Path(self.tmp.name) / "fallback.sqlite3").exists())

        missing_mount = Path(self.tmp.name) / "missing-volume"
        result = self._run_app_subprocess(
            script,
            {
                "RAILWAY_SERVICE_ID": "test-service",
                "RAILWAY_VOLUME_MOUNT_PATH": str(missing_mount),
                "TRACKR_DB_PATH": str(Path(self.tmp.name) / "fallback.sqlite3"),
            },
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Persistent Railway storage unavailable", result.stderr)
        self.assertFalse(missing_mount.exists())
        self.assertFalse((Path(self.tmp.name) / "fallback.sqlite3").exists())

        result = self._run_app_subprocess(
            script,
            {
                "RAILWAY_SERVICE_ID": "test-service",
                "RAILWAY_VOLUME_MOUNT_PATH": ".",
                "TRACKR_DB_PATH": str(Path(self.tmp.name) / "fallback.sqlite3"),
            },
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be an absolute path", result.stderr)
        self.assertFalse((Path(self.tmp.name) / "fallback.sqlite3").exists())

        file_mount = Path(self.tmp.name) / "volume-file"
        file_mount.write_text("not a directory", encoding="utf-8")
        result = self._run_app_subprocess(
            script,
            {"RAILWAY_ENVIRONMENT_ID": "test-environment", "RAILWAY_VOLUME_MOUNT_PATH": str(file_mount)},
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Persistent Railway storage unavailable", result.stderr)

        valid_mount = Path(self.tmp.name) / "valid-volume"
        valid_mount.mkdir()
        wrong_db = Path(self.tmp.name) / "wrong.sqlite3"
        result = self._run_app_subprocess(
            "import app; assert app.DB_PATH == __import__('pathlib').Path(__import__('os').environ['RAILWAY_VOLUME_MOUNT_PATH']).resolve() / 'trackr.sqlite3'",
            {
                "RAILWAY_PROJECT_ID": "test-project",
                "RAILWAY_VOLUME_MOUNT_PATH": str(valid_mount),
                "TRACKR_DB_PATH": str(wrong_db),
            },
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((valid_mount / "trackr.sqlite3").is_file())
        self.assertFalse(wrong_db.exists())

        # Empty mount values are invalid even when an old custom DB path exists.
        result = self._run_app_subprocess(
            script,
            {
                "RAILWAY_SERVICE_NAME": "trackr",
                "RAILWAY_VOLUME_MOUNT_PATH": "",
                "TRACKR_DB_PATH": str(Path(self.tmp.name) / "fallback.sqlite3"),
            },
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Persistent Railway storage unavailable", result.stderr)
        self.assertFalse((Path(self.tmp.name) / "fallback.sqlite3").exists())

    def test_non_railway_database_path_selection_is_preserved(self):
        previous_explicit = os.environ.get("TRACKR_DB_PATH")
        previous_railway = {
            name: os.environ.get(name)
            for name in (*trackr.RAILWAY_RUNTIME_VARIABLES, "RAILWAY_ENVIRONMENT")
        }
        try:
            for name in (*trackr.RAILWAY_RUNTIME_VARIABLES, "RAILWAY_ENVIRONMENT"):
                os.environ.pop(name, None)
            explicit_path = Path(self.tmp.name) / "custom.sqlite3"
            os.environ["TRACKR_DB_PATH"] = str(explicit_path)
            self.assertEqual(trackr.resolve_db_path(), explicit_path.resolve())
            os.environ.pop("TRACKR_DB_PATH", None)
            with mock.patch.object(trackr, "APP_DIR", Path(self.tmp.name)):
                self.assertEqual(trackr.resolve_db_path(), Path(self.tmp.name) / "flow.sqlite3")
        finally:
            if previous_explicit is None:
                os.environ.pop("TRACKR_DB_PATH", None)
            else:
                os.environ["TRACKR_DB_PATH"] = previous_explicit
            for name, value in previous_railway.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


    def test_backup_download_returns_sqlite_file(self):
        self.login_admin()
        response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data.startswith(b"SQLite format 3\x00"))
        self.assertIn("attachment", response.headers.get("Content-Disposition", "").lower())
        response.close()

    def _capture_download_temp_files(self):
        created = []
        real_named_temporary_file = trackr.tempfile.NamedTemporaryFile

        def create_temp_file(*args, **kwargs):
            kwargs["dir"] = self.tmp.name
            handle = real_named_temporary_file(*args, **kwargs)
            created.append(Path(handle.name))
            return handle

        return created, mock.patch.object(trackr.tempfile, "NamedTemporaryFile", side_effect=create_temp_file)

    def _admin_download_response(self, client=None):
        client = client or self.client
        with mock.patch.object(trackr, "get_current_user", return_value={"id": 1, "role": "admin"}):
            return client.get("/api/backup")

    def test_download_backup_removes_temp_file_after_success_and_returns_sqlite_bytes(self):
        db_before = trackr.DB_PATH.read_bytes()
        backup_dir = Path(self.tmp.name) / "backups"
        backup_dir.mkdir()
        persistent = backup_dir / "trackr-existing.sqlite3"
        recovery = backup_dir / "trackr-recovery-existing.sqlite3"
        persistent.write_bytes(b"persistent fixture")
        recovery.write_bytes(b"recovery fixture")
        created, patcher = self._capture_download_temp_files()
        with patcher:
            response = self._admin_download_response()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.is_streamed)
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].exists())
        self.assertTrue(response.data.startswith(b"SQLite format 3\x00"))
        snapshot = Path(self.tmp.name) / "download-check.sqlite3"
        snapshot.write_bytes(response.data)
        conn = sqlite3.connect(snapshot)
        try:
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM app_state").fetchone()[0], 1)
        finally:
            conn.close()
        response.close()
        self.assertFalse(created[0].exists())
        self.assertEqual(trackr.DB_PATH.read_bytes(), db_before)
        self.assertEqual(persistent.read_bytes(), b"persistent fixture")
        self.assertEqual(recovery.read_bytes(), b"recovery fixture")
        self.assertEqual(set(backup_dir.iterdir()), {persistent, recovery})

    def test_download_backup_closes_unconsumed_stream_before_exact_temp_unlink(self):
        created, patcher = self._capture_download_temp_files()
        streams = []
        real_send_file = trackr.send_file
        real_unlink = Path.unlink
        unlinked = []

        def capture_stream(*args, **kwargs):
            response = real_send_file(*args, **kwargs)
            streams.append(response.response.file)
            return response

        def check_unlink(path, *args, **kwargs):
            self.assertEqual(path, created[0])
            self.assertTrue(streams[0].closed)
            unlinked.append(path)
            return real_unlink(path, *args, **kwargs)

        with patcher, mock.patch.object(trackr, "send_file", side_effect=capture_stream), mock.patch.object(
            Path, "unlink", check_unlink
        ):
            response = self._admin_download_response()
            self.assertTrue(created[0].exists())
            self.assertFalse(streams[0].closed)
            response.close()
            response.close()
        self.assertEqual(unlinked, created)
        self.assertFalse(created[0].exists())

    def test_download_backup_cleans_temp_file_when_source_connection_fails(self):
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "get_db", side_effect=RuntimeError("source failed")):
            with self.assertRaisesRegex(RuntimeError, "source failed"):
                self._admin_download_response()
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_download_backup_cleans_temp_file_when_destination_connection_fails(self):
        source = trackr.get_db()
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "get_db", return_value=source), mock.patch.object(
            trackr.sqlite3, "connect", side_effect=sqlite3.OperationalError("destination failed")
        ):
            with self.assertRaisesRegex(sqlite3.OperationalError, "destination failed"):
                self._admin_download_response()
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())
        source.close()

    def test_download_backup_cleans_partial_temp_file_when_sqlite_backup_fails(self):
        class FailedSource:
            def backup(self, _destination):
                raise sqlite3.OperationalError("backup failed")

            def close(self):
                self.closed = True

        source = FailedSource()
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "get_db", return_value=source):
            with self.assertRaisesRegex(sqlite3.OperationalError, "backup failed"):
                self._admin_download_response()
        self.assertTrue(source.closed)
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_download_backup_streams_file_without_read_bytes_or_bytesio(self):
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")), mock.patch.object(
            trackr, "BytesIO", create=True, side_effect=AssertionError("backup buffer")
        ), mock.patch.object(trackr, "send_file", wraps=trackr.send_file) as send:
            response = self._admin_download_response()
            stream = send.call_args.args[0]
            self.assertEqual(Path(stream.name), created[0])
            self.assertEqual(stream.mode, "rb")
            self.assertFalse(stream.closed)
            self.assertEqual(response.content_length, created[0].stat().st_size)
            self.assertEqual(response.mimetype, "application/vnd.sqlite3")
            self.assertEqual(response.cache_control.max_age, 0)
            self.assertTrue(response.data.startswith(b"SQLite format 3\x00"))
            response.close()
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_download_backup_actual_send_file_wrapper_failure_closes_file_before_unlink(self):
        import werkzeug.utils

        created, patcher = self._capture_download_temp_files()
        streams = []
        real_unlink = Path.unlink

        def failed_wrap(_environ, file, *args, **kwargs):
            streams.append(file)
            raise RuntimeError("actual send_file wrapping failed")

        def check_unlink(path, *args, **kwargs):
            self.assertEqual(path, created[0])
            self.assertTrue(streams[0].closed)
            return real_unlink(path, *args, **kwargs)

        with patcher, mock.patch.object(werkzeug.utils, "wrap_file", side_effect=failed_wrap), mock.patch.object(
            Path, "unlink", check_unlink
        ):
            with self.assertRaisesRegex(RuntimeError, "actual send_file wrapping failed"):
                self._admin_download_response()
        self.assertFalse(created[0].exists())

    def test_download_backup_attempts_both_connection_closes_independently(self):
        closed = []

        class FakeConnection:
            def __init__(self, label):
                self.label = label

            def backup(self, _destination):
                pass

            def close(self):
                closed.append(self.label)
                raise OSError(f"{self.label} close failed")

        source = FakeConnection("source")
        destination = FakeConnection("destination")
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "get_db", return_value=source), mock.patch.object(
            trackr.sqlite3, "connect", return_value=destination
        ):
            with self.assertRaisesRegex(OSError, "destination close failed"):
                self._admin_download_response()
        self.assertCountEqual(closed, ["source", "destination"])
        self.assertFalse(created[0].exists())

    def test_download_backup_wrapper_install_failure_closes_stream_then_cleans_temp(self):
        created, patcher = self._capture_download_temp_files()
        streams = []
        real_send_file = trackr.send_file
        real_unlink = Path.unlink

        def capture_stream(*args, **kwargs):
            response = real_send_file(*args, **kwargs)
            streams.append(response.response.file)
            return response

        def check_unlink(path, *args, **kwargs):
            self.assertEqual(path, created[0])
            self.assertTrue(streams[0].closed)
            return real_unlink(path, *args, **kwargs)

        with patcher, mock.patch.object(trackr, "send_file", side_effect=capture_stream), mock.patch.object(
            trackr, "_DownloadBackupIterator", side_effect=RuntimeError("wrapper failed")
        ), mock.patch.object(Path, "unlink", check_unlink):
            with self.assertRaisesRegex(RuntimeError, "wrapper failed"):
                self._admin_download_response()
        self.assertFalse(created[0].exists())

    def test_download_backup_temp_handle_close_failure_cleans_reserved_file(self):
        created = []
        real_named_temporary_file = trackr.tempfile.NamedTemporaryFile

        def fail_close(*args, **kwargs):
            kwargs["dir"] = self.tmp.name
            handle = real_named_temporary_file(*args, **kwargs)
            created.append(Path(handle.name))
            handle.close()
            handle.close = mock.Mock(side_effect=OSError("temp close failed"))
            return handle

        with mock.patch.object(trackr.tempfile, "NamedTemporaryFile", side_effect=fail_close):
            with self.assertRaisesRegex(OSError, "temp close failed"):
                self._admin_download_response()
        self.assertFalse(created[0].exists())

    def test_download_backup_temp_creation_failure_never_unlinks_unowned_path(self):
        with mock.patch.object(trackr.tempfile, "NamedTemporaryFile", side_effect=OSError("temp creation failed")), mock.patch.object(
            Path, "unlink", side_effect=AssertionError("unowned cleanup")
        ) as unlink:
            with self.assertRaisesRegex(OSError, "temp creation failed"):
                self._admin_download_response()
        unlink.assert_not_called()

    def test_download_backup_original_error_survives_both_connection_close_failures(self):
        source = mock.Mock()
        source.backup.side_effect = RuntimeError("original backup error")
        source.close.side_effect = OSError("source close error")
        destination = mock.Mock()
        destination.close.side_effect = OSError("destination close error")
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "get_db", return_value=source), mock.patch.object(
            trackr.sqlite3, "connect", return_value=destination
        ), self.assertLogs(trackr.app.logger, level="ERROR"):
            with self.assertRaisesRegex(RuntimeError, "original backup error"):
                self._admin_download_response()
        source.close.assert_called_once()
        destination.close.assert_called_once()
        self.assertFalse(created[0].exists())

    def test_download_backup_reader_rejected_without_creating_temp_file(self):
        with mock.patch.object(trackr, "get_current_user", return_value={"id": 2, "role": "user"}), mock.patch.object(
            trackr.tempfile, "NamedTemporaryFile", side_effect=AssertionError("unauthorized backup")
        ) as create:
            response = self.client.get("/api/backup")
        self.assertEqual(response.status_code, 403)
        create.assert_not_called()
        response.close()

    def test_download_backup_stream_error_survives_close_and_unlink_errors(self):
        class BrokenStream:
            def __iter__(self):
                return self

            def __next__(self):
                raise RuntimeError("original stream error")

            def close(self):
                raise OSError("stream close error")

        created, patcher = self._capture_download_temp_files()

        def broken_response(*args, **kwargs):
            return trackr.app.response_class(BrokenStream(), direct_passthrough=True)

        with patcher, mock.patch.object(trackr, "send_file", side_effect=broken_response), mock.patch.object(
            Path, "unlink", side_effect=OSError("cleanup error")
        ), self.assertLogs(trackr.app.logger, level="ERROR") as logs:
            with self.assertRaisesRegex(RuntimeError, "original stream error"):
                self._admin_download_response()
        self.assertTrue(any("Could not close download backup stream" in line for line in logs.output))
        self.assertTrue(any("Could not remove temporary download backup" in line for line in logs.output))
        created[0].unlink()

    def test_download_backup_cleans_temp_file_when_response_preparation_fails(self):
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(trackr, "send_file", side_effect=RuntimeError("response failed")):
            with self.assertRaisesRegex(RuntimeError, "response failed"):
                self._admin_download_response()
        self.assertEqual(len(created), 1)
        self.assertFalse(created[0].exists())

    def test_download_cleanup_error_does_not_mask_backup_error_or_target_protected_paths(self):
        persistent = trackr.DB_PATH.parent / "backups" / "trackr-existing.sqlite3"
        persistent.parent.mkdir(parents=True, exist_ok=True)
        persistent.write_bytes(b"existing backup fixture")
        recovery = persistent.parent / "trackr-recovery-existing.sqlite3"
        recovery.write_bytes(b"existing recovery fixture")
        db_before = trackr.DB_PATH.read_bytes()

        class FailedSource:
            def backup(self, _destination):
                raise RuntimeError("original backup failure")

            def close(self):
                pass

        created, patcher = self._capture_download_temp_files()
        real_unlink = Path.unlink
        unlink_targets = []

        def fail_cleanup(path, *args, **kwargs):
            if created and path == created[0]:
                unlink_targets.append(path)
                raise OSError("cleanup failure")
            return real_unlink(path, *args, **kwargs)

        with patcher, mock.patch.object(trackr, "get_db", return_value=FailedSource()), mock.patch.object(
            Path, "unlink", fail_cleanup
        ):
            with self.assertRaisesRegex(RuntimeError, "original backup failure"):
                self._admin_download_response()
        self.assertEqual(unlink_targets, created)
        self.assertNotIn(trackr.DB_PATH, unlink_targets)
        self.assertNotIn(persistent, unlink_targets)
        self.assertNotIn(recovery, unlink_targets)
        self.assertTrue(created[0].exists())
        self.assertEqual(trackr.DB_PATH.read_bytes(), db_before)
        self.assertEqual(persistent.read_bytes(), b"existing backup fixture")
        self.assertEqual(recovery.read_bytes(), b"existing recovery fixture")
        real_unlink(created[0], missing_ok=True)

    def test_download_cleanup_error_without_prior_failure_is_logged_without_failing_response(self):
        created, patcher = self._capture_download_temp_files()
        with patcher, mock.patch.object(Path, "unlink", side_effect=OSError("cleanup failure")):
            response = self._admin_download_response()
            response.close()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0].exists())
        created[0].unlink(missing_ok=True)

    def test_download_filename_has_seconds_and_unique_suffix(self):
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 30, 6, 31, 22)

        with mock.patch.object(trackr, "datetime", FixedDateTime):
            response = self._admin_download_response()
        name = response.headers["Content-Disposition"]
        self.assertIn("2026-09-30-063122", name)
        self.assertRegex(name, r'trackr-backup-\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{6}\.sqlite3')
        response.close()

    def test_downloads_started_in_same_second_have_unique_names(self):
        names = []
        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 30, 6, 31, 22)

        with mock.patch.object(trackr, "datetime", FixedDateTime):
            for _ in range(2):
                response = self._admin_download_response()
                names.append(response.headers["Content-Disposition"])
                response.close()
        self.assertIn("2026-09-30-063122", names[0])
        self.assertNotEqual(names[0], names[1])

    def test_concurrent_downloads_use_distinct_temp_paths_and_filenames(self):
        created, patcher = self._capture_download_temp_files()
        responses = []
        barrier = threading.Barrier(2)

        def download():
            with trackr.app.test_client() as client:
                barrier.wait()
                responses.append(client.get("/api/backup"))

        with patcher, mock.patch.object(trackr, "get_current_user", return_value={"id": 1, "role": "admin"}):
            threads = [threading.Thread(target=download) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(created), 2)
        self.assertEqual(len(set(created)), 2)
        self.assertTrue(all(path.exists() for path in created))
        self.assertEqual(len(responses), 2)
        self.assertTrue(all(response.status_code == 200 for response in responses))
        self.assertEqual(len({response.headers["Content-Disposition"] for response in responses}), 2)
        responses[0].close()
        self.assertEqual(sum(path.exists() for path in created), 1)
        self.assertTrue(responses[1].data.startswith(b"SQLite format 3\x00"))
        responses[1].close()
        self.assertTrue(all(not path.exists() for path in created))

    def test_forced_persistent_backups_same_second_get_distinct_paths_and_preserve_existing_backup(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        existing = backup_dir / "trackr-existing-state-save.sqlite3"
        existing.write_bytes(b"user-owned backup fixture")

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 30, 6, 31, 22, 123456)

        with mock.patch.object(trackr, "datetime", FixedDateTime):
            first = trackr.backup_database(label="state-save", force=True)
            second = trackr.backup_database(label="state-save", force=True)
        self.assertNotEqual(first, second)
        self.assertTrue(first.is_file())
        self.assertTrue(second.is_file())
        self.assertEqual(existing.read_bytes(), b"user-owned backup fixture")

    def test_persistent_backup_reserves_unique_destination_before_opening(self):
        real_connect = trackr.sqlite3.connect
        destinations = []

        def track_destination(path, *args, **kwargs):
            if Path(path).parent == trackr.DB_PATH.parent / "backups":
                destinations.append(Path(path))
            return real_connect(path, *args, **kwargs)

        with mock.patch.object(trackr.sqlite3, "connect", side_effect=track_destination):
            first = trackr.backup_database(label="forced", force=True)
            second = trackr.backup_database(label="forced", force=True)
        self.assertEqual(destinations, [first, second])
        self.assertNotEqual(*destinations)

    def test_persistent_backup_reservation_close_failure_removes_reserved_path(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        existing = backup_dir / "trackr-existing.sqlite3"
        existing.write_bytes(b"existing persistent backup")
        real_open = Path.open
        reserved = []

        class FailedReservation:
            def close(self):
                raise OSError("reservation close failed")

        def fail_reservation_close(path, mode="r", *args, **kwargs):
            if mode == "xb" and path.parent == backup_dir:
                handle = real_open(path, mode, *args, **kwargs)
                handle.close()
                reserved.append(path)
                return FailedReservation()
            return real_open(path, mode, *args, **kwargs)

        with mock.patch.object(Path, "open", fail_reservation_close):
            with self.assertRaisesRegex(OSError, "reservation close failed"):
                trackr.backup_database(label="reservation-close", force=True)
        self.assertEqual(len(reserved), 1)
        self.assertFalse(reserved[0].exists())
        self.assertEqual(existing.read_bytes(), b"existing persistent backup")

    def test_persistent_backup_does_not_overwrite_existing_same_timestamp_candidate(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        timestamp = "20260930-063122-123456"
        collision = backup_dir / f"trackr-{timestamp}-collision-deadbeef.sqlite3"
        collision.write_bytes(b"pre-existing backup fixture")

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 30, 6, 31, 22, 123456)

        with mock.patch.object(trackr, "datetime", FixedDateTime), mock.patch.object(
            trackr.secrets, "token_hex", side_effect=["deadbeef", "cafebabe"]
        ):
            created = trackr.backup_database(label="collision", force=True)
        self.assertNotEqual(created, collision)
        self.assertEqual(collision.read_bytes(), b"pre-existing backup fixture")
        self.assertTrue(created.is_file())

    def test_concurrent_persistent_backups_reserve_distinct_destinations(self):
        destinations = []
        results = []
        lock = threading.Lock()
        barrier = threading.Barrier(2)
        real_get_db = trackr.get_db

        def concurrent_get_db():
            connection = real_get_db()
            barrier.wait(timeout=10)
            return connection

        real_connect = trackr.sqlite3.connect

        def track_destination(path, *args, **kwargs):
            path = Path(path)
            if path.parent == trackr.DB_PATH.parent / "backups":
                with lock:
                    destinations.append(path)
            return real_connect(path, *args, **kwargs)

        def create_backup():
            results.append(trackr.backup_database(label="parallel", force=True))

        class FixedDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 9, 30, 6, 31, 22, 123456)

        with mock.patch.object(trackr, "get_db", side_effect=concurrent_get_db), mock.patch.object(
            trackr.sqlite3, "connect", side_effect=track_destination
        ), mock.patch.object(trackr, "datetime", FixedDateTime):
            threads = [threading.Thread(target=create_backup) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=15)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(len(results), 2)
        self.assertEqual(len(set(results)), 2)
        self.assertEqual(len(set(destinations)), 2)

    def test_failed_persistent_backup_removes_only_its_partial_artifact(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        existing = backup_dir / "trackr-existing.sqlite3"
        existing.write_bytes(b"existing persistent backup")

        class FailedSource:
            def backup(self, _destination):
                raise sqlite3.OperationalError("persistent backup failed")

            def close(self):
                pass

        with mock.patch.object(trackr, "get_db", return_value=FailedSource()):
            with self.assertRaisesRegex(sqlite3.OperationalError, "persistent backup failed"):
                trackr.backup_database(label="forced", force=True)
        self.assertEqual(existing.read_bytes(), b"existing persistent backup")
        self.assertEqual(list(backup_dir.glob("trackr-*-forced-*.sqlite3")), [])

    def test_persistent_backup_close_failure_removes_its_partial_artifact(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)

        class FailedCloseSource:
            def backup(self, _destination):
                pass

            def close(self):
                raise OSError("source close failed")

        with mock.patch.object(trackr, "get_db", return_value=FailedCloseSource()):
            with self.assertRaisesRegex(OSError, "source close failed"):
                trackr.backup_database(label="close-failure", force=True)
        self.assertEqual(list(backup_dir.glob("trackr-*-close-failure-*.sqlite3")), [])

    def test_persistent_backup_retention_keeps_ten_newest(self):
        backup_dir = trackr.DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        for index in range(12):
            path = backup_dir / f"trackr-fixture-{index:02d}.sqlite3"
            path.write_bytes(f"fixture-{index}".encode())
            os.utime(path, (index + 1, index + 1))
        result = trackr.backup_database(label="retention", force=True)
        self.assertTrue(result.is_file())
        remaining = list(backup_dir.glob("trackr-*.sqlite3"))
        self.assertEqual(len(remaining), 10)
        self.assertIn(result, remaining)
        self.assertTrue((backup_dir / "trackr-fixture-11.sqlite3").exists())

    def test_recovery_backup_keeps_existing_microsecond_filename_and_failure_cleanup(self):
        source = trackr.get_db()
        backup = trackr.recovery_backup(label="recovery-regression", source_conn=source)
        source.close()
        self.assertRegex(backup.name, r"^trackr-\d{8}-\d{6}-\d{6}-recovery-regression\.sqlite3$")
        self.assertTrue(backup.is_file())

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

    @staticmethod
    def _pdf_labour_row(label, hours):
        return f"{label} - Labour description hr $50.00 {hours} $"

    def _recognized_pdf_text(self, *, heading=True, rows=None, quote_no="Q-123"):
        rows = rows if rows is not None else [("Assembly", 2), ("Drafting", 1)]
        parts = [f"Quote No: {quote_no}"] if quote_no else []
        if heading:
            parts.append("Labour Items")
        parts.extend(self._pdf_labour_row(label, hours) for label, hours in rows)
        return "\n".join(parts)

    def test_parse_estimate_pdf_requires_quote_and_labour_structure(self):
        recognized = self._recognized_pdf_text()
        cases = (
            ("supported rows with quote", recognized, True),
            ("unrelated readable text", "A totally unrelated document", False),
            ("quote without labour rows", "Quote No: Q-123\nQuote Name: Kitchen", False),
            ("next-line quote without labour rows", "Quote No:\nQ0701\nQuote Name: Kitchen", False),
            ("labour rows without quote", self._recognized_pdf_text(quote_no=""), False),
            ("heading without expected rows", "Quote No: Q-123\nLabour Items", False),
            ("recoverable but unrecognized text", "Quote Name: Kitchen\nDate: 01/02/2026", False),
        )
        for label, text, should_succeed in cases:
            with self.subTest(case=label), mock.patch.object(trackr, "read_pdf_text", return_value=text):
                if should_succeed:
                    result = trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))
                    self.assertEqual(result["quote_no"], "Q-123")
                    self.assertEqual(result["assembly_hours"], 2.0)
                else:
                    with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                        trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

    def test_parse_estimate_pdf_requires_distinct_labour_rows_without_heading(self):
        accepted = self._recognized_pdf_text(heading=False, rows=[("Assembly", 2), ("Drafting", 1)])
        with mock.patch.object(trackr, "read_pdf_text", return_value=accepted):
            result = trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))
        self.assertEqual(result["assembly_hours"], 2.0)
        self.assertEqual(result["drafting_hours"], 1.0)

        rejected_cases = (
            ("single row without heading", self._recognized_pdf_text(heading=False, rows=[("Assembly", 2)])),
            ("same category repeated", self._recognized_pdf_text(heading=False, rows=[("Assembly", 2), ("Assembly", 1)])),
        )
        for label, text in rejected_cases:
            with self.subTest(case=label), mock.patch.object(trackr, "read_pdf_text", return_value=text):
                with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                    trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

    def test_labour_row_boundaries_prevent_false_loading_match_and_cross_row_hours(self):
        unloading_only = self._recognized_pdf_text(heading=False, rows=[("Unloading", 3)])
        self.assertIsNone(trackr.extract_labour_hours(unloading_only, "Loading"))
        with mock.patch.object(trackr, "read_pdf_text", return_value=unloading_only):
            with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

        incomplete_assembly = "Quote No: Q-123\nAssembly - incomplete description\n" + self._pdf_labour_row("Drafting", 1)
        self.assertIsNone(trackr.extract_labour_hours(incomplete_assembly, "Assembly"))
        self.assertEqual(trackr.extract_labour_hours(incomplete_assembly, "Drafting"), 1.0)
        with mock.patch.object(trackr, "read_pdf_text", return_value=incomplete_assembly):
            with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

        adjacent_row_after_dash = "Quote No: Q-123\nAssembly -\n" + self._pdf_labour_row("Drafting", 1)
        self.assertIsNone(trackr.extract_labour_hours(adjacent_row_after_dash, "Assembly"))
        self.assertEqual(trackr.extract_labour_hours(adjacent_row_after_dash, "Drafting"), 1.0)
        with mock.patch.object(trackr, "read_pdf_text", return_value=adjacent_row_after_dash):
            with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

    def test_quote_no_does_not_capture_a_following_heading_when_blank(self):
        text = "Quote No:\nLabour Items\n" + self._pdf_labour_row("Assembly", 1)
        self.assertEqual(trackr.extract_quote_no(text), "")
        with mock.patch.object(trackr, "read_pdf_text", return_value=text):
            with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

    def test_pdf_quote_no_supports_only_an_immediate_nonempty_identifier_line(self):
        for text, expected in (
            ("Quote No: Q0701", "Q0701"),
            ("Quote No: LEGACY", "LEGACY"),
            ("Quote No:\nQ0701", "Q0701"),
            ("Quote No:\r\n \t\r\n Q0701 \r\n", "Q0701"),
        ):
            with self.subTest(text=text):
                self.assertEqual(trackr.extract_quote_no(text), expected)
        invalid_lines = ("Labour Items", "Labour Detail", "Quote Name", "Quote Name:",
                         *trackr.EXPECTED_LABOUR_LABELS, "Page 1", "Q0701 extra", "Q0701:", "", " \t")
        for line in invalid_lines:
            text = f"Quote No:\n{line}"
            if line.strip():
                text += "\nQ0701"  # Never skip an intervening heading/label.
            with self.subTest(line=line):
                self.assertEqual(trackr.extract_quote_no(text), "")
                with mock.patch.object(trackr, "read_pdf_text", return_value=text + "\nLabour Items\n" + self._pdf_labour_row("Assembly", 1)):
                    with self.assertRaises(trackr.UnsupportedEstimatePdfError):
                        trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))

    def test_pdf_supply_only_qualifiers_are_limited_to_loading_and_unloading(self):
        for label in ("Loading", "Unloading"):
            for qualifier in ("", " (Supply Only)"):
                text = f"{label}{qualifier} - $0\nhr\n$0.00\n0.54\n$0.00"
                with self.subTest(label=label, qualifier=qualifier):
                    self.assertEqual(trackr.extract_labour_hours(text, label), 0.54)
            for qualifier in (" (Other)", " (Supply Only extra)"):
                self.assertIsNone(trackr.extract_labour_hours(self._pdf_labour_row(label + qualifier, 1), label))
        self.assertIsNone(trackr.extract_labour_hours(self._pdf_labour_row("Assembly (Supply Only)", 1), "Assembly"))
        qualified_unloading = self._pdf_labour_row("Unloading (Supply Only)", 0.66)
        self.assertIsNone(trackr.extract_labour_hours(qualified_unloading, "Loading"))
        for incomplete in ("Assembly - incomplete description", "Assembly -"):
            text = incomplete + "\n" + qualified_unloading
            self.assertIsNone(trackr.extract_labour_hours(text, "Assembly"))
            self.assertEqual(trackr.extract_labour_hours(text, "Unloading"), 0.66)

    @staticmethod
    def _q0701_format_pdf_fixture():
        # Sanitized text reproduces the real PDF's newline-separated cells and
        # metadata after the table, without storing a customer's document.
        lines = ["Labour Detail", "Description", "Units", "Rate", "Quantity", "Total"]
        for label, rate, hours in (
            ("Assembly", 57, 3.39), ("CNC Machine", 55, 1.08),
            ("Drafting", 80, 1.56), ("Edgebander", 55, 1.11),
            ("QC", 50, 0.50), ("Loading (Supply Only)", 0, 0.54),
            ("Unloading (Supply Only)", 0, 0.66),
        ):
            lines.extend((f"{label} - ${rate}", "hr", f"${rate:.2f}", str(hours), "$0.00"))
        lines.extend(("Reporting On Section:", "Vanity", "Quote No:", "Q0701",
                      "Quote Name:", "1x Custom Vanity", "supply", "Date:", "05/10/2026"))
        writer = PdfWriter()
        page = writer.add_blank_page(width=612, height=792)
        font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                 NameObject("/Subtype"): NameObject("/Type1"),
                                 NameObject("/BaseFont"): NameObject("/Helvetica")})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        content = DecodedStreamObject()
        commands = ["BT /F1 10 Tf 12 TL 36 756 Td"]
        for line in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.append(f"({escaped}) Tj T*")
        commands.append("ET")
        content.set_data("\n".join(commands).encode("ascii"))
        page[NameObject("/Contents")] = content
        stream = BytesIO()
        writer.write(stream)
        stream.seek(0)
        return stream

    def test_real_q0701_pdf_extraction_format_is_recognized_and_imported(self):
        text = trackr.read_pdf_text(self._q0701_format_pdf_fixture())
        self.assertIn("Quote No:\nQ0701", text)
        self.assertIn("Labour Detail", text)
        self.assertNotIn("Labour Items", text)
        expected = {"assembly_hours": 3.39, "cnc_hours": 1.08, "drafting_hours": 1.56,
                    "edgebander_hours": 1.11, "qc_hours": 0.50,
                    "loading_hours": 0.54, "unloading_hours": 0.66}
        result = trackr.parse_estimate_pdf(self._q0701_format_pdf_fixture())
        self.assertEqual(result["quote_no"], "Q0701")
        for key, hours in expected.items():
            self.assertEqual(result[key], hours)
        csrf = self.login_admin()
        response = self.client.post(
            "/api/import-estimate",
            data={"estimate_pdf": (self._q0701_format_pdf_fixture(), "q0701-format.pdf", "application/pdf")},
            headers={"X-CSRF-Token": csrf}, content_type="multipart/form-data",
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(response.get_json()["extracted"], result)

    def test_parse_estimate_pdf_empty_text_is_rejected(self):
        for text in ("", " \t\n "):
            with self.subTest(text=repr(text)), mock.patch.object(trackr, "read_pdf_text", return_value=text):
                with self.assertRaises(trackr.EmptyEstimatePdfTextError):
                    trackr.parse_estimate_pdf(BytesIO(b"isolated image-only fixture"))

    def test_parse_estimate_pdf_distinguishes_matched_zero_from_missing_row(self):
        text = self._recognized_pdf_text(rows=[("Assembly", 0)])
        self.assertEqual(trackr.extract_labour_hours(text, "Assembly"), 0.0)
        self.assertIsNone(trackr.extract_labour_hours(text, "Drafting"))
        with mock.patch.object(trackr, "read_pdf_text", return_value=text):
            result = trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))
        self.assertEqual(result["assembly_hours"], 0.0)
        self.assertEqual(result["drafting_hours"], 0.0)
        self.assertEqual(result["drafting_total_hours"], 0.0)

    def test_parse_estimate_pdf_accepts_one_row_with_heading_and_normalizes_optional_rows(self):
        text = self._recognized_pdf_text(rows=[("Assembly", 2)])
        with mock.patch.object(trackr, "read_pdf_text", return_value=text):
            result = trackr.parse_estimate_pdf(BytesIO(b"isolated parser fixture"))
        self.assertEqual(result["assembly_hours"], 2.0)
        self.assertEqual(result["cnc_hours"], 0.0)
        self.assertEqual(result["unloading_hours"], 0.0)

    def test_read_pdf_text_rejects_encrypted_pdf_explicitly(self):
        class EncryptedReader:
            is_encrypted = True

            @property
            def pages(self):
                raise AssertionError("pages must not be accessed for encrypted PDFs")

        reader = EncryptedReader()
        with mock.patch.object(trackr, "PdfReader", return_value=reader):
            with self.assertRaises(trackr.EncryptedEstimatePdfError):
                trackr.read_pdf_text(BytesIO(b"isolated encrypted fixture"))

    def _build_pdf_fixture(self, *, encrypted=False):
        writer = PdfWriter()
        writer.add_blank_page(width=72, height=72)
        if encrypted:
            writer.encrypt("fixture-password")
        stream = BytesIO()
        writer.write(stream)
        stream.seek(0)
        return stream

    def test_real_pypdf_blank_and_encrypted_pdfs_are_rejected_safely(self):
        csrf = self.login_admin()
        blank_response = self.client.post(
            "/api/import-estimate",
            data={"estimate_pdf": (self._build_pdf_fixture(), "blank.pdf", "application/pdf")},
            headers={"X-CSRF-Token": csrf},
            content_type="multipart/form-data",
        )
        self.assertEqual(blank_response.status_code, 422)
        self.assertFalse(blank_response.get_json()["ok"])
        self.assertIn("No readable text was found", blank_response.get_json()["error"])

        encrypted_response = self.client.post(
            "/api/import-estimate",
            data={"estimate_pdf": (self._build_pdf_fixture(encrypted=True), "encrypted.pdf", "application/pdf")},
            headers={"X-CSRF-Token": csrf},
            content_type="multipart/form-data",
        )
        self.assertEqual(encrypted_response.status_code, 400)
        self.assertFalse(encrypted_response.get_json()["ok"])
        self.assertIn("Password-protected PDFs are not supported", encrypted_response.get_json()["error"])

    def test_real_malformed_pdf_bytes_return_controlled_error(self):
        csrf = self.login_admin()
        malformed_response = self.client.post(
            "/api/import-estimate",
            data={"estimate_pdf": (BytesIO(b"%PDF-1.7\nnot a valid PDF structure"), "broken.pdf", "application/pdf")},
            headers={"X-CSRF-Token": csrf},
            content_type="multipart/form-data",
        )
        self.assertEqual(malformed_response.status_code, 400)
        payload = malformed_response.get_json()
        self.assertFalse(payload["ok"])
        self.assertNotIn("extracted", payload)
        self.assertEqual(payload["error"], "The PDF could not be read and may be damaged or incomplete.")

    def test_pdf_import_rejects_unrecognized_and_empty_documents_without_state_changes(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        before_row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
        before = (before_row["state_json"], before_row["revision"])
        before_state = json.loads(before[0])
        conn.close()

        cases = (
            ("unrelated", "A readable unrelated document", 422,
             "This PDF is not a supported estimate/labour-detail PDF."),
            ("image-only", " \n\t ", 422,
             "No readable text was found."),
            ("quote without rows", "Quote No: Q-123", 422,
             "This PDF is not a supported estimate/labour-detail PDF."),
        )
        for label, text, status, message in cases:
            with self.subTest(case=label), mock.patch.object(trackr, "read_pdf_text", return_value=text):
                response = self.client.post(
                    "/api/import-estimate",
                    data={"estimate_pdf": (BytesIO(b"isolated PDF fixture"), "estimate.pdf", "application/pdf")},
                    headers={"X-CSRF-Token": csrf},
                    content_type="multipart/form-data",
                )
            self.assertEqual(response.status_code, status)
            payload = response.get_json()
            self.assertFalse(payload["ok"])
            self.assertNotIn("extracted", payload)
            self.assertIn(message, payload["error"])
            conn = trackr.get_db()
            after_row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
            conn.close()
            self.assertEqual((after_row["state_json"], after_row["revision"]), before)
            after_state = json.loads(after_row["state_json"])
            self.assertEqual(after_state["jobs"], before_state["jobs"])
            self.assertEqual(after_state["tasks"], before_state["tasks"])

    def test_pdf_import_valid_recognized_document_succeeds(self):
        csrf = self.login_admin()
        text = self._recognized_pdf_text(rows=[("Assembly", 0)])
        with mock.patch.object(trackr, "read_pdf_text", return_value=text):
            response = self.client.post(
                "/api/import-estimate",
                data={"estimate_pdf": (BytesIO(b"isolated PDF fixture"), "estimate.pdf", "application/pdf")},
                headers={"X-CSRF-Token": csrf},
                content_type="multipart/form-data",
            )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["ok"])
        self.assertEqual(response.get_json()["extracted"]["assembly_hours"], 0.0)

    def test_pdf_import_encrypted_and_corrupt_errors_are_controlled(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        before_row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
        before = (before_row["state_json"], before_row["revision"])
        before_state = json.loads(before[0])
        conn.close()
        encrypted_reader = mock.Mock(is_encrypted=True)
        cases = (
            ("encrypted", mock.patch.object(trackr, "PdfReader", return_value=encrypted_reader), 400,
             "Password-protected PDFs are not supported."),
            ("corrupt", mock.patch.object(trackr, "PdfReader", side_effect=ValueError("private parse details")), 400,
             "The PDF could not be read and may be damaged or incomplete."),
        )
        for label, reader_patch, status, message in cases:
            with self.subTest(case=label), reader_patch:
                response = self.client.post(
                    "/api/import-estimate",
                    data={"estimate_pdf": (BytesIO(b"isolated invalid PDF fixture"), "estimate.pdf", "application/pdf")},
                    headers={"X-CSRF-Token": csrf},
                    content_type="multipart/form-data",
                )
            self.assertEqual(response.status_code, status)
            payload = response.get_json()
            self.assertFalse(payload["ok"])
            self.assertNotIn("extracted", payload)
            self.assertIn(message, payload["error"])
            conn = trackr.get_db()
            after_row = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
            conn.close()
            self.assertEqual((after_row["state_json"], after_row["revision"]), before)
            after_state = json.loads(after_row["state_json"])
            self.assertEqual(after_state["jobs"], before_state["jobs"])
            self.assertEqual(after_state["tasks"], before_state["tasks"])
        self.assertNotIn("private parse details", response.get_json()["error"])

    def test_pdf_import_keeps_extension_and_mime_validation(self):
        csrf = self.login_admin()
        cases = (
            ("estimate.txt", "application/pdf", 400, "must be a PDF"),
            ("estimate.pdf", "text/plain", 400, "not recognised as a PDF"),
        )
        for filename, mimetype, status, message in cases:
            with self.subTest(filename=filename, mimetype=mimetype):
                response = self.client.post(
                    "/api/import-estimate",
                    data={"estimate_pdf": (BytesIO(b"isolated validation fixture"), filename, mimetype)},
                    headers={"X-CSRF-Token": csrf},
                    content_type="multipart/form-data",
                )
                self.assertEqual(response.status_code, status)
                self.assertFalse(response.get_json()["ok"])
                self.assertIn(message, response.get_json()["error"])

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
        backup_conn = sqlite3.connect(backups[0])
        backed_up = backup_conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0]
        backup_conn.close()
        self.assertEqual(backed_up, "{broken-json")

    def _create_state_database(self, path, state_json=None, *, include_row=True):
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE app_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT)"
        )
        if include_row:
            conn.execute(
                "INSERT INTO app_state (id, state_json, revision, updated_at) VALUES (1, ?, 7, 'original')",
                (state_json if state_json is not None else json.dumps(trackr.DEFAULT_STATE),),
            )
        conn.commit()
        conn.close()

    def _assert_startup_recovery_backup(self, path, expected_state_json=None, label=None):
        source_before = path.read_bytes()
        backups_before = set((path.parent / "backups").glob("trackr-*.sqlite3"))
        trackr.DB_PATH = path
        with self.assertRaises(RuntimeError):
            trackr.init_db()
        self.assertEqual(path.read_bytes(), source_before)
        backups = list(set((path.parent / "backups").glob("trackr-*.sqlite3")) - backups_before)
        self.assertTrue(backups)
        if path.stat().st_size == 0:
            self.assertEqual(backups[0].read_bytes(), source_before)
        if label:
            self.assertTrue(any(label in backup.name for backup in backups))
        backup = backups[0]
        if expected_state_json is not None:
            backup_conn = sqlite3.connect(backup)
            preserved = backup_conn.execute("SELECT state_json FROM app_state WHERE id = 1").fetchone()[0]
            backup_conn.close()
            self.assertEqual(preserved, expected_state_json)

    def test_migrate_state_rejects_non_object_values(self):
        for value in (None, [], "state", 7, True):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    trackr.migrate_state(value)

    def test_existing_empty_database_is_backed_up_and_not_initialized(self):
        path = Path(self.tmp.name) / "empty.sqlite3"
        path.write_bytes(b"")
        self._assert_startup_recovery_backup(path, label="empty-database")
        self.assertEqual(path.read_bytes(), b"")

    def test_existing_database_without_state_table_is_backed_up(self):
        path = Path(self.tmp.name) / "no-state-table.sqlite3"
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE unrelated (value TEXT)")
        conn.commit()
        conn.close()
        self._assert_startup_recovery_backup(path, label="missing-state-table")

    def test_existing_database_without_state_row_is_backed_up(self):
        path = Path(self.tmp.name) / "no-state-row.sqlite3"
        self._create_state_database(path, include_row=False)
        self._assert_startup_recovery_backup(path, label="missing-state-row")

    def test_non_object_json_state_is_backed_up_and_not_replaced(self):
        non_object_values = ("[]", "null", '"state"', "7", "true", "{}")
        for index, raw_state in enumerate(non_object_values):
            with self.subTest(raw_state=raw_state):
                path = Path(self.tmp.name) / f"non-object-{index}.sqlite3"
                self._create_state_database(path, raw_state)
                self._assert_startup_recovery_backup(path, raw_state, "invalid-state")

    def test_nonexistent_database_initializes_default_state(self):
        path = Path(self.tmp.name) / "new-workspace.sqlite3"
        self.assertFalse(path.exists())
        trackr.DB_PATH = path
        trackr.init_db()
        conn = trackr.get_db()
        stored = conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0]
        conn.close()
        self.assertEqual(json.loads(stored), trackr.validate_state(copy.deepcopy(trackr.DEFAULT_STATE)))

    def test_wal_corruption_backup_is_standalone_and_consistent(self):
        path = Path(self.tmp.name) / "wal-corrupt.sqlite3"
        writer = sqlite3.connect(path)
        writer.execute("PRAGMA journal_mode = WAL")
        writer.execute(
            "CREATE TABLE app_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT)"
        )
        damaged_state = '{"version":10, broken'
        writer.execute(
            "INSERT INTO app_state (id, state_json, revision, updated_at) VALUES (1, ?, 1, 'now')",
            (damaged_state,),
        )
        writer.commit()
        wal_path = Path(f"{path}-wal")
        self.assertTrue(wal_path.exists())
        trackr.DB_PATH = path
        with self.assertRaisesRegex(RuntimeError, "malformed"):
            trackr.init_db()
        writer.close()

        backups = list((path.parent / "backups").glob("trackr-*-corrupt-state.sqlite3"))
        self.assertTrue(backups)
        backup = backups[0]
        self.assertNotIn("raw-fallback", backup.name)
        self.assertFalse(Path(f"{backup}-wal").exists())
        self.assertFalse(Path(f"{backup}-shm").exists())
        backup_conn = sqlite3.connect(backup)
        backed_up = backup_conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0]
        backup_conn.close()
        self.assertEqual(backed_up, damaged_state)

    def test_valid_json_but_invalid_state_is_backed_up_and_not_repaired(self):
        path = Path(self.tmp.name) / "invalid-state.sqlite3"
        raw_state = json.dumps({"version": 10, "people": [], "jobs": "not-a-list"})
        self._create_state_database(path, raw_state)
        self._assert_startup_recovery_backup(path, raw_state, "invalid-state")

    def test_migration_failure_is_backed_up_before_schema_changes(self):
        path = Path(self.tmp.name) / "migration-failure.sqlite3"
        raw_state = json.dumps({**trackr.DEFAULT_STATE, "version": "not-a-number"})
        self._create_state_database(path, raw_state)
        self._assert_startup_recovery_backup(path, raw_state, "invalid-state")

    def test_invalid_calendar_events_fail_closed_without_startup_rewrite(self):
        cases = (
            ("current missing", trackr.STATE_VERSION, False, None),
            ("current null", trackr.STATE_VERSION, True, None),
            ("current string", trackr.STATE_VERSION, True, "invalid event data"),
            ("current object", trackr.STATE_VERSION, True, {"savedEvent": "invalid"}),
            ("older malformed", 9, True, {"savedEvent": "invalid"}),
        )
        for index, (label, version, present, events) in enumerate(cases):
            with self.subTest(case=label):
                path = Path(self.tmp.name) / f"invalid-calendar-events-{index}.sqlite3"
                state = copy.deepcopy(trackr.DEFAULT_STATE)
                state["version"] = version
                if present:
                    state["calendarEvents"] = events
                else:
                    state.pop("calendarEvents")
                raw_state = json.dumps(state)
                self._create_state_database(path, raw_state)
                self._assert_startup_recovery_backup(path, raw_state, "invalid-state")
                conn = sqlite3.connect(path)
                try:
                    self.assertEqual(conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone(), (raw_state, 7))
                    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    self.assertNotIn("users", tables)
                finally:
                    conn.close()

    def test_older_state_missing_calendar_events_migrates_with_recovery_snapshot(self):
        path = Path(self.tmp.name) / "legacy-missing-calendar-events.sqlite3"
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        state["version"] = 9
        state.pop("calendarEvents")
        raw_state = json.dumps(state)
        self._create_state_database(path, raw_state)
        trackr.DB_PATH = path
        trackr.init_db()
        conn = sqlite3.connect(path)
        try:
            stored, revision = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
            self.assertEqual(json.loads(stored)["calendarEvents"], [])
            self.assertEqual(revision, 8)
        finally:
            conn.close()
        backup = next((path.parent / "backups").glob("trackr-*-pre-state-migration.sqlite3"))
        conn = sqlite3.connect(backup)
        try:
            self.assertEqual(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], raw_state)
        finally:
            conn.close()

    def test_older_valid_state_gets_pre_migration_backup_then_migrates(self):
        path = Path(self.tmp.name) / "old-state.sqlite3"
        old_state = copy.deepcopy(trackr.DEFAULT_STATE)
        old_state["version"] = 9
        old_state.pop("absenceOverrides", None)
        raw_state = json.dumps(old_state)
        self._create_state_database(path, raw_state)
        trackr.DB_PATH = path
        trackr.init_db()
        backup = next((path.parent / "backups").glob("trackr-*-pre-state-migration.sqlite3"))
        backup_conn = sqlite3.connect(backup)
        self.assertEqual(backup_conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], raw_state)
        backup_conn.close()
        conn = sqlite3.connect(path)
        migrated = json.loads(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0])
        revision = conn.execute("SELECT revision FROM app_state WHERE id=1").fetchone()[0]
        conn.close()
        self.assertEqual(migrated["version"], trackr.STATE_VERSION)
        self.assertEqual(migrated["absenceOverrides"], [])
        self.assertEqual(revision, 8)

    def test_failed_online_migration_backup_aborts_without_source_or_schema_changes(self):
        path = Path(self.tmp.name) / "backup-failure.sqlite3"
        old_state = copy.deepcopy(trackr.DEFAULT_STATE)
        old_state["version"] = 9
        old_state.pop("absenceOverrides", None)
        raw_state = json.dumps(old_state)
        self._create_state_database(path, raw_state)
        source_before = path.read_bytes()
        trackr.DB_PATH = path
        with mock.patch.object(
            trackr,
            "online_database_backup",
            side_effect=sqlite3.OperationalError("simulated backup failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "pre-migration recovery backup"):
                trackr.init_db()
        self.assertEqual(path.read_bytes(), source_before)
        conn = sqlite3.connect(path)
        self.assertEqual(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], raw_state)
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        conn.close()
        self.assertNotIn("users", tables)
        self.assertEqual(list((path.parent / "backups").glob("trackr-*.sqlite3")), [])

    def test_current_valid_state_is_not_rewritten_on_startup(self):
        path = Path(self.tmp.name) / "current-state.sqlite3"
        state = copy.deepcopy(trackr.DEFAULT_STATE)
        state_json = json.dumps(state, separators=(",", ":"))
        self._create_state_database(path, state_json)
        trackr.DB_PATH = path
        trackr.init_db()
        conn = sqlite3.connect(path)
        saved, revision = conn.execute("SELECT state_json, revision FROM app_state WHERE id=1").fetchone()
        conn.close()
        self.assertEqual(saved, state_json)
        self.assertEqual(revision, 7)

    def test_api_state_missing_row_is_controlled_and_never_inserts_default(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        conn.execute("DELETE FROM app_state WHERE id=1")
        conn.commit()
        conn.close()
        backups_before = list((trackr.DB_PATH.parent / "backups").glob("trackr-*.sqlite3"))
        get_response = self.client.get("/api/state")
        post_response = self.client.post("/api/state", json={"_revision": 1, **copy.deepcopy(trackr.DEFAULT_STATE)}, headers={"X-CSRF-Token": csrf})
        self.assertEqual(get_response.status_code, 500)
        self.assertEqual(post_response.status_code, 500)
        conn = trackr.get_db()
        self.assertIsNone(conn.execute("SELECT id FROM app_state WHERE id=1").fetchone())
        conn.close()
        self.assertEqual(list((trackr.DB_PATH.parent / "backups").glob("trackr-*.sqlite3")), backups_before)

    def test_api_state_non_object_and_invalid_json_return_recovery_error(self):
        csrf = self.login_admin()
        conn = trackr.get_db()
        conn.execute("UPDATE app_state SET state_json='null' WHERE id=1")
        conn.commit()
        conn.close()
        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 500)
        self.assertIn("Restore a database backup", response.get_json()["error"])
        replacement = {"_revision": 1, **copy.deepcopy(trackr.DEFAULT_STATE)}
        self.assertEqual(
            self.client.post("/api/state", json=replacement, headers={"X-CSRF-Token": csrf}).status_code,
            500,
        )
        conn = trackr.get_db()
        self.assertEqual(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], "null")
        conn.execute("UPDATE app_state SET state_json='not-json' WHERE id=1")
        conn.commit()
        conn.close()
        self.assertEqual(self.client.get("/api/state").status_code, 500)
        conn = trackr.get_db()
        self.assertEqual(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], "not-json")
        semantically_invalid = json.dumps({"version": 10, "people": [], "jobs": "bad"})
        conn.execute("UPDATE app_state SET state_json=? WHERE id=1", (semantically_invalid,))
        conn.commit()
        conn.close()
        response = self.client.get("/api/state")
        self.assertEqual(response.status_code, 500)
        conn = trackr.get_db()
        self.assertEqual(conn.execute("SELECT state_json FROM app_state WHERE id=1").fetchone()[0], semantically_invalid)
        conn.close()

    def test_health_reports_missing_or_invalid_state_as_unavailable(self):
        conn = trackr.get_db()
        conn.execute("DELETE FROM app_state WHERE id=1")
        conn.commit()
        conn.close()
        self.assertEqual(self.client.get("/health").status_code, 503)
        conn = trackr.get_db()
        conn.execute("INSERT INTO app_state (id, state_json, revision, updated_at) VALUES (1, '[]', 1, 'now')")
        conn.commit()
        conn.close()
        self.assertEqual(self.client.get("/health").status_code, 503)


if __name__ == "__main__":
    unittest.main()
