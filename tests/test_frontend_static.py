from __future__ import annotations

import re
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
LOGIN = (ROOT / "templates" / "login.html").read_text(encoding="utf-8")
CHANGE_PASSWORD = (ROOT / "templates" / "change_password.html").read_text(encoding="utf-8")
APP = (ROOT / "app.py").read_text(encoding="utf-8")
JS_DIR = ROOT / "static" / "js"
JS_FILES = [
    "core.js",
    "home.js",
    "jobs.js",
    "calendar.js",
    "schedule.js",
    "tasks.js",
    "beta.js",
    "settings.js",
    "init.js",
]
JS = "\n".join((JS_DIR / name).read_text(encoding="utf-8") for name in JS_FILES)
CSS = (ROOT / "static" / "css" / "trackr.css").read_text(encoding="utf-8")


class FrontendStaticTests(unittest.TestCase):
    def test_main_template_has_no_duplicate_ids(self):
        ids = re.findall(r'\bid="([^"]+)"', INDEX)
        duplicates = sorted(name for name, count in Counter(ids).items() if count > 1)
        self.assertEqual(duplicates, [])

    def test_main_frontend_is_externalised(self):
        self.assertNotIn("<style>", INDEX)
        self.assertNotRegex(INDEX, r"<script(?![^>]*\bsrc=)")
        self.assertNotRegex(INDEX, r"\bon(?:click|change|input)=")
        self.assertIn("css/trackr.css", INDEX)
        for name in JS_FILES:
            self.assertIn(f"js/{name}", INDEX)
            self.assertTrue((JS_DIR / name).is_file())
        self.assertGreater(len(CSS), 1000)

    def test_external_js_has_no_generated_inline_handlers(self):
        self.assertNotRegex(JS, r"\bon(?:click|change|input)=")
        self.assertIn("function setupUiActions()", JS)
        self.assertIn('data-click-action="restoreAddJobStage"', JS)

    def test_csp_no_longer_allows_inline_scripts(self):
        csp = re.search(r'"default-src \'self\'; script-src ([^;]+); style-src ([^;]+); "', APP)
        self.assertIsNotNone(csp)
        self.assertEqual(csp.group(1), "'self'")
        # Dynamic schedule geometry still uses element.style, so inline styles remain allowed.
        self.assertIn("'unsafe-inline'", csp.group(2))

    def test_save_failure_recovery_hooks_are_present(self):
        self.assertIn("lastPersistedWorkspace", JS)
        self.assertIn("restoreLastPersistedWorkspace()", JS)
        self.assertIn("Latest data reloaded", JS)
        self.assertIn("stateDirty", JS)

    def test_read_only_task_details_are_not_edit_form(self):
        self.assertIn('id="taskDetailsPanel"', INDEX)
        self.assertIn('if (!isAdmin) {openTaskDetailsPanel(id); return;}', JS)
        self.assertIn('item.dataset.taskType === "admin" && isAdmin', JS)

    def test_actual_split_editor_is_wired(self):
        self.assertIn('data-input-action="handleTaskHoursChanged"', INDEX)
        self.assertIn("function buildTaskSplitForSave(selected,duration,rawValues)", JS)
        self.assertIn('data-input-action="updateTaskSplitDraft"', JS)
        self.assertIn("Enter 0h to remove an employee", JS)
        self.assertIn(".allocation-split-row", CSS)


    def test_beta_delivery_readiness_is_wired(self):
        self.assertIn('id="tabBeta"', INDEX)
        self.assertIn('id="betaView"', INDEX)
        self.assertIn('data-click-action="printBetaDeliveryReport"', INDEX)
        self.assertIn("function deliveryRequiredReadyDate(task)", JS)
        self.assertIn("function confirmDeliveryReady(taskId)", JS)
        self.assertIn("function undoDeliveryReady(taskId)", JS)
        self.assertIn("deliveryReady", APP)
        self.assertIn('"Completed" : "Not completed"', JS)
        self.assertNotIn('progress.detail', JS)
        self.assertIn("@media print", CSS)

    def test_workflow_uses_production_day_helper(self):
        self.assertIn("function isWorkingProductionDay(dateObj)", JS)
        self.assertIn("calendarEventBlocksProduction(globalCalendarEventForDate(dateObj))", JS)
        self.assertIn("if (isWorkingProductionDay(result)) remaining--;", JS)

    def test_auth_templates_expose_limits_and_accessible_errors(self):
        self.assertIn('maxlength="32"', LOGIN)
        self.assertIn('maxlength="200"', LOGIN)
        self.assertIn('role="alert"', LOGIN)
        self.assertIn('maxlength="200"', CHANGE_PASSWORD)
        self.assertIn('role="alert"', CHANGE_PASSWORD)


if __name__ == "__main__":
    unittest.main()
