from __future__ import annotations

import copy
from io import BytesIO
import json
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import threading
import time
from collections import defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    session,
    url_for,
)
from pypdf import PdfReader
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

APP_DIR = Path(__file__).resolve().parent
IS_PRODUCTION = bool(os.environ.get("RAILWAY_ENVIRONMENT") or os.environ.get("TRACKR_ENV", "").lower() == "production")


def resolve_db_path() -> Path:
    explicit = os.environ.get("TRACKR_DB_PATH")
    if explicit:
        return Path(explicit).expanduser().resolve()
    volume_path = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
    if volume_path:
        return (Path(volume_path) / "trackr.sqlite3").resolve()
    return APP_DIR / "flow.sqlite3"


DB_PATH = resolve_db_path()
SEED_DB_PATH = APP_DIR / "flow.sqlite3"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

secret_key = os.environ.get("TRACKR_SECRET_KEY")
if IS_PRODUCTION and not secret_key:
    raise RuntimeError("TRACKR_SECRET_KEY is required in production.")
if IS_PRODUCTION and len(secret_key) < 32:
    raise RuntimeError("TRACKR_SECRET_KEY must be at least 32 characters in production.")
if not secret_key:
    secret_key = secrets.token_hex(32)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.secret_key = secret_key
app.config.update(
    MAX_CONTENT_LENGTH=15 * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PRODUCTION or os.environ.get("TRACKR_SECURE_COOKIES") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
)

ALLOWED_USER_ROLES = {"admin", "user"}
ALLOWED_EMPLOYEE_ROLES = {"Drafting", "Cabinet Making", "Machining", "Installer / Site", "Admin"}
ALLOWED_TASK_TYPES = {"capacity", "milestone", "admin"}
ALLOWED_JOB_STATUSES = {"Active", "Forecast", "On Hold", "Complete", "Planned", "Waiting", "In Progress"}
ALLOWED_TASK_STATUSES = {"Planned", "Forecast", "In Progress", "Complete", "Waiting", "Active", "On Hold"}
ALLOWED_DAY_STATUS_TYPES = {"Sick", "Away", "Holiday", "RDO"}
ALLOWED_EVENT_TYPES = {"Factory Closure", "Public Holiday", "Company Event"}
WEEK_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")
TEXT_MAX = 500
STATE_VERSION = 9
MAX_PEOPLE = 250
MAX_JOBS = 5000
MAX_TASKS = 30000
MAX_DAY_STATUSES = 10000
MAX_CALENDAR_EVENTS = 5000

_login_attempts: dict[str, deque[float]] = defaultdict(deque)
_login_attempts_lock = threading.Lock()
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_FAILURES = 8
DUMMY_PASSWORD_HASH = generate_password_hash(secrets.token_urlsafe(24))

DEFAULT_STATE = {
  "version": 9,
  "people": [
    {
      "customStart": "2026-06-08",
      "name": "Old Ben",
      "role": "Admin",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "customStart": "2026-06-08",
      "name": "Nick",
      "role": "Admin",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "customStart": "2026-06-08",
      "name": "Lewis",
      "role": "Drafting",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "name": "Kass",
      "role": "Drafting",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "customStart": "2026-08-03",
      "name": "Adrian",
      "role": "Machining",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 0,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Custom"
    },
    {
      "customStart": "2026-06-08",
      "name": "Adam",
      "role": "Cabinet Making",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 0,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "name": "Luke",
      "role": "Cabinet Making",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "name": "Bohde",
      "role": "Cabinet Making",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "customStart": "2026-06-08",
      "name": "Luke F.",
      "role": "Cabinet Making",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    },
    {
      "customStart": "2026-06-08",
      "name": "Young Ben",
      "role": "Cabinet Making",
      "week": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week1": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "week2": {
        "Fri": 340,
        "Mon": 460,
        "Thu": 460,
        "Tue": 460,
        "Wed": 460
      },
      "workPattern": "Standard"
    }
  ],
  "jobs": [],
  "tasks": [],
  "dayStatuses": [],
  "calendarEvents": []
}

