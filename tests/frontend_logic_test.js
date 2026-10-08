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
  "materialiseAssignmentDates",
  "moveScheduleOrderKey",
  "reassignDraggedShare",
  "deliveryReadyCurrent",
  "deliveryRequiredReadyDate",
  "deliveryProductionTasks",
  "deliveryTasksForWeek",
  "deliveryReadinessStatus",
  "generatedTaskIdentityKey",
  "preserveGeneratedTaskMetadata",
  "invalidateStaleDeliveryReadyConfirmations",
  "betaWeekContextLabel",
  "betaProductionProgress",
  "scheduleOrderFor",
  "compareScheduleTaskPriority",
  "calculate",
  "unassignedTaskMinutes",
];
const context = { console, calendarEvents: [] };
vm.createContext(context);
vm.runInContext(names.map(extractFunction).join("\n"), context);
context.legacyDateForDayIndex = () => new Date(2026, 8, 7);
context.employeeAvailableForSchedule = person => !!person && person.role !== "Admin";
context.capacityForDate = () => 480;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const value of ["2026-09-14", "0001-01-01", "2000-02-29"]) {
  assert(context.parseIsoDate(value) !== null && !Number.isNaN(context.parseIsoDate(value).getTime()), `accept exact valid ISO date ${value}`);
  assert(context.toIsoDate(context.parseIsoDate(value)) === value, `round-trip canonical ISO date ${value}`);
}
for (const value of ["0099-12-31", "0100-01-01", "0999-12-31"]) {
  assert(context.toIsoDate(context.parseIsoDate(value)) === value, `preserve a four-digit early year ${value}`);
}
assert(context.toIsoDate(context.addCalendarDays(context.parseIsoDate("0001-01-01"),1)) === "0001-01-02", "day arithmetic preserves years below 100");
assert(context.toIsoDate(context.addCalendarDays(context.parseIsoDate("0099-12-31"),1)) === "0100-01-01", "day arithmetic crosses year 100 without a century shift");
assert(context.toIsoDate(context.startOfWeek(context.parseIsoDate("0001-01-03"))) === "0001-01-01", "week arithmetic preserves early years");
assert(context.calendarDayDifference(context.parseIsoDate("0099-12-31"),context.parseIsoDate("0100-01-01")) === 1, "day differences preserve the year-100 boundary");
for (const value of [
  "20260914", "2026-W38-1", "2026-9-14", "2026-09-4", "2026-09-14T00:00:00",
  "2026-02-29", "1900-02-29", "2026-13-01", "2026-00-01", "2026-09-31",
  "0000-01-01", "２０２６-09-14", "٢٠٢٦-09-14", "2026-09-14\n", 20260914, null,
]) {
  assert(context.parseIsoDate(value) === null, `reject noncanonical or impossible ISO date ${String(value)}`);
}

function testDraggedSplitSharesToUnassigned() {
  const h = {showToast:message=>{h.toasts.push(message);},toasts:[]};
  const run = code => vm.runInContext(code,h);
  vm.createContext(h);
  vm.runInContext(["parseIsoDate","toIsoDate","taskDate","materialiseAssignmentMinutes","materialiseAssignmentDates","moveScheduleOrderKey","reassignDraggedShare","unassignedTaskMinutes"].map(extractFunction).join("\n"),h);
  h.legacyDateForDayIndex = () => new Date(2026,8,14);

  let task = {id:"T1",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:240,Luke:360},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"},scheduleOrder:{Ben:3,Luke:1},customField:"keep"};
  assert(h.reassignDraggedShare(task,"Ben","",new Date(2026,8,16)), "first split share can be moved to Unassigned");
  assert(JSON.stringify(task.assigned) === JSON.stringify(["Luke"]) && task.assignmentMinutes.Luke === 360 && task.assignmentDates.Luke === "2026-09-15", "removing the first split share preserves the other employee's allocation and date");
  assert(task.unassignedMinutes === 240 && task.unassignedDate === "2026-09-16" && task.duration === 600,"departing share remains explicitly required and unassigned");
  h.reassignDraggedShare(task,"Unassigned","Luke",new Date(2026,8,17));
  assert(task.assignmentMinutes.Luke === 600 && task.assigned.length === 1 && task.unassignedMinutes === 0 && task.duration === 600,"reassign residual to existing employee merges without duplication or labour growth");

  task = {id:"T2",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:240,Luke:360},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"}};
  h.reassignDraggedShare(task,"Luke","",new Date(2026,8,16));
  assert(JSON.stringify(task.assigned) === JSON.stringify(["Ben"]) && task.assignmentMinutes.Ben === 240 && task.assignmentDates.Ben === "2026-09-14", "removing the second split share preserves the other employee's allocation and date");

  task = {id:"T3",duration:600,assigned:["Ben","Luke","Nora"],assignmentMinutes:{Ben:100,Luke:200,Nora:300},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15",Nora:"2026-09-16"},scheduleOrder:{Ben:4,Luke:2,Nora:1},customField:"keep"};
  h.reassignDraggedShare(task,"Luke","",new Date(2026,8,18));
  assert(JSON.stringify(task.assigned) === JSON.stringify(["Ben","Nora"]) && JSON.stringify(task.assignmentMinutes) === JSON.stringify({Ben:100,Nora:300}) && JSON.stringify(task.assignmentDates) === JSON.stringify({Ben:"2026-09-14",Nora:"2026-09-16"}), "removing a middle share preserves all remaining employee-specific values");
  assert(JSON.stringify(task.scheduleOrder) === JSON.stringify({Ben:4,Nora:1}) && task.duration === 600 && task.customField === "keep", "split unassignment removes only the departing order entry and preserves unrelated fields and task totals");

  task = {id:"T4",duration:601,assigned:["Ben","Luke","Nora"]};
  h.reassignDraggedShare(task,"Ben","",new Date(2026,8,16));
  assert(JSON.stringify(task.assignmentMinutes) === JSON.stringify({Luke:200,Nora:200}) && Object.values(task.assignmentMinutes).reduce((sum,n)=>sum+n,0) === 400, "fallback split shares retain the remaining employees' materialised minutes");
  assert(task.assignmentDates.Luke === "2026-09-14" && task.assignmentDates.Nora === "2026-09-14", "fallback assignment dates retain the original task date for remaining shares");

  task = {id:"T5",duration:300,assigned:["Ben"],assignmentMinutes:{Ben:300},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:2},other:{keep:true}};
  h.reassignDraggedShare(task,"Ben","",new Date(2026,8,16));
  assert(task.assigned.length === 0 && Object.keys(task.assignmentMinutes).length === 0 && Object.keys(task.assignmentDates).length === 0 && Object.keys(task.scheduleOrder).length === 0 && task.other.keep, "single-assignee unassignment still clears assignment data and retains unrelated task fields");
  assert(task.unassignedMinutes === 300,"single-assignee unassignment retains all required labour");
  h.reassignDraggedShare(task,"Unassigned","Nora",new Date(2026,8,17));
  assert(task.duration === 300 && task.assignmentMinutes.Nora === 300 && task.unassignedMinutes === 0,"reassign fully-unassigned task retains total labour");

  task = {id:"T6",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:240,Luke:360},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"},scheduleOrder:{Ben:3,Luke:1}};
  h.reassignDraggedShare(task,"Ben","Nora",new Date(2026,8,16));
  assert(JSON.stringify(task.assigned) === JSON.stringify(["Nora","Luke"]) && task.assignmentMinutes.Nora === 240 && task.assignmentMinutes.Luke === 360 && task.assignmentDates.Nora === "2026-09-16" && task.assignmentDates.Luke === "2026-09-15", "employee-to-employee reassignment still moves only the selected share");

  task = {id:"T7",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:240,Luke:360},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"}};
  h.reassignDraggedShare(task,"Ben","Ben",new Date(2026,8,16));
  assert(task.assignmentDates.Ben === "2026-09-16" && task.assignmentDates.Luke === "2026-09-15" && task.assignmentMinutes.Luke === 360, "same-employee split moves update that employee's date only");

  task = {id:"T8",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:240,Luke:360},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"},scheduleOrder:{Ben:3,Luke:1}};
  const before = JSON.stringify(task);
  assert(!h.reassignDraggedShare(task,"Ben","Luke",new Date(2026,8,16)), "reassignment into an existing share is rejected");
  assert(JSON.stringify(task) === before && h.toasts.length === 1, "rejected duplicate share leaves the task unchanged and reports why");
  console.log("Split share drag tests passed");
}

function generatedJobHarness({jobId="J1",renumberTo=jobId,newJob=false,oldTasks=[],stages=[],otherJobs=[]}={}) {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {value:"",textContent:"",innerHTML:"",disabled:false,dataset:{},style:{setProperty(){}},
      classList:{toggle(key,on){if(on) classes.add(key);else classes.delete(key);},add:key=>classes.add(key),remove:key=>classes.delete(key)},
      scrollIntoView(){},addEventListener(){},setAttribute(){},removeAttribute(){},querySelector(){return element();},querySelectorAll(){return [];}};
  }
  const sandbox = {console:{log(){},error(){}},setTimeout:()=>0,clearTimeout(){},
    window:{scrollTo(){},addEventListener(){},innerWidth:1400},
    document:{body:{dataset:{currentUser:JSON.stringify({role:"admin"}),csrfToken:"isolated-test"}},
      documentElement:{style:{setProperty(){}}},getElementById(id){if(!elements.has(id)) elements.set(id,element());return elements.get(id);},
      createElement:element,querySelectorAll(){return [];}}};
  vm.createContext(sandbox);
  for (const name of ["core.js","schedule.js","jobs.js"]) vm.runInContext(fs.readFileSync(path.join(root,"static","js",name),"utf8"),sandbox);
  const run = code => vm.runInContext(code,sandbox);
  sandbox.jobFixture = {jobId,renumberTo,newJob,oldTasks,stages,otherJobs};
  run(`
    jobs = jobFixture.newJob ? [...jobFixture.otherJobs] : [{id:jobFixture.jobId,name:"Old address",address:"Old address",installDate:"2026-09-14",labourHours:{}} ,...jobFixture.otherJobs];
    tasks = [...jobFixture.oldTasks,...jobFixture.otherJobs.flatMap(job => job.tasks || [])];
    people = [{name:"Ben",role:"Cabinet Making",week:{Mon:480,Tue:480,Wed:480,Thu:480,Fri:480}},{name:"Luke",role:"Cabinet Making",week:{Mon:480,Tue:480,Wed:480,Thu:480,Fri:480}},{name:"Nora",role:"Cabinet Making",week:{Mon:480,Tue:480,Wed:480,Thu:480,Fri:480}},{name:"Admin",role:"Admin",week:{}}];
    scheduleStartDate = new Date(2026,8,14);
    scheduleSpanDays = 14;
    buildScheduleDays();
    addJobStages = jobFixture.stages;
    editingJobId = jobFixture.newJob ? null : jobFixture.jobId;
    addJobSaveInProgress = false;
    queueStateSave = async () => true;
    renderAll = () => { buildScheduleDays(); calculate(); };
    renderBeta = () => {};
    showAddJobMessage = () => {};
    configureAddJobPage = () => {};
    showView = () => {};
  `);
  const values = {
    ajJobNumber:newJob ? renumberTo : renumberTo,
    ajAddress:"Updated address",ajBuilder:"Builder",ajInstallDate:"2026-09-14",ajJobStatus:"Active",ajTwoPack:"",
    ajJobLength:"4",ajNotes:"",ajHoursCheck:"0",ajHoursDrafting:"0",ajHoursMachining:"0",ajHoursAssembly:"0",ajHoursLoading:"0",ajHoursDelivery:"0",
  };
  for (const [id,value] of Object.entries(values)) elements.get(id) || elements.set(id,element());
  for (const [id,value] of Object.entries(values)) elements.get(id).value = value;
  elements.get("ajTwoPack").checked = false;
  run("addJobExcludedStages = new Set(); addJobSource = 'manual';");
  return {sandbox,run,elements,save:()=>run("saveAddJob()")};
}

