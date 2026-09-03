const currentUser = JSON.parse(document.body.dataset.currentUser || "{}");
const isAdmin = currentUser.role === "admin";
const csrfToken = document.body.dataset.csrfToken || "";
let stateRevision = 0;
let appUsers = [];

async function apiFetch(url, options={}){
  const method = String(options.method || "GET").toUpperCase();
  const headers = {...(options.headers || {})};
  if (!["GET","HEAD","OPTIONS"].includes(method)) headers["X-CSRF-Token"] = csrfToken;
  const response = await fetch(url, {...options, headers});
  if (response.status === 401) {window.location.href = "/login"; throw new Error("Login required");}
  if (response.status === 403) {
    let payload = {}; try {payload = await response.clone().json();} catch (_) {}
    if (String(payload.error || "").toLowerCase().includes("password change")) window.location.href = "/change-password";
  }
  return response;
}
const baseYear = 2026;
const baseMonth = 5; // legacy demo-data month (June)
const scheduleStartDay = 8;
const legacyBaseDate = new Date(baseYear, baseMonth, scheduleStartDay);
const calendarBaseDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

let scheduleStartDate = startOfWeek(new Date());
let scheduleSpanDays = 91;
let scheduleDayWidth = 160;
let days = [];

let people = [];

let jobs = [];

let tasks = [];

let selectedTaskId = null;
let selectedEmployeeName = null;
let visibleMonthOffset = 0;
let currentDragTask = null;
let currentDragPerson = null;
let schedulePointerDrag = null;
let schedulePointerFrame = 0;
let scheduleSuppressClickUntil = 0;
let calendarDragTask = null;
let calendarDragSuppressClick = false;
let homeWeek = "this";
let jobsViewMode = "current";
const JOB_ARCHIVE_AFTER_DAYS = 60;
let dayStatuses = [];
let saveTimer = null;
let saveChain = Promise.resolve();
let stateLoaded = false;
let addJobStages = [];
let addJobExcludedStages = new Set();
let addJobRemovedStageCache = new Map();
let addJobSource = "manual";
let addJobImportDetails = null;
let editingJobId = null;
let addJobSaveInProgress = false;
let lastStateSaveError = "";
let lastStateSaveConflict = false;
let pendingStateSaves = 0;
let scheduleMoveSaving = false;
let lastPersistedWorkspace = null;
let stateDirty = false;
let stateEpoch = 0;
let scheduleSaveStatusTimer = null;
let calendarEvents = [];
let activeSettingsSection = "employees";
let selectedCalendarEventId = null;
let employeeDragName = null;
let taskPanelOrigin = "general";