DEMO_JOBS_TO_REMOVE = {"J1003", "J1004", "J1005", "J1006"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def valid_iso_date(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        date.fromisoformat(value)
        return True
    except ValueError:
        return False


def clean_text(value: object, field: str, *, max_length: int = TEXT_MAX, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{field} is required.")
    if len(value) > max_length:
        raise ValueError(f"{field} is too long.")
    if any(ord(char) < 32 and char not in "\n\r\t" for char in value):
        raise ValueError(f"{field} contains invalid characters.")
    # Defence in depth for the legacy single-page renderer. The frontend also
    # escapes values, but persisted HTML-like content is rejected at the API.
    if "<" in value or ">" in value:
        raise ValueError(f"{field} cannot contain angle brackets.")
    return value


def require_number(value: object, field: str, minimum: float = 0, maximum: float = 10_000_000) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number.")
    number = float(value)
    if number < minimum or number > maximum:
        raise ValueError(f"{field} is outside the allowed range.")
    return number


def validate_week(value: object, field: str) -> None:
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object.")
    for day_name in WEEK_DAYS:
        minutes = value.get(day_name, 0)
        require_number(minutes, f"{field}.{day_name}", 0, 24 * 60)


def validate_state(payload: object) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("Invalid workspace state.")
    state = copy.deepcopy(payload)
    state.pop("_revision", None)

    for key, maximum in (
        ("people", MAX_PEOPLE),
        ("jobs", MAX_JOBS),
        ("tasks", MAX_TASKS),
        ("dayStatuses", MAX_DAY_STATUSES),
        ("calendarEvents", MAX_CALENDAR_EVENTS),
    ):
        if not isinstance(state.get(key), list):
            raise ValueError(f"Missing {key} list.")
        if len(state[key]) > maximum:
            raise ValueError(f"Too many {key} records.")

    people_names: set[str] = set()
    people_roles: dict[str, str] = {}
    people_capacity: dict[str, bool] = {}
    for index, person in enumerate(state["people"]):
        if not isinstance(person, dict):
            raise ValueError(f"Employee {index + 1} is invalid.")
        name = clean_text(person.get("name"), "Employee name", max_length=80, required=True)
        key = name.casefold()
        if key in people_names:
            raise ValueError(f"Duplicate employee name: {name}.")
        people_names.add(key)
        role = person.get("role")
        if role not in ALLOWED_EMPLOYEE_ROLES:
            raise ValueError(f"Invalid department for {name}.")
        counts_capacity = person.get("countsCapacity", role != "Admin")
        if not isinstance(counts_capacity, bool):
            raise ValueError(f"Capacity setting for {name} must be yes or no.")
        if role == "Admin" and counts_capacity:
            raise ValueError(f"Admin employee {name} cannot count toward capacity.")
        person["countsCapacity"] = counts_capacity
        people_roles[name] = role
        people_capacity[name] = counts_capacity
        pattern = person.get("workPattern", "Standard")
        if pattern not in {"Standard", "Custom"}:
            raise ValueError(f"Invalid work pattern for {name}.")
        validate_week(person.get("week", {}), f"{name} standard week")
        if pattern == "Custom":
            validate_week(person.get("week1", person.get("week", {})), f"{name} week 1")
            validate_week(person.get("week2", person.get("week", {})), f"{name} week 2")
            if person.get("customStart") and not valid_iso_date(person.get("customStart")):
                raise ValueError(f"Invalid custom roster start date for {name}.")
        capacity_overrides = person.get("capacityOverrides", {}) or {}
        if not isinstance(capacity_overrides, dict) or len(capacity_overrides) > 2000:
            raise ValueError(f"Invalid capacity overrides for {name}.")
        cleaned_overrides: dict[str, int] = {}
        for iso_value, minutes in capacity_overrides.items():
            if not valid_iso_date(iso_value):
                raise ValueError(f"Invalid capacity override date for {name}.")
            cleaned_overrides[iso_value] = int(round(require_number(minutes, f"Capacity override for {name} on {iso_value}", 0, 24 * 60)))
        person["capacityOverrides"] = cleaned_overrides

    job_ids: set[str] = set()
    for index, job in enumerate(state["jobs"]):
        if not isinstance(job, dict):
            raise ValueError(f"Job {index + 1} is invalid.")
        job_id = clean_text(job.get("id"), "Job number", max_length=64, required=True)
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,63}", job_id):
            raise ValueError(f"Job number {job_id!r} contains unsupported characters.")
        if job_id.casefold() in job_ids:
            raise ValueError(f"Duplicate job number: {job_id}.")
        job_ids.add(job_id.casefold())
        clean_text(job.get("address"), f"Address for {job_id}", max_length=300, required=True)
        clean_text(job.get("builder", ""), f"Builder for {job_id}", max_length=160)
        clean_text(job.get("notes", ""), f"Notes for {job_id}", max_length=3000)
        labour_hours = job.get("labourHours", {})
        if not isinstance(labour_hours, dict):
            raise ValueError(f"Invalid labour hours for {job_id}.")
        allowed_labour_hours = {"checkMeasure", "drafting", "machining", "assembly", "loading", "delivery"}
        if not set(labour_hours).issubset(allowed_labour_hours):
            raise ValueError(f"Invalid labour hour category for {job_id}.")
        job["labourHours"] = {
            key: require_number(value, f"{job_id} {key} labour hours", 0, 100_000)
            for key, value in labour_hours.items()
        }
        excluded_stages = job.get("excludedStages", [])
        if not isinstance(excluded_stages, list) or len(excluded_stages) > 50:
            raise ValueError(f"Invalid excluded stages for {job_id}.")
        cleaned_excluded_stages: list[str] = []
        seen_excluded_stages: set[str] = set()
        for stage_name in excluded_stages:
            cleaned_name = clean_text(stage_name, f"Excluded stage for {job_id}", max_length=140, required=True)
            if cleaned_name.casefold() not in seen_excluded_stages:
                cleaned_excluded_stages.append(cleaned_name)
                seen_excluded_stages.add(cleaned_name.casefold())
        job["excludedStages"] = cleaned_excluded_stages
        job_status = clean_text(job.get("status", "Active"), f"Status for {job_id}", max_length=40)
        if job_status not in ALLOWED_JOB_STATUSES:
            raise ValueError(f"Invalid status for {job_id}.")
        if job.get("installDate") and not valid_iso_date(job.get("installDate")):
            raise ValueError(f"Invalid install date for {job_id}.")

    task_ids: set[str] = set()
    exact_people_names = set(people_roles)
    for index, task in enumerate(state["tasks"]):
        if not isinstance(task, dict):
            raise ValueError(f"Task {index + 1} is invalid.")
        task_id = clean_text(task.get("id"), "Task ID", max_length=140, required=True)
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,140}", task_id):
            raise ValueError(f"Task ID {task_id!r} contains unsupported characters.")
        if task_id in task_ids:
            raise ValueError(f"Duplicate task ID: {task_id}.")
        task_ids.add(task_id)
        task.pop("parts", None)
        task.pop("unscheduledMinutes", None)
        task_type = task.get("type")
        if task_type not in ALLOWED_TASK_TYPES:
            raise ValueError(f"Invalid task type for {task_id}.")
        clean_text(task.get("job"), f"Job for {task_id}", max_length=160, required=True)
        clean_text(task.get("name"), f"Name for {task_id}", max_length=140, required=True)
        show_on_calendar = task.get("showOnCalendar", False)
        if not isinstance(show_on_calendar, bool):
            raise ValueError(f"Calendar setting for {task_id} must be yes or no.")
        task["showOnCalendar"] = show_on_calendar if task_type == "capacity" else False
        clean_text(task.get("department", ""), f"Department for {task_id}", max_length=80)
        task_status = clean_text(task.get("status", "Planned"), f"Status for {task_id}", max_length=40)
        if task_status not in ALLOWED_TASK_STATUSES:
            raise ValueError(f"Invalid status for {task_id}.")
        clean_text(task.get("notes", ""), f"Notes for {task_id}", max_length=2000)
        task["stoneMason"] = clean_text(task.get("stoneMason", ""), f"Stone mason for {task_id}", max_length=160)
        require_number(task.get("duration", 0), f"Duration for {task_id}", 0, 5_000_000)
        if task.get("date") and not valid_iso_date(task.get("date")):
            raise ValueError(f"Invalid date for {task_id}.")
        if task.get("endDate") and not valid_iso_date(task.get("endDate")):
            raise ValueError(f"Invalid end date for {task_id}.")
        assigned = task.get("assigned", [])
        if not isinstance(assigned, list) or len(assigned) > MAX_PEOPLE:
            raise ValueError(f"Invalid employee assignments for {task_id}.")
        if len(set(assigned)) != len(assigned):
            raise ValueError(f"Duplicate employee assignment for {task_id}.")
        for employee in assigned:
            if employee not in exact_people_names:
                raise ValueError(f"Task {task_id} refers to missing employee {employee}.")
        if task_type == "capacity":
            # Unassigned capacity tasks are valid. They remain visible in the
            # Schedule's Unassigned row until an employee is chosen later.
            if any(people_roles.get(employee) == "Admin" or not people_capacity.get(employee, False) for employee in assigned):
                raise ValueError(f"Capacity task {task_id} can only be assigned to capacity employees.")
        if task_type == "milestone":
            if any(people_roles.get(employee) == "Admin" or people_capacity.get(employee, False) for employee in assigned):
                raise ValueError(f"Calendar-only task {task_id} can only be assigned to non-capacity employees.")
        if task_type == "admin":
            if len(assigned) != 1 or people_roles.get(assigned[0]) != "Admin":
                raise ValueError(f"Admin calendar task {task_id} must have one Admin employee.")
        schedule_order = task.get("scheduleOrder", {}) or {}
        if not isinstance(schedule_order, dict):
            raise ValueError(f"Invalid schedule order for {task_id}.")
        if not set(schedule_order).issubset(set(assigned)):
            raise ValueError(f"Schedule order for {task_id} contains an unassigned employee.")
        task["scheduleOrder"] = {
            employee: require_number(value, f"{task_id} schedule order for {employee}", 0, 1_000_000_000)
            for employee, value in schedule_order.items()
        }
        for map_name in ("assignmentMinutes", "assignmentDates"):
            mapping = task.get(map_name, {}) or {}
            if not isinstance(mapping, dict):
                raise ValueError(f"Invalid {map_name} for {task_id}.")
            if not set(mapping).issubset(set(assigned)):
                raise ValueError(f"{map_name} for {task_id} contains an unassigned employee.")
            if map_name == "assignmentMinutes":
                for employee, minutes in mapping.items():
                    require_number(minutes, f"{task_id} allocation for {employee}", 0, 5_000_000)
                if mapping and task_type == "capacity":
                    if set(mapping) != set(assigned):
                        raise ValueError(f"Every assigned employee needs an hours allocation for {task_id}.")
                    allocated = sum(float(value) for value in mapping.values())
                    if abs(allocated - float(task.get("duration", 0))) > 1:
                        raise ValueError(f"Employee allocations must equal the task duration for {task_id}.")
            else:
                for employee, iso_value in mapping.items():
                    if not valid_iso_date(iso_value):
                        raise ValueError(f"Invalid assignment date for {employee} on {task_id}.")

    for index, status in enumerate(state["dayStatuses"]):
        if not isinstance(status, dict):
            raise ValueError(f"Blocked day {index + 1} is invalid.")
        person = clean_text(status.get("person"), "Blocked-day employee", max_length=80, required=True)
        if person not in exact_people_names:
            raise ValueError(f"Blocked day refers to missing employee {person}.")
        if status.get("type") not in ALLOWED_DAY_STATUS_TYPES:
            raise ValueError(f"Invalid blocked-day type for {person}.")
        start_date = status.get("startDate")
        end_date = status.get("endDate") or start_date
        if not valid_iso_date(start_date) or not valid_iso_date(end_date) or end_date < start_date:
            raise ValueError(f"Invalid blocked date range for {person}.")

    event_ids: set[str] = set()
    for index, event in enumerate(state["calendarEvents"]):
        if not isinstance(event, dict):
            raise ValueError(f"Calendar event {index + 1} is invalid.")
        event_id = clean_text(event.get("id"), "Calendar event ID", max_length=140, required=True)
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{1,140}", event_id) or event_id in event_ids:
            raise ValueError("Calendar event IDs must be unique and use supported characters.")
        event_ids.add(event_id)
        clean_text(event.get("name"), "Calendar event name", max_length=160, required=True)
        if event.get("type") not in ALLOWED_EVENT_TYPES:
            raise ValueError(f"Invalid calendar event type for {event_id}.")
        start_date = event.get("startDate")
        end_date = event.get("endDate") or start_date
        if not valid_iso_date(start_date) or not valid_iso_date(end_date) or end_date < start_date:
            raise ValueError(f"Invalid calendar event dates for {event_id}.")

    state["version"] = STATE_VERSION
    return state



def is_stone_task_name(value: object) -> bool:
    return "stone" in str(value or "").strip().casefold()


def default_calendar_stage(value: object) -> bool:
    name = str(value or "").strip().casefold()
    if "stone" in name:
        return False
    return (
        "check measure" in name
        or name == "delivery"
        or name.endswith(" delivery")
        or name == "install"
        or name.endswith(" install")
    )


def department_for_stage(value: object, fallback: object = "Cabinet Making") -> str:
    name = str(value or "").strip().casefold()
    if "check measure" in name or ("install" in name and "stone" not in name):
        return "Installer / Site"
    if "draft" in name or "forward ordering" in name or name == "ordering":
        return "Drafting"
    if "machin" in name or "machine 2pak" in name:
        return "Machining"
    if "assembl" in name or "load" in name or "deliver" in name or "prep 2pak" in name:
        return "Cabinet Making"
    fallback_text = str(fallback or "")
    return fallback_text if fallback_text in ALLOWED_EMPLOYEE_ROLES and fallback_text != "Admin" else "Cabinet Making"

def migrate_state(state: object) -> tuple[dict, bool]:
    if not isinstance(state, dict):
        return copy.deepcopy(DEFAULT_STATE), True
    changed = False
    current_version = int(state.get("version", 0) or 0)
    if current_version < 4:
        state["jobs"] = [job for job in state.get("jobs", []) if job.get("id") not in DEMO_JOBS_TO_REMOVE]
        state["tasks"] = [task for task in state.get("tasks", []) if task.get("job") not in DEMO_JOBS_TO_REMOVE]
        changed = True
    if not isinstance(state.get("calendarEvents"), list):
        state["calendarEvents"] = []
        changed = True
    if current_version < 7:
        for person in state.get("people", []):
            if isinstance(person, dict) and not isinstance(person.get("countsCapacity"), bool):
                person["countsCapacity"] = person.get("role") != "Admin"
                changed = True
        for task in state.get("tasks", []):
            if isinstance(task, dict) and not isinstance(task.get("showOnCalendar"), bool):
                task["showOnCalendar"] = False
                changed = True
    if current_version < 8:
        # Capacity placement used to search forward for spare time. Reset active
        # task shares to the date users originally selected so the new planner
        # starts from the stored planned date and permits over-capacity stacking.
        for task in state.get("tasks", []):
            if not isinstance(task, dict):
                continue
            if not isinstance(task.get("stoneMason"), str):
                task["stoneMason"] = ""
                changed = True
            if task.get("type") != "capacity" or task.get("status") == "Complete":
                continue
            planned_date = task.get("date")
            assigned = [name for name in task.get("assigned", []) if isinstance(name, str) and name]
            if valid_iso_date(planned_date) and assigned:
                reset_dates = {name: planned_date for name in assigned}
                if task.get("assignmentDates") != reset_dates:
                    task["assignmentDates"] = reset_dates
                    changed = True
    if current_version < 9:
        # Workflow v9: every generated non-stone stage is a capacity task.
        # Stone work remains calendar-only. Check Measure, Delivery and Install
        # are linked to Calendar by default. Existing dates and usable capacity
        # assignments are preserved; incomplete converted stages stay visible
        # with zero hours or no employee so users can finish them deliberately.
        jobs_by_id = {
            str(job.get("id")): job
            for job in state.get("jobs", [])
            if isinstance(job, dict) and job.get("id") is not None
        }
        people_by_name = {
            str(person.get("name")): person
            for person in state.get("people", [])
            if isinstance(person, dict) and person.get("name")
        }
        capacity_names = {
            name for name, person in people_by_name.items()
            if person.get("role") != "Admin" and person.get("countsCapacity", person.get("role") != "Admin") is not False
        }
        non_capacity_names = {
            name for name, person in people_by_name.items()
            if person.get("role") != "Admin" and person.get("countsCapacity", person.get("role") != "Admin") is False
        }
        for task in state.get("tasks", []):
            if not isinstance(task, dict):
                continue
            if not isinstance(task.get("showOnCalendar"), bool):
                task["showOnCalendar"] = False
                changed = True
            if not isinstance(task.get("stoneMason"), str):
                task["stoneMason"] = ""
                changed = True
            task_name = task.get("name", "")
            stone_task = is_stone_task_name(task_name)
            job = jobs_by_id.get(str(task.get("job")), {})
            historical = task.get("status") == "Complete" or job.get("status") == "Complete"
            generated_stage = not bool(task.get("custom", False))

            if historical:
                continue

            if stone_task and task.get("type") != "milestone":
                kept = [name for name in task.get("assigned", []) if name in non_capacity_names]
                task["type"] = "milestone"
                task["department"] = "Milestone"
                task["duration"] = 0
                task["estimatedHours"] = 0
                task["assigned"] = kept
                task["assignmentMinutes"] = {}
                task["assignmentDates"] = {
                    name: task.get("date") for name in kept if valid_iso_date(task.get("date"))
                }
                task["showOnCalendar"] = False
                changed = True
                continue

            if generated_stage and not stone_task and task.get("type") == "admin":
                duration = max(0, float(task.get("duration", 0) or 0))
                estimated = max(0, float(task.get("estimatedHours", 0) or 0))
                if duration <= 0 and estimated > 0:
                    duration = round(estimated * 60)
                if estimated <= 0 and duration > 0:
                    estimated = duration / 60
                task["type"] = "capacity"
                task["department"] = department_for_stage(task_name, task.get("stageDepartment") or task.get("department"))
                task["stageGroup"] = task.get("stageGroup") or task_name
                task["stageDepartment"] = task["department"]
                task["stageTotalHours"] = float(task.get("stageTotalHours", estimated) or estimated)
                task["duration"] = round(duration)
                task["estimatedHours"] = estimated
                task["assigned"] = []
                task["assignmentMinutes"] = {}
                task["assignmentDates"] = {}
                task["showOnCalendar"] = default_calendar_stage(task_name)
                task.pop("adminEmployee", None)
                task.pop("adminTask", None)
                changed = True
                continue

            if generated_stage and not stone_task and task.get("type") == "milestone":
                kept = [name for name in task.get("assigned", []) if name in capacity_names]
                duration = max(0, float(task.get("duration", 0) or 0))
                estimated = max(0, float(task.get("estimatedHours", 0) or 0))
                if duration <= 0 and estimated > 0:
                    duration = round(estimated * 60)
                if estimated <= 0 and duration > 0:
                    estimated = duration / 60
                task["type"] = "capacity"
                task["department"] = department_for_stage(task_name, task.get("department"))
                task["stageGroup"] = task.get("stageGroup") or task_name
                task["stageDepartment"] = task.get("stageDepartment") or task["department"]
                task["stageTotalHours"] = float(task.get("stageTotalHours", estimated) or estimated)
                task["duration"] = round(duration)
                task["estimatedHours"] = estimated
                task["assigned"] = kept
                if kept:
                    base = int(duration) // len(kept) if kept else 0
                    remainder = int(duration) - (base * len(kept))
                    allocations: dict[str, int] = {}
                    for name in kept:
                        allocations[name] = base + (1 if remainder > 0 else 0)
                        if remainder > 0:
                            remainder -= 1
                    task["assignmentMinutes"] = allocations
                    task["assignmentDates"] = {
                        name: task.get("date") for name in kept if valid_iso_date(task.get("date"))
                    }
                else:
                    task["assignmentMinutes"] = {}
                    task["assignmentDates"] = {}
                task["showOnCalendar"] = default_calendar_stage(task_name)
                changed = True
                continue

            if task.get("type") == "capacity" and not stone_task:
                desired_calendar = bool(task.get("showOnCalendar")) or default_calendar_stage(task_name)
                if task.get("showOnCalendar") != desired_calendar:
                    task["showOnCalendar"] = desired_calendar
                    changed = True
                desired_department = department_for_stage(task_name, task.get("department"))
                if task_name and ("check measure" in str(task_name).casefold() or ("install" in str(task_name).casefold() and "stone" not in str(task_name).casefold())) and task.get("department") != desired_department:
                    task["department"] = desired_department
                    task["stageDepartment"] = desired_department
                    changed = True
        changed = True
    if current_version < STATE_VERSION:
        state["version"] = STATE_VERSION
        changed = True
    return state, changed

def read_pdf_text(file_stream) -> str:
    reader = PdfReader(file_stream, strict=False)
    return "\n".join((page.extract_text() or "") for page in reader.pages)


def extract_quote_no(text: str) -> str:
    match = re.search(r"Quote\s+No:\s*([A-Za-z0-9\-]+)", text, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def extract_quote_name(text: str) -> str:
    match = re.search(r"Quote\s+Name:\s*(.+?)(?:\n\s*Date:|\n\s*Page|\n\s*Labour Items|\n)", text, re.IGNORECASE | re.DOTALL)
    if match:
        return " ".join(match.group(1).split()).strip(" ,")
    match = re.search(r"Reporting\s+On\s+Section:\s*(.+?)(?:\n\s*Quote\s+No:|\n)", text, re.IGNORECASE | re.DOTALL)
    return " ".join(match.group(1).split()).strip(" ,") if match else ""


def extract_pdf_date(text: str) -> str:
    match = re.search(r"Date:\s*(\d{1,2}/\d{1,2}/\d{4})", text, re.IGNORECASE)
    return match.group(1).strip() if match else ""


def extract_labour_hours(text: str, label: str) -> float:
    pattern = rf"{re.escape(label)}\s*-.*?\bhr\s+\$?[\d,]+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s+\$"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    if match:
        return float(match.group(1))
    compact_text = " ".join(text.split())
    match = re.search(pattern, compact_text, re.IGNORECASE)
    return float(match.group(1)) if match else 0.0


def parse_estimate_pdf(file_stream) -> dict:
    text = read_pdf_text(file_stream)
    assembly_hours = extract_labour_hours(text, "Assembly")
    cnc_hours = extract_labour_hours(text, "CNC Machine")
    delivery_hours = extract_labour_hours(text, "Delivery")
    drafting_hours = extract_labour_hours(text, "Drafting")
    edgebander_hours = extract_labour_hours(text, "Edgebander")
    loading_hours = extract_labour_hours(text, "Loading")
    qc_hours = extract_labour_hours(text, "QC")
    site_measure_hours = extract_labour_hours(text, "Site Measure")
    unloading_hours = extract_labour_hours(text, "Unloading")
    return {
        "quote_no": extract_quote_no(text),
        "quote_name": extract_quote_name(text),
        "estimate_date": extract_pdf_date(text),
        "assembly_hours": assembly_hours,
        "cnc_hours": cnc_hours,
        "delivery_hours": delivery_hours,
        "drafting_hours": drafting_hours,
        "edgebander_hours": edgebander_hours,
        "loading_hours": loading_hours,
        "qc_hours": qc_hours,
        "site_measure_hours": site_measure_hours,
        "unloading_hours": unloading_hours,
        "check_measure_hours": site_measure_hours,
        "drafting_total_hours": drafting_hours + qc_hours,
        "machining_hours": cnc_hours + edgebander_hours,
        "assembly_total_hours": assembly_hours,
        "loading_total_hours": loading_hours,
        "delivery_total_hours": delivery_hours + unloading_hours,
        "install_total_hours": 0,
    }


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=20)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 20000")
    return conn


def ensure_database_file() -> None:
    if DB_PATH.exists():
        return
    if DB_PATH != SEED_DB_PATH and SEED_DB_PATH.exists():
        shutil.copy2(SEED_DB_PATH, DB_PATH)


def add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def generate_bootstrap_password() -> str:
    return secrets.token_urlsafe(18)


def init_db() -> None:
    ensure_database_file()
    conn = get_db()
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS app_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                state_json TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        add_column_if_missing(conn, "app_state", "revision", "INTEGER NOT NULL DEFAULT 1")
        add_column_if_missing(conn, "app_state", "updated_at", "TEXT")
        conn.execute("UPDATE app_state SET updated_at = COALESCE(updated_at, ?)", (utc_now_iso(),))
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
                session_version INTEGER NOT NULL DEFAULT 1,
                must_change_password INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        add_column_if_missing(conn, "users", "session_version", "INTEGER NOT NULL DEFAULT 1")
        add_column_if_missing(conn, "users", "must_change_password", "INTEGER NOT NULL DEFAULT 0")

        existing = conn.execute("SELECT state_json FROM app_state WHERE id = 1").fetchone()
        if not existing:
            state = copy.deepcopy(DEFAULT_STATE)
            conn.execute(
                "INSERT INTO app_state (id, state_json, revision, updated_at) VALUES (1, ?, 1, ?)",
                (json.dumps(state, separators=(",", ":")), utc_now_iso()),
            )
        else:
            try:
                stored_state = json.loads(existing["state_json"])
            except (json.JSONDecodeError, TypeError):
                backup_database(conn=conn, label="corrupt-state")
                stored_state = copy.deepcopy(DEFAULT_STATE)
                changed = True
            else:
                try:
                    stored_version = int(stored_state.get("version", 0) or 0) if isinstance(stored_state, dict) else 0
                except (TypeError, ValueError):
                    stored_version = 0
                if stored_version < STATE_VERSION:
                    conn.commit()
                    backup_label = "pre-v9-workflow-conversion" if stored_version < 9 else "pre-state-migration"
                    backup_database(label=backup_label, force=True)
                stored_state, changed = migrate_state(stored_state)
            try:
                validated_state = validate_state(stored_state)
            except ValueError as exc:
                backup_database(conn=conn, label="invalid-state", force=True)
                raise RuntimeError(f"Stored TrackR state failed validation: {exc}") from exc
            if validated_state != stored_state:
                stored_state = validated_state
                changed = True
            if changed:
                conn.execute(
                    "UPDATE app_state SET state_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1",
                    (json.dumps(stored_state, separators=(",", ":")), utc_now_iso()),
                )

        user_count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
        if user_count == 0:
            username = validate_username(os.environ.get("TRACKR_BOOTSTRAP_ADMIN_USERNAME", "admin")) or "admin"
            password = os.environ.get("TRACKR_BOOTSTRAP_ADMIN_PASSWORD")
            if not password:
                if IS_PRODUCTION:
                    raise RuntimeError("TRACKR_BOOTSTRAP_ADMIN_PASSWORD is required when creating the first production admin.")
                password = generate_bootstrap_password()
                app.logger.warning("New local TrackR admin created: username=%s temporary_password=%s", username, password)
            if not validate_password(password):
                raise RuntimeError("TRACKR_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.")
            conn.execute(
                "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 1)",
                (username, generate_password_hash(password)),
            )
            factory_username = validate_username(os.environ.get("TRACKR_BOOTSTRAP_FACTORY_USERNAME", ""))
            factory_password = os.environ.get("TRACKR_BOOTSTRAP_FACTORY_PASSWORD")
            if factory_username and factory_password:
                if not validate_password(factory_password):
                    raise RuntimeError("TRACKR_BOOTSTRAP_FACTORY_PASSWORD must be at least 12 characters.")
                conn.execute(
                    "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'user', 1)",
                    (factory_username, generate_password_hash(factory_password)),
                )
        conn.commit()
    finally:
        conn.close()


def backup_database(*, conn: sqlite3.Connection | None = None, label: str = "auto", force: bool = False) -> Path | None:
    backup_dir = DB_PATH.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(backup_dir.glob("trackr-*.sqlite3"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not force and existing and time.time() - existing[0].stat().st_mtime < 6 * 60 * 60:
        return None
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_label = re.sub(r"[^A-Za-z0-9_-]+", "-", label)[:30]
    target = backup_dir / f"trackr-{timestamp}-{safe_label}.sqlite3"
    source = conn or get_db()
    owns_source = conn is None
    destination = sqlite3.connect(target)
    try:
        source.backup(destination)
    finally:
        destination.close()
        if owns_source:
            source.close()
    for old_backup in sorted(backup_dir.glob("trackr-*.sqlite3"), key=lambda path: path.stat().st_mtime, reverse=True)[10:]:
        old_backup.unlink(missing_ok=True)
    return target


def csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def validate_csrf() -> bool:
    submitted = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
    expected = session.get("csrf_token")
    return bool(submitted and expected and secrets.compare_digest(str(submitted), str(expected)))


@app.before_request
def protect_requests():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.endpoint not in {"health"}:
        if not validate_csrf():
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Security token expired. Refresh TrackR and try again."}), 400
            return "Invalid security token", 400
    user = get_current_user()
    if user and user.get("must_change_password") and request.endpoint not in {"change_password", "logout", "health", "static"}:
        if request.path.startswith("/api/"):
            return jsonify({"ok": False, "error": "Password change required."}), 403
        return redirect(url_for("change_password"))
    return None


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    )
    if IS_PRODUCTION:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


def get_current_user() -> dict | None:
    user_id = session.get("user_id")
    if not user_id:
        return None
    conn = get_db()
    row = conn.execute(
        "SELECT id, username, role, session_version, must_change_password FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    conn.close()
    if not row or session.get("session_version") != row["session_version"]:
        session.clear()
        return None
    return dict(row)


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = get_current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Login required"}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = get_current_user()
        if not user:
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Login required"}), 401
            return redirect(url_for("login"))
        if user["role"] != "admin":
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Admin access required"}), 403
            return redirect(url_for("index"))
        return view(*args, **kwargs)
    return wrapped


def validate_username(value: object) -> str | None:
    username = str(value or "").strip()
    return username if re.fullmatch(r"[A-Za-z0-9._-]{3,32}", username) else None


def validate_password(value: object) -> str | None:
    password = str(value or "")
    if len(password) < 12 or len(password) > 200:
        return None
    return password


def login_key(username: str) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    remote = forwarded or request.remote_addr or "unknown"
    return f"{remote}|{username.casefold()}"


def is_login_limited(key: str) -> bool:
    cutoff = time.time() - LOGIN_WINDOW_SECONDS
    with _login_attempts_lock:
        attempts = _login_attempts[key]
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        return len(attempts) >= LOGIN_MAX_FAILURES


def record_login_failure(key: str) -> None:
    with _login_attempts_lock:
        _login_attempts[key].append(time.time())


def clear_login_failures(key: str) -> None:
    with _login_attempts_lock:
        _login_attempts.pop(key, None)


@app.route("/login", methods=["GET", "POST"])
def login():
    if get_current_user():
        return redirect(url_for("index"))
    error = ""
    username = ""
    if request.method == "POST":
        username = str(request.form.get("username", "")).strip()
        password = str(request.form.get("password", ""))
        key = login_key(username)
        if is_login_limited(key):
            error = "Too many failed attempts. Wait 15 minutes and try again."
        else:
            conn = get_db()
            row = conn.execute(
                "SELECT id, username, password_hash, role, session_version, must_change_password FROM users WHERE username = ? COLLATE NOCASE",
                (username,),
            ).fetchone()
            conn.close()
            password_ok = check_password_hash(row["password_hash"] if row else DUMMY_PASSWORD_HASH, password)
            if row and password_ok:
                clear_login_failures(key)
                session.clear()
                session.permanent = True
                session["user_id"] = row["id"]
                session["session_version"] = row["session_version"]
                csrf_token()
                return redirect(url_for("change_password" if row["must_change_password"] else "index"))
            record_login_failure(key)
            error = "Incorrect username or password."
    return render_template("login.html", error=error, username=username, csrf_token=csrf_token())


@app.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    user = get_current_user()
    error = ""
    if request.method == "POST":
        current_password = str(request.form.get("current_password", ""))
        new_password = validate_password(request.form.get("new_password"))
        confirm_password = str(request.form.get("confirm_password", ""))
        conn = get_db()
        row = conn.execute("SELECT password_hash, session_version FROM users WHERE id = ?", (user["id"],)).fetchone()
        if not row or not check_password_hash(row["password_hash"], current_password):
            error = "Current password is incorrect."
        elif not new_password:
            error = "New password must be at least 12 characters."
        elif new_password != confirm_password:
            error = "New passwords do not match."
        elif check_password_hash(row["password_hash"], new_password):
            error = "Choose a password you have not already used."
        else:
            new_version = row["session_version"] + 1
            conn.execute(
                "UPDATE users SET password_hash = ?, session_version = ?, must_change_password = 0 WHERE id = ?",
                (generate_password_hash(new_password), new_version, user["id"]),
            )
            conn.commit()
            session["session_version"] = new_version
            conn.close()
            return redirect(url_for("index"))
        conn.close()
    return render_template("change_password.html", error=error, current_user=user, csrf_token=csrf_token())


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/health")
def health():
    try:
        conn = get_db()
        result = conn.execute("PRAGMA quick_check").fetchone()[0]
        conn.close()
        if result != "ok":
            raise RuntimeError(result)
        return jsonify({"ok": True, "service": "TrackR"})
    except Exception:
        app.logger.exception("Health check failed")
        return jsonify({"ok": False}), 503


@app.route("/")
@login_required
def index():
    return render_template("index.html", current_user=get_current_user(), csrf_token=csrf_token())


@app.get("/api/session")
@login_required
def get_session():
    return jsonify({"ok": True, "user": get_current_user(), "csrf_token": csrf_token()})


@app.get("/api/users")
@admin_required
def list_users():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, username, role, must_change_password, created_at FROM users ORDER BY LOWER(username)"
    ).fetchall()
    conn.close()
    current_user = get_current_user()
    return jsonify({
        "ok": True,
        "users": [
            {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "must_change_password": bool(row["must_change_password"]),
                "created_at": row["created_at"],
                "is_current": row["id"] == current_user["id"],
            }
            for row in rows
        ],
    })


@app.post("/api/users")
@admin_required
def create_user():
    payload = request.get_json(silent=True) or {}
    username = validate_username(payload.get("username"))
    password = validate_password(payload.get("password"))
    role = payload.get("role")
    if not username:
        return jsonify({"ok": False, "error": "Username must be 3-32 characters using letters, numbers, dots, dashes or underscores."}), 400
    if not password:
        return jsonify({"ok": False, "error": "Temporary password must be at least 12 characters."}), 400
    if role not in ALLOWED_USER_ROLES:
        return jsonify({"ok": False, "error": "Invalid role."}), 400
    conn = get_db()
    try:
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)",
            (username, generate_password_hash(password), role),
        )
        conn.commit()
        user_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"ok": False, "error": "That username already exists."}), 409
    conn.close()
    return jsonify({"ok": True, "id": user_id})


