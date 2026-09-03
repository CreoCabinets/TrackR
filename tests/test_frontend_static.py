from __future__ import annotations

import re
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
LOGIN = (ROOT / "templates" / "login.html").read_text(encoding="utf-8")
CHANGE_PASSWORD = (ROOT / "templates" / "change_password.html").read_text(encoding="utf-8")


class FrontendStaticTests(unittest.TestCase):
    def test_main_template_has_no_duplicate_ids(self):
        ids = re.findall(r'\bid="([^"]+)"', INDEX)
        duplicates = sorted(name for name, count in Counter(ids).items() if count > 1)
        self.assertEqual(duplicates, [])

    def test_save_failure_recovery_hooks_are_present(self):
        self.assertIn("lastPersistedWorkspace", INDEX)
        self.assertIn("restoreLastPersistedWorkspace()", INDEX)
        self.assertIn("Latest data reloaded", INDEX)
        self.assertIn("stateDirty", INDEX)

    def test_read_only_task_details_are_not_edit_form(self):
        self.assertIn('id="taskDetailsPanel"', INDEX)
        self.assertIn('if (!isAdmin) {openTaskDetailsPanel(id); return;}', INDEX)
        self.assertIn('item.dataset.taskType === "admin" && isAdmin', INDEX)

    def test_workflow_uses_production_day_helper(self):
        self.assertIn("function isWorkingProductionDay(dateObj)", INDEX)
        self.assertIn("calendarEventBlocksProduction(globalCalendarEventForDate(dateObj))", INDEX)
        self.assertIn("if (isWorkingProductionDay(result)) remaining--;", INDEX)

    def test_auth_templates_expose_limits_and_accessible_errors(self):
        self.assertIn('maxlength="32"', LOGIN)
        self.assertIn('maxlength="200"', LOGIN)
        self.assertIn('role="alert"', LOGIN)
        self.assertIn('maxlength="200"', CHANGE_PASSWORD)
        self.assertIn('role="alert"', CHANGE_PASSWORD)


if __name__ == "__main__":
    unittest.main()