function taskPayloadForSave(source){
  const {parts, unscheduledMinutes, ...task} = source;
  const assigned = [...new Set((task.assigned || []).filter(Boolean))];
  const assignedSet = new Set(assigned);
  const filterAssignedMap = mapping => Object.fromEntries(Object.entries(mapping || {}).filter(([name]) => assignedSet.has(name)));
  task.assigned = assigned;
  task.scheduleOrder = filterAssignedMap(task.scheduleOrder);
  task.assignmentMinutes = filterAssignedMap(task.assignmentMinutes);
  task.assignmentDates = filterAssignedMap(task.assignmentDates);
  if (task.deliveryReady) {
    const currentDeliveryDate = toIsoDate(taskDate(task));
    if (!isDeliveryTask(task) || task.deliveryReady.deliveryDate !== currentDeliveryDate) delete task.deliveryReady;
  }
  return task;
}
function workspaceSnapshot(){
  return JSON.parse(JSON.stringify({
    version: 9,
    people,
    jobs,
    tasks: tasks.map(taskPayloadForSave),
    dayStatuses,
    calendarEvents
  }));
}
function statePayload(){
  return {_revision: stateRevision, ...workspaceSnapshot()};
}
function applyWorkspaceSnapshot(snapshot){
  const state = JSON.parse(JSON.stringify(snapshot || {}));
  people = Array.isArray(state.people) ? state.people : [];
  people.forEach(person => {
    if (typeof person.countsCapacity !== "boolean") person.countsCapacity = person.role !== "Admin";
    if (person.role === "Admin") person.countsCapacity = false;
    if (!person.capacityOverrides || typeof person.capacityOverrides !== "object" || Array.isArray(person.capacityOverrides)) person.capacityOverrides = {};
  });
  jobs = Array.isArray(state.jobs) ? state.jobs : [];
  tasks = Array.isArray(state.tasks) ? state.tasks : [];
  tasks.forEach(task => {
    if (!task.date && Number.isFinite(Number(task.start))) task.date = toIsoDate(legacyDateForDayIndex(Number(task.start)));
    if (typeof task.showOnCalendar !== "boolean") task.showOnCalendar = false;
    if (typeof task.stoneMason !== "string") task.stoneMason = "";
  });
  dayStatuses = Array.isArray(state.dayStatuses) ? state.dayStatuses : [];
  calendarEvents = Array.isArray(state.calendarEvents) ? state.calendarEvents : [];
  dayStatuses.forEach(status => {
    if (!status.startDate && Number.isFinite(Number(status.start))) status.startDate = toIsoDate(legacyDateForDayIndex(Number(status.start)));
    if (!status.endDate && Number.isFinite(Number(status.end))) status.endDate = toIsoDate(legacyDateForDayIndex(Number(status.end)));
  });
}
function restoreLastPersistedWorkspace(){
  clearTimeout(saveTimer);
  saveTimer = null;
  stateEpoch += 1;
  if (lastPersistedWorkspace) applyWorkspaceSnapshot(lastPersistedWorkspace);
  stateDirty = false;
  renderAll();
}
function setScheduleSaveStatus(message="",kind=""){
  const el=document.getElementById("scheduleSaveStatus");
  if(!el) return;
  clearTimeout(scheduleSaveStatusTimer);
  el.textContent=message;
  el.className=`schedule-save-status ${kind || ""}`.trim();
  if(kind === "saved") scheduleSaveStatusTimer=setTimeout(()=>{if(pendingStateSaves===0 && !scheduleMoveSaving){el.textContent="";el.className="schedule-save-status";}},1800);
}
window.addEventListener("beforeunload",event=>{
  if(stateDirty || pendingStateSaves>0 || scheduleMoveSaving){
    event.preventDefault();
    event.returnValue="";
  }
});

async function loadSavedState({quiet=false}={}){
  try{
    const response = await apiFetch("/api/state");
    if (response.status === 401) {window.location.href = "/login"; return false;}
    if (!response.ok) {
      let payload={}; try{payload=await response.json();}catch(_){}
      throw new Error(payload.error || `Load failed (${response.status})`);
    }
    const state = await response.json();
    stateRevision = Number(state._revision || 0);
    applyWorkspaceSnapshot(state);
    initialiseScheduleWindow();
    stateLoaded = true;
    stateDirty = false;
    stateEpoch += 1;
    lastPersistedWorkspace = workspaceSnapshot();
    renderAll();
    if (isAdmin) loadUsers();
    if(!quiet) showToast("TrackR data loaded");
    return true;
  }catch(error){
    console.error(error);
    stateLoaded = false;
    if(!quiet) showToast(error?.message || "Could not load saved TrackR data");
    return false;
  }
}

