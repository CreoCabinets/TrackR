/* Task panel */
function fillPanelOptions(){}
function openDayTaskPanel(year,month,day){
  openCustomTaskPanel("calendar");
  document.getElementById("taskDate").value = toIsoDate(new Date(year,month,day));
  document.getElementById("panelTitle").textContent = `Add task · ${day} ${new Date(year,month,day).toLocaleString("en-AU",{month:"short"})}`;
  document.getElementById("panelSub").textContent = "Calendar milestone or schedule capacity task";
}
function openCustomTaskPanel(origin="general"){
  taskPanelOrigin=origin;
  selectedTaskId = null;
  fillPanelOptions();
  document.getElementById("panelTitle").textContent = "Add task";
  document.getElementById("panelSub").textContent = "Calendar milestone or schedule capacity task";
  document.getElementById("taskJob").value = "";
  updateTaskJobMeta();
  document.getElementById("taskType").value = "milestone";
  document.getElementById("taskName").value = "";
  document.getElementById("taskDate").value = toIsoDate(new Date());
  document.getElementById("taskHours").value = "2h";
  document.getElementById("taskDepartment").value = "Milestone";
  document.getElementById("taskStatus").value = "Planned";
  document.getElementById("taskShowOnCalendar").checked = origin === "calendar";
  document.getElementById("taskStoneMason").value = "";
  document.getElementById("employeeCard").open = false;
  renderEmployeeChoices([]);
  updateTypeHint();
  updateAllocationSummary(null);
  openPanel("taskPanel");
}
function openScheduleTaskPanel(personName,dayIndex){
  openCustomTaskPanel("schedule");
  const person = people.find(item => item.name === personName);
  const dateObj = dateForDayIndex(dayIndex);
  document.getElementById("panelTitle").textContent = `Add task · ${personName}`;
  document.getElementById("panelSub").textContent = dateObj.toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short",year:"numeric"});
  document.getElementById("taskType").value = "capacity";
  document.getElementById("taskDate").value = toIsoDate(dateObj);
  document.getElementById("taskDepartment").value = ["Drafting","Cabinet Making","Machining","Installer / Site"].includes(person?.role) ? person.role : "Cabinet Making";
  renderEmployeeChoices([personName]);
  updateTypeHint();
}
function openScheduleStatusPanel(personName, dayIndex){
  openStatusPanel(personName, dayIndex);
}
function updateTaskJobMeta(task=null){
  const row=document.getElementById("taskBuilderClientRow"),label=document.getElementById("taskBuilderClientLabel"),input=document.getElementById("taskBuilderClient");
  if(!row || !label || !input) return;
  const jobText=(task?.job || document.getElementById("taskJob")?.value || "").trim();
  const job=jobs.find(item=>normaliseSearch(item.id)===normaliseSearch(jobText));
  if(!job || !String(job.builder || "").trim()){row.style.display="none";input.value="";label.textContent="Builder / Client";return;}
  row.style.display="grid";
  input.value=job.builder || "";
  label.textContent=job.jobType === "private" ? "Client" : job.jobType === "builder" ? "Builder" : "Builder / Client";
}
function openTaskDetailsPanel(id){
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const job = jobById(task.job);
  const assigned = (task.assigned || []).join(", ") || "Unassigned";
  const dateObj = taskDate(task);
  const rows = [
    ["Job", task.job || "—"],
    ["Task", task.name || "—"],
    ["Type", task.type === "capacity" ? "Capacity task" : task.type === "admin" ? "Admin calendar task" : "Calendar milestone"],
    ["Date", dateObj ? dateObj.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}) : "—"],
    ["Hours", task.type === "milestone" ? "Calendar only" : fmt(task.duration)],
    ["Department", task.department || "—"],
    ["Status", task.status || "Planned"],
    ["Assigned", assigned]
  ];
  if (job?.builder) rows.splice(1,0,[job.jobType === "private" ? "Client" : job.jobType === "builder" ? "Builder" : "Builder / Client",job.builder]);
  if (task.stoneMason) rows.push(["Stone mason",task.stoneMason]);
  if (task.type === "capacity") rows.push(["Calendar",task.showOnCalendar ? "Shown on Calendar" : "Schedule only"]);
  document.getElementById("taskDetailsTitle").textContent = task.name || "Task details";
  document.getElementById("taskDetailsSub").textContent = "Read-only details";
  document.getElementById("taskDetailsBody").innerHTML = `<div class="detail-card"><h3>Task details</h3><div class="form-grid">${rows.map(([label,value])=>`<div class="form-row"><label>${escapeHtml(label)}</label><div class="readonly-field-value">${escapeHtml(value)}</div></div>`).join("")}</div></div>`;
  openPanel("taskDetailsPanel");
}
function openTaskPanel(id){
  if (!isAdmin) {openTaskDetailsPanel(id); return;}
  taskPanelOrigin="edit";
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  selectedTaskId = id;
  fillPanelOptions();
  document.getElementById("panelTitle").textContent = "Edit task";
  document.getElementById("panelSub").textContent = `${taskLabel(task)} · ${task.type === "milestone" ? "Calendar milestone only" : "Capacity task"}`;
  document.getElementById("taskJob").value = task.job;
  updateTaskJobMeta(task);
  document.getElementById("taskType").value = task.type;
  document.getElementById("taskName").value = task.name;
  document.getElementById("taskDate").value = toIsoDate(taskDate(task));
  document.getElementById("taskHours").value = task.type === "milestone" ? "0h" : fmt(task.duration);
  document.getElementById("taskDepartment").value = task.department;
  document.getElementById("taskStatus").value = task.status || "Planned";
  document.getElementById("taskShowOnCalendar").checked = task.showOnCalendar === true;
  document.getElementById("taskStoneMason").value = task.stoneMason || "";
  document.getElementById("employeeCard").open = false;
  renderEmployeeChoices(task.assigned);
  updateTypeHint();
  updateAllocationSummary(task);
  openPanel("taskPanel");
}
function updateEmployeeAssignedCount(){
  const count=document.querySelectorAll("#employeeChoices input:checked").length;
  const el=document.getElementById("employeeAssignedCount");
  if(el) el.textContent=`(${count})`;
}
function renderEmployeeChoices(selected){
  const type = document.getElementById("taskType").value;
  const available = type === "capacity"
    ? people.filter(employeeCountsCapacity)
    : people.filter(person => person.role !== "Admin" && !employeeCountsCapacity(person));
  const choices = available.map(person => `
    <div class="employee-choice">
      <label><input type="checkbox" value="${escapeHtml(person.name)}" ${selected.includes(person.name) ? "checked" : ""} data-change-action="updateEmployeeAssignedCount">${escapeHtml(person.name)}</label>
      <span>${escapeHtml(person.role)}</span>
    </div>`).join("");
  document.getElementById("employeeChoices").innerHTML = choices || `<div class="note">${type === "capacity" ? "No capacity employees are available." : "No non-capacity installers have been added yet."}</div>`;
  updateEmployeeAssignedCount();
}
function isStoneTaskName(value){return normaliseSearch(value).includes("stone");}
function updateStoneMasonField(){
  const visible=isStoneTaskName(document.getElementById("taskName")?.value);
  const row=document.getElementById("stoneMasonRow");if(row) row.style.display=visible ? "grid" : "none";
  const typeSelect=document.getElementById("taskType");
  if(typeSelect){
    if(visible && typeSelect.value !== "milestone"){
      typeSelect.value="milestone";
      setTimeout(updateTypeHint,0);
    }
    typeSelect.disabled=visible;
  }
}
function updateTypeHint(){
  const type=document.getElementById("taskType").value;
  const selected=[...document.querySelectorAll("#employeeChoices input:checked")].map(input=>input.value);
  const employeeCard=document.getElementById("employeeCard"),hoursInput=document.getElementById("taskHours"),department=document.getElementById("taskDepartment"),calendarRow=document.getElementById("showOnCalendarRow"),calendarCheckbox=document.getElementById("taskShowOnCalendar");
  employeeCard.style.display="block";
  if(type === "milestone"){
    hoursInput.value="0h";department.value="Milestone";calendarRow.style.display="none";calendarCheckbox.disabled=false;
    document.getElementById("employeeCardTitle").textContent="Non-capacity installer (optional)";
    document.getElementById("employeeCardNote").textContent="Choose a subcontractor here so their name appears on the Calendar without using company capacity.";
    document.getElementById("typeHint").textContent="Calendar milestone only: shows on Calendar and does not use employee capacity.";
  }else{
    calendarRow.style.display="flex";if(hoursInput.value === "0h") hoursInput.value="2h";if(department.value === "Milestone") department.value="Cabinet Making";
    const createdFromCalendar=taskPanelOrigin === "calendar" && !selectedTaskId;if(createdFromCalendar) calendarCheckbox.checked=true;calendarCheckbox.disabled=createdFromCalendar;
    document.getElementById("employeeCardTitle").textContent="Assigned capacity employees";
    document.getElementById("employeeCardNote").textContent="Assignment is optional. Leave everyone unticked to place the task in Schedule's Unassigned row, or choose multiple employees to split it evenly.";
    document.getElementById("typeHint").textContent=createdFromCalendar ? "Created from Calendar: this capacity task will appear on both Calendar and Schedule." : "Capacity task: the selected date is the earliest start. Schedule priority uses available hours first and spills remaining work forward. Use Show on Calendar when this task must appear in both places.";
  }
  renderEmployeeChoices(selected);updateStoneMasonField();
}