function generatedStage(name="Delivery",assigned=["Ben"],hours=1,date="2026-09-14") {
  return {name,department:"Cabinet Making",date,endDate:date,hours,countsCapacity:true,assignments:assigned.map(person=>({person,hours:hours/assigned.length,date}))};
}

async function testGeneratedJobRebuilds() {
  const oldReady = {deliveryDate:"2026-09-15",confirmedAt:"2026-09-10T01:02:03.000Z",confirmedBy:"admin@example.test",extra:"preserved"};
  const oldDelivery = {id:"DEL-ID",job:"J1",name:"Delivery",stageGroup:"Delivery",stageDepartment:"Cabinet Making",type:"capacity",date:"2026-09-14",duration:60,estimatedHours:1,assigned:["Ben","Luke"],assignmentMinutes:{Ben:30,Luke:30},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-14"},scheduleOrder:{Ben:4,Luke:2,Removed:1},deliveryReady:oldReady,parts:[]};
  const blocker = {id:"OTHER-BLOCK",job:"J2",name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",type:"capacity",date:"2026-09-14",duration:480,estimatedHours:8,assigned:["Ben"],assignmentMinutes:{Ben:480},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:1},parts:[]};
  const blockerLuke = {...blocker,id:"OTHER-BLOCK-LUKE",assigned:["Luke"],assignmentMinutes:{Luke:480},assignmentDates:{Luke:"2026-09-14"},scheduleOrder:{Luke:1}};
  const adminOld = {id:"ADMIN-ID",job:"J1",name:"Checking",stageGroup:"Checking",stageDepartment:"Cabinet Making",type:"admin",department:"Admin",adminEmployee:"Admin",assigned:["Admin"],duration:60,estimatedHours:1,assignmentMinutes:{Admin:60},assignmentDates:{Admin:"2026-09-14"},scheduleOrder:{Admin:7},parts:[]};

  // Details-only edit: IDs and exact confirmation fields survive, while assignment order follows current assignees.
  let h = generatedJobHarness({jobId:"J1",oldTasks:[oldDelivery,adminOld,blocker,blockerLuke],stages:[generatedStage("Delivery",["Ben","Luke"],1),generatedStage("Checking",["Ben","Admin"],2)]});
  await h.save();
  let rebuilt = h.run('tasks.find(task=>task.job==="J1" && task.name==="Delivery")');
  assert(rebuilt.id === "DEL-ID", "details-only edit preserves generated task ID through shared identity lookup");
  assert(JSON.stringify(rebuilt.scheduleOrder) === JSON.stringify({Ben:4,Luke:2}), "scheduleOrder is copied exactly for still-assigned employees and excludes removed employees");
  assert(rebuilt.scheduleOrder !== oldDelivery.scheduleOrder, "scheduleOrder is a new object");
  assert(JSON.stringify(rebuilt.deliveryReady) === JSON.stringify(oldReady), "Delivery confirmation fields including confirmedAt and confirmedBy are exact");
  assert(rebuilt.deliveryReady !== oldReady, "deliveryReady is copied into a new object");
  assert(h.run('tasks.find(task=>task.job==="J1" && task.type==="admin").id') === "ADMIN-ID", "admin assignment ID uses the shared generated identity including employee");

  // The planned date differs from the calculated date. A confirmation for the calculated date stays current.
  assert(rebuilt.date === "2026-09-14" && h.run('toIsoDate(scheduledTaskDate(tasks.find(task=>task.id==="DEL-ID")))') === "2026-09-15", "cross-job work shifts the rebuilt Delivery after its planned date");
  assert(rebuilt.deliveryReady.deliveryDate === h.run('toIsoDate(scheduledTaskDate(tasks.find(task=>task.id==="DEL-ID")))'), "confirmation matching calculated Schedule date survives despite a different planned date");

  // A confirmation matching the planned date but not the calculated date is removed in full.
  const stale = {...oldDelivery,deliveryReady:{deliveryDate:"2026-09-14",confirmedAt:"stale-time",confirmedBy:"old-admin"}};
  h = generatedJobHarness({jobId:"J1",oldTasks:[stale,blocker],stages:[generatedStage("Delivery",["Ben"],1)]});
  await h.save();
  rebuilt = h.run('tasks.find(task=>task.job==="J1" && task.name==="Delivery")');
  assert(rebuilt.date === "2026-09-14" && h.run('toIsoDate(scheduledTaskDate(tasks.find(task=>task.id==="DEL-ID")))') === "2026-09-15", "stale test distinguishes planned and calculated dates");
  assert(!Object.prototype.hasOwnProperty.call(rebuilt,"deliveryReady"), "mismatch deletes the complete deliveryReady object using calculated date");

  // Assignment changes remove old order entries and do not invent order for a newly assigned employee.
  h = generatedJobHarness({jobId:"J1",oldTasks:[oldDelivery],stages:[generatedStage("Delivery",["Ben","Nora"],1)]});
  await h.save();
  rebuilt = h.run('tasks.find(task=>task.job==="J1" && task.name==="Delivery")');
  assert(JSON.stringify(rebuilt.scheduleOrder) === JSON.stringify({Ben:4}), "reassignment keeps the still-assigned employee order and removes the departed employee order");
  assert(rebuilt.assigned.includes("Nora") && !("Nora" in rebuilt.scheduleOrder) && !("Luke" in rebuilt.scheduleOrder), "new employee has no invented priority and removed employee has no stale priority");

  // Renumbering keeps generated IDs/metadata and manually created tasks, relinking only their job number.
  const manual = {id:"MANUAL-ID",job:"J1",name:"Custom note",type:"capacity",custom:true,date:"2026-09-16",duration:0,assigned:[],parts:[{person:"Unassigned",date:"2026-09-16",day:2,minutes:0}],scheduleOrder:{Ben:9}};
  h = generatedJobHarness({jobId:"J1",renumberTo:"J1-NEW",oldTasks:[oldDelivery,manual,blocker,blockerLuke],stages:[generatedStage("Delivery",["Ben","Luke"],1)]});
  await h.save();
  rebuilt = h.run('tasks.find(task=>task.job==="J1-NEW" && task.name==="Delivery")');
  const relinkedManual = h.run('tasks.find(task=>task.id==="MANUAL-ID")');
  assert(rebuilt.id === "DEL-ID" && rebuilt.deliveryReady.confirmedAt === oldReady.confirmedAt && rebuilt.deliveryReady.confirmedBy === oldReady.confirmedBy, "renumbering preserves generated ID and Ready metadata");
  assert(relinkedManual.job === "J1-NEW" && relinkedManual.custom && relinkedManual.scheduleOrder.Ben === 9, "manual task remains intact and is relinked on renumber");

  // Removed/replaced stages do not transfer identity or either metadata object.
  h = generatedJobHarness({jobId:"J1",oldTasks:[oldDelivery],stages:[generatedStage("Dispatch",["Ben"],1)]});
  await h.save();
  rebuilt = h.run('tasks.find(task=>task.job==="J1" && task.name==="Dispatch")');
  assert(rebuilt.id !== "DEL-ID" && !rebuilt.deliveryReady && !rebuilt.scheduleOrder, "replacement stage receives no ID, Ready confirmation, or Schedule order from Delivery");

  // A genuinely new job has no prior logical match to inherit.
  const unrelated = {...oldDelivery,job:"J9"};
  h = generatedJobHarness({jobId:"J10",renumberTo:"J10",newJob:true,oldTasks:[unrelated],stages:[generatedStage("Delivery",["Ben"],1)]});
  await h.save();
  rebuilt = h.run('tasks.find(task=>task.job==="J10" && task.name==="Delivery")');
  assert(rebuilt.id !== "DEL-ID" && !rebuilt.deliveryReady && !rebuilt.scheduleOrder, "new job starts without metadata from another job");

  // Rebuilding job A changes a higher-priority capacity task and invalidates job B's shifted Delivery.
  const jobACapacity = {id:"A-ASSEMBLY",job:"J1",name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",stageTotalHours:4,type:"capacity",date:"2026-09-14",duration:240,estimatedHours:4,assigned:["Ben"],assignmentMinutes:{Ben:240},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:1},parts:[]};
  const jobBDelivery = {id:"JOB-B-DEL",job:"J2",name:"Delivery",stageGroup:"Delivery",stageDepartment:"Cabinet Making",type:"capacity",date:"2026-09-14",duration:60,estimatedHours:1,assigned:["Ben"],assignmentMinutes:{Ben:60},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:2},deliveryReady:{deliveryDate:"2026-09-14",confirmedAt:"2026-09-13T23:00:00.000Z",confirmedBy:"other-admin"},parts:[]};
  h = generatedJobHarness({jobId:"J1",oldTasks:[jobACapacity,jobBDelivery],stages:[generatedStage("Assembly",["Ben"],8)]});
  await h.save();
  const crossJobDelivery = h.run('tasks.find(task=>task.id==="JOB-B-DEL")');
  assert(crossJobDelivery.date === "2026-09-14", "rebuilding job A does not change job B's planned Delivery date");
  assert(h.run('toIsoDate(scheduledTaskDate(tasks.find(task=>task.id==="JOB-B-DEL")))') === "2026-09-15", "job A's raised higher-priority Ben capacity shifts job B's calculated Delivery date");
  assert(!Object.prototype.hasOwnProperty.call(crossJobDelivery,"deliveryReady"), "cross-job Schedule shift removes the entire Ready confirmation from job B");
  console.log("Generated job rebuild tests passed");
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

function schedulerFixture(taskList, capacityForDate=()=>480) {
  context.calendarEvents = [];
  context.scheduleStartDate = new Date(2026, 8, 7);
  context.days = Array.from({length: 7}, (_, index) => ({iso: context.toIsoDate(new Date(2026, 8, 7 + index))}));
  context.people = [
    {name:"Ben",role:"Cabinet Making",week:{Mon:480,Tue:480,Wed:480,Thu:480,Fri:480}},
    {name:"Luke",role:"Cabinet Making",week:{Mon:480,Tue:480,Wed:480,Thu:480,Fri:480}},
  ];
  context.tasks = taskList;
  context.capacityForDate = capacityForDate;
  return context.calculate();
}
function schedulerTask(id, date, duration, overrides={}) {
  return {id,job:`J-${id}`,name:id,type:"capacity",date,duration,assigned:["Ben"],assignmentMinutes:{Ben:duration},assignmentDates:{Ben:date},...overrides};
}
function testSchedulerDateJumpAndBounds() {
  let result = schedulerFixture([
    schedulerTask("EARLY","2026-09-07",10),
    schedulerTask("LATE","2029-01-01",20),
  ]);
  assert(context.tasks[1].parts[0].date === "2029-01-01" && context.tasks[1].unscheduledMinutes === 0, "a gap longer than 730 days jumps to the next task start without consuming the progress bound");

  schedulerFixture([schedulerTask("FAR","2035-06-15",30)]);
  assert(context.tasks[0].parts.length === 1 && context.tasks[0].parts[0].date === "2035-06-15", "multi-year initial gaps jump directly to the task start date");

  schedulerFixture([schedulerTask("LONG","2026-09-07",731)],()=>1);
  assert(context.tasks[0].parts.length === 731 && context.tasks[0].unscheduledMinutes === 0, "allocation progress resets the no-progress bound and continues beyond 730 work days");

  let zeroCapacityDays = 0;
  schedulerFixture([schedulerTask("BLOCKED","2026-09-07",60)],()=>{zeroCapacityDays++;return 0;});
  assert(zeroCapacityDays === 730 && context.tasks[0].parts.length === 0 && context.tasks[0].unscheduledMinutes === 60, "730 consecutive eligible days with zero capacity stop safely and report the remaining minutes");

  schedulerFixture([
    schedulerTask("A","2026-09-07",600,{scheduleOrder:{Ben:2}}),
    schedulerTask("B","2026-09-07",60,{scheduleOrder:{Ben:1}}),
  ]);
  assert(context.tasks[1].parts[0].minutes === 60 && context.tasks[1].parts[0].date === "2026-09-07", "normal scheduling keeps the established higher-priority first-day result");
  assert(context.tasks[0].parts[0].minutes === 420 && context.tasks[0].parts[0].date === "2026-09-07" && context.tasks[0].parts[1].date === "2026-09-08", "normal scheduling keeps capacity limits and next-day spillover");

  schedulerFixture([
    schedulerTask("LATER","2026-09-07",60,{scheduleOrder:{Ben:2}}),
    schedulerTask("EARLIER","2026-09-08",60,{scheduleOrder:{Ben:1}}),
  ]);
  assert(context.tasks[0].parts[0].date === "2026-09-07" && context.tasks[1].parts[0].date === "2026-09-08", "manual priority never makes a task eligible before its assignment start date");

  const noCapacityDates = new Set(["2026-09-08","2026-09-09"]);
  schedulerFixture([schedulerTask("CLOSURE","2026-09-07",500)],(_person,date)=>noCapacityDates.has(context.toIsoDate(date))?0:480);
  assert(!context.tasks[0].parts.some(part=>noCapacityDates.has(part.date)) && context.tasks[0].parts[1].date === "2026-09-10", "company closure capacity continues to block work while preserving spillover");

  const absenceDates = new Set(["2026-09-08","2026-09-09"]);
  schedulerFixture([schedulerTask("ABSENCE","2026-09-07",500)],(_person,date)=>absenceDates.has(context.toIsoDate(date))?0:480);
  assert(!context.tasks[0].parts.some(part=>absenceDates.has(part.date)) && context.tasks[0].parts[1].date === "2026-09-10", "employee absence capacity continues to block work while preserving spillover");

  schedulerFixture([
    schedulerTask("ORDER-2","2026-09-07",480,{scheduleOrder:{Ben:20}}),
    schedulerTask("ORDER-1","2026-09-07",480,{scheduleOrder:{Ben:10}}),
  ]);
  assert(context.tasks[1].parts[0].date === "2026-09-07" && context.tasks[0].parts[0].date === "2026-09-08", "scheduleOrder still controls allocation sequence after the cursor advances");

  const split = {id:"SPLIT",job:"J-SPLIT",name:"Split",type:"capacity",date:"2026-09-07",duration:600,assigned:["Ben","Luke"],assignmentMinutes:{Ben:300,Luke:300},assignmentDates:{Ben:"2026-09-07",Luke:"2026-09-09"}};
  schedulerFixture([split]);
  assert(split.parts.some(part=>part.person === "Ben" && part.date === "2026-09-07" && part.minutes === 300) && split.parts.some(part=>part.person === "Luke" && part.date === "2026-09-09" && part.minutes === 300), "split assignments keep each employee's minutes and assignmentDates start");

  schedulerFixture([
    schedulerTask("EARLY-YEAR","0001-01-01",10),
    schedulerTask("EARLY-YEAR-JUMP","0099-01-01",20),
  ]);
  assert(context.tasks[1].parts[0].date === "0099-01-01" && context.tasks[1].unscheduledMinutes === 0, "cursor jumps preserve accepted years below 100");
  schedulerFixture([schedulerTask("EARLY-YEAR-SPILL","0099-12-31",2)],()=>1);
  assert(context.tasks[0].parts[0].date === "0099-12-31" && context.tasks[0].parts[1].date === "0100-01-01", "scheduler spillover preserves the year-100 boundary");

  const persistentTask = schedulerTask("PERSIST","2026-09-07",120,{parts:[{person:"old",date:"2026-09-01",minutes:1}],unscheduledMinutes:99,status:"Planned",customField:{keep:true}});
  const persistedFieldsBefore = JSON.stringify({...persistentTask,parts:undefined,unscheduledMinutes:undefined});
  schedulerFixture([persistentTask]);
  assert(JSON.stringify({...persistentTask,parts:undefined,unscheduledMinutes:undefined}) === persistedFieldsBefore, "calculate mutates only transient parts and unscheduledMinutes, not persisted task fields");
  assert(persistentTask.parts.length > 0 && persistentTask.unscheduledMinutes === 0, "transient scheduling fields are recomputed on each calculation");
  console.log("Scheduler date-jump regression tests passed (14 cases)");
}
testSchedulerDateJumpAndBounds();

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

// Generated task edits retain identity and only carry assignment-specific metadata forward.
const oldGeneratedDelivery = {id:"OLD-DEL",job:"J4",name:"Delivery",stageGroup:"Delivery",stageDepartment:"Cabinet Making",type:"capacity",assigned:["Ben","Luke"],scheduleOrder:{Ben:3,Luke:1,Gone:0},deliveryReady:{deliveryDate:"2026-09-14",confirmedAt:"then",confirmedBy:"admin"}};
const rebuiltDelivery = {id:"temporary",job:"J4",name:"Delivery",stageGroup:"Delivery",stageDepartment:"Cabinet Making",type:"capacity",date:"2026-09-14",duration:60,assigned:["Ben"],assignmentMinutes:{Ben:60},assignmentDates:{Ben:"2026-09-14"}};
context.preserveGeneratedTaskMetadata(rebuiltDelivery,oldGeneratedDelivery);
assert(rebuiltDelivery.id === "OLD-DEL", "editing should preserve a generated stage task ID");
assert(JSON.stringify(rebuiltDelivery.scheduleOrder) === JSON.stringify({Ben:3}), "schedule order should be copied only for employees still assigned");
assert(rebuiltDelivery.scheduleOrder !== oldGeneratedDelivery.scheduleOrder, "schedule order should be copied into a new object");
assert(rebuiltDelivery.deliveryReady !== oldGeneratedDelivery.deliveryReady && rebuiltDelivery.deliveryReady.deliveryDate === "2026-09-14", "same logical Delivery should receive an exact copy of its Ready confirmation");
assert(context.generatedTaskIdentityKey({name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",type:"admin",assigned:["Ben"]}) === context.generatedTaskIdentityKey({name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",type:"admin",adminEmployee:"Ben"}), "admin assignment identity should use its employee");
const ordinaryTask = {id:"N",job:"J4",name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",type:"capacity",assigned:["Ben"]};
context.preserveGeneratedTaskMetadata(ordinaryTask,oldGeneratedDelivery);
assert(!ordinaryTask.deliveryReady && !ordinaryTask.scheduleOrder, "metadata from another logical task must not be copied");

// Recalculate the complete Schedule before checking every Delivery confirmation.
context.days = Array.from({length: 7}, (_, index) => ({iso: context.toIsoDate(new Date(2026, 8, 14 + index))}));
context.tasks = [
  {id:"LOAD",job:"J4",name:"Loading",type:"capacity",date:"2026-09-14",duration:480,assigned:["Ben"],assignmentMinutes:{Ben:480},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:1},status:"Planned"},
  rebuiltDelivery,
  {id:"DEL2",job:"J5",name:"Delivery",type:"capacity",date:"2026-09-14",duration:60,assigned:["Ben"],assignmentMinutes:{Ben:60},assignmentDates:{Ben:"2026-09-14"},deliveryReady:{deliveryDate:"2026-09-14",confirmedBy:"admin"}},
  {id:"DEL3",job:"J6",name:"Delivery",type:"capacity",date:"2026-09-16",duration:60,assigned:["Ben"],assignmentMinutes:{Ben:60},deliveryReady:{deliveryDate:"2026-09-16",confirmedBy:"admin"}},
];
context.calculate();
assert(context.invalidateStaleDeliveryReadyConfirmations(context.tasks), "changed scheduled Delivery dates should invalidate confirmations");
assert(!rebuiltDelivery.deliveryReady && !context.tasks[2].deliveryReady, "all Delivery confirmations with mismatched calculated dates should be removed");
assert(context.tasks[3].deliveryReady.deliveryDate === "2026-09-16", "a confirmation matching its recalculated Delivery date should remain");

// Run the actual state/capacity/panel modules together, including asynchronous
// saves. The small DOM stand-in captures rendered controls and click listeners.
function absenceHarness(role="admin") {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {innerHTML:"",textContent:"",value:"",dataset:{},style:{setProperty(){}},children:[],listeners:{},
      classList:{contains:key=>classes.has(key),add:key=>classes.add(key),remove:key=>classes.delete(key)},
      addEventListener(type,fn){this.listeners[type]=fn;},
      setAttribute(){},removeAttribute(){},
      appendChild(child){this.children.push(child);},
      querySelector(selector){
        const action=selector.match(/data-day-action="([^"]+)"/);
        if(action && !this.innerHTML.includes(`data-day-action="${action[1]}"`)) return null;
        if(!this.controls) this.controls={};
        return this.controls[selector] ||= element();
      },querySelectorAll(){return [];}};
  }
  const sandbox={console:{log(){},error(){}},setTimeout:()=>0,clearTimeout(){},
    window:{addEventListener(){},innerWidth:1400},
    document:{body:{dataset:{currentUser:JSON.stringify({role}),csrfToken:"test"}},
      documentElement:{style:{setProperty(){}}},createElement:element,
      getElementById(id){if(!elements.has(id)) elements.set(id,element());return elements.get(id);},
      querySelectorAll(){return [];}}};
  vm.createContext(sandbox);
  for(const name of ["core.js","calendar.js","schedule.js","tasks.js","settings.js","home.js"])
    vm.runInContext(fs.readFileSync(path.join(root,"static","js",name),"utf8"),sandbox);
  const run=code=>vm.runInContext(code,sandbox);
  run('renderAll=()=>{calculate();}; showToast=()=>{}; loadUsers=()=>{}; syncFloatingScrollWidth=()=>{}; stateLoaded=true;');
  run('initialiseScheduleWindow=()=>{scheduleStartDate=new Date(2026,8,14);buildScheduleDays();};');
  const person={name:"Ben",role:"Cabinet Making",week:{Mon:480,Tue:450,Wed:360,Thu:420,Fri:240}};
  const state={version:10,people:[person,{...person,name:"Luke"}],jobs:[],tasks:[],dayStatuses:[],calendarEvents:[],absenceOverrides:[]};
  sandbox.seed=state;
  run('applyWorkspaceSnapshot(seed); scheduleStartDate=new Date(2026,8,14); buildScheduleDays(); lastPersistedWorkspace=workspaceSnapshot();');
  let saved=null;
  sandbox.fetch=async(_url,options)=>{
    if(options?.method === "POST") {saved=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({revision:2})};}
    return {ok:true,status:200,json:async()=>saved};
  };
  return {sandbox,run,elements,state,get saved(){return saved;}};
}

