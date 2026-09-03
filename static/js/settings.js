/* Employees */
async function userApi(url, options={}){
  const response = await apiFetch(url, {
    ...options,
    headers: {"Content-Type":"application/json", ...(options.headers || {})}
  });
  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  if (response.status === 401) {window.location.href = "/login"; throw new Error("Login required");}
  if (!response.ok) throw new Error(payload.error || "User update failed");
  return payload;
}
async function loadUsers(){
  if (!isAdmin) return;
  try {
    const payload = await userApi("/api/users", {method:"GET", headers:{}});
    appUsers = Array.isArray(payload.users) ? payload.users : [];
    renderUserAdmin();
  } catch (error) {
    const rows = document.getElementById("userRows");
    if (rows) rows.innerHTML = `<div class="note">${escapeHtml(error.message)}</div>`;
  }
}
function renderUserAdmin(){
  const rows = document.getElementById("userRows");
  if (!rows) return;
  rows.innerHTML = appUsers.length ? appUsers.map(user => `<div class="user-row">
    <div class="user-identity"><strong>${escapeHtml(user.username)}${user.is_current ? `<span class="user-role-pill">You</span>` : ""}${user.must_change_password ? `<span class="user-role-pill">Password change required</span>` : ""}</strong><span>${user.role === "admin" ? "Full admin access" : "Home, Calendar and Schedule only"}</span></div>
    <div class="form-row"><label>Access</label><select id="userRole-${user.id}" ${user.is_current ? "disabled" : ""}><option value="user" ${user.role === "user" ? "selected" : ""}>Read-only user</option><option value="admin" ${user.role === "admin" ? "selected" : ""}>Admin</option></select></div>
    <div class="form-row"><label>New password</label><input id="userPassword-${user.id}" type="password" maxlength="200" autocomplete="new-password" placeholder="Leave blank to keep current"></div>
    <div class="user-actions"><button data-click-action="saveFlowUser" data-click-args='[${user.id}]'>Save</button>${user.is_current ? "" : `<button class="danger" data-click-action="deleteFlowUser" data-click-args='${escapeHtml(JSON.stringify([user.id,encodeURIComponent(user.username)]))}'>Delete</button>`}</div>
  </div>`).join("") : `<div class="note">No users found.</div>`;
}
async function addFlowUser(){
  if (!isAdmin) return;
  const username = document.getElementById("newUsername").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;
  try {
    await userApi("/api/users", {method:"POST", body:JSON.stringify({username,password,role})});
    document.getElementById("newUsername").value = "";
    document.getElementById("newUserPassword").value = "";
    document.getElementById("newUserRole").value = "user";
    await loadUsers();
    showToast("User added");
  } catch (error) { showToast(error.message); }
}
async function saveFlowUser(userId){
  if (!isAdmin) return;
  const user = appUsers.find(item => item.id === userId);
  if (!user) return;
  const roleElement = document.getElementById(`userRole-${userId}`);
  const passwordElement = document.getElementById(`userPassword-${userId}`);
  const changes = {};
  if (roleElement && !roleElement.disabled && roleElement.value !== user.role) changes.role = roleElement.value;
  if (passwordElement && passwordElement.value) changes.password = passwordElement.value;
  if (!Object.keys(changes).length) {showToast("No changes to save"); return;}
  try {
    await userApi(`/api/users/${userId}`, {method:"PATCH", body:JSON.stringify(changes)});
    if (passwordElement) passwordElement.value = "";
    await loadUsers();
    showToast("User updated");
  } catch (error) {showToast(error.message); await loadUsers();}
}
async function deleteFlowUser(userId, encodedUsername){
  if (!isAdmin) return;
  const username = decodeURIComponent(encodedUsername || "user");
  if (!confirm(`Delete ${username}?`)) return;
  try {
    await userApi(`/api/users/${userId}`, {method:"DELETE"});
    await loadUsers();
    showToast("User deleted");
  } catch (error) {showToast(error.message);}
}