function savePanelTask(){
  const enteredName = document.getElementById("taskName").value.trim();
  let type = document.getElementById("taskType").value;
  if (isStoneTaskName(enteredName)) type = "milestone";
  const selected = [...document.querySelectorAll("#employeeChoices input:checked")].map(input => input.value);
  const jobText = document.getElementById("taskJob").value.trim();
  if (!jobText) {showToast("Enter a job number or description."); document.getElementById("taskJob").focus(); return;}
  const selectedDate = parseIsoDate(document.getElementById("taskDate").value);
  if (!selectedDate) {showToast("Choose a valid task date."); document.getElementById("taskDate").focus(); return;}
  const parsedDuration = type === "milestone" ? 0 : parseHours(document.getElementById("taskHours").value);
  if (!Number.isFinite(parsedDuration)) {showToast("Enter task hours such as 2h, 1h30 or 2.5."); document.getElementById("taskHours").focus(); return;}
  const existingIndex = selectedTaskId ? tasks.findIndex(t => t.id === selectedTaskId) : -1;
  const task = existingIndex >= 0 ? JSON.parse(JSON.stringify(tasks[existingIndex])) : {id:`custom-${Date.now()}`, custom:true};
  task.job = jobText;
  task.type = type;
  task.name = enteredName || (type === "milestone" ? "Milestone" : "Custom Task");
  task.start = legacyIndexForDate(selectedDate);
  task.monthDay = selectedDate.getDate();
  task.date = toIsoDate(selectedDate);
  task.department = type === "milestone" ? "Milestone" : document.getElementById("taskDepartment").value;
  task.duration = parsedDuration;
  task.assigned = selected;
  task.assignmentMinutes = {};
  task.assignmentDates = Object.fromEntries(selected.map(name => [name,toIsoDate(selectedDate)]));
  task.showOnCalendar = type === "capacity" && (taskPanelOrigin === "calendar" || document.getElementById("taskShowOnCalendar").checked);
  task.stoneMason = isStoneTaskName(task.name) ? document.getElementById("taskStoneMason").value.trim() : "";
  task.status = document.getElementById("taskStatus").value;
  if (existingIndex >= 0) tasks[existingIndex] = task;
  else tasks.push(task);
  calculate();
  updateAllocationSummary(task);
  renderAll();
  closeTaskPanel();
  saveState(type === "milestone" ? "Calendar task saved" : "Capacity task saved");
}
function deleteTask(){
  if (!selectedTaskId) {closeTaskPanel(); return;}
  tasks = tasks.filter(t => t.id !== selectedTaskId);
  closeTaskPanel();
  renderAll();
  saveState("Task deleted");
}
function updateAllocationSummary(task){
  const el = document.getElementById("allocationSummary");
  if (!task || task.type !== "capacity") {
    const names = (task?.assigned || []).join(", ");
    el.textContent = names ? `Calendar only · ${names}` : "No capacity allocation for calendar-only items.";
    return;
  }
  calculate();
  const rows = task.assigned.map(name => {
    const minutes = (task.parts || []).filter(p => p.person === name).reduce((s,p)=>s+p.minutes,0);
    return `${name}: ${fmt(minutes)}`;
  });
  el.replaceChildren(...rows.flatMap((row,index) => index ? [document.createElement("br"),document.createTextNode(row)] : [document.createTextNode(row)]));
}

