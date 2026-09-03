/* Schedule */
function renderSchedule(){
  buildScheduleDays();
  updateScheduleDayWidth();
  const result=calculate();
  const query=searchValue("scheduleSearch");
  const rangeStart=dateForDayIndex(0);
  const rangeEnd=dateForDayIndex(days.length-1);
  document.getElementById("scheduleRangeLabel").textContent=`${rangeStart.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})} – ${rangeEnd.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
  const today=new Date();
  document.getElementById("daysHeader").innerHTML=`<div class="corner">Employees</div>`+days.map(day=>{
    const dateObj=parseIsoDate(day.iso);const isToday=isSameDate(dateObj,today);const closure=globalCalendarEventForDate(dateObj);
    return `<div class="day-head ${day.working ? "" : "weekend"} ${isToday ? "today" : ""} ${closure ? "closed" : ""}" title="${closure ? escapeHtml(closure.name) : ""}"><span class="day-cap">${closure ? "Closed" : isToday ? "Today" : day.working ? "Work" : "Off"}</span><div class="day-name">${day.name}<span class="day-date">${day.date}</span></div></div>`;
  }).join("");
  const rows=document.getElementById("rows");rows.innerHTML="";
  const rowNames=people.filter(employeeCountsCapacity).filter(person=>{
    if(!query) return true;
    return normaliseSearch(`${person.name} ${person.role}`).includes(query) || tasks.some(task=>(task.assigned || []).includes(person.name) && taskMatchesQuery(task,query));
  }).map(person=>person.name);
  const matchingUnassigned=tasks.some(task=>task.type === "capacity" && !(task.assigned || []).length && taskMatchesQuery(task,query));
  if(matchingUnassigned) rowNames.unshift("Unassigned");
  rowNames.forEach(rowName=>{
    const isUnassignedRow=rowName === "Unassigned";
    const person=people.find(item=>item.name === rowName);
    const encodedRowName=encodeURIComponent(rowName);
    const rowMatchesQuery=query && normaliseSearch(`${rowName} ${person?.role || ""}`).includes(query);
    const rowTasks=tasks.filter(task=>(!query || rowMatchesQuery || taskMatchesQuery(task,query)) && (task.parts || []).some(part=>part.person === rowName && part.day >= 0 && part.day < days.length));
    const compactLayout=buildCompactScheduleLaneItems(rowTasks,rowName);
    const laneItems=compactLayout.items;
    const laneCount=compactLayout.laneCount;
    const lanePitch=54;
    const row=document.createElement("div");row.className="row";row.dataset.person=rowName;row.style.minHeight=`${Math.max(124,56+laneCount*lanePitch+16)}px`;
    row.innerHTML=`<div class="person" data-click-action="openDayPanel" data-click-args='${escapeHtml(JSON.stringify([rowName,0]))}' ><strong>${escapeHtml(rowName)}</strong><span>${isUnassignedRow ? "Needs assignment" : escapeHtml(person.role)}</span></div>${days.map((day,index)=>{
      if(isUnassignedRow){
        const count=tasks.filter(task=>task.type === "capacity" && !(task.assigned || []).length && scheduleIndexForDate(taskDate(task)) === index && taskMatchesQuery(task,query)).length;
        return `<div class="cell ${day.working ? "" : "weekend"}" data-person="Unassigned" data-day="${index}" data-click-action="openDayPanel" data-click-args='["Unassigned",${index}]' ><span class="badge ${count ? "tight" : "off"}">${count ? `${count} waiting` : "None"}</span></div>`;
      }
      const dateObj=dateForDayIndex(index),blockedStatus=blockedStatusForDate(rowName,dateObj),calendarEvent=globalCalendarEventForDate(dateObj);
      const cap=capacityFor(person,index),booked=(result.used[rowName] && result.used[rowName][index]) || 0,over=booked > cap+1;
      const override=capacityOverrideForDate(person,dateObj),normalCap=normalCapacityForDate(person,dateObj);
      const adjusted=override !== null,adjustmentLabel=adjusted ? (override > normalCap ? "OT" : "Adj") : "";
      const rosteredOff=day.working && !blockedStatus && !calendarEvent && cap === 0,isTodayCell=isSameDate(dateObj,today);
      const badgeClass=over ? "over" : calendarEvent && !adjusted ? "closure" : blockedStatus ? String(blockedStatus.type || "").toLowerCase() : rosteredOff ? "rdo" : booked >= cap-10 ? "tight" : "";
      const badgeText=calendarEvent && !booked && !adjusted ? calendarEvent.name : blockedStatus && !booked ? blockedStatus.type : rosteredOff && !booked && !adjusted ? "RDO" : `${fmt(booked)} / ${fmt(cap)}${adjustmentLabel ? ` · ${adjustmentLabel}` : ""}${over ? ` · +${fmt(booked-cap)}` : ""}`;
      const cellTitle=[adjusted ? `${adjustmentLabel === "OT" ? "Overtime" : "Adjusted"} availability: ${fmt(cap)}` : "",over ? `Over capacity by ${fmt(booked-cap)}` : "",calendarEvent ? calendarEvent.name : ""].filter(Boolean).join(" · ");
      return `<div class="cell ${day.working ? "" : "weekend"} ${calendarEvent ? "calendar-event-day" : ""} ${blockedStatus ? "blocked-day" : ""} ${rosteredOff ? "rostered-off" : ""} ${over ? "over-capacity" : ""} ${adjusted ? "capacity-adjusted" : ""} ${isTodayCell ? "today" : ""}" data-person="${escapeHtml(rowName)}" data-day="${index}" data-click-action="openDayPanel" data-click-args='${escapeHtml(JSON.stringify([rowName,index]))}'  title="${escapeHtml(cellTitle)}"><span class="badge ${badgeClass}">${escapeHtml(badgeText)}</span></div>`;
    }).join("")}<div class="bars"></div>`;
    const bars=row.querySelector(".bars");
    laneItems.forEach(item=>{
      const relevantParts=(item.task.parts || []).filter(part=>part.person === rowName && part.day >= item.start && part.day < item.start+item.span);
      const minutes=relevantParts.reduce((sum,part)=>sum+part.minutes,0);
      const over=!isUnassignedRow && relevantParts.some(part=>((result.used[rowName] || [])[part.day] || 0) > capacityFor(person,part.day)+1);
      const detailsRequired=taskNeedsDetails(item.task);
      const bar=document.createElement("div");
      bar.className=`bar ${typeColour(item.task)} ${(item.task.assigned || []).length > 1 ? "split" : ""} ${over ? "over-capacity" : ""} ${detailsRequired ? "details-required" : ""}`;
      bar.style.left=`${item.start*scheduleDayWidth+10}px`;bar.style.width=`${Math.max(96,item.span*scheduleDayWidth-20)}px`;bar.style.top=`${56+item.lane*lanePitch}px`;
      const metaBits=[fmt(minutes)];
      if((item.task.assigned || []).length > 1) metaBits.push("Split");
      if(over) metaBits.push("Over capacity");
      if(detailsRequired) metaBits.push("Details required");
      bar.innerHTML=`<span class="dot"></span><span class="bar-copy"><span class="bar-main">${escapeHtml(taskLabel(item.task))}</span><span class="bar-meta">${escapeHtml(metaBits.join(" · "))}</span></span>`;
      bar.title=`${taskLabel(item.task)} · ${fmt(minutes)}${detailsRequired ? " · Details required" : ""}${over ? " · Over capacity" : ""} · Drag to move`;
      bar.setAttribute("aria-label",`Edit ${taskLabel(item.task)}`);
      bar.dataset.taskId=item.task.id;
      bar.dataset.person=rowName;
      bar.draggable=false;
      if(isAdmin){
        bar.addEventListener("click",event=>{event.stopPropagation();if(Date.now()<scheduleSuppressClickUntil) return;openTaskPanel(item.task.id);});
        bar.addEventListener("pointerdown",event=>beginSchedulePointerDrag(event,bar,item.task,rowName));
      }
      bars.appendChild(bar);
    });rows.appendChild(row);
  });
  if(!rowNames.length) rows.innerHTML=`<div class="search-empty">No employees or tasks match this search.</div>`;
  if(!isAdmin){rows.querySelectorAll("[data-click-action]").forEach(element=>element.removeAttribute("data-click-action"));rows.querySelectorAll("[draggable]").forEach(element=>{element.draggable=false;element.removeAttribute("draggable");});}
  syncFloatingScrollWidth();
}

function clearDropClasses(){document.querySelectorAll(".cell").forEach(cell => cell.classList.remove("drop-active"));document.querySelectorAll("#rows .bar.reorder-before,#rows .bar.reorder-after").forEach(bar=>bar.classList.remove("reorder-before","reorder-after"));}
function highlightScheduleDropCell(cell){
  if(!cell) return;
  document.querySelectorAll("#rows .cell.drop-active").forEach(other=>{if(other!==cell) other.classList.remove("drop-active");});
  cell.classList.add("drop-active");
}
function scheduleCellAtPointer(row,clientX){
  const cells=[...row.querySelectorAll(".cell")];
  if(!cells.length) return null;
  const exact=cells.find(cell=>{const rect=cell.getBoundingClientRect();return clientX>=rect.left && clientX<rect.right;});
  if(exact) return exact;
  const firstRect=cells[0].getBoundingClientRect(),lastRect=cells[cells.length-1].getBoundingClientRect();
  if(clientX<firstRect.left) return cells[0];
  if(clientX>=lastRect.right) return cells[cells.length-1];
  return null;
}
function scheduleRowAtPointer(clientY){
  const rows=[...document.querySelectorAll("#rows .row")];
  if(!rows.length) return null;
  const exact=rows.find(row=>{const rect=row.getBoundingClientRect();return clientY>=rect.top && clientY<=rect.bottom;});
  if(exact) return exact;
  let nearest=null,nearestDistance=Infinity;
  rows.forEach(row=>{
    const rect=row.getBoundingClientRect();
    const distance=clientY<rect.top ? rect.top-clientY : clientY>rect.bottom ? clientY-rect.bottom : 0;
    if(distance<nearestDistance){nearest=row;nearestDistance=distance;}
  });
  return nearestDistance<=36 ? nearest : null;
}
function scheduleReorderTargetAtPointer(row,clientX,clientY,draggedTaskId){
  if(!row) return null;
  const bars=[...row.querySelectorAll(".bar")].filter(bar=>bar.dataset.taskId && bar.dataset.taskId!==draggedTaskId && !bar.classList.contains("dragging"));
  const direct=bars.filter(bar=>{const rect=bar.getBoundingClientRect();return clientX>=rect.left && clientX<=rect.right && clientY>=rect.top-5 && clientY<=rect.bottom+5;});
  if(!direct.length) return null;
  direct.sort((a,b)=>Math.abs(clientY-(a.getBoundingClientRect().top+a.getBoundingClientRect().height/2))-Math.abs(clientY-(b.getBoundingClientRect().top+b.getBoundingClientRect().height/2)));
  const bar=direct[0],rect=bar.getBoundingClientRect();
  return {bar,task:tasks.find(task=>task.id===bar.dataset.taskId) || null,before:clientY<rect.top+rect.height/2};
}
function createScheduleDragGhost(bar,event){
  const rect=bar.getBoundingClientRect();
  const ghost=bar.cloneNode(true);
  const width=Math.min(Math.max(180,rect.width),420);
  ghost.classList.remove("dragging","reorder-before","reorder-after");
  ghost.classList.add("schedule-drag-ghost");
  ghost.style.width=`${width}px`;
  ghost.style.height=`${rect.height}px`;
  document.body.appendChild(ghost);
  return {ghost,width,grabX:Math.min(Math.max(18,event.clientX-rect.left),width-18),grabY:Math.min(Math.max(8,event.clientY-rect.top),rect.height-8)};
}
function beginSchedulePointerDrag(event,bar,task,rowName){
  if(!isAdmin || event.button!==0 || schedulePointerDrag) return;
  if(scheduleMoveSaving){showToast("Wait for the current Schedule move to finish saving.");return;}
  const rect=bar.getBoundingClientRect();
  const sourceRow=bar.closest(".row"),sourceCell=sourceRow ? scheduleCellAtPointer(sourceRow,event.clientX) : null;
  schedulePointerDrag={pointerId:event.pointerId,bar,task,sourcePerson:rowName,sourceDay:sourceCell ? Number(sourceCell.dataset.day) : null,startX:event.clientX,startY:event.clientY,clientX:event.clientX,clientY:event.clientY,active:false,targetCell:null,reorderTarget:null,before:true,ghost:null,ghostWidth:0,grabX:event.clientX-rect.left,grabY:event.clientY-rect.top};
  try{bar.setPointerCapture(event.pointerId);}catch(_){ }
  bar.addEventListener("pointermove",onSchedulePointerMove);
  bar.addEventListener("pointerup",onSchedulePointerUp);
  bar.addEventListener("pointercancel",onSchedulePointerCancel);
}
function activateSchedulePointerDrag(event){
  const drag=schedulePointerDrag;
  if(!drag || drag.active) return;
  drag.active=true;
  currentDragTask=drag.task;currentDragPerson=drag.sourcePerson;
  const ghostInfo=createScheduleDragGhost(drag.bar,event);
  drag.ghost=ghostInfo.ghost;drag.ghostWidth=ghostInfo.width;drag.grabX=ghostInfo.grabX;drag.grabY=ghostInfo.grabY;
  drag.bar.classList.add("dragging");
  document.getElementById("planner")?.classList.add("schedule-dragging");
  scheduleSuppressClickUntil=Date.now()+700;
}
function onSchedulePointerMove(event){
  const drag=schedulePointerDrag;
  if(!drag || event.pointerId!==drag.pointerId) return;
  drag.clientX=event.clientX;drag.clientY=event.clientY;
  if(!drag.active){
    if(Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)<6) return;
    activateSchedulePointerDrag(event);
  }
  event.preventDefault();
  if(!schedulePointerFrame) schedulePointerFrame=requestAnimationFrame(refreshSchedulePointerDrag);
}
function refreshSchedulePointerDrag(){
  schedulePointerFrame=0;
  const drag=schedulePointerDrag;
  if(!drag || !drag.active) return;
  if(drag.ghost) drag.ghost.style.transform=`translate3d(${Math.round(drag.clientX-drag.grabX)}px,${Math.round(drag.clientY-drag.grabY)}px,0)`;
  const planner=document.getElementById("planner");
  let scrolled=false;
  if(planner){
    const rect=planner.getBoundingClientRect(),edge=72;
    let dx=0;
    if(drag.clientX<rect.left+edge) dx=-Math.ceil(Math.min(24,(rect.left+edge-drag.clientX)/3));
    else if(drag.clientX>rect.right-edge) dx=Math.ceil(Math.min(24,(drag.clientX-(rect.right-edge))/3));
    if(dx){const before=planner.scrollLeft;planner.scrollLeft=Math.max(0,planner.scrollLeft+dx);scrolled=scrolled || before!==planner.scrollLeft;}
  }
  const verticalEdge=64;
  let dy=0;
  if(drag.clientY<verticalEdge) dy=-Math.ceil(Math.min(18,(verticalEdge-drag.clientY)/3));
  else if(drag.clientY>window.innerHeight-verticalEdge) dy=Math.ceil(Math.min(18,(drag.clientY-(window.innerHeight-verticalEdge))/3));
  if(dy){window.scrollBy(0,dy);scrolled=true;}
  updateSchedulePointerTarget(drag.clientX,drag.clientY);
  if(scrolled && schedulePointerDrag) schedulePointerFrame=requestAnimationFrame(refreshSchedulePointerDrag);
}
function updateSchedulePointerTarget(clientX,clientY){
  const drag=schedulePointerDrag;
  if(!drag || !drag.active) return;
  clearDropClasses();
  const row=scheduleRowAtPointer(clientY);
  const cell=row ? scheduleCellAtPointer(row,clientX) : null;
  drag.targetCell=cell;
  drag.reorderTarget=null;
  drag.before=true;
  if(cell) highlightScheduleDropCell(cell);
  const target=scheduleReorderTargetAtPointer(row,clientX,clientY,drag.task.id);
  if(target && target.task){
    drag.reorderTarget=target.task;
    drag.before=target.before;
    target.bar.classList.toggle("reorder-before",target.before);
    target.bar.classList.toggle("reorder-after",!target.before);
  }
}
function cleanupSchedulePointerDrag(){
  const drag=schedulePointerDrag;
  if(!drag) return;
  drag.bar.removeEventListener("pointermove",onSchedulePointerMove);
  drag.bar.removeEventListener("pointerup",onSchedulePointerUp);
  drag.bar.removeEventListener("pointercancel",onSchedulePointerCancel);
  try{if(drag.bar.hasPointerCapture?.(drag.pointerId)) drag.bar.releasePointerCapture(drag.pointerId);}catch(_){ }
  drag.bar.classList.remove("dragging");
  drag.ghost?.remove();
  document.getElementById("planner")?.classList.remove("schedule-dragging");
  clearDropClasses();
  if(schedulePointerFrame){cancelAnimationFrame(schedulePointerFrame);schedulePointerFrame=0;}
  schedulePointerDrag=null;currentDragTask=null;currentDragPerson=null;
}
function onSchedulePointerUp(event){
  const drag=schedulePointerDrag;
  if(!drag || event.pointerId!==drag.pointerId) return;
  const active=drag.active,task=drag.task,sourcePerson=drag.sourcePerson,sourceDay=drag.sourceDay,cell=drag.targetCell,reorderTarget=drag.reorderTarget,before=drag.before;
  if(active){event.preventDefault();event.stopPropagation();scheduleSuppressClickUntil=Date.now()+700;}
  cleanupSchedulePointerDrag();
  if(active && cell) moveTaskToCell(task,cell,sourcePerson,reorderTarget,before,sourceDay);
}
function onSchedulePointerCancel(event){
  if(!schedulePointerDrag || event.pointerId!==schedulePointerDrag.pointerId) return;
  cleanupSchedulePointerDrag();
}
function materialiseAssignmentMinutes(task){
  const names = [...new Set((task.assigned || []).filter(Boolean))];
  const existing = task.assignmentMinutes || {};
  const total = Math.max(0,Number(task.duration || 0));
  if (!names.length) return {};
  const hasCustom = names.some(name => existing[name] != null);
  if (hasCustom) return Object.fromEntries(names.map(name => [name,Math.max(0,Number(existing[name])||0)]));
  const base = Math.floor(total / names.length);
  let remainder = total - (base * names.length);
  return Object.fromEntries(names.map(name => {
    const share = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    return [name,share];
  }));
}
function materialiseAssignmentDates(task){
  const names = [...new Set((task.assigned || []).filter(Boolean))];
  const existing = task.assignmentDates || {};
  const fallback = toIsoDate(taskDate(task));
  return Object.fromEntries(names.map(name => [name,existing[name] || fallback]));
}
function moveScheduleOrderKey(task,sourcePerson,newPerson){
  const current={...(task.scheduleOrder || {})};
  const previous=sourcePerson ? current[sourcePerson] : undefined;
  if(sourcePerson) delete current[sourcePerson];
  if(newPerson && newPerson !== "Unassigned"){
    if(previous != null && current[newPerson] == null) current[newPerson]=previous;
  }
  task.scheduleOrder=current;
}
function reassignDraggedShare(task,sourcePerson,newPerson,newDate){
  const assigned = [...new Set((task.assigned || []).filter(Boolean))];
  const shares = materialiseAssignmentMinutes(task);
  const dates = materialiseAssignmentDates(task);
  const newIso = toIsoDate(newDate || taskDate(task));
  if (!newPerson) {
    moveScheduleOrderKey(task,sourcePerson,"");
    task.assigned = [];
    task.assignmentMinutes = {};
    task.assignmentDates = {};
    return true;
  }
  if (assigned.length > 1 && sourcePerson && assigned.includes(sourcePerson)) {
    if (sourcePerson !== newPerson) {
      if (assigned.includes(newPerson)) {
        showToast(`${newPerson} already has a separate share of this stage.`);
        return false;
      }
      const movedMinutes = Math.max(0,Number(shares[sourcePerson])||0);
      delete shares[sourcePerson];
      delete dates[sourcePerson];
      task.assigned = assigned.map(name => name === sourcePerson ? newPerson : name);
      moveScheduleOrderKey(task,sourcePerson,newPerson);
      shares[newPerson] = movedMinutes;
      dates[newPerson] = newIso;
    } else {
      task.assigned = assigned;
      dates[sourcePerson] = newIso;
    }
    task.assignmentMinutes = Object.fromEntries(task.assigned.map(name => [name,Math.max(0,Number(shares[name])||0)]));
    task.assignmentDates = Object.fromEntries(task.assigned.map(name => [name,dates[name] || newIso]));
    return true;
  }
  const total = Object.values(shares).reduce((sum,value)=>sum+Math.max(0,Number(value)||0),0) || Math.max(0,Number(task.duration || 0));
  moveScheduleOrderKey(task,sourcePerson,newPerson);
  task.assigned = [newPerson];
  task.assignmentMinutes = {[newPerson]:total};
  task.assignmentDates = {[newPerson]:newIso};
  return true;
}
async function moveTaskToCell(task,cell,sourcePerson=currentDragPerson,reorderTarget=null,before=true,sourceDay=null){
  const newDay=Number(cell.dataset.day),newPerson=cell.dataset.person,newDate=dateForDayIndex(newDay);
  if(!task || task.type !== "capacity" || newPerson === "Milestones"){showToast("Only capacity tasks can be moved here.");return;}
  if(scheduleMoveSaving){showToast("Wait for the current Schedule move to finish saving.");return;}
  scheduleMoveSaving=true;
  setScheduleSaveStatus("Saving move…","saving");
  try{
    const independentShare=(task.assigned || []).length > 1 && sourcePerson && (task.assigned || []).includes(sourcePerson);
    const priorityOnly=!!reorderTarget && sourcePerson === newPerson && sourceDay != null && Number(sourceDay) === newDay;
    if(!priorityOnly){
      if(independentShare){const moved=reassignDraggedShare(task,sourcePerson,newPerson === "Unassigned" ? "" : newPerson,newDate);if(!moved){renderAll();return;}}
      else{setTaskDate(task,newDate);reassignDraggedShare(task,sourcePerson,newPerson === "Unassigned" ? "" : newPerson,newDate);}
    }
    if(reorderTarget && newPerson !== "Unassigned" && reorderTarget.id !== task.id){
      setScheduleOrderRelative(task,reorderTarget,newPerson,before);
    }
    renderAll();
    const action=priorityOnly ? "Task priority updated" : reorderTarget ? "Task moved and reprioritised" : (independentShare ? "Employee share moved" : "Task moved");
    const saved=await queueStateSave(action);
    if(!saved){
      setScheduleSaveStatus("Move not saved","error");
      showToast(lastStateSaveConflict ? "Move not saved. Latest TrackR data has been reloaded." : "Move failed. Unsaved workspace changes were rolled back.");
      return;
    }
    setScheduleSaveStatus("Saved","saved");
  }finally{
    scheduleMoveSaving=false;
  }
}


function wireScheduleDrops(){
  // Schedule uses pointer-driven dragging rather than the browser's native
  // HTML drag events. This keeps movement smooth and makes manual ordering
  // deterministic even when several jobs occupy the same day.
}