function showSettingsSection(section){
  if (!isAdmin) return;
  activeSettingsSection = section;
  ["user","employees","calendarEvents"].forEach(name => {
    document.getElementById(`settings${name[0].toUpperCase()+name.slice(1)}Section`)?.classList.toggle("active", section === name);
  });
  document.getElementById("settingsNavUser")?.classList.toggle("active", section === "user");
  document.getElementById("settingsNavEmployees")?.classList.toggle("active", section === "employees");
  document.getElementById("settingsNavCalendarEvents")?.classList.toggle("active", section === "calendarEvents");
  if (section === "calendarEvents") renderCalendarEvents();
  if (section === "user") loadUsers();
}
function renderSettings(){
  renderEmployees();
  renderCalendarEvents();
  showSettingsSection(activeSettingsSection);
}
function renderEmployees(){
  const rows = document.getElementById("employeeRows");
  if (!rows) return;
  rows.innerHTML = people.map(p => {
    const patternHtml = (p.workPattern || "Standard") === "Custom"
      ? ["Mon","Tue","Wed","Thu","Fri"].map(d => `<span class="day-dot ${(p.week1[d] || 0) === 0 ? "off" : ""}">${d[0]}</span>`).join("") + ["Mon","Tue","Wed","Thu","Fri"].map(d => `<span class="day-dot ${(p.week2[d] || 0) === 0 ? "off" : ""}">${d[0]}</span>`).join("")
      : ["Mon","Tue","Wed","Thu","Fri"].map(d => `<span class="day-dot ${(p.week[d] || 0) === 0 ? "off" : ""}">${d[0]}</span>`).join("");
    return `<div class="employee-row" draggable="true" data-employee="${escapeHtml(p.name)}">
      <div class="employee-name-cell"><span class="drag-handle" title="Drag to reorder" aria-label="Drag ${escapeHtml(p.name)} to reorder">⋮⋮</span><div><strong>${escapeHtml(p.name)}</strong><div class="job-sub">${escapeHtml(p.workPattern || "Standard")}</div></div></div>
      <div><span class="pill grey">${escapeHtml(p.role)}</span></div>
      <div><span class="pill ${employeeCountsCapacity(p) ? "green" : "grey"}">${employeeCountsCapacity(p) ? fmt(weeklyCapacity(p)) : "Non capacity"}</span></div>
      <div><div class="days-mini">${patternHtml}</div></div>
    </div>`;
  }).join("");

  rows.querySelectorAll(".employee-row").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest(".drag-handle") || employeeDragName) return;
      openEmployeePanel(row.dataset.employee);
    });
    row.addEventListener("dragstart", event => {
      employeeDragName = row.dataset.employee;
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", employeeDragName);
    });
    row.addEventListener("dragover", event => {
      if (!employeeDragName || employeeDragName === row.dataset.employee) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      row.classList.toggle("drop-before", !after);
      row.classList.toggle("drop-after", after);
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before","drop-after"));
    row.addEventListener("drop", event => {
      event.preventDefault();
      const targetName = row.dataset.employee;
      const after = row.classList.contains("drop-after");
      document.querySelectorAll(".employee-row").forEach(item => item.classList.remove("drop-before","drop-after"));
      if (!employeeDragName || employeeDragName === targetName) return;
      const fromIndex = people.findIndex(person => person.name === employeeDragName);
      if (fromIndex < 0) return;
      const [moved] = people.splice(fromIndex,1);
      let targetIndex = people.findIndex(person => person.name === targetName);
      if (targetIndex < 0) targetIndex = people.length;
      if (after) targetIndex += 1;
      people.splice(Math.min(targetIndex, people.length),0,moved);
      employeeDragName = null;
      renderAll();
      saveState("Employee order saved");
    });
    row.addEventListener("dragend", () => {
      employeeDragName = null;
      document.querySelectorAll(".employee-row").forEach(item => item.classList.remove("dragging","drop-before","drop-after"));
    });
  });
}
function renderCalendarEvents(){
  const rows = document.getElementById("calendarEventRows");
  if (!rows) return;
  const ordered = [...calendarEvents].sort((a,b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name));
  rows.innerHTML = ordered.length ? ordered.map(event => `<div class="calendar-event-row">
    <div><strong>${escapeHtml(event.name)}</strong><span>${escapeHtml(event.type)}</span></div>
    <div><strong>${formatCalendarEventDate(event.startDate)}</strong><span>Starts</span></div>
    <div><strong>${formatCalendarEventDate(event.endDate)}</strong><span>Ends</span></div>
    <div class="calendar-event-actions"><button data-click-action="editCalendarEvent" data-click-args='${escapeHtml(JSON.stringify([event.id]))}'>Edit</button><button class="danger" data-click-action="removeCalendarEvent" data-click-args='${escapeHtml(JSON.stringify([event.id]))}'>Remove</button></div>
  </div>`).join("") : `<div class="note">No company-wide calendar events have been added yet.</div>`;
}
function formatCalendarEventDate(value){
  const date = parseIsoDate(value);
  return date ? date.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"}) : "—";
}
function clearCalendarEventForm(){
  selectedCalendarEventId = null;
  ["calendarEventName","calendarEventStart","calendarEventEnd"].forEach(id => {const element=document.getElementById(id); if(element) element.value="";});
  const type = document.getElementById("calendarEventType"); if(type) type.value = "Factory Closure";
  const button = document.getElementById("calendarEventSaveButton"); if(button) button.textContent = "Add event";
}
function saveCalendarEvent(){
  if (!isAdmin) return;
  const name = document.getElementById("calendarEventName").value.trim();
  const type = document.getElementById("calendarEventType").value;
  const startDate = document.getElementById("calendarEventStart").value;
  const endDate = document.getElementById("calendarEventEnd").value || startDate;
  if (!name || !startDate) {showToast("Enter an event name and start date"); return;}
  if (endDate < startDate) {showToast("End date must be on or after the start date"); return;}
  let event = calendarEvents.find(item => item.id === selectedCalendarEventId);
  if (!event) {
    event = {id:`calendar-event-${Date.now()}`,name,type,startDate,endDate};
    calendarEvents.push(event);
  } else Object.assign(event,{name,type,startDate,endDate});
  clearCalendarEventForm();
  renderAll();
  saveState("Calendar event saved");
}
function editCalendarEvent(id){
  if (!isAdmin) return;
  const event = calendarEvents.find(item => item.id === id);
  if (!event) return;
  selectedCalendarEventId = event.id;
  document.getElementById("calendarEventName").value = event.name;
  document.getElementById("calendarEventType").value = event.type;
  document.getElementById("calendarEventStart").value = event.startDate;
  document.getElementById("calendarEventEnd").value = event.endDate;
  document.getElementById("calendarEventSaveButton").textContent = "Save changes";
}
function removeCalendarEvent(id){
  if (!isAdmin) return;
  const event = calendarEvents.find(item => item.id === id);
  if (!event || !confirm(`Remove ${event.name}?`)) return;
  calendarEvents = calendarEvents.filter(item => item.id !== id);
  if (selectedCalendarEventId === id) clearCalendarEventForm();
  renderAll();
  saveState("Calendar event removed");
}
function openEmployeePanel(name){
  if (!isAdmin) return;
  selectedEmployeeName = name;
  let p = people.find(x => x.name === name);
  if (!p) p = {name:"", role:"Cabinet Making", countsCapacity:true, workPattern:"Standard", week:{Mon:460,Tue:460,Wed:460,Thu:460,Fri:340}};
  document.getElementById("employeePanelTitle").textContent = p.name || "Add employee";
  document.getElementById("employeeNameInput").value = p.name;
  document.getElementById("employeeRoleInput").value = p.role;
  document.getElementById("employeeCountsCapacity").checked = employeeCountsCapacity(p);
  updateEmployeeCapacityControl();
  document.getElementById("empMon").value = fmt((p.week && p.week.Mon) || 0);
  document.getElementById("empTue").value = fmt((p.week && p.week.Tue) || 0);
  document.getElementById("empWed").value = fmt((p.week && p.week.Wed) || 0);
  document.getElementById("empThu").value = fmt((p.week && p.week.Thu) || 0);
  document.getElementById("empFri").value = fmt((p.week && p.week.Fri) || 0);
  document.getElementById("customStartInput").value = p.customStart || "2026-06-08";
  setWeekInputs("w1", p.week1 || p.week || {Mon:460,Tue:460,Wed:460,Thu:460,Fri:340});
  setWeekInputs("w2", p.week2 || p.week || {Mon:460,Tue:460,Wed:460,Thu:460,Fri:0});
  setEmployeePattern(p.workPattern || "Standard");
  refreshRosterTotals();
  openPanel("employeePanel");
}
function updateEmployeeCapacityControl(){
  const role = document.getElementById("employeeRoleInput").value;
  const checkbox = document.getElementById("employeeCountsCapacity");
  const hint = document.getElementById("employeeCapacityHint");
  const isAdminRole = role === "Admin";
  if (isAdminRole) checkbox.checked = false;
  checkbox.disabled = isAdminRole;
  hint.textContent = isAdminRole
    ? "Admin employees are calendar-only and cannot count toward production capacity."
    : "Turn this off for subcontractors who should appear on Calendar without adding company capacity.";
}
function renameEmployeeReferences(oldName,newName){
  tasks.forEach(task => {
    task.assigned = (task.assigned || []).map(name => name === oldName ? newName : name);
    if (task.adminEmployee === oldName) task.adminEmployee = newName;
    ["assignmentMinutes","assignmentDates"].forEach(key => {
      const mapping = task[key] || {};
      if (Object.prototype.hasOwnProperty.call(mapping,oldName)) {
        mapping[newName] = mapping[oldName];
        delete mapping[oldName];
        task[key] = mapping;
      }
    });
  });
  dayStatuses.forEach(status => {if (status.person === oldName) status.person = newName;});
}
function convertEmployeeAssignmentsForRole(name,oldRole,newRole,newCountsCapacity=true){
  if (oldRole === newRole) return;
  if (newRole === "Admin") {
    tasks.filter(task => task.type === "milestone" && (task.assigned || []).includes(name)).forEach(task => {
      task.assigned = (task.assigned || []).filter(employee => employee !== name);
      if (task.assignmentMinutes) delete task.assignmentMinutes[name];
      if (task.assignmentDates) delete task.assignmentDates[name];
    });
    const additions = [];
    tasks.filter(task => task.type === "capacity" && (task.assigned || []).includes(name)).forEach(task => {
      const shares = materialiseAssignmentMinutes(task);
      const share = Math.max(0,Number(shares[name] || 0));
      const assignmentDate = (task.assignmentDates || {})[name] || task.date;
      task.assigned = (task.assigned || []).filter(employee => employee !== name);
      if (task.assignmentMinutes) delete task.assignmentMinutes[name];
      if (task.assignmentDates) delete task.assignmentDates[name];
      task.duration = Math.max(0,Number(task.duration || 0)-share);
      task.estimatedHours = Number(task.duration || 0)/60;
      if (share > 0) additions.push({...task,id:`${task.id}-admin-${Date.now()}-${additions.length}`,type:"admin",department:"Admin",adminEmployee:name,duration:share,estimatedHours:share/60,assigned:[name],assignmentMinutes:{[name]:share},assignmentDates:{[name]:assignmentDate},date:assignmentDate,endDate:assignmentDate,parts:[]});
    });
    tasks = tasks.filter(task => !(task.type === "capacity" && Number(task.duration || 0) <= 0 && !(task.assigned || []).length));
    tasks.push(...additions);
  } else if (oldRole === "Admin") {
    const adminTasks = tasks.filter(task => task.type === "admin" && ((task.assigned || []).includes(name) || task.adminEmployee === name));
    if (!newCountsCapacity) {
      adminTasks.forEach(adminTask => {
        adminTask.type = "milestone";
        adminTask.department = "Milestone";
        adminTask.adminEmployee = undefined;
        adminTask.duration = 0;
        adminTask.estimatedHours = 0;
        adminTask.assigned = [name];
        adminTask.assignmentMinutes = {};
        adminTask.assignmentDates = {[name]:adminTask.date};
        adminTask.showOnCalendar = false;
        adminTask.parts = [];
      });
      return;
    }
    adminTasks.forEach(adminTask => {
      const stageDepartment = adminTask.stageDepartment || newRole;
      let capacityTask = tasks.find(task => task.type === "capacity" && task.job === adminTask.job && (task.stageGroup || task.name) === (adminTask.stageGroup || adminTask.name) && (task.stageDepartment || task.department) === stageDepartment);
      if (!capacityTask) {
        capacityTask = {...adminTask,id:`${adminTask.id}-capacity`,type:"capacity",department:stageDepartment,adminEmployee:undefined,duration:0,estimatedHours:0,assigned:[],assignmentMinutes:{},assignmentDates:{},showOnCalendar:false,parts:[]};
        tasks.push(capacityTask);
      }
      const share = Math.max(0,Number(adminTask.duration || 0));
      capacityTask.assigned = [...new Set([...(capacityTask.assigned || []),name])];
      capacityTask.assignmentMinutes = {...(capacityTask.assignmentMinutes || {}),[name]:share};
      capacityTask.assignmentDates = {...(capacityTask.assignmentDates || {}),[name]:adminTask.date};
      capacityTask.duration = Number(capacityTask.duration || 0)+share;
      capacityTask.estimatedHours = Number(capacityTask.duration || 0)/60;
    });
    const adminIds = new Set(adminTasks.map(task => task.id));
    tasks = tasks.filter(task => !adminIds.has(task.id));
  }
}
function employeeAssignmentCount(name){
  return tasks.filter(task => (task.assigned || []).includes(name) || task.adminEmployee === name).length;
}
function saveEmployee(){
  if (!isAdmin) return;
  const nameInput = document.getElementById("employeeNameInput");
  const newName = nameInput.value.trim();
  if (!newName) {
    showToast("Enter an employee name");
    nameInput.focus();
    return;
  }

  let p = people.find(x => x.name === selectedEmployeeName);
  const duplicate = people.find(x => x !== p && x.name.toLowerCase() === newName.toLowerCase());
  if (duplicate) {
    showToast("That employee name already exists");
    nameInput.focus();
    return;
  }

  const isNewEmployee = !p;
  if (!p) {
    p = {name:"", role:"Cabinet Making", countsCapacity:true, workPattern:"Standard", week:{Mon:460,Tue:460,Wed:460,Thu:460,Fri:340}};
  }

  const oldName = p.name;
  const oldRole = p.role;
  const oldCountsCapacity = employeeCountsCapacity(p);
  const newRole = document.getElementById("employeeRoleInput").value;
  const newCountsCapacity = newRole !== "Admin" && document.getElementById("employeeCountsCapacity").checked;
  if (oldName && oldCountsCapacity && !newCountsCapacity && oldRole !== "Admin") {
    const linked = tasks.filter(task => task.type === "capacity" && (task.assigned || []).includes(oldName)).length;
    if (linked) {showToast(`Reassign ${linked} capacity task${linked === 1 ? "" : "s"} before making this employee non-capacity.`); return;}
  }
  if (oldName && !oldCountsCapacity && newCountsCapacity) {
    const linked = tasks.filter(task => task.type === "milestone" && (task.assigned || []).includes(oldName)).length;
    if (linked) {showToast(`Remove this employee from ${linked} calendar-only task${linked === 1 ? "" : "s"} before making them capacity.`); return;}
  }
  const standardWeek = getStandardWeekFromInputs();
  const customWeek1 = getCustomWeekInputs("w1");
  const customWeek2 = getCustomWeekInputs("w2");
  const rosterValues = [...Object.values(standardWeek),...Object.values(customWeek1),...Object.values(customWeek2)];
  if (rosterValues.some(value => !Number.isFinite(value) || value < 0 || value > 24*60)) {
    showToast("Enter roster hours as values such as 7h40, 8h or 7.5.");
    return;
  }
  p.name = newName;
  p.role = newRole;
  p.countsCapacity = newCountsCapacity;
  p.workPattern = currentEmployeePattern();
  p.week = standardWeek;
  p.week1 = customWeek1;
  p.week2 = customWeek2;
  p.customStart = document.getElementById("customStartInput").value || "2026-06-08";

  if (oldName && oldName !== p.name) renameEmployeeReferences(oldName,p.name);
  if (oldName) convertEmployeeAssignmentsForRole(p.name,oldRole,newRole,newCountsCapacity);
  if (isNewEmployee) people.push(p);

  selectedEmployeeName = p.name;
  closeEmployeePanel();
  renderAll();
  saveState("Employee saved");
}
function removeEmployee(){
  if (!isAdmin) return;
  if (!selectedEmployeeName) return;
  const assignmentCount = employeeAssignmentCount(selectedEmployeeName);
  if (assignmentCount) {showToast(`Reassign or delete ${assignmentCount} linked task${assignmentCount === 1 ? "" : "s"} before removing this employee.`); return;}
  if (!confirm(`Remove ${selectedEmployeeName}?`)) return;
  people = people.filter(p => p.name !== selectedEmployeeName);
  dayStatuses = dayStatuses.filter(status => status.person !== selectedEmployeeName);
  closeEmployeePanel();
  renderAll();
  saveState("Employee removed");
}