/* Day panel */
function openDayPanel(personName, dayIndex){
  const day = days[dayIndex];
  const result = calculate();
  const person = people.find(p => p.name === personName);
  const title = personName === "Milestones" ? `${day.name} ${day.date}` : `${personName} · ${day.name} ${day.date}`;
  document.getElementById("dayPanelTitle").textContent = title;
  const body = document.getElementById("dayPanelBody");
  if (personName === "Milestones") {
    const items = tasks.filter(t => t.type === "milestone" && scheduleIndexForDate(taskDate(t)) === dayIndex);
    body.innerHTML = `<div class="detail-card"><h3>Calendar items</h3>${items.map(t => `<div class="mini-detail"><span>${escapeHtml(taskLabel(t))}</span><button data-open-task="${escapeHtml(encodeURIComponent(t.id))}">Open</button></div>`).join("") || `<div class="note">No items.</div>`}</div><button class="primary" data-add-calendar-task>Add task here</button>`;
    body.querySelectorAll("[data-open-task]").forEach(button => button.addEventListener("click", () => openTaskPanel(decodeURIComponent(button.dataset.openTask))));
    body.querySelector("[data-add-calendar-task]")?.addEventListener("click", () => openDayTaskPanel(dateForDayIndex(dayIndex).getFullYear(),dateForDayIndex(dayIndex).getMonth(),dateForDayIndex(dayIndex).getDate()));
  } else if (personName === "Unassigned") {
    const items = tasks.filter(t => t.type === "capacity" && !(t.assigned || []).length && scheduleIndexForDate(taskDate(t)) === dayIndex);
    body.innerHTML = `<div class="detail-card"><h3>Unassigned tasks</h3>${items.map(t => `<div class="mini-detail"><span>${escapeHtml(taskLabel(t))}</span><button data-open-task="${escapeHtml(encodeURIComponent(t.id))}">Assign</button></div>`).join("") || `<div class="note">No unassigned tasks.</div>`}</div>`;
    body.querySelectorAll("[data-open-task]").forEach(button => button.addEventListener("click", () => openTaskPanel(decodeURIComponent(button.dataset.openTask))));
  } else {
    const booked = (result.used[personName] && result.used[personName][dayIndex]) || 0;
    const cap = capacityFor(person, dayIndex);
    const items = (result.allocation[personName] && result.allocation[personName][dayIndex]) || [];
    const blocked=blockedStatusForDate(personName,dateForDayIndex(dayIndex));
    const over=Math.max(0,booked-cap);
    body.innerHTML = `
      <div class="detail-card"><h3>Capacity</h3><div class="note">${blocked && !booked ? `${blocked.type} · capacity blocked` : `${fmt(booked)} booked / ${fmt(cap)} available${over ? ` · Over by ${fmt(over)}` : ""}`}</div>${blocked ? `<button class="danger" style="margin-top:10px;width:100%" data-day-action="remove-status">Remove ${blocked.type} from this day</button>` : ""}</div>
      <div class="detail-card"><h3>Tasks</h3>${items.map(item => `<div class="mini-detail"><span>${escapeHtml(taskLabel(item.task))}</span><strong>${fmt(item.minutes)}</strong></div>`).join("") || `<div class="note">No work allocated.</div>`}</div>
      <div class="detail-card"><h3>Add to this day</h3><div class="action-row"><button class="primary" data-day-action="task">Add custom task</button><button data-day-action="status">Sick / Away</button></div></div>`;
    body.querySelector('[data-day-action="task"]').addEventListener("click", () => openScheduleTaskPanel(personName, dayIndex));
    body.querySelector('[data-day-action="status"]').addEventListener("click", () => openScheduleStatusPanel(personName, dayIndex));
    const removeStatusButton = body.querySelector('[data-day-action="remove-status"]');
    if (removeStatusButton) removeStatusButton.addEventListener("click", () => removeBlockedDay(personName, dayIndex));
  }
  openPanel("dayPanel");
}


