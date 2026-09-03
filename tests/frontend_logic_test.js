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
  "beta.js",
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
  "normaliseSearch",
  "isDeliveryTask",
  "isInstallTask",
  "buildTaskSplitForSave",
  "toIsoDate",
  "globalCalendarEventForDate",
  "calendarEventBlocksProduction",
  "isWorkingProductionDay",
  "addBusinessDays",
  "ensureBusinessDay",
  "parseIsoDate",
  "addCalendarDays",
  "startOfWeek",
  "calendarDayDifference",
  "scheduleIndexForDate",
  "taskDate",
  "scheduledTaskDate",
  "taskDateForPerson",
  "materialiseAssignmentMinutes",
  "deliveryReadyCurrent",
  "deliveryRequiredReadyDate",
  "deliveryProductionTasks",
  "deliveryTasksForWeek",
  "deliveryReadinessStatus",
  "betaWeekContextLabel",
  "betaProductionProgress",
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

assert(context.betaWeekContextLabel(new Date(2026, 8, 14), new Date(2026, 8, 16)) === "THIS WEEK", "current BETA week should be labelled clearly");
assert(context.betaWeekContextLabel(new Date(2026, 8, 21), new Date(2026, 8, 16)) === "NEXT WEEK", "next BETA week should be labelled clearly");
assert(context.betaWeekContextLabel(new Date(2026, 8, 7), new Date(2026, 8, 16)) === "LAST WEEK", "previous BETA week should be labelled clearly");
assert(context.betaWeekContextLabel(new Date(2026, 8, 28), new Date(2026, 8, 16)) === "2 WEEKS AHEAD", "future BETA weeks should show their relative position");

// BETA Delivery Readiness: previous working day, task completion and manual Ready confirmation.
context.calendarEvents = [{
  id: "friday-closure",
  name: "Factory closed",
  type: "Factory Closure",
  startDate: "2026-09-11",
  endDate: "2026-09-11",
}];
const deliveryTask = {id:"D1",job:"J1",name:"Delivery",type:"capacity",date:"2026-09-14",status:"Planned"};
assert(context.toIsoDate(context.deliveryRequiredReadyDate(deliveryTask)) === "2026-09-10", "Monday delivery should roll ready-by back past a Friday closure");
context.tasks = [
  deliveryTask,
  {id:"A1",job:"J1",name:"Assembly",type:"capacity",date:"2026-09-09",status:"Complete"},
  {id:"L1",job:"J1",name:"Loading",type:"capacity",date:"2026-09-10",status:"In Progress"},
  {id:"I1",job:"J1",name:"Install",type:"capacity",date:"2026-09-15",status:"Planned"},
];
let readiness = context.deliveryReadinessStatus(deliveryTask, new Date(2026, 8, 10));
assert(readiness.key === "due" && readiness.incomplete.length === 1 && readiness.incomplete[0].id === "L1", "ready-by day should warn while pre-delivery work is incomplete");
let productionLabel = context.betaProductionProgress(readiness);
assert(productionLabel.text === "Not completed", "BETA production summary should be binary while work remains");
context.tasks[2].status = "Complete";
readiness = context.deliveryReadinessStatus(deliveryTask, new Date(2026, 8, 10));
productionLabel = context.betaProductionProgress(readiness);
assert(productionLabel.text === "Completed", "BETA production summary should say Completed once production work is complete");
context.tasks[2].status = "In Progress";
readiness = context.deliveryReadinessStatus(deliveryTask, new Date(2026, 8, 10));
deliveryTask.parts = [{person:"Ben",date:"2026-09-15",minutes:60}];
assert(context.toIsoDate(context.scheduledTaskDate(deliveryTask)) === "2026-09-15", "BETA should prefer the calculated Schedule date over the planned task date");
assert(context.toIsoDate(context.deliveryRequiredReadyDate(deliveryTask)) === "2026-09-14", "ready-by should be based on the calculated Schedule delivery date");
deliveryTask.deliveryReady = {deliveryDate:"2026-09-15",confirmedAt:"2026-09-10T01:00:00.000Z",confirmedBy:"admin"};
assert(context.deliveryReadyCurrent(deliveryTask), "manual Ready confirmation should apply to the matching calculated Schedule date");
readiness = context.deliveryReadinessStatus(deliveryTask, new Date(2026, 8, 10));
assert(readiness.key === "ready", "manual Ready confirmation should suppress warnings");
deliveryTask.parts = [{person:"Ben",date:"2026-09-16",minutes:60}];
assert(!context.deliveryReadyCurrent(deliveryTask), "moving the Delivery in Schedule should invalidate the old Ready confirmation");

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

// BETA must follow the calculated Schedule date when capacity pushes Delivery forward.
context.calendarEvents = [];
context.scheduleStartDate = new Date(2026, 8, 14);
context.days = Array.from({length: 7}, (_, index) => ({iso: context.toIsoDate(new Date(2026, 8, 14 + index))}));
context.people = [{name: "Ben", role: "Cabinet Making", countsCapacity: true}];
const pushedDelivery = {id:"DEL",job:"J3",name:"Delivery",type:"capacity",date:"2026-09-14",duration:60,assigned:["Ben"],assignmentMinutes:{Ben:60},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:2},status:"Planned"};
context.tasks = [
  {id:"BLOCK",job:"J2",name:"Assembly",type:"capacity",date:"2026-09-14",duration:480,assigned:["Ben"],assignmentMinutes:{Ben:480},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:1},status:"Planned"},
  pushedDelivery,
];
context.calculate();
assert(context.toIsoDate(context.scheduledTaskDate(pushedDelivery)) === "2026-09-15", "capacity spillover should move the effective BETA delivery date to Tuesday");
const scheduledWeekDeliveries = context.deliveryTasksForWeek(new Date(2026, 8, 14));
assert(scheduledWeekDeliveries.length === 1 && scheduledWeekDeliveries[0].id === "DEL", "BETA week scan should read Delivery tasks from the calculated Schedule");

console.log("frontend logic tests passed");