async function testAbsenceOverrides(){
  for(const kind of ["RDO","Away","Holiday","Sick"]){
    const h=absenceHarness();
    h.sandbox.kind=kind;
    h.run('dayStatuses=[{person:"Ben",type:kind,startDate:"2026-09-14",endDate:"2026-09-18"}]; lastPersistedWorkspace=workspaceSnapshot();');
    const original=h.run('JSON.stringify(dayStatuses)');
    assert(h.run('capacityFor(people[0],2)')===0,`${kind} blocks normal capacity`);
    h.run('openDayPanel("Ben",2)');
    assert(h.elements.get("dayPanelBody").innerHTML.includes("Work this day"),`${kind} has admin action`);
    await h.elements.get("dayPanelBody").controls['[data-day-action="work-status"]'].listeners.click();
    assert(h.run('capacityFor(people[0],2)')===360,`${kind} restores exact Wednesday roster`);
    assert(h.run('capacityFor(people[1],2)')===360,"other employee unchanged");
    assert(h.run('[0,1,3,4].every(day=>capacityFor(people[0],day)===0)'),"other absence dates blocked");
    assert(h.run('JSON.stringify(dayStatuses)')===original,"source record unchanged");
    assert(h.saved.absenceOverrides.length===1,"normal save includes override");
    assert(h.run('stateDirty')===false,"saved snapshot includes override");
    const html=h.elements.get("dayPanelBody").innerHTML;
    assert(html.includes(`Restore ${kind}`) && html.includes(`${kind} overridden`) && html.includes("2026-09-16"),"panel shows source, date and active override");
    h.run('applyWorkspaceSnapshot({});');
    h.sandbox.reload=h.saved;
    h.run('applyWorkspaceSnapshot(reload);');
    assert(h.run('capacityFor(people[0],2)')===360,"reload restores override capacity");
    h.run('renderSchedule()');
    assert(h.elements.get("rows").children[0].innerHTML.includes("Working"),"schedule marks working day");
    assert(await h.run('setDayAbsenceOverride("Ben","2026-09-16",false)'),"restore saves");
    assert(h.run('capacityFor(people[0],2)')===0 && h.saved.absenceOverrides.length===0,"restore blocks capacity and persists");
    assert(h.run('JSON.stringify(dayStatuses)')===original,"restore preserves source record");
  }

  const h=absenceHarness();
  h.run('dayStatuses=[{person:"Ben",type:"Holiday",startDate:"2026-09-14",endDate:"2026-09-18"}]; tasks=[{id:"A",type:"capacity",date:"2026-09-14",duration:600,assigned:["Ben"]}]; lastPersistedWorkspace=workspaceSnapshot();');
  assert(h.run('tasks[0].parts[0].date')==="2026-09-21","absence spills to following Monday");
  await h.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  assert(h.run('tasks[0].parts[0].date')==="2026-09-16" && h.run('tasks[0].parts[0].minutes')===360,"work fills restored day");
  assert(h.run('tasks[0].parts[1].date')==="2026-09-21" && h.run('tasks[0].parts[1].minutes')===240,"remaining work spills past rest of absence");
  assert(h.run('departmentCapacity(new Date(2026,8,14),new Date(2026,8,18))["Cabinet Making"]')===2310,"Home uses same capacity calculation");
  h.run('people[0].capacityOverrides={"2026-09-16":900};');
  assert(h.run('capacityFor(people[0],2)')===360,"absence override cannot invent overtime");
  for(const kind of ["Factory Closure","Public Holiday","Company Event"]){
    h.sandbox.kind=kind;
    h.run('calendarEvents=[{name:"Closed",type:kind,startDate:"2026-09-16",endDate:"2026-09-16"}]; calculate(); openDayPanel("Ben",2);');
    assert(h.run('capacityFor(people[0],2)')===0,"global event blocks override and existing overtime");
    assert(h.run('tasks[0].parts.every(part=>part.date!=="2026-09-16")'),"spill skips closure");
    assert(h.elements.get("dayPanelBody").innerHTML.includes("still blocks capacity"),"panel explains closure");
    assert(!await h.run('setDayAbsenceOverride("Ben","2026-09-16",true)'),"cannot activate through closure");
  }
  h.run('calendarEvents=[]; people[0].workPattern="Custom"; people[0].customStart="2026-09-07"; people[0].week1={Wed:420}; people[0].week2={Wed:120};');
  assert(h.run('capacityFor(people[0],2)')===120,"override uses correct custom roster week");
  h.run('people[0].week2.Wed=0;');
  assert(h.run('capacityFor(people[0],2)')===0,"zero roster RDO stays zero");
  h.run('people[0].countsCapacity=false;');
  assert(h.run('capacityFor(people[0],2)')===0,"absence still blocks an employee excluded from Home capacity");
  h.run('people[0].countsCapacity=true; people[0].workPattern="Standard";');
  h.run('dayStatuses[0].endDate="2026-09-17";');
  assert(h.run('capacityFor(people[0],2)')===0,"edited source invalidates override even if date still covered");
  assert(h.run('workspaceSnapshot().absenceOverrides.length')===0,"stale override not saved");
  h.run('dayStatuses=[]; applyWorkspaceSnapshot(workspaceSnapshot()); dayStatuses=[{person:"Ben",type:"Sick",startDate:"2026-09-16",endDate:"2026-09-16"}];');
  assert(h.run('capacityFor(people[0],2)')===0,"removed source cannot override new absence");
  await h.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  h.run('dayStatuses.push({person:"Ben",type:"Away",startDate:"2026-09-16",endDate:"2026-09-16"});');
  assert(h.run('capacityFor(people[0],2)')===0,"new overlapping absence blocks old override");
  await h.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  assert(h.run('capacityFor(people[0],2)')===360,"explicit override covers all current overlapping absences");
  h.run('people[0].name="Renamed"; renameEmployeeReferences("Ben","Renamed");');
  assert(h.run('capacityFor(people[0],2)')===360,"rename preserves linked override");
  h.run('absenceOverrides=[null,{person:"Renamed",date:"2026-02-30",statuses:[]},{person:"Renamed",date:"2026-09-16",statuses:[null]}];');
  assert(h.run('validAbsenceOverrides().length')===0 && h.run('capacityFor(people[0],2)')===0,"malformed overrides fail closed");

  const reader=absenceHarness("user");
  reader.sandbox.reload=h.saved;
  reader.run('applyWorkspaceSnapshot(reload); openDayPanel("Ben",2); renderSchedule();');
  const readHtml=reader.elements.get("dayPanelBody").innerHTML;
  assert(readHtml.includes("overridden") && !readHtml.includes("data-day-action"),"reader sees override without mutation controls");
  assert(reader.elements.get("rows").children[0].innerHTML.includes('data-click-action="openDayPanel"'),"reader can open Schedule day");
  const before=reader.run('JSON.stringify(absenceOverrides)');
  assert(!await reader.run('setDayAbsenceOverride("Ben","2026-09-16",false)'),"reader restore handler denied");
  assert(!await reader.run('setDayAbsenceOverride("Ben","2026-09-16",true)'),"reader work handler denied");
  assert(reader.run('JSON.stringify(absenceOverrides)')===before,"reader handlers leave state untouched");

  const failed=absenceHarness();
  failed.run('dayStatuses=[{person:"Ben",type:"Away",startDate:"2026-09-16",endDate:"2026-09-16"}]; lastPersistedWorkspace=workspaceSnapshot();');
  failed.sandbox.fetch=async()=>({ok:false,status:500,json:async()=>({error:"Test failure"})});
  assert(!await failed.run('setDayAbsenceOverride("Ben","2026-09-16",true)'),"failed save reported");
  assert(failed.run('capacityFor(people[0],2)')===0,"failed save rolls back capacity");
  assert(failed.elements.get("dayPanelBody").innerHTML.includes("Work this day"),"panel refreshes after rollback");

  const conflict=absenceHarness();
  conflict.run('dayStatuses=[{person:"Ben",type:"Sick",startDate:"2026-09-16",endDate:"2026-09-16"}]; lastPersistedWorkspace=workspaceSnapshot();');
  const latest=JSON.parse(conflict.run('JSON.stringify(workspaceSnapshot())'));
  conflict.sandbox.fetch=async(_url,options)=>options?.method === "POST"
    ? {ok:false,status:409,json:async()=>({error:"Changed elsewhere"})}
    : {ok:true,status:200,json:async()=>({...latest,_revision:7})};
  assert(!await conflict.run('setDayAbsenceOverride("Ben","2026-09-16",true)'),"conflict reported");
  assert(conflict.run('absenceOverrides.length')===0 && conflict.run('stateRevision')===7,"conflict reloads latest persisted override state");
  assert(!conflict.elements.get("dayPanelBody").innerHTML.includes("Sick overridden"),"conflict does not leave active override in panel");

  const weekend=absenceHarness();
  weekend.run('dayStatuses=[{person:"Ben",type:"RDO",startDate:"2026-09-19",endDate:"2026-09-19"}];');
  await weekend.run('setDayAbsenceOverride("Ben","2026-09-19",true)');
  assert(weekend.run('capacityFor(people[0],5)')===0,"weekend absence override adds no hours");
  weekend.run('people[0].capacityOverrides={"2026-09-14":600};');
  assert(weekend.run('capacityFor(people[0],0)')===600,"ordinary overtime behaviour is preserved");

  const removed=absenceHarness();
  removed.run('dayStatuses=[{person:"Ben",type:"Holiday",startDate:"2026-09-14",endDate:"2026-09-18"}];');
  await removed.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  removed.run('removeBlockedDay("Ben",0);');
  assert(removed.run('absenceOverrides.length')===0 && removed.run('capacityFor(people[0],2)')===0,"editing underlying range through existing removal expires override");
  await removed.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  removed.run('removeStatusRange(0); dayStatuses=[{person:"Ben",type:"Holiday",startDate:"2026-09-15",endDate:"2026-09-18"}];');
  assert(removed.run('capacityFor(people[0],2)')===0,"recreated identical absence does not reuse removed override");
  console.log("frontend logic tests passed (including absence capacity, panel, persistence and permissions)");
}
async function testCustomTaskDeletionSafety(){
  const h=absenceHarness("admin");
  h.run(`
    fillPanelOptions=()=>{}; updateTaskJobMeta=()=>{}; renderEmployeeChoices=()=>{};
    updateTypeHint=()=>{}; updateAllocationSummary=()=>{}; openPanel=()=>{};
    tasks=[
      {id:"CUSTOM",custom:true,name:"Custom install",type:"capacity",job:"J1",date:"2026-09-14",duration:120,assigned:["Ben"],assignmentMinutes:{Ben:120},assignmentDates:{Ben:"2026-09-14"},scheduleOrder:{Ben:3},other:{preserve:true}},
      {id:"GENERATED-CAPACITY",custom:false,name:"Generated drafting",type:"capacity",job:"J1"},
      {id:"GENERATED-MILESTONE",name:"Generated milestone",type:"milestone",job:"J1"},
      {id:"UNRELATED",custom:true,name:"Other custom",type:"milestone",job:"J2",metadata:{preserve:true}}
    ];
  `);
  h.run('openTaskPanel("CUSTOM");');
  assert(h.elements.get("taskDeleteButton").style.display==="inline-flex","Delete is visible when an admin edits an existing custom task");
  h.run('openCustomTaskPanel("general");');
  assert(h.elements.get("taskDeleteButton").style.display==="none","Delete is hidden while creating a new unsaved task");
  h.run('openTaskPanel("GENERATED-CAPACITY");');
  assert(h.elements.get("taskDeleteButton").style.display==="none","Delete is hidden for generated capacity tasks");
  h.run('openTaskPanel("GENERATED-MILESTONE");');
  assert(h.elements.get("taskDeleteButton").style.display==="none","Delete is hidden for generated milestones");

  h.run(`
    calls={confirm:[],close:0,render:0,calculate:0,save:[],events:[]}; drawerOpen=true;
    selectedTaskId="CUSTOM";
    confirm=message=>{calls.confirm.push(message);return false;};
    closeTaskPanel=()=>{calls.close+=1;calls.events.push("close");drawerOpen=false;};
    renderAll=()=>{calls.render+=1;calls.events.push("render");}; calculate=()=>{calls.calculate+=1;};
    saveState=message=>{calls.save.push(message);calls.events.push(message);};
  `);
  const cancelBefore=h.run('JSON.stringify(tasks)');
  h.run('deleteTask();');
  assert(h.run('JSON.stringify(tasks)')===cancelBefore,"Cancel leaves the complete task array unchanged");
  assert(h.run('selectedTaskId==="CUSTOM" && drawerOpen'),"Cancel leaves selected task and drawer unchanged");
  assert(h.run('calls.confirm.length===1 && calls.confirm[0].includes("Custom install") && calls.confirm[0].includes("cannot be undone")'),"confirmation identifies the custom task and warns deletion cannot be undone");
  assert(h.run('calls.close===0 && calls.render===0 && calls.calculate===0 && calls.save.length===0'),"Cancel does not close, render, calculate, or save");

  h.run('confirm=message=>{calls.confirm.push(message);return true;}; calls.confirm=[];');
  const unrelatedBefore=h.run('JSON.stringify(tasks.filter(task=>task.id!=="CUSTOM"))');
  h.sandbox.unrelatedBefore=unrelatedBefore;
  h.run('deleteTask();');
  assert(h.run('tasks.length===3 && !tasks.some(task=>task.id==="CUSTOM")'),"Confirm removes exactly the selected custom task");
  assert(h.run('JSON.stringify(tasks)===unrelatedBefore'),"Confirm preserves unrelated generated and custom tasks unchanged");
  assert(h.run('selectedTaskId==="CUSTOM" && !drawerOpen'),"Confirm closes the drawer while retaining the existing selected ID behavior");
  assert(h.run('calls.close===1 && calls.render===1 && calls.calculate===0 && calls.save.length===1 && calls.save[0]==="Task deleted" && JSON.stringify(calls.events)===JSON.stringify(["close","render","Task deleted"])'),"Confirm preserves close, render, and Task deleted save sequence without direct recalculation");

  for(const id of ["GENERATED-CAPACITY","GENERATED-MILESTONE"]){
    h.run(`tasks=[{id:${JSON.stringify(id)},name:"Generated",custom:false}]; selectedTaskId=${JSON.stringify(id)}; calls={confirm:[],close:0,render:0,calculate:0,save:[]};`);
    const before=h.run('JSON.stringify(tasks)');
    h.sandbox.before=before;
    h.run('deleteTask();');
    assert(h.run(`JSON.stringify(tasks)===before && selectedTaskId===${JSON.stringify(id)}`),`${id} direct deletion is rejected without mutation`);
    assert(h.run('calls.confirm.length===0 && calls.close===0 && calls.render===0 && calls.calculate===0 && calls.save.length===0'),`${id} direct deletion does not prompt, close, render, calculate, or save`);
  }

  h.run('tasks=[{id:"CUSTOM",custom:true,name:"Custom install"}]; selectedTaskId="STALE"; calls={confirm:[],close:0,render:0,calculate:0,save:[]};');
  const staleBefore=h.run('JSON.stringify(tasks)');
  h.sandbox.staleBefore=staleBefore;
  h.run('deleteTask();');
  assert(h.run('JSON.stringify(tasks)===staleBefore && selectedTaskId==="STALE"'),"missing or stale selection leaves task data and selected ID unchanged");
  assert(h.run('calls.confirm.length===0 && calls.close===0 && calls.render===0 && calls.save.length===0'),"missing or stale selection has no destructive side effects");
  h.run('selectedTaskId=null; calls={confirm:[],close:0,render:0,calculate:0,save:[]};');
  h.run('deleteTask();');
  assert(h.run('JSON.stringify(tasks)===staleBefore && selectedTaskId===null && calls.confirm.length===0 && calls.close===0 && calls.render===0 && calls.save.length===0'),"missing selected ID returns without changing tasks or invoking deletion side effects");

  const reader=absenceHarness("user");
  reader.run('tasks=[{id:"CUSTOM",custom:true,name:"Reader protected task",type:"capacity",date:"2026-09-14",duration:120,assigned:[]}]; selectedTaskId="CUSTOM"; calls={confirm:0,close:0,render:0,save:0}; confirm=()=>{calls.confirm+=1;return true;}; closeTaskPanel=()=>{calls.close+=1;}; renderAll=()=>{calls.render+=1;}; saveState=()=>{calls.save+=1;}; openPanel=()=>{}; openTaskPanel("CUSTOM");');
  const readerBefore=reader.run('JSON.stringify(tasks)');
  reader.sandbox.readerBefore=readerBefore;
  reader.run('deleteTask();');
  assert(reader.run('JSON.stringify(tasks)===readerBefore && selectedTaskId==="CUSTOM"'),"reader direct delete leaves task and selection unchanged");
  assert(reader.run('calls.confirm===0 && calls.close===0 && calls.render===0 && calls.save===0'),"reader direct delete cannot prompt, close, render, or save");
  assert(reader.elements.get("taskDeleteButton").style.display!=="inline-flex","reader does not receive a working Delete action");

  const job={isAdmin:true,editingJobId:"J1",jobs:[{id:"J1"},{id:"J2"}],tasks:[{id:"T1",job:"J1"},{id:"T2",job:"J2"}],calls:[],
    confirm:message=>{job.calls.push(message);return true;},renderAll:()=>job.calls.push("render"),
    queueStateSave:async message=>{job.calls.push(message);return true;},configureAddJobPage(){},showView(){},window:{scrollTo(){}}};
  vm.createContext(job);
  vm.runInContext(extractFunction("deleteEditingJob").replace(/^function/,"async function"),job);
  await job.deleteEditingJob();
  assert(JSON.stringify(job.jobs.map(item=>item.id))===JSON.stringify(["J2"]) && JSON.stringify(job.tasks.map(item=>item.id))===JSON.stringify(["T2"]),"existing job deletion still removes its linked tasks and leaves other jobs intact");
  assert(job.calls[0].includes("linked Calendar and Schedule item") && job.calls.includes("render") && job.calls.includes("J1 deleted"),"existing job deletion keeps its confirmation, rerender, and persistence behavior");
  console.log("Custom-task deletion safety tests passed");
}
function alternatingRosterHarness(role="admin") {
  const h=absenceHarness(role);
  h.run('Object.assign(people[0],{workPattern:"Custom",customStart:"2026-09-07",week:{Mon:460,Tue:460,Wed:460,Thu:460,Fri:300},week1:{Mon:460,Tue:460,Wed:460,Thu:460,Fri:340},week2:{Mon:460,Tue:460,Wed:460,Thu:460,Fri:0}}); lastPersistedWorkspace=workspaceSnapshot();');
  return h;
}