function currentEmployeePattern(){
  return document.getElementById("customPatternBtn").classList.contains("active") ? "Custom" : "Standard";
}
function setEmployeePattern(pattern){
  document.getElementById("standardPatternBtn").classList.toggle("active", pattern === "Standard");
  document.getElementById("customPatternBtn").classList.toggle("active", pattern === "Custom");
  document.getElementById("customRosterCard").style.display = pattern === "Custom" ? "block" : "none";
  refreshRosterTotals();
}
function getStandardWeekFromInputs(){
  return {Mon:parseHours(empMon.value),Tue:parseHours(empTue.value),Wed:parseHours(empWed.value),Thu:parseHours(empThu.value),Fri:parseHours(empFri.value)};
}
function getCustomWeekInputs(prefix){
  return {
    Mon:parseHours(document.getElementById(prefix+"Mon").value),
    Tue:parseHours(document.getElementById(prefix+"Tue").value),
    Wed:parseHours(document.getElementById(prefix+"Wed").value),
    Thu:parseHours(document.getElementById(prefix+"Thu").value),
    Fri:parseHours(document.getElementById(prefix+"Fri").value)
  };
}
function setWeekInputs(prefix, week){
  document.getElementById(prefix+"Mon").value = fmt((week && week.Mon) || 0);
  document.getElementById(prefix+"Tue").value = fmt((week && week.Tue) || 0);
  document.getElementById(prefix+"Wed").value = fmt((week && week.Wed) || 0);
  document.getElementById(prefix+"Thu").value = fmt((week && week.Thu) || 0);
  document.getElementById(prefix+"Fri").value = fmt((week && week.Fri) || 0);
}
function refreshRosterTotals(){
  if (!document.getElementById("week1Total")) return;
  const standard = getStandardWeekFromInputs();
  const week1 = getCustomWeekInputs("w1");
  const week2 = getCustomWeekInputs("w2");
  const standardTotal = Object.values(standard).reduce((s,v)=>s+v,0);
  const total1 = Object.values(week1).reduce((s,v)=>s+v,0);
  const total2 = Object.values(week2).reduce((s,v)=>s+v,0);
  document.getElementById("week1Total").textContent = fmt(total1);
  document.getElementById("week2Total").textContent = fmt(total2);
  document.getElementById("averageWeekTotal").textContent = currentEmployeePattern() === "Custom" ? fmt((total1 + total2) / 2) : fmt(standardTotal);
}



