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
  for(const name of ["core.js","schedule.js","tasks.js","settings.js","home.js"])
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
  assert(h.run('capacityFor(people[0],2)')===0,"non-capacity employee stays zero");
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
testAbsenceOverrides().then(testRosterDayOffOverrides).catch(error=>{console.error(error);process.exitCode=1;});
