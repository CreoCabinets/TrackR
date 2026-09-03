/* Add Job */
const ADD_JOB_TEMPLATES = {
  2:{Drafting:8,Machining:8,Assembly:24},
  3:{Drafting:10,Machining:8,Assembly:28},
  4:{Drafting:12,Machining:10,Assembly:32},
  5:{Drafting:14,Machining:12,Assembly:38},
  6:{Drafting:16,Machining:14,Assembly:44},
  7:{Drafting:18,Machining:16,Assembly:50}
};
function setAddJobSaving(saving,isEditing=!!editingJobId){
  addJobSaveInProgress = saving;
  const button = document.getElementById("ajSaveButton");
  if (!button) return;
  button.disabled = saving;
  button.textContent = saving ? (isEditing ? "Saving..." : "Creating...") : (isEditing ? "Save Changes" : "Create Job");
}
function configureAddJobPage(isEditing){
  document.getElementById("addJobTitle").textContent = isEditing ? "Edit Job" : "Add Job";
  document.getElementById("addJobSubtitle").textContent = isEditing ? "Update the job details, production dates, hours and assignments." : "Import an estimate PDF or enter the job manually. Both routes create the same production plan.";
  setAddJobSaving(false,isEditing);
  document.getElementById("ajDeleteButton").style.display = isEditing ? "inline-flex" : "none";
  document.getElementById("ajSourceChoices").style.display = isEditing ? "none" : "grid";
}
function openAddJob(){
  if (!isAdmin) return;
  editingJobId = null;
  configureAddJobPage(false);
  startManualJob(false);
  showView("addJob");
  window.scrollTo({top:0, behavior:"smooth"});
}
function openEditJob(jobId){
  if (!isAdmin) return;
  const job = jobs.find(item => String(item.id) === String(jobId));
  if (!job) return;
  editingJobId = String(job.id);
  configureAddJobPage(true);
  addJobSource = job.source || "manual";
  addJobImportDetails = null;
  document.getElementById("ajJobNumber").value = job.id || "";
  document.getElementById("ajAddress").value = job.address || "";
  document.getElementById("ajBuilder").value = job.builder || "";
  document.getElementById("ajJobLength").value = String(job.jobLengthWeeks || 4);
  const existingJobTasks = tasks.filter(task => String(task.job) === String(job.id));
  const installTask = existingJobTasks.find(task => String(task.name).toLowerCase() === "install");
  const normalisedInstallDate = job.installDate || (installTask ? toIsoDate(taskDate(installTask)) : "");
  document.getElementById("ajInstallDate").value = normalisedInstallDate;
  document.getElementById("ajJobStatus").value = job.status || "Active";
  document.getElementById("ajTwoPack").checked = !!job.twoPack;
  document.getElementById("ajNotes").value = job.notes || "";
  document.getElementById("ajSourceLabel").textContent = "Editing existing job";
  document.getElementById("ajEstimateBadge").textContent = "Existing job";
  const jobTasks = existingJobTasks;
  addJobExcludedStages = new Set(Array.isArray(job.excludedStages) ? job.excludedStages.map(name => String(name)) : []);
  addJobRemovedStageCache = new Map();
  const storedHours = job.labourHours && typeof job.labourHours === "object" ? job.labourHours : {};
  const hoursFor = (storedKey,...names) => {
    const stored = Number(storedHours[storedKey]);
    if (Number.isFinite(stored)) return Math.max(0,stored);
    return jobTasks.filter(task => names.includes(task.name)).reduce((sum,task)=>sum+Number(task.estimatedHours ?? (Number(task.duration||0)/60)),0);
  };
  document.getElementById("ajHoursCheck").value = hoursFor("checkMeasure","Check Measure");
  document.getElementById("ajHoursDrafting").value = hoursFor("drafting","Drafting");
  document.getElementById("ajHoursMachining").value = hoursFor("machining","Machining","Machine 2pak Items");
  document.getElementById("ajHoursAssembly").value = hoursFor("assembly","Assembly","Prep 2pak Items");
  document.getElementById("ajHoursLoading").value = hoursFor("loading","Loading");
  document.getElementById("ajHoursDelivery").value = hoursFor("delivery","Delivery");
  addJobStages = stagesFromJobTasks(jobTasks).filter(stage => !addJobExcludedStages.has(stage.name));
  if (!addJobStages.length && job.installDate) addJobStages = buildAddJobStages();
  hideAddJobMessage();
  renderAddJobStages();
  showView("addJob");
  window.scrollTo({top:0, behavior:"smooth"});
}
function setAddJobSource(source){
  addJobSource = source;
  document.getElementById("ajPdfCard").classList.toggle("active", source === "pdf");
  document.getElementById("ajManualCard").classList.toggle("active", source === "manual");
  document.getElementById("ajSourceLabel").textContent = source === "pdf" ? "PDF import · labour hours read from estimate" : "Manual entry · standard template hours";
}
function startManualJob(scroll=true){
  setAddJobSource("manual");
  addJobImportDetails = null;
  addJobStages = [];
  addJobExcludedStages = new Set();
  addJobRemovedStageCache = new Map();
  ["ajJobNumber","ajAddress","ajBuilder","ajInstallDate","ajNotes"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("ajJobLength").value = "4";
  document.getElementById("ajJobStatus").value = "Active";
  document.getElementById("ajTwoPack").checked = false;
  document.getElementById("ajEstimateBadge").textContent = "Manual entry";
  applyManualDefaultHours();
  hideAddJobMessage();
  if (scroll) document.getElementById("ajDetailsPanel").scrollIntoView({behavior:"smooth",block:"start"});
}
function showAddJobMessage(message, isError=false){
  const box = document.getElementById("ajImportMessage");
  box.textContent = message;
  box.classList.add("show");
  box.style.background = isError ? "#fee2e2" : "#eaf8f0";
  box.style.color = isError ? "#991b1b" : "#17613b";
  box.style.borderColor = isError ? "#fecaca" : "#c6ecd7";
}
function hideAddJobMessage(){document.getElementById("ajImportMessage").classList.remove("show")}
function handlePdfFileChosen(){
  const input = document.getElementById("ajPdfFile");
  const file = input.files && input.files[0];
  document.getElementById("ajPdfDropHint").textContent = file ? file.name : "Drag an estimate PDF anywhere into this box";
}
function setupAddJobPdfDrop(){
  const card = document.getElementById("ajPdfCard");
  const input = document.getElementById("ajPdfFile");
  if (!card || !input || card.dataset.dropReady === "true") return;
  card.dataset.dropReady = "true";
  ["dragenter","dragover"].forEach(type => card.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
    card.classList.add("pdf-dragging");
  }));
  ["dragleave","dragend"].forEach(type => card.addEventListener(type, event => {
    event.preventDefault();
    if (type === "dragleave" && card.contains(event.relatedTarget)) return;
    card.classList.remove("pdf-dragging");
  }));
  card.addEventListener("drop", event => {
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove("pdf-dragging");
    const file = Array.from(event.dataTransfer?.files || []).find(item => item.type === "application/pdf" || item.name.toLowerCase().endsWith(".pdf"));
    if (!file) {
      showAddJobMessage("Drop a PDF estimate into the import box.", true);
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    handlePdfFileChosen();
    importEstimatePdf();
  });
}
async function importEstimatePdf(){
  const fileInput = document.getElementById("ajPdfFile");
  const file = fileInput.files && fileInput.files[0];
  if (!file) {showAddJobMessage("Choose an estimate PDF first.", true); return;}
  const button = document.getElementById("ajReadPdfBtn");
  button.disabled = true;
  button.textContent = "Reading...";
  const form = new FormData();
  form.append("estimate_pdf", file);
  try{
    const response = await apiFetch("/api/import-estimate", {method:"POST", body:form});
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Could not read that PDF.");
    const data = result.extracted || {};
    addJobImportDetails = data;
    setAddJobSource("pdf");
    document.getElementById("ajJobNumber").value = data.quote_no || "";
    document.getElementById("ajAddress").value = data.quote_name || "";
    document.getElementById("ajEstimateBadge").textContent = "PDF imported";
    document.getElementById("ajHoursCheck").value = Number(data.check_measure_hours || 0);
    document.getElementById("ajHoursDrafting").value = Number(data.drafting_total_hours || 0);
    document.getElementById("ajHoursMachining").value = Number(data.machining_hours || 0);
    document.getElementById("ajHoursAssembly").value = Number(data.assembly_total_hours || 0);
    document.getElementById("ajHoursLoading").value = Number(data.loading_total_hours || 0);
    document.getElementById("ajHoursDelivery").value = Number(data.delivery_total_hours || 0);
    document.getElementById("ajNotes").value = `Imported from estimate PDF. Check Measure ${Number(data.check_measure_hours || 0)}h calendar only, Drafting ${Number(data.drafting_total_hours || 0)}h, Machining ${Number(data.machining_hours || 0)}h, Assembly ${Number(data.assembly_total_hours || 0)}h, Loading ${Number(data.loading_total_hours || 0)}h, Delivery ${Number(data.delivery_total_hours || 0)}h.`;
    refreshAddJobPlan();
    showAddJobMessage("PDF read successfully. Check the details and choose the predicted install date.");
    document.getElementById("ajDetailsPanel").scrollIntoView({behavior:"smooth",block:"start"});
  }catch(error){
    console.error(error);
    showAddJobMessage(error.message || "Could not read that PDF.", true);
  }finally{
    button.disabled = false;
    button.textContent = "Read PDF";
  }
}
function onAddJobLengthChange(){
  if (addJobSource === "manual") applyManualDefaultHours();
  else refreshAddJobPlan();
}
function applyManualDefaultHours(){
  const weeks = Number(document.getElementById("ajJobLength").value || 4);
  const template = ADD_JOB_TEMPLATES[weeks] || ADD_JOB_TEMPLATES[4];
  document.getElementById("ajHoursCheck").value = 0;
  document.getElementById("ajHoursDrafting").value = template.Drafting;
  document.getElementById("ajHoursMachining").value = template.Machining;
  document.getElementById("ajHoursAssembly").value = template.Assembly;
  document.getElementById("ajHoursLoading").value = 0;
  document.getElementById("ajHoursDelivery").value = 0;
  refreshAddJobPlan();
}
function addJobHour(id){const value=Number(document.getElementById(id).value);return Number.isFinite(value)&&value>0?value:0}
function buildAddJobStages(){
  const install = parseIsoDate(document.getElementById("ajInstallDate").value);
  if (!install) return [];
  const installDate = ensureBusinessDay(install);
  const weeks = Number(document.getElementById("ajJobLength").value || 4);
  const checkDate = addBusinessDays(installDate, -(weeks * 5));
  const draftingDate = addBusinessDays(checkDate, 2);
  const standardForward = addBusinessDays(installDate, -20);
  const draftMinusOne = addBusinessDays(draftingDate, -1);
  const forwardDate = standardForward < draftMinusOne ? standardForward : draftMinusOne;
  const oldByName = new Map(addJobStages.map(stage => [stage.name, stage]));
  const stage = (name, department, dateObj, hours, countsCapacity, notes="") => {
    const old = oldByName.get(name) || {};
    const totalHours = Number(hours||0);
    const plannedDate = toIsoDate(dateObj);
    const assignments = countsCapacity ? normaliseStageAssignments(old, totalHours) : normaliseMilestoneAssignments(old);
    if(countsCapacity) assignments.forEach(item => { if (!item.date || item.date === old.date) item.date = plannedDate; });
    const showOnCalendar = countsCapacity
      ? (typeof old.showOnCalendar === "boolean" ? old.showOnCalendar : defaultCalendarVisibilityForStage(name))
      : true;
    return {name,department,date:plannedDate,endDate:plannedDate,hours:totalHours,countsCapacity,showOnCalendar,notes,status:old.status||"Planned",stoneMason:old.stoneMason||"",assignments};
  };
  let stages = [
    stage("Forward Ordering","Drafting",forwardDate,.5,true,"Standard 30 minutes from Drafting capacity."),
    stage("Check Measure","Installer / Site",checkDate,addJobHour("ajHoursCheck"),true,"Capacity task shown on Calendar by default."),
    stage("Drafting","Drafting",draftingDate,addJobHour("ajHoursDrafting"),true,"Includes drafting and QC labour."),
    stage("Machining","Machining",addBusinessDays(installDate,-10),addJobHour("ajHoursMachining"),true,"Includes CNC and edgebander labour."),
    stage("Assembly","Cabinet Making",addBusinessDays(installDate,-5),addJobHour("ajHoursAssembly"),true),
    stage("Loading","Cabinet Making",addBusinessDays(installDate,-2),addJobHour("ajHoursLoading"),true),
    stage("Delivery","Cabinet Making",addBusinessDays(installDate,-1),addJobHour("ajHoursDelivery"),true,"Capacity task shown on Calendar by default."),
    stage("Install","Installer / Site",installDate,0,true,"Enter the install hours and installer. Shown on Calendar by default.")
  ];
  if (document.getElementById("ajTwoPack").checked) {
    const machining = stages.find(item => item.name === "Machining");
    const assembly = stages.find(item => item.name === "Assembly");
    const normalMachining = parseIsoDate(machining.date);
    const awayEnd = addBusinessDays(normalMachining,-1);
    const awayStart = addBusinessDays(awayEnd,-9);
    const prepDate = addBusinessDays(awayStart,-1);
    const machineDate = addBusinessDays(prepDate,-1);
    const drafting = stages.find(item => item.name === "Drafting");
    const draftNeededBy = addBusinessDays(machineDate,-1);
    if (parseIsoDate(drafting.date) > draftNeededBy) {
      const previousDraftDate = drafting.date;
      drafting.date = toIsoDate(draftNeededBy);
      (drafting.assignments || []).forEach(item => { if (!item.date || item.date === previousDraftDate) item.date = drafting.date; });
    }
    const originalMachiningHours = Number(machining.hours||0);
    const originalAssemblyHours = Number(assembly.hours||0);
    const machine2pakHours = Math.round((originalMachiningHours / 2) * 100) / 100;
    const prep2pakHours = Math.round((originalAssemblyHours / 2) * 100) / 100;
    machining.hours = Math.round((originalMachiningHours - machine2pakHours) * 100) / 100;
    assembly.hours = Math.round((originalAssemblyHours - prep2pakHours) * 100) / 100;
    if (machining.assignments?.length === 1 && Math.abs(Number(machining.assignments[0].hours||0)-originalMachiningHours) < .01) machining.assignments[0].hours = machining.hours;
    if (assembly.assignments?.length === 1 && Math.abs(Number(assembly.assignments[0].hours||0)-originalAssemblyHours) < .01) assembly.assignments[0].hours = assembly.hours;
    machining.notes = `Remaining machining after 2pak split: ${machining.hours}h.`;
    assembly.notes = `Remaining assembly after 2pak split: ${assembly.hours}h.`;
    const insertAt = stages.findIndex(item => item.name === "Machining");
    const awayStage = stage("2pak Away","Cabinet Making",awayStart,0,true,`Away until ${toIsoDate(awayEnd)}. Add hours/employee only if this stage needs company labour.`);
    awayStage.endDate = toIsoDate(awayEnd);
    stages.splice(insertAt,0,
      stage("Machine 2pak Items","Machining",machineDate,machine2pakHours,true,"Machine 2pak items early for painting."),
      stage("Prep 2pak Items","Cabinet Making",prepDate,prep2pakHours,true,"Prepare 2pak items before sending away."),
      awayStage
    );
  }
  const stoneCheck = addBusinessDays(installDate,1);
  stages.push(stage("Stone Check Measure","Milestone",stoneCheck,0,false,"Stone work is calendar-only and never affects capacity."));
  stages.push(stage("Stone Install","Milestone",addBusinessDays(stoneCheck,5),0,false,"Stone work is calendar-only and never affects capacity."));
  return stages.filter(item => !addJobExcludedStages.has(item.name));
}
function refreshAddJobPlan(){
  addJobStages = buildAddJobStages();
  renderAddJobStages();
}
function employeesForDepartment(department){
  const capacityPeople = people.filter(employeeCountsCapacity);
  const matching = capacityPeople.filter(person => person.role === department);
  const others = capacityPeople.filter(person => person.role !== department);
  return [...matching,...others];
}
function assignmentsFromTask(task){
  const names = Array.isArray(task.assigned) ? task.assigned.filter(Boolean) : [];
  const fallbackDate = toIsoDate(taskDate(task));
  if (!names.length) return [{person:"",hours:Number(task.estimatedHours ?? (Number(task.duration||0)/60))||0,date:fallbackDate}];
  const custom = task.assignmentMinutes || {};
  const dates = task.assignmentDates || {};
  const totalHours = Number(task.estimatedHours ?? (Number(task.duration||0)/60))||0;
  const even = totalHours / names.length;
  return names.map(name => ({person:name,hours:custom[name] != null ? Number(custom[name])/60 : even,date:dates[name] || fallbackDate}));
}
function isAdminEmployee(name){
  const person = people.find(item => item.name === name);
  return !!person && person.role === "Admin";
}
function stagesFromJobTasks(jobTasks){
  const generated = jobTasks.filter(task => !task.custom);
  const milestones = generated.filter(task => task.type === "milestone").map(task => ({
    name:task.name,
    department:"Milestone",
    date:toIsoDate(taskDate(task)),
    endDate:task.endDate || toIsoDate(taskDate(task)),
    hours:0,
    countsCapacity:false,
    showOnCalendar:true,
    notes:task.notes || "",
    status:task.status || "Planned",
    stoneMason:task.stoneMason || "",
    assignments:(task.assigned || []).map(person => ({person}))
  }));
  const grouped = new Map();
  generated.filter(task => task.type === "capacity" || task.type === "admin").forEach(task => {
    const department = task.stageDepartment || (task.type === "capacity" ? task.department : "Cabinet Making");
    const key = task.stageGroup || `${task.name}|${department}`;
    if (!grouped.has(key)) grouped.set(key,{name:task.stageGroup || task.name,department,capacityTask:null,adminTasks:[]});
    const group = grouped.get(key);
    if (task.type === "capacity") group.capacityTask = task;
    else group.adminTasks.push(task);
  });
  const production = [...grouped.values()].map(group => {
    const base = group.capacityTask || group.adminTasks[0];
    const capacityHours = group.capacityTask ? Number(group.capacityTask.estimatedHours ?? (Number(group.capacityTask.duration||0)/60)) : 0;
    const adminHours = group.adminTasks.reduce((sum,task)=>sum+Number(task.estimatedHours ?? (Number(task.duration||0)/60)),0);
    const totalHours = Number(group.capacityTask?.stageTotalHours ?? base?.stageTotalHours ?? (capacityHours + adminHours));
    let assignments = group.capacityTask ? assignmentsFromTask(group.capacityTask) : [];
    if (group.adminTasks.length && assignments.length === 1 && !assignments[0].person && Number(assignments[0].hours||0) === 0) assignments = [];
    group.adminTasks.forEach(task => {
      const person = (task.assigned || [])[0] || task.adminEmployee || "";
      if (person) assignments.push({person,hours:Number(task.estimatedHours ?? (Number(task.duration||0)/60))||0,date:(task.assignmentDates||{})[person] || toIsoDate(taskDate(task))});
    });
    if (!assignments.length) assignments = [{person:"",hours:totalHours,date:toIsoDate(taskDate(base))}];
    return {
      name:group.name,
      department:group.department,
      date:toIsoDate(taskDate(base)),
      endDate:base.endDate || toIsoDate(taskDate(base)),
      hours:totalHours,
      countsCapacity:true,
      showOnCalendar:!!group.capacityTask?.showOnCalendar || group.adminTasks.length > 0,
      notes:base.notes || "",
      status:base.status || "Planned",
      stoneMason:base.stoneMason || "",
      assignments
    };
  });
  return [...production,...milestones].sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")) || a.name.localeCompare(b.name));
}
function normaliseStageAssignments(stage,totalHours){
  if (Array.isArray(stage.assignments) && stage.assignments.length) {
    const items = stage.assignments.map(item => ({person:item.person||"",hours:Math.max(0,Number(item.hours)||0),date:item.date || stage.date || ""}));
    const previousTotal = Number(stage.hours||0);
    if (items.length === 1 && Math.abs(Number(items[0].hours||0)-previousTotal) < .01 && Math.abs(Number(totalHours||0)-previousTotal) > .01) items[0].hours = Number(totalHours||0);
    return items;
  }
  if (Array.isArray(stage.assigned) && stage.assigned.length) {
    const even = totalHours / stage.assigned.length;
    return stage.assigned.map(person => ({person,hours:even,date:stage.date || ""}));
  }
  if (stage.assigned) return [{person:stage.assigned,hours:totalHours,date:stage.date || ""}];
  return [{person:"",hours:totalHours,date:stage.date || ""}];
}
function normaliseMilestoneAssignments(stage){
  const validNames = new Set(people.filter(person => person.role !== "Admin" && !employeeCountsCapacity(person)).map(person => person.name));
  const raw = Array.isArray(stage.assignments) ? stage.assignments : Array.isArray(stage.assigned) ? stage.assigned.map(person => ({person})) : stage.assigned ? [{person:stage.assigned}] : [];
  const cleaned = raw.map(item => ({person:item?.person || ""})).filter((item,index,array) => !item.person || (validNames.has(item.person) && array.findIndex(other => other.person === item.person) === index));
  return cleaned.length ? cleaned : [{person:""}];
}
function milestoneEmployeeOptions(selected){
  const available = people.filter(person => person.role !== "Admin" && !employeeCountsCapacity(person));
  return `<option value="">Choose non-capacity person</option>${available.map(person => `<option value="${escapeHtml(person.name)}" ${selected===person.name?"selected":""}>${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("")}`;
}

function stageAssignedHours(stage){
  return (stage.assignments || []).filter(item => item.person).reduce((sum,item)=>sum+Math.max(0,Number(item.hours)||0),0);
}
function stageRemainingHours(stage){return Math.round((Number(stage.hours||0)-stageAssignedHours(stage))*100)/100}
function stageEmployeeOptions(stage,selected){
  const capacityPeople = people.filter(employeeCountsCapacity);
  const matching = capacityPeople.filter(person => person.role === stage.department);
  const others = capacityPeople.filter(person => person.role !== stage.department);
  const make = list => list.map(person => `<option value="${escapeHtml(person.name)}" ${selected===person.name?"selected":""}>${escapeHtml(person.name)} · ${escapeHtml(person.role)}</option>`).join("");
  return `<option value="">Choose employee</option>${matching.length?`<optgroup label="${escapeHtml(stage.department)}">${make(matching)}</optgroup>`:""}${others.length?`<optgroup label="Other capacity employees">${make(others)}</optgroup>`:""}`;
}
function renderRemovedAddJobStages(){
  const box = document.getElementById("ajRemovedStages");
  if (!box) return;
  const names = [...addJobExcludedStages];
  box.classList.toggle("show", names.length > 0);
  box.innerHTML = names.length ? `<strong>Removed from this job:</strong>${names.map(name => `<span class="aj-removed-stage-chip"><span>${escapeHtml(name)}</span><button type="button" data-click-action="restoreAddJobStage" data-click-args='${escapeHtml(JSON.stringify([name]))}'>Undo</button></span>`).join("")}` : "";
}
function removeAddJobStage(index){
  const stage = addJobStages[index];
  if (!stage) return;
  addJobExcludedStages.add(stage.name);
  addJobRemovedStageCache.set(stage.name, JSON.parse(JSON.stringify(stage)));
  addJobStages.splice(index,1);
  renderAddJobStages();
  showToast(`${stage.name} removed from this job.`);
}
function restoreAddJobStage(name){
  if (!addJobExcludedStages.has(name)) return;
  const cached = addJobRemovedStageCache.get(name);
  addJobExcludedStages.delete(name);
  addJobRemovedStageCache.delete(name);
  if (cached) addJobStages.push(cached);
  refreshAddJobPlan();
  showToast(`${name} restored.`);
}
function renderAddJobStages(){
  const rows = document.getElementById("ajStageRows");
  const milestonesWrap = document.getElementById("ajCalendarDates");
  const milestoneRows = document.getElementById("ajMilestoneRows");
  renderRemovedAddJobStages();
  if (!addJobStages.length) {
    const installSelected = !!parseIsoDate(document.getElementById("ajInstallDate").value);
    const allRemoved = installSelected && addJobExcludedStages.size > 0;
    rows.innerHTML = allRemoved
      ? `<div class="note aj-stage-empty"><strong>All workflow stages are removed</strong><span>Use an Undo button above to restore a stage.</span></div>`
      : `<div class="note aj-stage-empty"><strong>Choose an install date</strong><span>Your production stages will appear here automatically.</span></div>`;
    milestonesWrap.style.display = "none";
    milestoneRows.innerHTML = "";
  } else {
    const orderedStages = addJobStages.map((stage,index) => ({stage,index})).sort((a,b) => String(a.stage.date||"").localeCompare(String(b.stage.date||"")) || a.index-b.index);
    const capacityStages = orderedStages.filter(item => item.stage.countsCapacity);
    const milestones = orderedStages.filter(item => !item.stage.countsCapacity);
    rows.innerHTML = capacityStages.map(({stage,index}) => {
      stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
      const assigned = stageAssignedHours(stage);
      const remaining = stageRemainingHours(stage);
      const selectedCount = stage.assignments.filter(item => item.person).length;
      const duplicate = new Set(stage.assignments.filter(item=>item.person).map(item=>item.person)).size !== selectedCount;
      const missing = [];
      if(Number(stage.hours||0) <= 0) missing.push("hours");
      if(selectedCount === 0) missing.push("employee");
      const detailsRequired = missing.length > 0;
      const over = remaining < -0.01;
      const complete = selectedCount > 0 && Number(stage.hours||0) > 0 && Math.abs(remaining) <= 0.01 && !duplicate;
      const cardClass = over || duplicate ? "over" : complete ? "complete" : "warning";
      const departmentClass = stage.department==="Drafting"?"blue":stage.department==="Machining"?"purple":stage.department==="Installer / Site"?"yellow":"green";
      const progress = Number(stage.hours||0)>0 ? Math.min(100,Math.max(0,(assigned/Number(stage.hours))*100)) : 0;
      const statusText = duplicate ? "Employee selected twice" : over ? `${Math.abs(remaining)}h over` : detailsRequired ? "⚠ Details required" : remaining>0.01 ? `${remaining}h remaining` : "Fully allocated";
      const statusClass = duplicate || over ? "bad" : complete ? "good" : "warn";
      const assignmentRows = stage.assignments.map((assignment,assignmentIndex) => `<div class="aj-assignment-row">
        <select class="${selectedCount===0?"missing-field":""}" aria-label="Employee for ${escapeHtml(stage.name)}" data-change-action="updateStageAssignment" data-change-args='[${index},${assignmentIndex},"person"]' data-change-pass-value="true">${stageEmployeeOptions(stage,assignment.person)}</select>
        <input aria-label="Hours for ${escapeHtml(stage.name)} assignment" type="number" min="0" step="0.25" value="${Math.round(Number(assignment.hours||0)*100)/100}" data-change-action="updateStageAssignment" data-change-args='[${index},${assignmentIndex},"hours"]' data-change-pass-value="true">
        <button type="button" aria-label="Remove employee" data-click-action="removeStageAssignment" data-click-args='[${index},${assignmentIndex}]' >×</button>
      </div>`).join("");
      return `<article class="aj-workflow-card ${cardClass}">
        <div class="aj-workflow-head"><div><div class="aj-workflow-title">${escapeHtml(stage.name)}</div><div class="aj-workflow-meta"><span class="pill ${departmentClass}">${escapeHtml(stage.department)}</span><span class="pill grey">${Math.round(Number(stage.hours||0)*100)/100}h total</span>${stage.showOnCalendar?`<span class="pill yellow">Calendar</span>`:``}</div></div><div class="aj-workflow-head-actions"><span class="aj-allocation-status ${statusClass}">${statusText}</span><button type="button" class="aj-stage-remove" title="Remove ${escapeHtml(stage.name)} from this job" aria-label="Remove ${escapeHtml(stage.name)} from this job" data-click-action="removeAddJobStage" data-click-args='[${index}]' >×</button></div></div>
        <div class="aj-workflow-fields"><div class="aj-mini-field"><label>Planned date</label><input type="date" value="${stage.date}" data-change-action="updateAddJobStage" data-change-args='[${index},"date"]' data-change-pass-value="true"></div><div class="aj-mini-field"><label>Total hours</label><input class="${Number(stage.hours||0)<=0?"missing-field":""}" type="number" min="0" step="0.25" value="${stage.hours}" data-change-action="updateAddJobStage" data-change-args='[${index},"hours"]' data-change-pass-value="true"></div></div>
        <div class="aj-mini-field aj-card-status"><label>Status</label><select data-change-action="updateAddJobStage" data-change-args='[${index},"status"]' data-change-pass-value="true">${["Planned","Forecast","In Progress","Complete","Waiting","Active","On Hold"].map(value=>`<option ${stage.status===value?"selected":""}>${value}</option>`).join("")}</select></div>
        ${detailsRequired?`<div class="aj-detail-warning">⚠ Details required: ${escapeHtml(missing.join(" and "))}</div>`:``}
        <div><div class="aj-assignment-labels"><span>Employee</span><span>Hours</span><span></span></div><div class="aj-assignment-list">${assignmentRows}</div></div>
        <div class="aj-progress"><span style="width:${progress}%"></span></div>
        <div class="aj-workflow-actions"><div class="aj-workflow-actions-left"><button type="button" data-click-action="addStageAssignment" data-click-args='[${index}]'>+ Add employee</button><button type="button" data-click-action="splitStageEvenly" data-click-args='[${index}]'>Split evenly</button></div></div>
      </article>`;
    }).join("") || `<div class="note aj-stage-empty"><strong>No capacity stages</strong><span>This plan only contains stone calendar stages.</span></div>`;
    milestonesWrap.style.display = milestones.length ? "block" : "none";
    milestoneRows.innerHTML = milestones.map(({stage,index}) => {
      stage.assignments = normaliseMilestoneAssignments(stage);
      const assignmentRows = stage.assignments.map((assignment,assignmentIndex)=>`<div class="aj-stone-assignment-row"><select data-change-action="updateMilestoneAssignment" data-change-args='[${index},${assignmentIndex}]' data-change-pass-value="true">${milestoneEmployeeOptions(assignment.person)}</select><button type="button" aria-label="Remove person" data-click-action="removeMilestoneAssignment" data-click-args='[${index},${assignmentIndex}]' >×</button></div>`).join("");
      return `<article class="aj-workflow-card stone-card">
        <div class="aj-workflow-head"><div><div class="aj-workflow-title">${escapeHtml(stage.name)}</div><div class="aj-workflow-meta"><span class="pill yellow">Calendar only</span><span class="pill grey">Non-capacity</span></div></div><button type="button" class="aj-stage-remove" title="Remove ${escapeHtml(stage.name)} from this job" aria-label="Remove ${escapeHtml(stage.name)} from this job" data-click-action="removeAddJobStage" data-click-args='[${index}]' >×</button></div>
        <div class="aj-card-options"><div class="aj-mini-field"><label>Planned date</label><input type="date" value="${stage.date}" data-change-action="updateAddJobStage" data-change-args='[${index},"date"]' data-change-pass-value="true"></div><div class="aj-mini-field"><label>Status</label><select data-change-action="updateAddJobStage" data-change-args='[${index},"status"]' data-change-pass-value="true">${["Planned","Forecast","In Progress","Complete","Waiting","Active","On Hold"].map(value=>`<option ${stage.status===value?"selected":""}>${value}</option>`).join("")}</select></div></div>
        <div class="aj-mini-field"><label>Stone mason / company</label><input type="text" maxlength="160" value="${escapeHtml(stage.stoneMason||"")}" placeholder="Type the stone mason or company" data-change-action="updateAddJobStage" data-change-args='[${index},"stoneMason"]' data-change-pass-value="true"></div>
        <div><div class="aj-assignment-labels" style="grid-template-columns:minmax(0,1fr) 34px"><span>Non-capacity person (optional)</span><span></span></div><div class="aj-assignment-list">${assignmentRows}</div></div>
        <div class="aj-workflow-actions"><div class="aj-workflow-actions-left"><button type="button" data-click-action="addMilestoneAssignment" data-click-args='[${index}]'>+ Add person</button></div></div>
      </article>`;
    }).join("");
  }
  document.getElementById("ajStageCount").textContent = addJobStages.length;
  const capacityHours = addJobStages.filter(stage => stage.countsCapacity).reduce((sum,stage)=>sum+Number(stage.hours||0),0);
  document.getElementById("ajCapacityTotal").textContent = `${Math.round(capacityHours*100)/100}h`;
  const install = parseIsoDate(document.getElementById("ajInstallDate").value);
  document.getElementById("ajInstallSummary").textContent = install ? install.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}) : "Not selected";
}
function updateAddJobStage(index,field,value){
  const stage = addJobStages[index];
  if (!stage) return;
  if (field === "hours") {
    const oldTotal = Number(stage.hours||0);
    const nextTotal = Math.max(0,Number(value)||0);
    stage.assignments = normaliseStageAssignments(stage,oldTotal);
    if (stage.assignments.length === 1 && Math.abs(Number(stage.assignments[0].hours||0)-oldTotal) < .01) stage.assignments[0].hours = nextTotal;
    stage.hours = nextTotal;
  } else if (field === "date") {
    const oldDate = stage.date || "";
    if(stage.countsCapacity) stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
    stage.date = value;
    stage.endDate = value;
    if(stage.countsCapacity) stage.assignments.forEach(item => { if (!item.date || item.date === oldDate) item.date = value; });
  } else if(field === "showOnCalendar") stage.showOnCalendar = !!value;
  else stage[field] = value;
  renderAddJobStages();
}
function updateMilestoneAssignment(stageIndex,assignmentIndex,value){
  const stage=addJobStages[stageIndex];if(!stage)return;
  stage.assignments=normaliseMilestoneAssignments(stage);
  if(stage.assignments[assignmentIndex]) stage.assignments[assignmentIndex].person=value;
  renderAddJobStages();
}
function addMilestoneAssignment(stageIndex){
  const stage=addJobStages[stageIndex];if(!stage)return;
  stage.assignments=normaliseMilestoneAssignments(stage);
  stage.assignments.push({person:""});
  renderAddJobStages();
}
function removeMilestoneAssignment(stageIndex,assignmentIndex){
  const stage=addJobStages[stageIndex];if(!stage)return;
  stage.assignments=normaliseMilestoneAssignments(stage);
  stage.assignments.splice(assignmentIndex,1);
  if(!stage.assignments.length) stage.assignments.push({person:""});
  renderAddJobStages();
}
function updateStageAssignment(stageIndex,assignmentIndex,field,value){
  const stage = addJobStages[stageIndex];
  if (!stage) return;
  stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
  const assignment = stage.assignments[assignmentIndex];
  if (!assignment) return;
  assignment[field] = field === "hours" ? Math.max(0,Number(value)||0) : value;
  renderAddJobStages();
}
function addStageAssignment(stageIndex){
  const stage = addJobStages[stageIndex];
  if (!stage) return;
  stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
  const remaining = Math.max(0,stageRemainingHours(stage));
  stage.assignments.push({person:"",hours:remaining,date:stage.date || ""});
  renderAddJobStages();
}
function removeStageAssignment(stageIndex,assignmentIndex){
  const stage = addJobStages[stageIndex];
  if (!stage) return;
  stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
  stage.assignments.splice(assignmentIndex,1);
  if (!stage.assignments.length) stage.assignments.push({person:"",hours:Number(stage.hours||0),date:stage.date || ""});
  renderAddJobStages();
}
function splitStageEvenly(stageIndex){
  const stage = addJobStages[stageIndex];
  if (!stage) return;
  stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
  const selected = stage.assignments.filter(item => item.person);
  if (selected.length < 2) {showToast("Choose at least two employees first."); return;}
  const total = Math.round(Number(stage.hours||0)*100);
  const base = Math.floor(total/selected.length);
  let remainder = total-(base*selected.length);
  selected.forEach(item => {item.hours=(base+(remainder>0?1:0))/100;if(remainder>0) remainder--;});
  stage.assignments.filter(item => !item.person).forEach(item => item.hours=0);
  renderAddJobStages();
}
function assignAllStagesByDepartment(){
  addJobStages.filter(stage=>stage.countsCapacity).forEach(stage => {
    const employee = people.find(person => employeeCountsCapacity(person) && person.role === stage.department);
    stage.assignments = [{person:employee ? employee.name : "",hours:Number(stage.hours||0),date:stage.date || ""}];
  });
  renderAddJobStages();
  showToast("Stages assigned by department.");
}
async function saveAddJob(){
  if (!isAdmin || addJobSaveInProgress) return;
  const jobNumber = document.getElementById("ajJobNumber").value.trim();
  const address = document.getElementById("ajAddress").value.trim();
  const builder = document.getElementById("ajBuilder").value.trim();
  const installValue = document.getElementById("ajInstallDate").value;
  const installDate = parseIsoDate(installValue);
  if (!jobNumber || !address || !installDate) {
    showAddJobMessage("Complete the job number, site address and predicted install date.",true);
    window.scrollTo({top:0,behavior:"smooth"});
    return;
  }
  const duplicate = jobs.some(job => String(job.id).toLowerCase() === jobNumber.toLowerCase() && String(job.id) !== String(editingJobId || ""));
  if (duplicate) {showAddJobMessage("That job number already exists.",true); return;}
  const allocationProblem = addJobStages.find(stage => {
    if (!stage.countsCapacity) return false;
    stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
    const selected = stage.assignments.filter(item => item.person);
    if (!selected.length) return false;
    const names = selected.map(item=>item.person);
    return new Set(names).size !== names.length || Math.abs(stageRemainingHours(stage)) > .01;
  });
  if (allocationProblem) {showAddJobMessage(`Assign every hour for ${allocationProblem.name}. Assigned hours must equal the stage total and each employee can only appear once.`,true); document.getElementById("ajStageRows").scrollIntoView({behavior:"smooth",block:"start"}); return;}

  const isEditing = !!editingJobId;
  const originalId = editingJobId;
  const job = {
    id:jobNumber,
    name:address,
    address,
    builder,
    install:installDate.toLocaleDateString("en-AU",{day:"numeric",month:"short"}),
    installDate:toIsoDate(installDate),
    status:document.getElementById("ajJobStatus").value,
    jobLengthWeeks:Number(document.getElementById("ajJobLength").value||4),
    twoPack:document.getElementById("ajTwoPack").checked,
    notes:document.getElementById("ajNotes").value.trim(),
    source:addJobSource,
    labourHours:{
      checkMeasure:addJobHour("ajHoursCheck"),
      drafting:addJobHour("ajHoursDrafting"),
      machining:addJobHour("ajHoursMachining"),
      assembly:addJobHour("ajHoursAssembly"),
      loading:addJobHour("ajHoursLoading"),
      delivery:addJobHour("ajHoursDelivery")
    },
    excludedStages:[...addJobExcludedStages]
  };

  if (isEditing) {
    const index = jobs.findIndex(item => String(item.id) === String(originalId));
    if (index < 0) {showAddJobMessage("That job could not be found. Refresh TrackR and try again.",true); return;}
    jobs[index] = job;
  } else {
    jobs.push(job);
  }

  const sourceJobId = String(originalId || jobNumber);
  const existingStageIds = new Map();
  tasks.filter(task => String(task.job) === sourceJobId && !task.custom).forEach(task => {
    const employeeKey = task.type === "admin" ? ((task.assigned || [])[0] || task.adminEmployee || "") : "";
    const key = `${task.stageGroup || task.name}|${task.stageDepartment || task.department}|${task.type}|${employeeKey}`;
    if (!existingStageIds.has(key)) existingStageIds.set(key, task.id);
  });

  // Keep manually created tasks, including their Calendar/Schedule position, and
  // relink them if the job number changed. Generated stages are rebuilt below.
  tasks.forEach(task => {
    if (isEditing && String(task.job) === String(originalId) && task.custom) task.job = jobNumber;
  });
  tasks = tasks.filter(task => !(String(task.job) === sourceJobId && !task.custom));

  addJobStages.forEach((stage,index) => {
    const stageDate = parseIsoDate(stage.date);
    const start = stageDate ? legacyIndexForDate(stageDate) : 0;
    if (!stage.countsCapacity) {
      const type = "milestone";
      const department = "Milestone";
      const key = `${stage.name}|${department}|${type}|`;
      tasks.push({
        id:existingStageIds.get(key) || `${jobNumber}-${Date.now()}-${index}`,
        job:jobNumber,
        name:stage.name,
        type,
        department,
        start,
        monthDay:stageDate ? stageDate.getDate() : scheduleStartDay,
        date:stage.date,
        endDate:stage.endDate || stage.date,
        duration:0,
        estimatedHours:Number(stage.hours||0),
        assigned:normaliseMilestoneAssignments(stage).map(item=>item.person).filter(Boolean),
        assignmentMinutes:{},
        assignmentDates:Object.fromEntries(normaliseMilestoneAssignments(stage).map(item=>item.person).filter(Boolean).map(person=>[person,stage.date])),
        status:stage.status || "Planned",
        notes:stage.notes || "",
        stoneMason:stage.stoneMason || "",
        custom:false,
        generated:true,
        parts:[]
      });
      return;
    }

    stage.assignments = normaliseStageAssignments(stage,Number(stage.hours||0));
    const selectedAssignments = stage.assignments.filter(item => item.person);
    const adminAssignments = selectedAssignments.filter(item => isAdminEmployee(item.person));
    const capacityAssignments = selectedAssignments.filter(item => !isAdminEmployee(item.person));
    const hasAnyAssignments = selectedAssignments.length > 0;
    const capacityHours = hasAnyAssignments ? capacityAssignments.reduce((sum,item)=>sum+Math.max(0,Number(item.hours)||0),0) : Number(stage.hours||0);
    const department = stage.department;
    const capacityKey = `${stage.name}|${department}|capacity|`;
    tasks.push({
      id:existingStageIds.get(capacityKey) || `${jobNumber}-${Date.now()}-${index}-capacity`,
      job:jobNumber,
      name:stage.name,
      stageGroup:stage.name,
      stageDepartment:department,
      stageTotalHours:Number(stage.hours||0),
      type:"capacity",
      department,
      start,
      monthDay:stageDate ? stageDate.getDate() : scheduleStartDay,
      date:stage.date,
      endDate:stage.endDate || stage.date,
      duration:Math.round(capacityHours*60),
      estimatedHours:capacityHours,
      assigned:[...new Set(capacityAssignments.map(item=>item.person))],
      assignmentMinutes:Object.fromEntries(capacityAssignments.map(item=>[item.person,Math.round(Math.max(0,Number(item.hours)||0)*60)])),
      assignmentDates:Object.fromEntries(capacityAssignments.map(item=>[item.person,item.date || stage.date])),
      showOnCalendar:!!stage.showOnCalendar,
      status:stage.status || "Planned",
      notes:stage.notes || "",
      stoneMason:stage.stoneMason || "",
      custom:false,
      generated:true,
      parts:[]
    });

    adminAssignments.forEach((assignment,adminIndex) => {
      const assignmentDate = parseIsoDate(assignment.date || stage.date) || stageDate;
      const adminKey = `${stage.name}|${department}|admin|${assignment.person}`;
      tasks.push({
        id:existingStageIds.get(adminKey) || `${jobNumber}-${Date.now()}-${index}-admin-${adminIndex}`,
        job:jobNumber,
        name:stage.name,
        stageGroup:stage.name,
        stageDepartment:department,
        stageTotalHours:Number(stage.hours||0),
        type:"admin",
        department:"Admin",
        adminEmployee:assignment.person,
        start:assignmentDate ? legacyIndexForDate(assignmentDate) : start,
        monthDay:assignmentDate ? assignmentDate.getDate() : scheduleStartDay,
        date:assignmentDate ? toIsoDate(assignmentDate) : stage.date,
        endDate:assignmentDate ? toIsoDate(assignmentDate) : stage.date,
        duration:Math.round(Math.max(0,Number(assignment.hours)||0)*60),
        estimatedHours:Math.max(0,Number(assignment.hours)||0),
        assigned:[assignment.person],
        assignmentMinutes:{[assignment.person]:Math.round(Math.max(0,Number(assignment.hours)||0)*60)},
        assignmentDates:{[assignment.person]:assignmentDate ? toIsoDate(assignmentDate) : stage.date},
        status:stage.status || "Planned",
        notes:`Admin calendar task for ${stage.name}.`,
        stoneMason:stage.stoneMason || "",
        custom:false,
        generated:true,
        adminTask:true,
        parts:[]
      });
    });
  });

  // Move the Calendar to the edited install month and make sure the Schedule
  // recalculates from the new dates/assignments immediately.
  visibleMonthOffset = (installDate.getFullYear()-calendarBaseDate.getFullYear())*12 + (installDate.getMonth()-calendarBaseDate.getMonth());
  tasks.forEach(task => { task.parts = []; });
  renderAll();

  setAddJobSaving(true,isEditing);
  let saved = false;
  try {
    saved = await queueStateSave(isEditing ? "Job updated" : "Job created");
  } finally {
    setAddJobSaving(false,isEditing);
  }
  if (!saved) {
    const detail = lastStateSaveError ? ` ${lastStateSaveError}` : "";
    showAddJobMessage(lastStateSaveConflict ? `The job was not saved because TrackR changed elsewhere. The latest saved data has been reloaded.${detail}` : `The job could not be saved. Unsaved workspace changes were rolled back.${detail}`,true);
    return;
  }

  editingJobId = null;
  configureAddJobPage(false);
  showView("jobs");
  window.scrollTo({top:0,behavior:"smooth"});
}

async function deleteEditingJob(){
  if (!isAdmin) return;
  if (!editingJobId) return;
  const job = jobs.find(item => String(item.id) === String(editingJobId));
  if (!job) return;
  const linkedTaskCount = tasks.filter(task => String(task.job) === String(editingJobId)).length;
  const confirmed = confirm(`Delete ${job.id}? This will also delete ${linkedTaskCount} linked Calendar and Schedule item${linkedTaskCount === 1 ? "" : "s"}. This cannot be undone.`);
  if (!confirmed) return;

  jobs = jobs.filter(item => String(item.id) !== String(editingJobId));
  tasks = tasks.filter(task => String(task.job) !== String(editingJobId));
  tasks.forEach(task => { task.parts = []; });
  renderAll();

  const deletedId = editingJobId;
  const saved = await queueStateSave(`${deletedId} deleted`);
  if (!saved) {
    showAddJobMessage(lastStateSaveConflict ? "The job was not deleted because TrackR changed elsewhere. The latest saved data has been reloaded." : "The job could not be deleted. Unsaved workspace changes were rolled back.",true);
    return;
  }

  editingJobId = null;
  configureAddJobPage(false);
  showView("jobs");
  window.scrollTo({top:0,behavior:"smooth"});
}

/* Jobs */
function setJobsViewMode(mode){
  jobsViewMode = mode === "archive" ? "archive" : "current";
  document.getElementById("jobsCurrentBtn")?.classList.toggle("active", jobsViewMode === "current");
  document.getElementById("jobsArchiveBtn")?.classList.toggle("active", jobsViewMode === "archive");
  renderJobs();
}
function scheduledDatesForJob(jobId){
  const dates = [];
  const addDate = value => {
    const parsed = parseIsoDate(value);
    if (parsed) dates.push(parsed);
  };
  tasks.filter(task => String(task.job) === String(jobId)).forEach(task => {
    addDate(task.date);
    Object.values(task.assignmentDates || {}).forEach(addDate);
    (task.parts || []).forEach(part => addDate(part.date));
  });
  return dates;
}
function jobIsArchived(job){
  const dates = scheduledDatesForJob(job.id);
  if (!dates.length) return false;
  const latest = new Date(Math.max(...dates.map(dateObj => dateObj.getTime())));
  const today = new Date();
  const todayLocal = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const cutoff = addCalendarDays(todayLocal, -JOB_ARCHIVE_AFTER_DAYS);
  return latest < cutoff;
}
function calendarStageNamesForJob(jobId){
  const seen = new Set();
  return tasks
    .filter(task => String(task.job) === String(jobId) && calendarTaskVisible(task))
    .sort((a,b) => {
      const aDate = taskDate(a);
      const bDate = taskDate(b);
      const dateDiff = (aDate?.getTime?.() || 0) - (bDate?.getTime?.() || 0);
      return dateDiff || String(a.name || "").localeCompare(String(b.name || ""));
    })
    .map(task => String(task.stageGroup || task.name || "").trim())
    .filter(name => {
      const key = name.toLocaleLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
function renderJobs(){
  const rows = document.getElementById("jobRows");
  const query = searchValue("jobsSearch");
  const currentJobs = jobs.filter(job => !jobIsArchived(job));
  const archiveJobs = jobs.filter(job => jobIsArchived(job));
  // Search intentionally spans both Current and Archive so old work is always easy to find.
  const sourceJobs = query ? jobs : (jobsViewMode === "archive" ? archiveJobs : currentJobs);
  const visibleJobs = sourceJobs.filter(job => jobMatchesQuery(job,query));
  const currentButton = document.getElementById("jobsCurrentBtn");
  currentButton?.classList.toggle("active", jobsViewMode === "current");
  if (currentButton) currentButton.textContent = `Current ${currentJobs.length}`;
  document.getElementById("jobsArchiveBtn")?.classList.toggle("active", jobsViewMode === "archive");
  rows.innerHTML = visibleJobs.map(job => {
    const jobTasks = tasks.filter(task => String(task.job) === String(job.id));
    const capMins = jobTasks.filter(task => task.type === "capacity").reduce((sum,task) => sum+Number(task.duration || 0),0);
    const milestones = calendarStageNamesForJob(job.id).join(", ") || "None";
    const missingCount = jobMissingDetailsCount(job.id);
    return `<div class="job-row" data-job-id="${escapeHtml(encodeURIComponent(job.id))}">
      <div><div class="job-title">${escapeHtml(job.id)}</div><div class="job-sub">${jobTasks.length} tasks · ${escapeHtml(job.status || "Active")}</div>${missingCount?`<span class="job-detail-warning">⚠ ${missingCount} task${missingCount===1?"":"s"} need details</span>`:``}</div>
      <div><span class="job-sub">${escapeHtml(job.builder || "—")}</span></div>
      <div><span class="job-sub">${escapeHtml(job.address)}</span></div>
      <div><span class="pill ${job.status === "Forecast" ? "yellow" : "grey"}">${escapeHtml(job.install || "")}</span></div>
      <div><span class="pill green">${fmt(capMins)}</span></div>
      <div><span class="job-sub">${escapeHtml(milestones)}</span></div>
    </div>`;
  }).join("") || `<div class="search-empty">${query ? "No jobs match this search." : (jobsViewMode === "archive" ? "No jobs have moved to Archive yet." : "No current jobs to show.")}</div>`;
  rows.querySelectorAll("[data-job-id]").forEach(row => row.addEventListener("click",()=>openEditJob(decodeURIComponent(row.dataset.jobId))));
}