function openStatusPanel(personName=null, dayIndex=null){
  document.getElementById("statusPerson").innerHTML = people.filter(employeeCountsCapacity).map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join("");
  const opts = days.map(d => `<option value="${d.iso}">${d.name} ${d.date}</option>`).join("");
  document.getElementById("statusStart").innerHTML = opts;
  document.getElementById("statusEnd").innerHTML = opts;
  if (personName && people.some(person => person.name === personName)) document.getElementById("statusPerson").value = personName;
  const selectedIso = Number.isInteger(dayIndex) ? toIsoDate(dateForDayIndex(dayIndex)) : document.getElementById("statusStart").value;
  document.getElementById("statusStart").value = selectedIso;
  document.getElementById("statusEnd").value = selectedIso;
  openPanel("statusPanel");
}
function closeStatusPanel(closeBackdrop=true){
  document.getElementById("statusPanel").classList.remove("open");
  if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open");
}
function saveStatusRange(){
  const startDate = document.getElementById("statusStart").value;
  let endDate = document.getElementById("statusEnd").value;
  if (endDate < startDate) endDate = startDate;
  dayStatuses.push({
    person: document.getElementById("statusPerson").value,
    type: document.getElementById("statusType").value,
    startDate,
    endDate,
    start:legacyIndexForDate(parseIsoDate(startDate)),
    end:legacyIndexForDate(parseIsoDate(endDate))
  });
  closeStatusPanel();
  renderAll();
  saveState("Blocked range saved");
}
function removeStatusRange(index){
  dayStatuses.splice(index,1);
  renderAll();
  saveState("Blocked range removed");
}
function removeBlockedDay(personName, dayIndex){
  const targetDate = dateForDayIndex(dayIndex);
  const targetIso = toIsoDate(targetDate);
  const statusIndex = dayStatuses.findIndex(status => {
    if (status.person !== personName) return false;
    const startDate = parseIsoDate(status.startDate) || legacyDateForDayIndex(Number(status.start || 0));
    const endDate = parseIsoDate(status.endDate) || legacyDateForDayIndex(Number(status.end || status.start || 0));
    return targetDate >= startDate && targetDate <= endDate;
  });
  if (statusIndex < 0) return;

  const status = dayStatuses[statusIndex];
  const startDate = parseIsoDate(status.startDate) || legacyDateForDayIndex(Number(status.start || 0));
  const endDate = parseIsoDate(status.endDate) || legacyDateForDayIndex(Number(status.end || status.start || 0));

  if (isSameDate(startDate,endDate)) {
    dayStatuses.splice(statusIndex,1);
  } else if (isSameDate(targetDate,startDate)) {
    const nextStart = addCalendarDays(startDate,1);
    status.startDate = toIsoDate(nextStart);
    status.start = legacyIndexForDate(nextStart);
  } else if (isSameDate(targetDate,endDate)) {
    const nextEnd = addCalendarDays(endDate,-1);
    status.endDate = toIsoDate(nextEnd);
    status.end = legacyIndexForDate(nextEnd);
  } else {
    const beforeEnd = addCalendarDays(targetDate,-1);
    const afterStart = addCalendarDays(targetDate,1);
    const afterStatus = {
      ...status,
      startDate:toIsoDate(afterStart),
      endDate:toIsoDate(endDate),
      start:legacyIndexForDate(afterStart),
      end:legacyIndexForDate(endDate)
    };
    status.endDate = toIsoDate(beforeEnd);
    status.end = legacyIndexForDate(beforeEnd);
    dayStatuses.splice(statusIndex + 1,0,afterStatus);
  }

  closeDayPanel();
  renderAll();
  saveState(`${status.type} removed from ${targetIso}`);
}
