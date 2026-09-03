/* Calendar */
function openCalendarDayFromGrid(year,month,day){
  if(!calendarDragSuppressClick) openDayTaskPanel(year,month,day);
}
function openCalendarEventsSettings(){
  showSettingsSection("calendarEvents");
  showView("settings");
}
function renderCalendar(){
  const grid = document.getElementById("monthGrid");
  // Calendar is always a full Monday-Sunday view. Keep this inline so no later layout rule can collapse it to five columns.
  grid.style.gridTemplateColumns = "repeat(7, minmax(0, 1fr))";
  const monthDate = new Date(calendarBaseDate.getFullYear(), calendarBaseDate.getMonth() + visibleMonthOffset, 1);
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  document.getElementById("monthTitle").textContent = monthDate.toLocaleString("en-AU", {month:"long", year:"numeric"});
  const calendarQuery = searchValue("calendarSearch");
  const firstDay = new Date(year,month,1);
  const firstGridDate = new Date(firstDay);
  const mondayOffset = (firstDay.getDay() + 6) % 7;
  firstGridDate.setDate(firstDay.getDate() - mondayOffset);

  const headers = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day => `<div class="month-head">${day}</div>`).join("");
  let cells = "";
  for (let i=0;i<42;i++){
    const d = new Date(firstGridDate);
    d.setDate(firstGridDate.getDate()+i);
    const inMonth = d.getMonth() === month;
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const now = new Date();
    const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const items = tasks.filter(task => {
      if (!calendarTaskVisible(task) || !taskMatchesQuery(task,calendarQuery)) return false;
      const taskDate = task.date ? parseIsoDate(task.date) : new Date(baseYear,baseMonth,task.monthDay);
      return taskDate && taskDate.getFullYear() === d.getFullYear() && taskDate.getMonth() === d.getMonth() && taskDate.getDate() === d.getDate();
    });
    const closure = globalCalendarEventForDate(d);
    cells += `<div class="month-day ${inMonth ? "" : "outside"} ${isWeekend ? "weekend" : ""} ${isToday ? "today" : ""} ${closure ? "closed-day" : ""}" data-date="${toIsoDate(d)}" data-click-action="openCalendarDayFromGrid" data-click-args='[${d.getFullYear()},${d.getMonth()},${d.getDate()}]' >
      <div class="month-day-number">${d.getDate()}</div>
      ${closure ? `<div class="month-item closure" data-click-action="openCalendarEventsSettings" data-stop-propagation="true"><div class="month-item-title">${escapeHtml(closure.name)}</div><div class="month-item-sub">${escapeHtml(closure.type)}</div></div>` : ``}
      ${items.map(task => {
        const job = jobById(task.job);
        const lower = task.name.toLowerCase();
        const cls = task.type === "admin" ? "admin" : lower.includes("install") ? "install" : lower.includes("stone") ? "stone" : lower.includes("check") ? "check" : "";
        const assignee = task.type === "admin" ? ((task.assigned || [])[0] || task.adminEmployee || "Admin") : (task.assigned || []).join(", ");
        const calendarKind = task.type === "capacity" ? "Capacity" : "";
        const detailsRequired = taskNeedsDetails(task);
        const subtitle = [detailsRequired ? "⚠ Details required" : "",task.stoneMason ? `Stone: ${task.stoneMason}` : "",assignee,calendarKind,job?.builder,job ? job.address : ""].filter(Boolean).join(" · ");
        return `<div class="month-item ${cls} ${detailsRequired?"details-required":""}" draggable="true" data-task-id="${escapeHtml(task.id)}" data-task-type="${escapeHtml(task.type)}" data-job-id="${escapeHtml(encodeURIComponent(task.job))}">
          <div class="month-item-title">${escapeHtml(task.job)} · ${escapeHtml(task.name)}</div>
          <div class="month-item-sub">${escapeHtml(subtitle)}</div>
        </div>`;
      }).join("")}
    </div>`;
  }
  grid.innerHTML = headers + cells;
  grid.querySelectorAll(".month-item[data-task-id]").forEach(item => item.addEventListener("click", event => {
    event.stopPropagation();
    if (calendarDragSuppressClick) return;
    if (item.dataset.taskType === "admin" && isAdmin) openEditJob(decodeURIComponent(item.dataset.jobId));
    else openTaskPanel(item.dataset.taskId);
  }));
  if (isAdmin) {
    wireCalendarDrops();
  } else {
    grid.querySelectorAll("[onclick]").forEach(element => {element.onclick = null; element.removeAttribute("onclick");});
    grid.querySelectorAll("[draggable]").forEach(element => {element.draggable = false; element.removeAttribute("draggable");});
  }
}
function clearCalendarDropClasses(){
  document.querySelectorAll("#monthGrid .month-day").forEach(day => day.classList.remove("calendar-drop-active"));
}
function syncInstallDateFromTask(task){
  if (!task || !calendarTaskVisible(task) || task.name.trim().toLowerCase() !== "install") return;
  const job = jobById(task.job);
  const dateObj = parseIsoDate(task.date);
  if (!job || !dateObj) return;
  job.installDate = toIsoDate(dateObj);
  job.install = dateObj.toLocaleDateString("en-AU",{day:"numeric",month:"short"});
}
function setTaskDate(task,newDate){
  if (!task || !newDate) return;
  const oldDate = taskDate(task);
  const delta = oldDate ? calendarDayDifference(oldDate,newDate) : 0;
  task.start = legacyIndexForDate(newDate);
  task.monthDay = newDate.getDate();
  task.date = toIsoDate(newDate);
  const oldEnd = parseIsoDate(task.endDate);
  if (oldEnd) task.endDate = toIsoDate(addCalendarDays(oldEnd,delta));
  if (task.assignmentDates) {
    task.assignmentDates = Object.fromEntries(Object.entries(task.assignmentDates).map(([name,iso]) => {
      const assignmentDate = parseIsoDate(iso);
      return [name, assignmentDate ? toIsoDate(addCalendarDays(assignmentDate,delta)) : toIsoDate(newDate)];
    }));
  }
  syncInstallDateFromTask(task);
}
function moveCalendarTaskToDate(task, isoDate){
  const newDate = parseIsoDate(isoDate);
  if (!task || !newDate) return;
  setTaskDate(task,newDate);
  renderAll();
  saveState("Calendar task moved and saved");
}
function wireCalendarDrops(){
  document.querySelectorAll("#monthGrid .month-item").forEach(item => {
    item.addEventListener("dragstart", event => {
      const task = tasks.find(candidate => candidate.id === item.dataset.taskId);
      if (!task) {event.preventDefault(); return;}
      calendarDragTask = task;
      calendarDragSuppressClick = true;
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      calendarDragTask = null;
      clearCalendarDropClasses();
      setTimeout(() => {calendarDragSuppressClick = false;}, 180);
    });
  });
  document.querySelectorAll("#monthGrid .month-day").forEach(day => {
    day.addEventListener("dragover", event => {
      if (!calendarDragTask) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      clearCalendarDropClasses();
      day.classList.add("calendar-drop-active");
    });
    day.addEventListener("drop", event => {
      if (!calendarDragTask) return;
      event.preventDefault();
      event.stopPropagation();
      const task = calendarDragTask;
      calendarDragTask = null;
      clearCalendarDropClasses();
      moveCalendarTaskToDate(task, day.dataset.date);
      setTimeout(() => {calendarDragSuppressClick = false;}, 180);
    });
    day.addEventListener("dragleave", event => {
      if (!day.contains(event.relatedTarget)) day.classList.remove("calendar-drop-active");
    });
  });
}
function changeMonth(delta){visibleMonthOffset += delta; renderCalendar()}
function goToday(){visibleMonthOffset = 0; renderCalendar()}
