const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const jsFiles = [
  "core.js",
  "home.js",
  "jobs.js",
  "calendar.js",
  "schedule.js",
  "tasks.js",
  "settings.js",
  "init.js",
];
const source = jsFiles.map(name => fs.readFileSync(path.join(root, "static", "js", name), "utf8")).join("\n");

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Function ${name} not found`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not parse function ${name}`);
}

const names = [
  "parseHours",
  "fmt",
  "buildTaskSplitForSave",
  "toIsoDate",
  "globalCalendarEventForDate",
  "calendarEventBlocksProduction",
  "isWorkingProductionDay",
  "addBusinessDays",
  "ensureBusinessDay",
  "parseIsoDate",
  "addCalendarDays",
  "calendarDayDifference",
  "scheduleIndexForDate",
  "taskDate",
  "taskDateForPerson",
  "materialiseAssignmentMinutes",
  "scheduleOrderFor",
  "compareScheduleTaskPriority",
  "calculate",
];
const context = { console, calendarEvents: [] };
vm.createContext(context);
vm.runInContext(names.map(extractFunction).join("\n"), context);
context.legacyDateForDayIndex = () => new Date(2026, 8, 7);
context.employeeCountsCapacity = person => !!person && person.countsCapacity !== false && person.role !== "Admin";
context.capacityForDate = () => 480;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(context.parseHours("1h30") === 90, "1h30 should parse to 90 minutes");
assert(context.parseHours("1h 30m") === 90, "1h 30m should parse to 90 minutes");
assert(context.parseHours("2.5") === 150, "2.5 should parse to 150 minutes");
assert(Number.isNaN(context.parseHours("banana")), "malformed hours must be NaN, not zero");
assert(Number.isNaN(context.parseHours("1h75")), "minute components must stay below 60");

let split = context.buildTaskSplitForSave(["Ben","Luke"], 16 * 60, {Ben:"10h",Luke:"6h"});
assert(split.ok, "valid actual split should save");
assert(split.assignmentMinutes.Ben === 600 && split.assignmentMinutes.Luke === 360, "edited split minutes should be preserved");
split = context.buildTaskSplitForSave(["Ben","Luke"], 16 * 60, {Ben:"16h",Luke:"0h"});
assert(split.ok && split.assigned.length === 1 && split.assigned[0] === "Ben", "0h should remove that employee from the task");
assert(!("Luke" in split.assignmentMinutes), "0h employee should be removed from assignmentMinutes");
split = context.buildTaskSplitForSave(["Ben","Luke"], 16 * 60, {Ben:"10h",Luke:"5h"});
assert(!split.ok, "split total must equal the task duration");
split = context.buildTaskSplitForSave(["Ben"], 7 * 60, {Ben:"1h"});
assert(split.ok && split.assignmentMinutes.Ben === 420, "single employee should always receive the full task duration");

context.calendarEvents = [{
  id: "closure",
  name: "Closed",
  type: "Factory Closure",
  startDate: "2026-09-07",
  endDate: "2026-09-07",
}];
let result = context.addBusinessDays(new Date(2026, 8, 4), 1); // Friday + one production day; Monday is closed.
assert(context.toIsoDate(result) === "2026-09-08", "workflow should skip weekend and closure");
result = context.ensureBusinessDay(new Date(2026, 8, 7));
assert(context.toIsoDate(result) === "2026-09-08", "closure date should roll to next production day");

context.calendarEvents = [{
  id: "company-event",
  name: "Company event",
  type: "Company Event",
  startDate: "2026-09-09",
  endDate: "2026-09-09",
}];
assert(context.isWorkingProductionDay(new Date(2026, 8, 9)) === false, "Company Event should preserve existing blocking behaviour");

// Scheduling regression: capacity is a hard daily limit and lower-priority work spills forward.
context.scheduleStartDate = new Date(2026, 8, 7);
context.days = Array.from({length: 7}, (_, index) => ({iso: context.toIsoDate(new Date(2026, 8, 7 + index))}));
context.people = [{name: "Ben", role: "Cabinet Making", countsCapacity: true}];
context.tasks = [
  {id: "A", job: "J1", name: "Assembly", type: "capacity", date: "2026-09-07", duration: 600, assigned: ["Ben"], assignmentMinutes: {Ben: 600}, assignmentDates: {Ben: "2026-09-07"}, scheduleOrder: {Ben: 2}},
  {id: "B", job: "J2", name: "Machining", type: "capacity", date: "2026-09-07", duration: 60, assigned: ["Ben"], assignmentMinutes: {Ben: 60}, assignmentDates: {Ben: "2026-09-07"}, scheduleOrder: {Ben: 1}},
];
const schedule = context.calculate();
assert(schedule.used.Ben[0] === 480, "first day must stop at 480 minutes");
assert(schedule.used.Ben[1] === 180, "remaining work should spill to the next day");
assert(context.tasks[1].parts[0].minutes === 60 && context.tasks[1].parts[0].date === "2026-09-07", "higher-priority task should run first");
assert(context.tasks[0].parts.reduce((sum, part) => sum + part.minutes, 0) === 600, "all lower-priority work should still be allocated");

console.log("frontend logic tests passed");