async function testRosterDayOffOverrides(){
  const h=alternatingRosterHarness();
  const rosterBefore=h.run('JSON.stringify([people[0].workPattern,people[0].customStart,people[0].week,people[0].week1,people[0].week2])');
  assert(h.run('capacityFor(people[0],4)')===0,"alternate Friday begins at zero");
  h.run('openDayPanel("Ben",4)');
  assert(h.elements.get("dayPanelBody").innerHTML.includes("Work this day makes 5h40"),"panel previews same-weekday hours rather than longest day");
  await h.elements.get("dayPanelBody").controls['[data-day-action="work-status"]'].listeners.click();
  assert(h.run('capacityFor(people[0],4)')===340,"alternate Friday becomes 5h40 rather than 7h40");
  assert(h.run('capacityFor(people[0],18)')===0,"next RDO Friday is unchanged");
  assert(h.run('capacityFor(people[0],11)')===340,"working Friday is unchanged");
  assert(h.run('capacityFor(people[0],3)')===460 && h.run('capacityFor(people[1],4)')===240,"other dates and employees are unchanged");
  assert(h.run('JSON.stringify([people[0].workPattern,people[0].customStart,people[0].week,people[0].week1,people[0].week2])')===rosterBefore,"underlying roster is unchanged");
  assert(h.saved.people[0].capacityOverrides["2026-09-18"]===340 && h.saved.absenceOverrides.length===0 && h.saved.dayStatuses.length===0,"roster work uses existing per-date capacity map without fabricated absence records");
  assert(h.run('stateDirty')===false,"roster work participates in persisted snapshot");
  h.sandbox.reload=h.saved;
  h.run('applyWorkspaceSnapshot({}); applyWorkspaceSnapshot(reload); openDayPanel("Ben",4); renderSchedule();');
  assert(h.run('capacityFor(people[0],4)')===340,"roster work survives state reload");
  assert(h.elements.get("dayPanelBody").innerHTML.includes("Restore RDO") && h.elements.get("dayPanelBody").innerHTML.includes("RDO overridden"),"reloaded panel shows active override and restore");
  assert(h.elements.get("rows").children[0].innerHTML.includes("Roster RDO overridden"),"Schedule identifies worked RDO");
  h.run('tasks=[{id:"R",type:"capacity",date:"2026-09-18",duration:400,assigned:["Ben"]}]; calculate();');
  assert(h.run('tasks[0].parts[0].minutes')===340 && h.run('tasks[0].parts[0].date')==="2026-09-18","existing scheduler fills worked Friday");
  assert(h.run('tasks[0].parts[1].minutes')===60 && h.run('tasks[0].parts[1].date')==="2026-09-21","remaining hours spill through existing scheduler");
  for(const kind of ["Factory Closure","Public Holiday","Company Event"]){
    h.sandbox.kind=kind;
    h.run('calendarEvents=[{name:"Closed",type:kind,startDate:"2026-09-18",endDate:"2026-09-18"}]; calculate(); openDayPanel("Ben",4);');
    assert(h.run('capacityFor(people[0],4)')===0,"global closure overrides per-date roster work");
    assert(h.run('tasks[0].parts[0].date')==="2026-09-21","work spills past closed Friday");
    assert(h.elements.get("dayPanelBody").innerHTML.includes("still blocks capacity"),"panel explains closure precedence");
    assert(!await h.run('setDayAbsenceOverride("Ben","2026-09-18",true)'),"cannot activate roster work on global closure");
  }
  // Restoration remains available even while a company closure covers the date.
  await h.elements.get("dayPanelBody").controls['[data-day-action="work-status"]'].listeners.click();
  assert(!("2026-09-18" in h.saved.people[0].capacityOverrides),"Restore RDO removes saved per-date capacity");
  h.run('calendarEvents=[]; calculate(); openDayPanel("Ben",4);');
  assert(h.run('capacityFor(people[0],4)')===0,"Restore RDO returns to rostered zero hours");
  assert(h.elements.get("dayPanelBody").innerHTML.includes("Work this day"),"restore offers Work this day again");

  const fallback=alternatingRosterHarness();
  fallback.run('people[0].week1.Fri=0;');
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",true)');
  assert(fallback.run('capacityFor(people[0],4)')===300,"positive standard Friday is used before longest-day fallback");
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",false)');
  fallback.run('people[0].week.Fri=0;');
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",true)');
  assert(fallback.run('capacityFor(people[0],4)')===460,"no positive Friday falls back to defaultDailyCapacity");
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",false)');
  fallback.run('people[0].week={}; people[0].week1={}; people[0].week2={};');
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",true)');
  assert(fallback.run('capacityFor(people[0],4)')===460,"all-zero patterns use existing 460-minute fallback");
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",false)');
  fallback.run('people[0].workPattern="Standard"; people[0].week={Mon:420,Fri:0};');
  await fallback.run('setDayAbsenceOverride("Ben","2026-09-18",true)');
  assert(fallback.run('capacityFor(people[0],4)')===420,"standard-week day off uses existing employee default");

  const reversed=alternatingRosterHarness();
  reversed.run('people[0].customStart="2026-09-14"; people[0].week1.Fri=0; people[0].week2.Fri=340;');
  await reversed.run('setDayAbsenceOverride("Ben","2026-09-18",true)');
  assert(reversed.run('capacityFor(people[0],4)')===340,"weekday lookup works when RDO is in week one");
  const weekend=alternatingRosterHarness();
  await weekend.run('setDayAbsenceOverride("Ben","2026-09-19",true)');
  assert(weekend.run('capacityFor(people[0],5)')===460 && weekend.run('capacityFor(people[0],6)')===0,"roster day-off weekend uses default for only selected date");

  const reader=alternatingRosterHarness("user");
  reader.sandbox.reload=reversed.saved;
  reader.run('applyWorkspaceSnapshot(reload); openDayPanel("Ben",4);');
  assert(reader.elements.get("dayPanelBody").innerHTML.includes("RDO overridden") && !reader.elements.get("dayPanelBody").innerHTML.includes("data-day-action"),"read-only user sees roster override without actions");
  const before=reader.run('JSON.stringify(people)');
  assert(!await reader.run('setDayAbsenceOverride("Ben","2026-09-18",false)') && !await reader.run('setDayAbsenceOverride("Ben","2026-09-18",true)'),"read-only handlers cannot add or remove roster work");
  assert(reader.run('JSON.stringify(people)')===before,"read-only calls do not mutate roster overrides");

  const failed=alternatingRosterHarness();
  failed.sandbox.fetch=async()=>({ok:false,status:500,json:async()=>({error:"Test failure"})});
  assert(!await failed.run('setDayAbsenceOverride("Ben","2026-09-18",true)'),"failed roster save reported");
  assert(failed.run('capacityFor(people[0],4)')===0 && failed.elements.get("dayPanelBody").innerHTML.includes("Work this day"),"failed roster save rolls back capacity and panel");
  const conflict=alternatingRosterHarness();
  const latest=JSON.parse(conflict.run('JSON.stringify(workspaceSnapshot())'));
  conflict.sandbox.fetch=async(_url,options)=>options?.method === "POST"
    ? {ok:false,status:409,json:async()=>({error:"Changed elsewhere"})}
    : {ok:true,status:200,json:async()=>({...latest,_revision:7})};
  assert(!await conflict.run('setDayAbsenceOverride("Ben","2026-09-18",true)'),"roster save conflict reported");
  assert(conflict.run('capacityFor(people[0],4)')===0 && !conflict.elements.get("dayPanelBody").innerHTML.includes("RDO overridden"),"conflict reloads saved roster capacity and panel");
  console.log("roster day-off override tests passed");
}
async function testHomeCapacityOptOut(){
  const h=absenceHarness();
  h.run('tasks=[{id:"BEN",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:120,assigned:["Ben"],assignmentMinutes:{Ben:120},assignmentDates:{Ben:"2026-09-14"}},{id:"LUKE",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:120,assigned:["Luke"],assignmentMinutes:{Luke:120},assignmentDates:{Luke:"2026-09-14"}}]; calculate(); document.getElementById("rows").children=[]; renderSchedule();');
  assert(h.elements.get("rows").children.length===3,"all Schedule employees and an admin Unassigned drop target render while counted in Home capacity");
  assert(h.run('capacityFor(people[0],0)')===480 && h.run('tasks[0].parts[0].minutes')===120,"roster hours and task scheduling work normally");
  assert(h.run('departmentCapacity(new Date(2026,8,14),new Date(2026,8,18))["Cabinet Making"]')===3900,"Home capacity includes both employees when enabled");
  assert(h.run('departmentBooked("2026-09-14","2026-09-18")["Cabinet Making"]')===240,"Home workload includes both employees when enabled");
  h.run('people[0].countsCapacity=false; calculate(); document.getElementById("rows").children=[]; renderSchedule();');
  assert(h.elements.get("rows").children.length===3,"Home opt-out does not hide the employee from Schedule or Unassigned target");
  assert(h.run('capacityFor(people[0],0)')===480 && h.run('tasks[0].parts[0].minutes')===120,"Home opt-out keeps normal Schedule capacity and task allocation");
  assert(h.run('departmentCapacity(new Date(2026,8,14),new Date(2026,8,18))["Cabinet Making"]')===1950,"Home capacity excludes opted-out available hours");
  assert(h.run('departmentBooked("2026-09-14","2026-09-18")["Cabinet Making"]')===120,"Home workload excludes opted-out allocations");
  h.run('dayStatuses=[{person:"Ben",type:"Holiday",startDate:"2026-09-16",endDate:"2026-09-16"}];');
  assert(h.run('capacityFor(people[0],2)')===0,"absence still blocks a Home-opted-out employee");
  await h.run('setDayAbsenceOverride("Ben","2026-09-16",true)');
  assert(h.run('capacityFor(people[0],2)')===360,"single-day absence override still restores Schedule capacity");
  await h.run('setDayAbsenceOverride("Ben","2026-09-16",false)');
  assert(h.run('capacityFor(people[0],2)')===0,"restoring the absence still blocks the date");
  h.run('dayStatuses=[]; people[0].countsCapacity=true;');
  assert(h.run('departmentCapacity(new Date(2026,8,14),new Date(2026,8,18))["Cabinet Making"]')===3900 && h.run('departmentBooked("2026-09-14","2026-09-18")["Cabinet Making"]')===240,"re-enabling restores both Home totals");
  console.log("Home capacity opt-out tests passed");
}
function testReadOnlyCalendarAndSchedule(){
  const reader=absenceHarness("user");
  reader.sandbox.calls={day:0,render:0,save:0,close:0,settings:0,views:[],panels:[]};
  reader.run(`
    tasks=[{id:"VIEW",job:"J1",name:"Assembly",type:"capacity",date:"2026-09-14",duration:120,department:"Cabinet Making",status:"Planned",showOnCalendar:true,assigned:["Ben"],assignmentMinutes:{Ben:120},assignmentDates:{Ben:"2026-09-14"}}];
    calendarDragSuppressClick=false;
    guardedOpenDayTaskPanel=openDayTaskPanel;
    openDayTaskPanel=()=>{calls.day+=1;};
    renderAll=()=>{calls.render+=1;};
    saveState=()=>{calls.save+=1;};
    closeTaskPanel=()=>{calls.close+=1;};
    showSettingsSection=()=>{calls.settings+=1;};
    showView=view=>{calls.views.push(view);};
    openPanel=id=>{calls.panels.push(id);};
  `);
  const readerTasksBefore=reader.run("JSON.stringify(tasks)");
  reader.sandbox.readerTasksBefore=readerTasksBefore;
  reader.run("openCalendarDayFromGrid(2026,8,23)");
  assert(reader.run("calls.day===0 && calls.render===0 && calls.save===0 && JSON.stringify(tasks)===readerTasksBefore"),"reader empty Calendar-day click does not enter task creation, mutate, render, or save");
  reader.run('document.getElementById("taskDate").value="unchanged-date"; document.getElementById("taskType").value="unchanged-type";');
  const readerFormBefore=reader.run('JSON.stringify([document.getElementById("taskDate").value,document.getElementById("taskType").value])');
  reader.sandbox.readerFormBefore=readerFormBefore;
  reader.run("openDayTaskPanel=guardedOpenDayTaskPanel; openDayTaskPanel(2026,8,23); openCustomTaskPanel('calendar'); openScheduleTaskPanel('Ben',0); savePanelTask(); selectedTaskId='VIEW'; deleteTask();");
  assert(reader.run('JSON.stringify(tasks)===readerTasksBefore && JSON.stringify([document.getElementById("taskDate").value,document.getElementById("taskType").value])===readerFormBefore && calls.render===0 && calls.save===0 && calls.close===0 && calls.panels.length===0'),"direct reader task edit functions return before form or browser-state mutation or persistence");
  reader.run("openCalendarEventsSettings()");
  assert(reader.run("calls.settings===0 && calls.views.length===0"),"reader closure click attempts neither Settings navigation nor a Home fallback");

  const adminCalendar=absenceHarness("admin");
  adminCalendar.sandbox.calls={panels:[],settings:[],views:[]};
  adminCalendar.run(`
    updateTaskJobMeta=()=>{}; renderEmployeeChoices=()=>{}; updateTypeHint=()=>{}; updateAllocationSummary=()=>{};
    openPanel=id=>{calls.panels.push(id);};
    showSettingsSection=section=>{calls.settings.push(section);};
    showView=view=>{calls.views.push(view);};
    calendarDragSuppressClick=false;
    openCalendarDayFromGrid(2026,8,23);
  `);
  assert(adminCalendar.run('calls.panels[0]==="taskPanel" && document.getElementById("taskDate").value==="2026-09-23"'),"admin empty Calendar-day click still opens task creation on the selected date");
  adminCalendar.run("openCalendarEventsSettings()");
  assert(adminCalendar.run('calls.settings[0]==="calendarEvents" && calls.views[0]==="settings"'),"admin closure click still opens Calendar Events Settings");

  reader.run(`
    calls.panels=[]; calls.render=0; calls.save=0;
    renderAll=()=>{calls.render+=1;}; saveState=()=>{calls.save+=1;};
    scheduleStartDate=new Date(2026,8,14); buildScheduleDays(); calculate(); document.getElementById("rows").children=[]; renderSchedule();
  `);
  const readerRow=reader.elements.get("rows").children[0];
  const readerBar=readerRow.querySelector(".bars").children[0];
  const readerScheduleBefore=reader.run("JSON.stringify(tasks)");
  reader.sandbox.readerScheduleBefore=readerScheduleBefore;
  assert(readerBar && typeof readerBar.listeners.click === "function","reader Schedule bar remains clickable");
  assert(!readerBar.listeners.pointerdown && readerBar.draggable === false,"reader Schedule bar has no drag handler and is not draggable");
  readerBar.listeners.click({stopPropagation(){}});
  assert(reader.run('calls.panels.length===1 && calls.panels[0]==="taskDetailsPanel" && !calls.panels.includes("taskPanel")'),"reader Schedule-bar click opens only the safe task-details panel");
  assert(reader.run("JSON.stringify(tasks)===readerScheduleBefore && calls.render===0 && calls.save===0"),"reader Schedule details leave task data unchanged and do not render or save edits");

  const calendarCard={dataset:{taskId:"VIEW",taskType:"capacity",jobId:encodeURIComponent("J1")},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}};
  reader.run('document.getElementById("monthGrid")');
  const monthGrid=reader.elements.get("monthGrid");
  monthGrid.querySelectorAll=selector=>selector === ".month-item[data-task-id]" ? [calendarCard] : [];
  reader.run('calls.panels=[]; calls.render=0; calls.save=0; calendarBaseDate.setFullYear(2026,8,1); visibleMonthOffset=0; calendarDragSuppressClick=false;');
  const readerCalendarBefore=reader.run("JSON.stringify(tasks)");
  reader.sandbox.readerCalendarBefore=readerCalendarBefore;
  reader.run("renderCalendar()");
  assert(monthGrid.innerHTML.includes('data-task-id="VIEW"') && typeof calendarCard.listeners.click === "function","reader Calendar renders the visible VIEW task card and registers its real click listener");
  calendarCard.listeners.click({stopPropagation(){}});
  const detailsHtml=reader.elements.get("taskDetailsBody").innerHTML;
  assert(reader.run('calls.panels.length===1 && calls.panels[0]==="taskDetailsPanel" && !calls.panels.includes("taskPanel")'),"reader Calendar task-card click opens only the safe details panel");
  assert(detailsHtml.includes("readonly-field-value") && detailsHtml.includes("Assembly") && !/<(?:input|select|button)\b/i.test(detailsHtml),"reader Calendar task details contain read-only content without edit controls");
  assert(reader.run("JSON.stringify(tasks)===readerCalendarBefore && calls.render===0 && calls.save===0"),"reader Calendar task-card details leave tasks unchanged and make no render or save edit attempt");

  const adminSchedule=absenceHarness("admin");
  adminSchedule.sandbox.calls={panels:[]};
  adminSchedule.run(`
    tasks=[{id:"EDIT",job:"J1",name:"Assembly",type:"capacity",date:"2026-09-14",duration:120,department:"Cabinet Making",status:"Planned",assigned:["Ben"],assignmentMinutes:{Ben:120},assignmentDates:{Ben:"2026-09-14"}}];
    updateTaskJobMeta=()=>{}; renderEmployeeChoices=()=>{}; updateTypeHint=()=>{}; updateAllocationSummary=()=>{};
    openPanel=id=>{calls.panels.push(id);};
    scheduleStartDate=new Date(2026,8,14); buildScheduleDays(); calculate(); document.getElementById("rows").children=[]; renderSchedule();
  `);
  const adminRow=adminSchedule.elements.get("rows").children.find(row=>row.dataset.person === "Ben");
  const adminBar=adminRow.querySelector(".bars").children[0];
  assert(adminBar && typeof adminBar.listeners.click === "function" && typeof adminBar.listeners.pointerdown === "function","admin Schedule bar retains both edit click and drag pointer handlers");
  adminBar.listeners.click({stopPropagation(){}});
  assert(adminSchedule.run('calls.panels.length===1 && calls.panels[0]==="taskPanel"'),"admin Schedule-bar click retains editable task behavior");
  console.log("Read-only Calendar and Schedule tests passed");
}
function testForecastJobPresentation(){
  for(const role of ["admin","user"]){
    const h=absenceHarness(role);
    vm.runInContext(extractFunction("renderJobs"),h.sandbox);
    h.run('jobIsArchived=()=>false; calendarStageNamesForJob=()=>[]; document.getElementById("jobsCurrentBtn").classList.toggle=()=>{}; document.getElementById("jobsArchiveBtn").classList.toggle=()=>{}; calendarBaseDate.setFullYear(2026,8,1); visibleMonthOffset=0; document.getElementById("rows");');
    const stages=["Check Measure","Forward Ordering","Drafting","Machining","Assembly","Loading","Delivery","Install","2pak","Stone","Custom stage"];
    const fixture={...h.state,jobs:[{id:"SAVED",status:"Forecast",builder:"Synthetic builder",address:"Synthetic address",createdAt:"2020-01-01"},{id:"OTHER",status:"Active"}],tasks:[]};
    stages.forEach((name,index)=>fixture.tasks.push({id:`SAVED-${index}`,job:"SAVED",name,type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:60,assigned:["Ben"],showOnCalendar:true,status:"Planned",custom:index===10}));
    fixture.tasks.push(
      {id:"SAVED-UNASSIGNED",job:"SAVED",name:"Unassigned assembly",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:60,assigned:[],showOnCalendar:true,status:"Planned"},
      {id:"SAVED-SPLIT",job:"SAVED",name:"Split assembly",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:120,assigned:["Ben","Luke"],assignmentMinutes:{Ben:60,Luke:60},showOnCalendar:true,status:"Planned"},
      {id:"SAVED-ADMIN",job:"SAVED",name:"Admin stage",type:"admin",date:"2026-09-14",duration:60,assigned:[],status:"Planned"},
      {id:"SAVED-MILESTONE",job:"SAVED",name:"Install",type:"milestone",date:"2026-09-14",assigned:[],status:"Planned"},
      {id:"OTHER-TASK",job:"OTHER",name:"Assembly",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:60,assigned:["Luke"],showOnCalendar:true,status:"Forecast"},
      {id:"NO-JOB",job:"MISSING",name:"Custom stage",type:"capacity",date:"2026-09-14",duration:60,assigned:["Luke"],showOnCalendar:true,status:"Forecast"}
    );
    h.sandbox.fixture=fixture;
    const fixtureBefore=JSON.stringify(fixture);
    h.run('applyWorkspaceSnapshot(fixture); calculate();');
    const scheduledBefore=h.run('JSON.stringify(tasks.map(task=>task.parts))');
    const unrelatedBefore=h.run('JSON.stringify(taskPayloadForSave(tasks.find(task=>task.id==="OTHER-TASK")))');
    function renderAndCheck(expected){
      const stateBefore=h.run('JSON.stringify(workspaceSnapshot())');
      h.elements.get("rows").children=[];
      h.run('renderJobs(); renderCalendar(); renderSchedule();');
      const calendar=h.elements.get("monthGrid").innerHTML;
      const cards=[...calendar.matchAll(/class="month-item ([^"]*)"[^>]*data-task-id="([^"]*)"/g)];
      assert(cards.length===fixture.tasks.length,`${role}: all synthetic Calendar tasks rendered`);
      for(const [,classes,id] of cards){
        const forecast=expected && (id.startsWith("SAVED-") || id==="NEW-TASK");
        assert(classes.split(/\s+/).includes("forecast-job")===forecast,`${role}: Calendar ${id} follows parent job status`);
      }
      const bars=h.elements.get("rows").children.flatMap(row=>row.querySelector(".bars").children);
      assert(bars.some(bar=>bar.dataset.taskId==="SAVED-UNASSIGNED"),`${role}: Unassigned Forecast card rendered`);
      assert(bars.filter(bar=>bar.dataset.taskId==="SAVED-SPLIT").length===2,`${role}: both Forecast split cards rendered`);
      for(const bar of bars){
        const id=bar.dataset.taskId;
        const forecast=expected && (id.startsWith("SAVED-") || id==="NEW-TASK");
        assert(bar.className.split(/\s+/).includes("forecast-job")===forecast,`${role}: Schedule ${id} follows parent job status`);
        assert(bar.className.includes(h.run(`typeColour(tasks.find(task=>task.id===${JSON.stringify(id)}))`)),`${role}: Schedule task-type class retained`);
        assert(!bar.style.background && !bar.style.color,`${role}: no inline card colour overrides`);
      }
      const jobHtml=h.elements.get("jobRows").innerHTML;
      const pills=[...jobHtml.matchAll(/class="job-status ([^"]*)">([^<]*)/g)];
      const status=h.run('jobs[0].status');
      const cls=status==="Forecast" ? "forecast" : status==="On Hold" ? "hold" : status==="Complete" ? "complete" : "active";
      assert(pills[0][1]===cls && pills[0][2]===status,`${role}: Jobs pill uses current status`);
      assert(h.run('JSON.stringify(workspaceSnapshot())')===stateBefore,`${role}: all views leave saved state unchanged`);
      assert(h.run('JSON.stringify(tasks.map(task=>task.parts))')===scheduledBefore,`${role}: status colours do not change scheduling results`);
      assert(h.run('JSON.stringify(taskPayloadForSave(tasks.find(task=>task.id==="OTHER-TASK")))')===unrelatedBefore,`${role}: unrelated Forecast task on Active job unchanged`);
      assert(h.saved===null,`${role}: presentation never saves data`);
    }
    renderAndCheck(true);
    assert(JSON.stringify(fixture)===fixtureBefore,`${role}: loading and rendering preserve original saved fixture`);
    for(const status of ["Active","On Hold","Complete","Planned","Waiting","In Progress","Forecast"]){
      h.sandbox.nextStatus=status;
      h.run('jobs[0].status=nextStatus;');
      renderAndCheck(status==="Forecast");
    }
    h.run('jobs.push({id:"NEW",status:"Forecast"}); tasks.push({id:"NEW-TASK",job:"NEW",name:"Assembly",type:"capacity",department:"Cabinet Making",date:"2026-09-14",duration:60,assigned:["Luke"],showOnCalendar:true,status:"Planned"}); calculate();');
    // New tasks naturally add scheduled parts; subsequent presentation must preserve them.
    const newScheduled=h.run('JSON.stringify(tasks.map(task=>task.parts))');
    h.elements.get("rows").children=[];
    const newState=h.run('JSON.stringify(workspaceSnapshot())');
    h.run('renderJobs(); renderCalendar(); renderSchedule();');
    assert(/class="month-item [^"]*forecast-job[^"]*"[^>]*data-task-id="NEW-TASK"/.test(h.elements.get("monthGrid").innerHTML),`${role}: new Forecast Calendar card`);
    const newBar=h.elements.get("rows").children.flatMap(row=>row.querySelector(".bars").children).find(bar=>bar.dataset.taskId==="NEW-TASK");
    assert(newBar?.className.includes("forecast-job"),`${role}: new Forecast Schedule card`);
    assert(/data-job-id="NEW"[\s\S]*?class="job-status forecast">Forecast/.test(h.elements.get("jobRows").innerHTML),`${role}: new Forecast Jobs pill`);
    assert(h.run('JSON.stringify(workspaceSnapshot())')===newState && h.run('JSON.stringify(tasks.map(task=>task.parts))')===newScheduled && h.saved===null,`${role}: new Forecast rendering does not reschedule or save`);
  }
  console.log("Forecast presentation tests passed (Jobs/Calendar/Schedule, saved/new jobs, status transitions, task types, warnings, split/unassigned, admin/read-only, no data writes)");
}
function testEmployeeRenameReferences(){
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:"",checked:true,focus(){},classList:{remove(){}}});
    return elements.get(id);
  };
  const task = {
    id:"RENAME",assigned:["Ben","Luke","Nora","Ben"],adminEmployee:"Ben",
    assignmentMinutes:{Ben:83.25,Luke:120,Nora:60,Removed:5},
    assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15",Nora:"2026-09-16",Removed:"2026-09-17"},
    scheduleOrder:{Ben:17,Luke:4,Nora:9,Removed:1},customField:{keep:true},parts:[{date:"2026-09-14",minutes:83.25}],
  };
  const missingOrderTask = {id:"MISSING-ORDER",assigned:["Ben"],assignmentMinutes:{Ben:12},assignmentDates:{Ben:"2026-09-14"}};
  const emptyOrderTask = {id:"EMPTY-ORDER",assigned:["Ben"],scheduleOrder:{}};
  const orderWithoutOldNameTask = {id:"NO-OLD-ORDER",assigned:["Ben"],scheduleOrder:{Luke:8}};
  const unrelatedTask = {id:"UNRELATED",assigned:["Luke","Luke"],assignmentMinutes:{Luke:30},scheduleOrder:{Luke:2},metadata:"unchanged"};
  const absentAssignmentsTask = {id:"ABSENT-ASSIGNMENTS",scheduleOrder:{Luke:5}};
  const malformedAssignmentsTask = {id:"MALFORMED-ASSIGNMENTS",assigned:"legacy-value",scheduleOrder:{Luke:6}};
  const h = {
    people:[{name:"Ben",role:"Cabinet Making",countsCapacity:true},{name:"Luke",role:"Cabinet Making",countsCapacity:true}],
    tasks:[task,missingOrderTask,emptyOrderTask,orderWithoutOldNameTask,unrelatedTask,absentAssignmentsTask,malformedAssignmentsTask],dayStatuses:[{person:"Ben",type:"Sick",startDate:"2026-09-14",endDate:"2026-09-14"}],
    absenceOverrides:[{person:"Ben",date:"2026-09-14",statuses:[{type:"Sick"}]}],
    selectedEmployeeName:"Ben",isAdmin:true,toasts:[],document:{getElementById:element},
    showToast:message=>h.toasts.push(message),getStandardWeekFromInputs(){return {Mon:480};},
    getCustomWeekInputs(){return {};},currentEmployeePattern(){return "Standard";},convertEmployeeAssignmentsForRole(){},closeEmployeePanel(){},renderAll(){},saveState(){},
  };
  vm.createContext(h);
  vm.runInContext([extractFunction("renameEmployeeReferences"),extractFunction("saveEmployee"),extractFunction("taskPayloadForSave")].join("\n"),h);
  const unrelatedBefore = JSON.stringify(unrelatedTask);
  const absentAssignmentsBefore = JSON.stringify(absentAssignmentsTask);
  const malformedAssignmentsBefore = JSON.stringify(malformedAssignmentsTask);

  h.renameEmployeeReferences("Ben","Nora");
  assert(JSON.stringify(task.assigned) === JSON.stringify(["Nora","Luke"]),"rename deduplicates assigned employees after colliding with the new name");
  assert(task.assignmentMinutes.Nora === 83.25 && !("Ben" in task.assignmentMinutes),"rename moves exact assignment minutes and removes the old key");
  assert(task.assignmentDates.Nora === "2026-09-14" && !("Ben" in task.assignmentDates),"rename moves assignment dates and removes the old key");
  assert(task.scheduleOrder.Nora === 17 && task.scheduleOrder.Luke === 4 && !("Ben" in task.scheduleOrder),"rename moves exact schedule order without renumbering or retaining the old key");
  assert(!Object.prototype.hasOwnProperty.call(missingOrderTask,"scheduleOrder") && missingOrderTask.assignmentMinutes.Nora === 12,"rename does not invent schedule order when the task had no order map");
  assert(JSON.stringify(emptyOrderTask.scheduleOrder) === "{}","rename preserves an empty schedule order map");
  assert(JSON.stringify(orderWithoutOldNameTask.scheduleOrder) === JSON.stringify({Luke:8}),"rename does not add a new priority when schedule order has no old-name key");
  assert(task.adminEmployee === "Nora" && h.dayStatuses[0].person === "Nora" && h.absenceOverrides[0].person === "Nora","rename updates admin employee, absence status, and absence override references");
  assert(task.customField.keep && task.parts[0].minutes === 83.25 && JSON.stringify(unrelatedTask) === unrelatedBefore,"rename leaves task metadata and unrelated duplicate assignees unchanged");
  assert(JSON.stringify(absentAssignmentsTask) === absentAssignmentsBefore && JSON.stringify(malformedAssignmentsTask) === malformedAssignmentsBefore,"rename safely leaves tasks with absent or non-array assignments unchanged");
  const payload = h.taskPayloadForSave(task);
  assert(payload.scheduleOrder.Nora === 17 && !("Ben" in payload.scheduleOrder) && !("Removed" in payload.scheduleOrder),"save payload retains the renamed order key and filters stale order keys");
  assert(payload.assignmentMinutes.Nora === 83.25 && !("Removed" in payload.assignmentMinutes),"save payload retains renamed assignment values and filters stale map keys");

  h.people[0].name = "Nora";
  h.selectedEmployeeName = "Nora";
  element("employeeRoleInput").value = "Cabinet Making";
  for (const duplicateName of ["Luke","lUkE"]) {
    const beforeDuplicate = JSON.stringify({people:h.people,tasks:h.tasks,dayStatuses:h.dayStatuses,absenceOverrides:h.absenceOverrides});
    element("employeeNameInput").value = duplicateName;
    h.saveEmployee();
    assert(JSON.stringify({people:h.people,tasks:h.tasks,dayStatuses:h.dayStatuses,absenceOverrides:h.absenceOverrides}) === beforeDuplicate,`duplicate-name rejection for ${duplicateName} leaves complete relevant state unchanged`);
    assert(h.toasts[h.toasts.length-1] === "That employee name already exists",`duplicate-name rejection for ${duplicateName} reports the existing name`);
  }

  element("employeeNameInput").value = "nora";
  h.saveEmployee();
  assert(h.people[0].name === "nora" && h.people[1].name === "Luke","case-only rename is accepted");
  assert(JSON.stringify(task.assigned) === JSON.stringify(["nora","Luke"]) && task.adminEmployee === "nora","case-only rename updates assigned and admin employee references");
  assert(task.assignmentMinutes.nora === 83.25 && !("Nora" in task.assignmentMinutes) && task.assignmentDates.nora === "2026-09-14" && !("Nora" in task.assignmentDates),"case-only rename migrates exact assignment values and dates without stale keys");
  assert(task.scheduleOrder.nora === 17 && !("Nora" in task.scheduleOrder),"case-only rename migrates schedule order without stale keys");
  assert(h.dayStatuses[0].person === "nora" && h.absenceOverrides[0].person === "nora","case-only rename updates day status and absence override references");
  const caseOnlyPayload = h.taskPayloadForSave(task);
  assert(caseOnlyPayload.assigned.includes("nora") && caseOnlyPayload.assignmentMinutes.nora === 83.25 && caseOnlyPayload.assignmentDates.nora === "2026-09-14" && caseOnlyPayload.scheduleOrder.nora === 17 && !("Nora" in caseOnlyPayload.scheduleOrder),"saved payload retains case-only renamed references and schedule order");
  console.log("Employee rename reference tests passed");
}
async function testPartialUnassignedPersistence(){
  const h=absenceHarness();
  h.run(`tasks=[{id:"SPLIT",job:"Test",name:"Assembly",custom:true,type:"capacity",date:"2026-09-14",duration:360,assigned:["Ben","Luke"],assignmentMinutes:{Ben:120,Luke:240},assignmentDates:{Ben:"2026-09-14",Luke:"2026-09-15"},scheduleOrder:{Ben:5,Luke:7}},{id:"OTHER",custom:true,job:"Test",name:"Other",type:"capacity",date:"2026-09-14",duration:60,assigned:["Ben"]}]; lastPersistedWorkspace=workspaceSnapshot();`);
  const other=h.run('JSON.stringify(taskPayloadForSave(tasks[1]))');
  await h.run('moveTaskToCell(tasks[0],{dataset:{person:"Unassigned",day:"2"}},"Ben",null,true,0)');
  assert(h.saved.tasks[0].unassignedMinutes===120 && h.saved.tasks[0].duration===360 && h.saved.tasks[0].assignmentMinutes.Luke===240,"real drag queues serialized balanced partial allocation");
  assert(!("Ben" in h.saved.tasks[0].scheduleOrder) && !("Ben" in h.saved.tasks[0].assignmentDates) && !("Ben" in h.saved.tasks[0].assignmentMinutes),"drag removes all old employee keys");
  assert(h.run('JSON.stringify(taskPayloadForSave(tasks[1]))')===other,"drag leaves unrelated task unchanged");
  h.sandbox.reload=h.saved;
  h.run('applyWorkspaceSnapshot(reload); calculate(); document.getElementById("rows").children=[]; renderSchedule();');
  assert(h.run('tasks[0].parts.some(part=>part.person==="Unassigned" && part.minutes===120 && part.date==="2026-09-16") && tasks[0].parts.some(part=>part.person==="Luke" && part.minutes===240 && part.date==="2026-09-15")'),"reload schedules both preserved assigned share and residual");
  const row=h.elements.get("rows").children.find(row=>row.dataset.person==="Unassigned");
  assert(row.innerHTML.includes("1 waiting") && row.querySelector(".bars").children.length===1,"real Schedule render includes partial residual row, count and bar");
  h.run('openDayPanel("Unassigned",2)');
  assert(h.elements.get("dayPanelBody").innerHTML.includes("Assembly"),"Unassigned day panel includes partial task");
  h.run('openTaskPanel("SPLIT")');
  assert(h.elements.get("allocationSummary").innerHTML.includes("2h unassigned"),"single remaining employee task editor displays residual");
  h.sandbox.document.querySelectorAll=selector=>selector === "#employeeChoices input:checked" ? [{value:"Luke"}] : [];
  h.run('savePanelTask()');
  assert(h.run('tasks[0].duration===360 && tasks[0].assignmentMinutes.Luke===240 && tasks[0].unassignedMinutes===120'),"details-only task save preserves residual and assigned share");
  await h.run('moveTaskToCell(tasks[0],{dataset:{person:"Luke",day:"3"}},"Unassigned",null,true,2)');
  assert(h.saved.tasks[0].duration===360 && h.saved.tasks[0].assignmentMinutes.Luke===360 && h.saved.tasks[0].assigned.length===1 && h.saved.tasks[0].unassignedMinutes===0,"real residual reassignment merges without growing total");
  const generated={id:"GEN",job:"J1",name:"Assembly",stageGroup:"Assembly",stageDepartment:"Cabinet Making",department:"Cabinet Making",type:"capacity",date:"2026-09-14",duration:360,estimatedHours:6,assigned:["Luke"],assignmentMinutes:{Luke:240},assignmentDates:{Luke:"2026-09-15"},scheduleOrder:{Luke:7},unassignedMinutes:120,unassignedDate:"2026-09-16"};
  const g=generatedJobHarness({oldTasks:[generated]});
  g.run('addJobStages=stagesFromJobTasks(tasks);');
  await g.save();
  assert(g.run('tasks[0].duration===360 && tasks[0].assignmentMinutes.Luke===240 && tasks[0].unassignedMinutes===120 && tasks[0].unassignedDate==="2026-09-16" && tasks[0].scheduleOrder.Luke===7'),"generated job details save preserves explicit blank share and exact order");
  const fully={...generated,assigned:[],assignmentMinutes:{},assignmentDates:{},scheduleOrder:{},unassignedMinutes:360};
  const fullJob=generatedJobHarness({oldTasks:[fully]});
  fullJob.run('addJobStages=stagesFromJobTasks(tasks);');
  await fullJob.save();
  assert(fullJob.run('tasks[0].id==="GEN" && tasks[0].duration===360 && tasks[0].assigned.length===0 && tasks[0].unassignedMinutes===360 && tasks[0].unassignedDate==="2026-09-16"'),"fully-unassigned generated job edit retains identity, explicit total and distinct residual target date");
  const role=absenceHarness();
  role.sandbox.partial=generated;
  role.run('tasks=[JSON.parse(JSON.stringify(partial))]; convertEmployeeAssignmentsForRole("Luke","Cabinet Making","Admin");');
  assert(role.run('tasks[0].duration===120 && tasks[0].unassignedMinutes===120 && tasks[0].assigned.length===0 && tasks[1].duration===240 && !("unassignedMinutes" in tasks[1]) && !("unassignedDate" in tasks[1])'),"Admin role conversion preserves capacity residual without copying fields into admin task");
  console.log("Partial unassigned persistence tests passed (drag, reload, render, task/job editing, reassignment, role conversion)");
}
async function emitSplitState(){
  const h=absenceHarness();
  h.sandbox.backendSeed=JSON.parse(fs.readFileSync(0,"utf8"));
  h.run('applyWorkspaceSnapshot(backendSeed); stateRevision=backendSeed._revision; lastPersistedWorkspace=workspaceSnapshot();');
  const action=process.argv.includes("--residual-to-employee") ? 'moveTaskToCell(tasks[0],{dataset:{person:"Ben",day:"3"}},"Unassigned",null,true,2)' : process.argv.includes("--move-unassigned") ? 'moveTaskToCell(tasks[0],{dataset:{person:"Unassigned",day:"3"}},"Unassigned",null,true,2)' : 'moveTaskToCell(tasks[0],{dataset:{person:"Unassigned",day:"2"}},"Ben",null,true,0)';
  await h.run(action);
  console.log(JSON.stringify(h.saved));
}
const frontendTests = process.argv.includes("--emit-split-state") ? [emitSplitState] : process.argv.includes("--split-only") ? [testDraggedSplitSharesToUnassigned,testPartialUnassignedPersistence] : process.argv.includes("--task-delete-only")
  ? [testCustomTaskDeletionSafety]
  : [testDraggedSplitSharesToUnassigned,testPartialUnassignedPersistence,testGeneratedJobRebuilds,testAbsenceOverrides,testCustomTaskDeletionSafety,testRosterDayOffOverrides,testHomeCapacityOptOut,testReadOnlyCalendarAndSchedule,testForecastJobPresentation,testEmployeeRenameReferences];
frontendTests.reduce((pending,test)=>pending.then(test),Promise.resolve()).catch(error=>{console.error(error);process.exitCode=1;});