async function persistState(message="Saved", queuedEpoch=stateEpoch){
  if(!stateLoaded || !isAdmin || queuedEpoch !== stateEpoch) return false;
  clearTimeout(saveTimer);
  saveTimer = null;
  lastStateSaveError = "";
  lastStateSaveConflict = false;
  pendingStateSaves += 1;
  setScheduleSaveStatus("Saving…","saving");
  let successful=false;
  const payload = statePayload();
  const sentSnapshot = JSON.parse(JSON.stringify({
    version: payload.version,
    people: payload.people,
    jobs: payload.jobs,
    tasks: payload.tasks,
    dayStatuses: payload.dayStatuses,
    calendarEvents: payload.calendarEvents
  }));
  try{
    const response = await apiFetch("/api/state", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    let result = {}; try {result = await response.json();} catch (_) {}
    if (response.status === 409) {
      lastStateSaveConflict = true;
      lastStateSaveError = result.error || "TrackR changed elsewhere. Your change was not saved.";
      clearTimeout(saveTimer);
      saveTimer = null;
      stateLoaded = false;
      stateDirty = false;
      stateEpoch += 1;
      setScheduleSaveStatus("Not saved","error");
      const reloaded = await loadSavedState({quiet:true});
      showToast(reloaded ? `${lastStateSaveError} Latest data reloaded.` : `${lastStateSaveError} Refresh TrackR.`);
      return false;
    }
    if(!response.ok) throw new Error(result.error || `Save failed (${response.status})`);
    stateRevision = Number(result.revision || stateRevision + 1);
    lastPersistedWorkspace = sentSnapshot;
    stateDirty = JSON.stringify(workspaceSnapshot()) !== JSON.stringify(sentSnapshot);
    successful=true;
    showToast(message);
    return true;
  }catch(error){
    console.error(error);
    lastStateSaveError = error?.message || "Save failed";
    setScheduleSaveStatus("Not saved","error");
    restoreLastPersistedWorkspace();
    showToast(`${lastStateSaveError} Unsaved changes were rolled back.`);
    return false;
  }finally{
    pendingStateSaves=Math.max(0,pendingStateSaves-1);
    if(successful && pendingStateSaves===0) setScheduleSaveStatus("Saved","saved");
  }
}

function queueStateSave(message="Saved"){
  if(!stateLoaded || !isAdmin) return Promise.resolve(false);
  clearTimeout(saveTimer);
  saveTimer = null;
  stateDirty = true;
  const queuedEpoch = stateEpoch;
  saveChain = saveChain.then(
    () => persistState(message, queuedEpoch),
    () => persistState(message, queuedEpoch)
  );
  return saveChain;
}
function saveState(message="Saved"){
  if(!stateLoaded || !isAdmin) return;
  stateDirty = true;
  clearTimeout(saveTimer);
  const queuedEpoch = stateEpoch;
  saveTimer = setTimeout(() => {
    if (queuedEpoch !== stateEpoch) return;
    queueStateSave(message);
  }, 180);
}

function fmt(minutes){
  minutes = Math.round(minutes || 0);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2,"0")}`;
}
function parseHours(value){
  const txt = String(value || "").trim().toLowerCase();
  if (!txt || txt === "0" || txt === "0h") return 0;
  const compact = txt.match(/^(\d+)\s*h\s*(\d+)$/);
  if (compact) {
    const extraMinutes = Number(compact[2]);
    return extraMinutes < 60 ? Number(compact[1]) * 60 + extraMinutes : Number.NaN;
  }
  const h = txt.match(/^(\d+(?:\.\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/);
  if (h) {
    const extraMinutes = Number(h[2] || 0);
    return extraMinutes < 60 ? Math.round(Number(h[1]) * 60 + extraMinutes) : Number.NaN;
  }
  const minutes = txt.match(/^(\d+)\s*m$/);
  if (minutes) return Number(minutes[1]);
  const decimal = Number(txt);
  if (Number.isFinite(decimal) && decimal >= 0) return Math.round(decimal * 60);
  return Number.NaN;
}
function jobById(id){return jobs.find(job => job.id === id)}
function dayNameForIndex(i){return days[i] ? days[i].name : ""}
function parseIsoDate(value){
  if (!value) return null;
  const p = String(value).split("-").map(Number);
  if (p.length !== 3 || p.some(Number.isNaN)) return null;
  return new Date(p[0], p[1]-1, p[2]);
}
function addCalendarDays(dateObj, amount){
  const result = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  result.setDate(result.getDate() + Number(amount || 0));
  return result;
}
function startOfWeek(dateObj){
  const result = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const offset = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - offset);
  return result;
}
function legacyDateForDayIndex(dayIndex){ return addCalendarDays(legacyBaseDate, Number(dayIndex || 0)); }
function legacyIndexForDate(dateObj){ return calendarDayDifference(legacyBaseDate, dateObj); }
function dateForDayIndex(dayIndex){ return addCalendarDays(scheduleStartDate, Number(dayIndex || 0)); }
function taskDate(task){ return parseIsoDate(task && task.date) || legacyDateForDayIndex(Number(task && task.start || 0)); }
function taskDateForPerson(task,personName){
  const override = task && task.assignmentDates && personName ? parseIsoDate(task.assignmentDates[personName]) : null;
  return override || taskDate(task);
}
function isSameDate(a,b){ return !!a && !!b && a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }
function scheduleIndexForDate(dateObj){ return calendarDayDifference(scheduleStartDate, dateObj); }
function buildScheduleDays(){
  days = Array.from({length:scheduleSpanDays}, (_,index) => {
    const dateObj = dateForDayIndex(index);
    return {name:dateObj.toLocaleDateString("en-AU",{weekday:"short"}),date:dateObj.toLocaleDateString("en-AU",{day:"numeric",month:"short"}),iso:toIsoDate(dateObj),monthDay:dateObj.getDate(),working:dateObj.getDay()!==0&&dateObj.getDay()!==6};
  });
  document.documentElement.style.setProperty("--day-count", scheduleSpanDays);
}
function initialiseScheduleWindow(){
  // Always open the Schedule on the current week. Users can then navigate
  // forward or backward without the initial view jumping to the nearest task.
  scheduleStartDate = startOfWeek(new Date());
  buildScheduleDays();
}
function updateScheduleDayWidth(){
  const planner = document.getElementById("planner");
  const peopleWidth = 190;
  const plannerWidth = planner?.clientWidth || Math.max(900, window.innerWidth - 48);
  const available = Math.max(7 * 125, plannerWidth - peopleWidth - 2);
  // Fit exactly one Monday-to-Sunday week in the visible planner.
  // The remaining continuous timeline stays available through horizontal scrolling.
  scheduleDayWidth = Math.max(125, Math.floor(available / 7));
  document.documentElement.style.setProperty("--day", `${scheduleDayWidth}px`);
}
function changeScheduleWeek(direction){ scheduleStartDate = addCalendarDays(scheduleStartDate, Number(direction||0)*7); buildScheduleDays(); renderAll(); }
function goScheduleToday(){ scheduleStartDate = startOfWeek(new Date()); buildScheduleDays(); renderAll(); }
function toIsoDate(dateObj){
  if (!dateObj || Number.isNaN(dateObj.getTime())) return "";
  return `${dateObj.getFullYear()}-${String(dateObj.getMonth()+1).padStart(2,"0")}-${String(dateObj.getDate()).padStart(2,"0")}`;
}
function calendarEventBlocksProduction(event){
  // Preserve TrackR's existing capacity rule: Factory Closure, Public Holiday
  // and Company Event are all company-wide non-production days.
  return !!event;
}
function isWorkingProductionDay(dateObj){
  if (!dateObj || dateObj.getDay() === 0 || dateObj.getDay() === 6) return false;
  return !calendarEventBlocksProduction(globalCalendarEventForDate(dateObj));
}
function addBusinessDays(dateObj, amount){
  const result = new Date(dateObj);
  const direction = amount >= 0 ? 1 : -1;
  let remaining = Math.abs(Number(amount) || 0);
  while (remaining > 0) {
    result.setDate(result.getDate() + direction);
    if (isWorkingProductionDay(result)) remaining--;
  }
  return result;
}
function ensureBusinessDay(dateObj){
  const result = new Date(dateObj);
  while (!isWorkingProductionDay(result)) result.setDate(result.getDate() + 1);
  return result;
}
function calendarDayDifference(fromDate, toDate){
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.round((end - start) / 86400000);
}
function escapeHtml(value){
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[char]));
}
function weekPatternForDate(person, dateObj){
  if ((person.workPattern || "Standard") !== "Custom") return person.week || {};
  const start = parseIsoDate(person.customStart) || new Date(baseYear, baseMonth, scheduleStartDay);
  const diffDays = Math.floor((dateObj - start) / (24*60*60*1000));
  const cycleDay = ((diffDays % 14) + 14) % 14;
  return cycleDay < 7 ? (person.week1 || person.week || {}) : (person.week2 || person.week || {});
}
function blockedStatusForDate(personName, dateObj){
  if (!personName || !dateObj) return null;
  const iso = toIsoDate(dateObj);
  return dayStatuses.find(status => {
    if (status.person !== personName) return false;
    const start = status.startDate || toIsoDate(legacyDateForDayIndex(Number(status.start || 0)));
    const end = status.endDate || toIsoDate(legacyDateForDayIndex(Number(status.end || status.start || 0)));
    return iso >= start && iso <= end;
  }) || null;
}
function globalCalendarEventForDate(dateObj){
  if (!dateObj) return null;
  const iso = toIsoDate(dateObj);
  return calendarEvents.find(event => iso >= event.startDate && iso <= event.endDate) || null;
}
function employeeCountsCapacity(person){ return !!person && person.role !== "Admin" && person.countsCapacity !== false; }
function defaultCalendarVisibilityForStage(value){
  const name=normaliseSearch(value);
  if(name.includes("stone")) return false;
  return name.includes("check measure") || name === "delivery" || name.endsWith(" delivery") || name === "install" || name.endsWith(" install");
}
function taskNeedsDetails(task){
  return !!task && task.type === "capacity" && (Number(task.duration || 0) <= 0 || !(task.assigned || []).length);
}
function jobMissingDetailsCount(jobId){
  return tasks.filter(task => String(task.job) === String(jobId) && taskNeedsDetails(task) && task.status !== "Complete").length;
}
function calendarTaskVisible(task){ return !!task && (task.type === "milestone" || task.type === "admin" || (task.type === "capacity" && task.showOnCalendar === true)); }
function rosteredCapacityForDate(person,dateObj){
  if (!employeeCountsCapacity(person) || !dateObj) return 0;
  const dayName = dateObj.toLocaleDateString("en-AU",{weekday:"short"});
  return Math.max(0,Number(weekPatternForDate(person,dateObj)[dayName] || 0));
}
function defaultDailyCapacity(person){
  const values = [person?.week,person?.week1,person?.week2].flatMap(week => Object.values(week || {})).map(Number).filter(value => value > 0);
  return values.length ? Math.max(...values) : 460;
}
function capacityOverrideForDate(person,dateObj){
  if (!person || !dateObj || !person.capacityOverrides) return null;
  const iso = toIsoDate(dateObj);
  if (!Object.prototype.hasOwnProperty.call(person.capacityOverrides,iso)) return null;
  const value = Number(person.capacityOverrides[iso]);
  return Number.isFinite(value) ? Math.max(0,value) : null;
}
function normalCapacityForDate(person,dateObj){
  if (!employeeCountsCapacity(person) || !dateObj || !isWorkingProductionDay(dateObj)) return 0;
  return rosteredCapacityForDate(person,dateObj);
}
function capacityForDate(person,dateObj){
  if (!employeeCountsCapacity(person) || !dateObj) return 0;
  if (blockedStatusForDate(person.name,dateObj)) return 0;
  const override = capacityOverrideForDate(person,dateObj);
  if (override !== null) return override;
  return normalCapacityForDate(person,dateObj);
}
function capacityFor(person, dayIndex){ return capacityForDate(person, dateForDayIndex(dayIndex)); }
function weeklyCapacity(person){
  if (!employeeCountsCapacity(person)) return 0;
  if ((person.workPattern || "Standard") === "Custom") {
    const week1 = Object.values(person.week1 || {}).reduce((sum, mins) => sum + (mins || 0), 0);
    const week2 = Object.values(person.week2 || {}).reduce((sum, mins) => sum + (mins || 0), 0);
    return Math.round((week1 + week2) / 2);
  }
  return Object.values(person.week || {}).reduce((sum, mins) => sum + (mins || 0), 0);
}
function taskLabel(task){return `${task.job} · ${task.name}`}
function isDeliveryTask(task){
  const name = normaliseSearch(task?.name);
  return /(^|[^a-z])delivery([^a-z]|$)/.test(name);
}
function isInstallTask(task){
  const name = normaliseSearch(task?.name);
  return /(^|[^a-z])install(?:ation)?([^a-z]|$)/.test(name);
}
function typeColour(task){
  const name = String(task.name || "").toLowerCase();
  if (task.custom) return "stage-custom";
  if (name.includes("stone")) return "stage-stone";
  if (name.includes("check measure")) return "stage-check";
  if (name.includes("forward ordering") || name.includes("ordering")) return "stage-ordering";
  if (name.includes("draft")) return "stage-drafting";
  if (name.includes("machin")) return "stage-machining";
  if (name.includes("assembl")) return "stage-assembly";
  if (name.includes("load")) return "stage-loading";
  if (name.includes("deliver")) return "stage-delivery";
  if (name.includes("install")) return "stage-install";
  if (name.includes("2pak") || name.includes("2 pak")) return "stage-2pak";
  if (task.type === "milestone") return "yellow";
  if (task.department === "Drafting") return "stage-drafting";
  if (task.department === "Machining") return "stage-machining";
  if (task.department === "Cabinet Making") return "stage-assembly";
  if (task.department === "Installer / Site") return "stage-install";
  return "stage-custom";
}
function normaliseSearch(value){return String(value || "").trim().toLocaleLowerCase();}
function searchValue(id){return normaliseSearch(document.getElementById(id)?.value || "");}
function taskSearchText(task){
  const job = jobById(task?.job);
  return normaliseSearch([task?.job,task?.name,task?.department,task?.stoneMason,(task?.assigned || []).join(" "),job?.builder,job?.address,taskNeedsDetails(task)?"details required missing hours unassigned":""].filter(Boolean).join(" "));
}
function taskMatchesQuery(task,query){return !query || taskSearchText(task).includes(query);}
function jobSearchText(job){
  const linked = tasks.filter(task => String(task.job) === String(job.id));
  return normaliseSearch([job.id,job.builder,job.address,job.status,jobMissingDetailsCount(job.id)?"details required missing information":"",...linked.flatMap(task => [task.name,task.stoneMason,...(task.assigned || [])])].filter(Boolean).join(" "));
}
function jobMatchesQuery(job,query){return !query || jobSearchText(job).includes(query);}
function taskMatchesFilters(task,rowName="",query=searchValue("scheduleSearch")){
  if (!query) return true;
  const person = people.find(item => item.name === rowName);
  const rowText = normaliseSearch([rowName,person?.role].filter(Boolean).join(" "));
  return rowText.includes(query) || taskMatchesQuery(task,query);
}

function calculate(){
  tasks.forEach(task => {task.parts = []; task.unscheduledMinutes = 0;});
  const used = {};
  const allocation = {};
  const usedByDate = {};
  people.forEach(person => {
    used[person.name] = days.map(() => 0);
    allocation[person.name] = days.map(() => []);
    usedByDate[person.name] = {};
  });

  tasks.filter(task => task.type === "milestone").forEach(task => {
    const dateObj = taskDate(task);
    task.parts.push({person:"Milestones",day:scheduleIndexForDate(dateObj),date:toIsoDate(dateObj),minutes:0});
  });
  tasks.filter(task => task.type === "capacity" && !(task.assigned || []).length).forEach(task => {
    const dateObj = taskDate(task);
    task.parts.push({person:"Unassigned",day:scheduleIndexForDate(dateObj),date:toIsoDate(dateObj),minutes:Number(task.duration || 0)});
  });

  // Priority-capacity scheduling: each employee/day is a hard capacity limit.
  // A task's assignment date is its earliest allowed start. From that date on,
  // eligible work is filled top-to-bottom using the manual Schedule order.
  // Lower-priority work automatically spills forward instead of overbooking.
  const capacityTasks = tasks.filter(task => task.type === "capacity");
  people.filter(employeeCountsCapacity).forEach(person => {
    const work = [];
    capacityTasks.forEach(task => {
      if (!(task.assigned || []).includes(person.name)) return;
      const shares = materialiseAssignmentMinutes(task);
      const minutes = Math.max(0,Number(shares[person.name] ?? 0));
      const startDate = taskDateForPerson(task,person.name);
      if (minutes <= 0) {
        const iso = toIsoDate(startDate);
        const visibleDay = scheduleIndexForDate(startDate);
        task.parts.push({person:person.name,day:visibleDay,date:iso,minutes:0});
        if (visibleDay >= 0 && visibleDay < days.length) allocation[person.name][visibleDay].push({task,minutes:0});
        return;
      }
      work.push({task,startDate,remaining:minutes});
    });
    if (!work.length) return;

    let cursor = work.reduce((earliest,item) => item.startDate < earliest ? item.startDate : earliest, work[0].startDate);
    let guard = 0;
    while (work.some(item => item.remaining > 0) && guard < 730) {
      let available = Math.max(0,Number(capacityForDate(person,cursor) || 0));
      if (available > 0) {
        const eligible = work
          .filter(item => item.remaining > 0 && item.startDate <= cursor)
          .sort((a,b) => compareScheduleTaskPriority(a.task,b.task,person.name) || a.startDate-b.startDate || String(a.task.id).localeCompare(String(b.task.id)));
        for (const item of eligible) {
          if (available <= 0) break;
          const use = Math.min(item.remaining,available);
          if (use <= 0) continue;
          const iso = toIsoDate(cursor);
          const visibleDay = scheduleIndexForDate(cursor);
          item.remaining -= use;
          available -= use;
          usedByDate[person.name][iso] = (usedByDate[person.name][iso] || 0) + use;
          item.task.parts.push({person:person.name,day:visibleDay,date:iso,minutes:use});
          if (visibleDay >= 0 && visibleDay < days.length) {
            used[person.name][visibleDay] += use;
            allocation[person.name][visibleDay].push({task:item.task,minutes:use});
          }
        }
      }
      cursor = addCalendarDays(cursor,1);
      guard++;
    }
    work.forEach(item => {
      if (item.remaining > 0) item.task.unscheduledMinutes = Number(item.task.unscheduledMinutes || 0) + item.remaining;
    });
  });

  tasks.forEach(task => task.parts.sort((a,b) => String(a.date).localeCompare(String(b.date)) || String(a.person).localeCompare(String(b.person))));
  return {used,allocation,usedByDate};
}

function segmentsForTask(task, rowName){
  const parts = (task.parts || []).filter(part => part.person === rowName && part.day >= 0 && part.day < days.length).sort((a,b)=>a.day-b.day);
  const out = [];
  let current = null;
  parts.forEach(part => {
    if (!current) current = {start:part.day, span:1};
    else if (current.start + current.span === part.day) current.span += 1;
    else {out.push(current); current = {start:part.day, span:1};}
  });
  if (current) out.push(current);
  return out;
}

function scheduleOrderFor(task,rowName){
  const value = task && task.scheduleOrder ? Number(task.scheduleOrder[rowName]) : NaN;
  return Number.isFinite(value) ? value : null;
}
function compareScheduleTaskPriority(a,b,rowName){
  const ao=scheduleOrderFor(a,rowName),bo=scheduleOrderFor(b,rowName);
  if(ao != null || bo != null){
    if(ao == null) return 1;
    if(bo == null) return -1;
    if(ao !== bo) return ao-bo;
  }
  const dateDiff=taskDateForPerson(a,rowName)-taskDateForPerson(b,rowName);
  return dateDiff || String(a.id).localeCompare(String(b.id));
}
function buildCompactScheduleLaneItems(rowTasks,rowName){
  // Lay out each visible day independently, then merge adjacent days only while
  // a task stays on the same lane. This keeps manual priority top-to-bottom on
  // every day without letting a chain of overlaps create huge empty row gaps.
  const tasksByDay=Array.from({length:days.length},()=>[]);
  rowTasks.forEach(task=>{
    const taskDays=[...new Set((task.parts || [])
      .filter(part=>part.person === rowName && part.day >= 0 && part.day < days.length)
      .map(part=>Number(part.day)))];
    taskDays.forEach(day=>tasksByDay[day].push(task));
  });
  const laneByTaskDay=new Map();
  let laneCount=0;
  tasksByDay.forEach((dayTasks,day)=>{
    dayTasks.sort((a,b)=>compareScheduleTaskPriority(a,b,rowName));
    laneCount=Math.max(laneCount,dayTasks.length);
    dayTasks.forEach((task,lane)=>laneByTaskDay.set(`${task.id}|${day}`,lane));
  });
  const items=[];
  rowTasks.forEach(task=>{
    const taskDays=[...new Set((task.parts || [])
      .filter(part=>part.person === rowName && part.day >= 0 && part.day < days.length)
      .map(part=>Number(part.day)))].sort((a,b)=>a-b);
    let current=null;
    taskDays.forEach(day=>{
      const lane=laneByTaskDay.get(`${task.id}|${day}`) ?? 0;
      if(current && current.start+current.span === day && current.lane === lane) current.span += 1;
      else{if(current) items.push(current);current={task,start:day,span:1,lane};}
    });
    if(current) items.push(current);
  });
  items.sort((a,b)=>a.start-b.start || a.lane-b.lane || compareScheduleTaskPriority(a.task,b.task,rowName));
  return {items,laneCount};
}

function assignScheduleLanes(items,rowName){
  // Manual schedule order is authoritative. A lower-priority task must never be
  // packed back above a higher-priority task when their visible spans overlap.
  // Grouping segments by task also keeps one task on the same visual lane when
  // weekends/closures split its bar into multiple visible segments.
  const grouped=new Map();
  items.forEach(item=>{
    if(!grouped.has(item.task.id)) grouped.set(item.task.id,{task:item.task,items:[]});
    grouped.get(item.task.id).items.push(item);
  });
  const groups=[...grouped.values()].sort((a,b)=>{
    const priority=compareScheduleTaskPriority(a.task,b.task,rowName);
    if(priority) return priority;
    const aStart=Math.min(...a.items.map(item=>item.start)),bStart=Math.min(...b.items.map(item=>item.start));
    return aStart-bStart || String(a.task.id).localeCompare(String(b.task.id));
  });
  const placed=[];
  let laneCount=0;
  const overlaps=(a,b)=>a.items.some(left=>b.items.some(right=>left.start < right.start+right.span && right.start < left.start+left.span));
  groups.forEach(group=>{
    let lane=0;
    placed.forEach(higher=>{if(overlaps(group,higher)) lane=Math.max(lane,higher.lane+1);});
    group.items.forEach(item=>{item.lane=lane;});
    placed.push({...group,lane});
    laneCount=Math.max(laneCount,lane+1);
  });
  return laneCount;
}
function orderedScheduleTasksForRow(rowName){
  return tasks.filter(task=>task.type === "capacity" && (task.assigned || []).includes(rowName))
    .sort((a,b)=>compareScheduleTaskPriority(a,b,rowName));
}
function setScheduleOrderRelative(task,targetTask,rowName,before=true){
  if(!task || !targetTask || !rowName || rowName === "Unassigned" || task.id === targetTask.id) return;
  const ordered=orderedScheduleTasksForRow(rowName).filter(candidate=>candidate.id !== task.id);
  const targetIndex=ordered.findIndex(candidate=>candidate.id === targetTask.id);
  if(targetIndex < 0) return;
  ordered.splice(targetIndex + (before ? 0 : 1),0,task);
  ordered.forEach((candidate,index)=>{
    candidate.scheduleOrder={...(candidate.scheduleOrder || {})};
    candidate.scheduleOrder[rowName]=(index+1)*10;
  });
}

function showView(view){
  const allowedViews = isAdmin ? ["home","jobs","addJob","calendar","schedule","beta","settings"] : ["home","calendar","schedule"];
  if (!allowedViews.includes(view)) view = "home";
  ["home","jobs","addJob","calendar","schedule","beta","settings"].forEach(name => {
    const section = document.getElementById(name + "View");
    if (section) section.classList.toggle("active", view === name);
  });
  ["home","jobs","calendar","schedule","beta","settings"].forEach(name => {
    const tab = document.getElementById("tab" + name[0].toUpperCase() + name.slice(1));
    if (tab) tab.classList.toggle("active", view === name || (name === "jobs" && view === "addJob"));
  });
  if (view === "settings" && isAdmin) showSettingsSection(activeSettingsSection);
  if (view === "beta" && isAdmin) renderBeta();
  if (view === "schedule") setTimeout(() => {updateScheduleDayWidth(); renderSchedule();}, 0);
  setTimeout(syncFloatingScrollWidth, 0);
}
function renderAll(){
  renderHome();
  if (isAdmin) renderJobs();
  renderCalendar();
  renderSchedule();
  if (isAdmin) {
    renderBeta();
    renderSettings();
  }
}
