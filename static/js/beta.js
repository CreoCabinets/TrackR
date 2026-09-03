let betaWeekStartDate = startOfWeek(new Date());

function deliveryReadyCurrent(task){
  if(!task?.deliveryReady || !isDeliveryTask(task)) return false;
  const deliveryDate=toIsoDate(taskDate(task));
  return task.deliveryReady.deliveryDate === deliveryDate && !!task.deliveryReady.confirmedAt;
}
function deliveryRequiredReadyDate(task){
  const deliveryDate=taskDate(task);
  return deliveryDate ? addBusinessDays(deliveryDate,-1) : null;
}
function deliveryProductionTasks(deliveryTask){
  if(!deliveryTask) return [];
  return tasks.filter(task =>
    String(task.job) === String(deliveryTask.job) &&
    task.id !== deliveryTask.id &&
    task.type === "capacity" &&
    !isDeliveryTask(task) &&
    !isInstallTask(task)
  );
}
function deliveryTasksForWeek(weekStart=betaWeekStartDate){
  const startIso=toIsoDate(weekStart);
  const endIso=toIsoDate(addCalendarDays(weekStart,6));
  return tasks
    .filter(task => {
      if(!calendarTaskVisible(task) || !isDeliveryTask(task)) return false;
      const iso=toIsoDate(taskDate(task));
      return iso >= startIso && iso <= endIso;
    })
    .sort((a,b) => toIsoDate(taskDate(a)).localeCompare(toIsoDate(taskDate(b))) || String(a.job).localeCompare(String(b.job)));
}
function deliveryReadinessStatus(task,today=new Date()){
  const production=deliveryProductionTasks(task);
  const incomplete=production.filter(item => item.status !== "Complete");
  const readyBy=deliveryRequiredReadyDate(task);
  const todayIso=toIsoDate(today);
  const readyIso=toIsoDate(readyBy);
  if(deliveryReadyCurrent(task)) return {key:"ready",label:"READY",incomplete,production,readyBy};
  if(!incomplete.length) return {key:"confirm",label:"READY TO CONFIRM",incomplete,production,readyBy};
  if(todayIso > readyIso) return {key:"overdue",label:"NOT READY",incomplete,production,readyBy};
  if(todayIso === readyIso) return {key:"due",label:"DUE TODAY",incomplete,production,readyBy};
  return {key:"upcoming",label:"UPCOMING",incomplete,production,readyBy};
}
function betaWeekLabel(){
  const end=addCalendarDays(betaWeekStartDate,6);
  const sameMonth=betaWeekStartDate.getMonth()===end.getMonth() && betaWeekStartDate.getFullYear()===end.getFullYear();
  if(sameMonth) return `${betaWeekStartDate.toLocaleDateString("en-AU",{day:"numeric"})}-${end.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
  return `${betaWeekStartDate.toLocaleDateString("en-AU",{day:"numeric",month:"short"})} - ${end.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
}
function betaDateLabel(dateObj){
  return dateObj ? dateObj.toLocaleDateString("en-AU",{weekday:"short",day:"numeric",month:"short"}) : "-";
}
function betaConfirmationLabel(task){
  if(!deliveryReadyCurrent(task)) return "";
  const confirmedAt=new Date(task.deliveryReady.confirmedAt);
  const when=Number.isNaN(confirmedAt.getTime()) ? "" : confirmedAt.toLocaleString("en-AU",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});
  const by=task.deliveryReady.confirmedBy || "Admin";
  return `Confirmed by ${by}${when ? ` - ${when}` : ""}`;
}
function betaProductionProgress(status){
  return {text:status.production.length && !status.incomplete.length ? "Completed" : "Not completed"};
}
function renderBeta(){
  if(!isAdmin) return;
  const rows=document.getElementById("betaDeliveryRows");
  if(!rows) return;
  const deliveries=deliveryTasksForWeek();
  const statuses=deliveries.map(task=>({task,status:deliveryReadinessStatus(task)}));
  const ready=statuses.filter(item=>item.status.key === "ready").length;
  const urgent=statuses.filter(item=>["overdue","due"].includes(item.status.key)).length;
  const awaiting=statuses.length-ready;
  const weekLabel=betaWeekLabel();
  const range=document.getElementById("betaWeekLabel");
  if(range) range.textContent=`Week ${weekLabel}`;
  const printMeta=document.getElementById("betaPrintMeta");
  if(printMeta) printMeta.textContent=`Delivery Readiness - Week ${weekLabel} - Printed ${new Date().toLocaleString("en-AU",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"})}`;
  const totalEl=document.getElementById("betaDeliveryCount");
  const readyEl=document.getElementById("betaReadyCount");
  const actionEl=document.getElementById("betaActionCount");
  const urgentEl=document.getElementById("betaUrgentCount");
  if(totalEl) totalEl.textContent=String(deliveries.length);
  if(readyEl) readyEl.textContent=String(ready);
  if(actionEl) actionEl.textContent=String(awaiting);
  if(urgentEl) urgentEl.textContent=String(urgent);
  if(!statuses.length){
    rows.innerHTML=`<div class="beta-empty"><strong>No deliveries this week</strong><span>TrakR could not find any Calendar delivery tasks between ${escapeHtml(weekLabel)}.</span></div>`;
    return;
  }
  rows.innerHTML=statuses.map(({task,status})=>{
    const job=jobById(task.job);
    const progress=betaProductionProgress(status);
    const confirmed=betaConfirmationLabel(task);
    const action=status.key === "ready"
      ? `<button class="beta-undo" data-click-action="undoDeliveryReady" data-click-args='${escapeHtml(JSON.stringify([task.id]))}'>Undo Ready</button>`
      : `<button class="primary" data-click-action="confirmDeliveryReady" data-click-args='${escapeHtml(JSON.stringify([task.id]))}'>${status.incomplete.length ? "Confirm Ready Anyway" : "Confirm Ready"}</button>`;
    return `<article class="beta-delivery-card beta-status-${status.key}">
      <div class="beta-delivery-main">
        <div class="beta-delivery-date"><span>Delivery</span><strong>${escapeHtml(betaDateLabel(taskDate(task)))}</strong></div>
        <div class="beta-delivery-job"><div class="beta-job-title">${escapeHtml(task.job)}</div><div class="beta-job-address">${escapeHtml(job?.address || "No address")}</div>${job?.builder ? `<div class="beta-job-builder">${escapeHtml(job.builder)}</div>` : ""}</div>
        <div class="beta-ready-by"><span>Must be ready</span><strong>${escapeHtml(betaDateLabel(status.readyBy))}</strong></div>
        <div class="beta-production"><span>Production</span><strong>${escapeHtml(progress.text)}</strong></div>
        <div class="beta-status-wrap"><span class="beta-status beta-status-pill-${status.key}">${escapeHtml(status.label)}</span>${status.key === "ready" ? `<small>${escapeHtml(confirmed)}</small>` : ""}</div>
      </div>
      <div class="beta-delivery-actions"><button data-click-action="openTaskPanel" data-click-args='${escapeHtml(JSON.stringify([task.id]))}'>Open Delivery</button>${action}</div>
    </article>`;
  }).join("");
}
function changeBetaWeek(direction){
  betaWeekStartDate=addCalendarDays(betaWeekStartDate,Number(direction||0)*7);
  renderBeta();
}
function goBetaCurrentWeek(){
  betaWeekStartDate=startOfWeek(new Date());
  renderBeta();
}
async function confirmDeliveryReady(taskId){
  if(!isAdmin) return;
  const task=tasks.find(item=>item.id===taskId);
  if(!task || !isDeliveryTask(task)) return;
  const status=deliveryReadinessStatus(task);
  if(status.incomplete.length){
    const names=status.incomplete.slice(0,4).map(item=>item.name).join(", ");
    const extra=status.incomplete.length>4 ? ` and ${status.incomplete.length-4} more` : "";
    if(!window.confirm(`${status.incomplete.length} production task${status.incomplete.length===1?" is":"s are"} still marked incomplete (${names}${extra}). Confirm this delivery is ready anyway?`)) return;
  }
  task.deliveryReady={
    deliveryDate:toIsoDate(taskDate(task)),
    confirmedAt:new Date().toISOString(),
    confirmedBy:String(currentUser.username || "Admin")
  };
  renderBeta();
  await queueStateSave("Delivery confirmed ready");
}
async function undoDeliveryReady(taskId){
  if(!isAdmin) return;
  const task=tasks.find(item=>item.id===taskId);
  if(!task?.deliveryReady) return;
  if(!window.confirm(`Mark ${task.job} as not ready again?`)) return;
  delete task.deliveryReady;
  renderBeta();
  await queueStateSave("Delivery ready confirmation removed");
}
function printBetaDeliveryReport(){
  if(!isAdmin) return;
  renderBeta();
  window.print();
}