@app.patch("/api/users/<int:user_id>")
@admin_required
def update_user(user_id: int):
    payload = request.get_json(silent=True) or {}
    current_user = get_current_user()
    conn = get_db()
    target = conn.execute(
        "SELECT id, username, role, session_version FROM users WHERE id = ?", (user_id,)
    ).fetchone()
    if not target:
        conn.close()
        return jsonify({"ok": False, "error": "User not found."}), 404
    updates: list[str] = []
    values: list[object] = []
    revoke_sessions = False
    if "password" in payload and str(payload.get("password") or ""):
        password = validate_password(payload.get("password"))
        if not password:
            conn.close()
            return jsonify({"ok": False, "error": "Password must be at least 12 characters."}), 400
        updates.extend(["password_hash = ?", "must_change_password = ?"])
        values.extend([generate_password_hash(password), 0 if current_user["id"] == user_id else 1])
        revoke_sessions = True
    if "role" in payload:
        role = payload.get("role")
        if role not in ALLOWED_USER_ROLES:
            conn.close()
            return jsonify({"ok": False, "error": "Invalid role."}), 400
        if target["role"] == "admin" and role != "admin":
            admin_count = conn.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").fetchone()["count"]
            if admin_count <= 1:
                conn.close()
                return jsonify({"ok": False, "error": "TrackR must always have at least one admin."}), 400
        updates.append("role = ?")
        values.append(role)
        revoke_sessions = revoke_sessions or role != target["role"]
    if not updates:
        conn.close()
        return jsonify({"ok": False, "error": "No changes supplied."}), 400
    new_version = target["session_version"] + (1 if revoke_sessions else 0)
    if revoke_sessions:
        updates.append("session_version = ?")
        values.append(new_version)
    values.append(user_id)
    conn.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", values)
    conn.commit()
    conn.close()
    if current_user["id"] == user_id:
        if payload.get("role") == "user":
            session.clear()
        elif revoke_sessions:
            session["session_version"] = new_version
    return jsonify({"ok": True})