/* Weekly bulk overtime overrides */
function currentScheduleWeekDates(){
  return Array.from({length:7},(_,index)=>dateForDayIndex(index));
}
function openCapacityOverridePanel(){
  if(!isAdmin) return;
  const weekDates=currentScheduleWeekDates();
  const weekStart=weekDates[0],weekEnd=weekDates[6];
  const label=document.getElementById("capacityOverrideWeekLabel");
  if(label) label.textContent=`${weekStart.toLocaleDateString("en-AU",{day:"numeric",month:"short"})} – ${weekEnd.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
  document.getElementById("capacityOverrideAmount").value="2h";
  const capacityPeople=people.filter(employeeCountsCapacity);
  document.getElementById("capacityOverrideEmployees").innerHTML=capacityPeople.map(person=>`<div class="employee-choice"><label><input type="checkbox" data-capacity-override-person="${escapeHtml(person.name)}"><strong>${escapeHtml(person.name)}</strong></label><span>${escapeHtml(person.role)}</span></div>`).join("") || `<div class="note">No capacity employees available.</div>`;
  document.getElementById("capacityOverrideDays").innerHTML=weekDates.map((dateObj,index)=>{
    const checked=index < 5 ? "checked" : "";
    const dayName=dateObj.toLocaleDateString("en-AU",{weekday:"short"});
    const dayDate=dateObj.toLocaleDateString("en-AU",{day:"numeric"});
    return `<label class="overtime-day-option" title="${escapeHtml(dateObj.toLocaleDateString("en-AU",{weekday:"long",day:"numeric",month:"long"}))}"><input type="checkbox" data-capacity-override-day="${index}" ${checked}><span class="overtime-day-chip">${escapeHtml(dayName)} ${escapeHtml(dayDate)}</span></label>`;
  }).join("");
  openPanel("capacityOverridePanel");
}
function setCapacityOverrideEmployees(checked){
  document.querySelectorAll("#capacityOverrideEmployees input[data-capacity-override-person]").forEach(input=>{input.checked=checked;});
}
function selectedCapacityOverridePeople(){
  return [...document.querySelectorAll("#capacityOverrideEmployees input[data-capacity-override-person]:checked")].map(input=>input.dataset.capacityOverridePerson).filter(Boolean);
}
function selectedCapacityOverrideDayIndexes(){
  return [...document.querySelectorAll("#capacityOverrideDays input[data-capacity-override-day]:checked")].map(input=>Number(input.dataset.capacityOverrideDay)).filter(index=>Number.isInteger(index) && index>=0 && index<7);
}
function applyCapacityOverrides(){
  if(!isAdmin) return;
  const names=selectedCapacityOverridePeople();
  if(!names.length){showToast("Select at least one employee.");return;}
  const dayIndexes=selectedCapacityOverrideDayIndexes();
  if(!dayIndexes.length){showToast("Select at least one day.");return;}
  const amountText=String(document.getElementById("capacityOverrideAmount")?.value || "").trim().toLowerCase();
  const minutes=parseHours(amountText);
  if(!amountText || !Number.isFinite(minutes) || minutes <= 0 || minutes > 12*60){showToast("Enter overtime such as 1h, 1h30 or 2h.");return;}
  names.forEach(name=>{
    const person=people.find(item=>item.name===name);if(!person) return;
    if(!person.capacityOverrides || typeof person.capacityOverrides !== "object") person.capacityOverrides={};
    dayIndexes.forEach(index=>{
      const dateObj=dateForDayIndex(index),iso=toIsoDate(dateObj);
      person.capacityOverrides[iso]=Math.min(24*60,Math.round(normalCapacityForDate(person,dateObj)+minutes));
    });
  });
  closeCapacityOverridePanel();renderAll();saveState("Overtime applied");
}
function resetCapacityOverrides(){
  if(!isAdmin) return;
  const names=selectedCapacityOverridePeople();
  if(!names.length){showToast("Select at least one employee.");return;}
  const dayIndexes=selectedCapacityOverrideDayIndexes();
  if(!dayIndexes.length){showToast("Select at least one day.");return;}
  names.forEach(name=>{
    const person=people.find(item=>item.name===name);if(!person?.capacityOverrides) return;
    dayIndexes.forEach(index=>delete person.capacityOverrides[toIsoDate(dateForDayIndex(index))]);
  });
  closeCapacityOverridePanel();renderAll();saveState("Overtime cleared");
}

/* Panels and scroll */
function openPanel(panelId){
  closeAllPanels(false);
  document.getElementById("panelBackdrop").classList.add("open");
  document.getElementById(panelId).classList.add("open");
}
function closeTaskPanel(closeBackdrop=true){document.getElementById("taskPanel").classList.remove("open"); if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open")}
function closeTaskDetailsPanel(closeBackdrop=true){document.getElementById("taskDetailsPanel").classList.remove("open"); if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open")}
function closeDayPanel(closeBackdrop=true){document.getElementById("dayPanel").classList.remove("open"); if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open")}
function closeEmployeePanel(closeBackdrop=true){document.getElementById("employeePanel").classList.remove("open"); if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open")}
function closeCapacityOverridePanel(closeBackdrop=true){document.getElementById("capacityOverridePanel").classList.remove("open"); if(closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open")}
function closeAllPanels(closeBackdrop=true){
  document.getElementById("taskPanel").classList.remove("open");
  document.getElementById("taskDetailsPanel").classList.remove("open");
  document.getElementById("dayPanel").classList.remove("open");
  document.getElementById("statusPanel").classList.remove("open");
  document.getElementById("employeePanel").classList.remove("open");
  document.getElementById("capacityOverridePanel").classList.remove("open");
  if (closeBackdrop) document.getElementById("panelBackdrop").classList.remove("open");
}
function syncFloatingScrollWidth(){
  const planner=document.getElementById("planner"),plannerHeader=document.getElementById("plannerHeader"),floatScroll=document.getElementById("floatScroll"),inner=document.getElementById("floatScrollInner");
  if(!planner || !floatScroll || !inner) return;
  inner.style.width=Math.max(planner.scrollWidth,planner.clientWidth+1)+"px";
  const scheduleActive=document.getElementById("scheduleView")?.classList.contains("active");
  floatScroll.style.display=scheduleActive && planner.scrollWidth > planner.clientWidth+2 ? "block" : "none";
  floatScroll.scrollLeft=planner.scrollLeft;if(plannerHeader) plannerHeader.scrollLeft=planner.scrollLeft;
}
function setupScrollSync(){
  const planner=document.getElementById("planner"),plannerHeader=document.getElementById("plannerHeader"),floatScroll=document.getElementById("floatScroll");
  if(!planner || !floatScroll) return;let locking=false;
  const syncFrom=(source,targetA,targetB)=>{if(locking)return;locking=true;if(targetA)targetA.scrollLeft=source.scrollLeft;if(targetB)targetB.scrollLeft=source.scrollLeft;locking=false;};
  planner.addEventListener("scroll",()=>syncFrom(planner,floatScroll,plannerHeader));floatScroll.addEventListener("scroll",()=>syncFrom(floatScroll,planner,plannerHeader));plannerHeader?.addEventListener("scroll",()=>syncFrom(plannerHeader,planner,floatScroll));
}

function showToast(message){
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}