@app.delete("/api/users/<int:user_id>")
@admin_required
def delete_user(user_id: int):
    current_user = get_current_user()
    if current_user["id"] == user_id:
        return jsonify({"ok": False, "error": "You cannot delete the account you are currently using."}), 400
    conn = get_db()
    target = conn.execute("SELECT id, role FROM users WHERE id = ?", (user_id,)).fetchone()
    if not target:
        conn.close()
        return jsonify({"ok": False, "error": "User not found."}), 404
    if target["role"] == "admin":
        admin_count = conn.execute("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").fetchone()["count"]
        if admin_count <= 1:
            conn.close()
            return jsonify({"ok": False, "error": "TrackR must always have at least one admin."}), 400
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


def filtered_state_for_user(state: dict) -> dict:
    filtered = copy.deepcopy(state)
    filtered["jobs"] = [
        {key: job.get(key) for key in ("id", "address", "builder", "install", "installDate", "status") if key in job}
        for job in filtered.get("jobs", [])
    ]
    for task in filtered.get("tasks", []):
        task.pop("notes", None)
    return filtered


@app.get("/api/state")
@login_required
def get_state():
    conn = get_db()
    row = conn.execute("SELECT state_json, revision FROM app_state WHERE id = 1").fetchone()
    conn.close()
    if not row:
        state = copy.deepcopy(DEFAULT_STATE)
        revision = 1
    else:
        try:
            state = json.loads(row["state_json"])
        except json.JSONDecodeError:
            app.logger.error("Stored TrackR state is corrupt; refusing to mask it with sample data.")
            return jsonify({"ok": False, "error": "TrackR data could not be read. Restore a database backup."}), 500
        revision = int(row["revision"] or 1)
    user = get_current_user()
    if user["role"] != "admin":
        state = filtered_state_for_user(state)
    state["_revision"] = revision
    return jsonify(state)


@app.post("/api/state")
@admin_required
def save_state():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "Invalid state."}), 400
    try:
        expected_revision = int(payload.get("_revision"))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Missing workspace revision. Refresh TrackR and try again."}), 400
    try:
        validated = validate_state(payload)
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    encoded = json.dumps(validated, separators=(",", ":"))
    conn = get_db()
    try:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT revision FROM app_state WHERE id = 1").fetchone()
        current_revision = int(current["revision"] if current else 0)
        if current_revision != expected_revision:
            conn.rollback()
            return jsonify({
                "ok": False,
                "error": "TrackR changed in another browser or tab. Refresh before saving again.",
                "conflict": True,
                "revision": current_revision,
            }), 409
        new_revision = current_revision + 1
        conn.execute(
            "UPDATE app_state SET state_json = ?, revision = ?, updated_at = ? WHERE id = 1",
            (encoded, new_revision, utc_now_iso()),
        )
        conn.commit()
    finally:
        conn.close()
    try:
        backup_database(label="state-save")
    except Exception:
        app.logger.exception("Automatic database backup failed")
    return jsonify({"ok": True, "revision": new_revision})


@app.get("/api/backup")
@admin_required
def download_backup():
    handle = tempfile.NamedTemporaryFile(prefix="trackr-backup-", suffix=".sqlite3", delete=False)
    handle.close()
    target = Path(handle.name)
    source = get_db()
    destination = sqlite3.connect(target)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()

    try:
        backup_bytes = target.read_bytes()
    finally:
        target.unlink(missing_ok=True)

    filename = f"trackr-backup-{datetime.now().strftime('%Y-%m-%d-%H%M')}.sqlite3"
    return send_file(
        BytesIO(backup_bytes),
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.sqlite3",
        max_age=0,
    )


@app.post("/api/import-estimate")
@admin_required
def import_estimate():
    uploaded_file = request.files.get("estimate_pdf")
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"ok": False, "error": "Choose an estimate PDF first."}), 400
    if not uploaded_file.filename.lower().endswith(".pdf"):
        return jsonify({"ok": False, "error": "The selected file must be a PDF."}), 400
    if uploaded_file.mimetype not in {"application/pdf", "application/octet-stream", ""}:
        return jsonify({"ok": False, "error": "The selected file is not recognised as a PDF."}), 400
    try:
        extracted = parse_estimate_pdf(uploaded_file.stream)
    except Exception:
        app.logger.exception("Estimate PDF import failed")
        return jsonify({"ok": False, "error": "Could not read that PDF. Check that it is a valid, text-based estimate PDF."}), 400
    return jsonify({"ok": True, "extracted": extracted})




init_db()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    debug = os.environ.get("TRACKR_DEBUG") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
