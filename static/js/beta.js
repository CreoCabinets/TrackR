let betaWeekStartDate = startOfWeek(new Date());

function deliveryReadyCurrent(task){
  if(!task?.deliveryReady || !isDeliveryTask(task)) return false;
  const deliveryDate=toIsoDate(scheduledTaskDate(task));
  return task.deliveryReady.deliveryDate === deliveryDate && !!task.deliveryReady.confirmedAt;
}
function deliveryRequiredReadyDate(task){
  const deliveryDate=scheduledTaskDate(task);
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
  // BETA follows the Schedule, not the Calendar/planned task date. calculate()
  // materialises each capacity task into task.parts after capacity/spillover.
  calculate();
  const startIso=toIsoDate(weekStart);
  const endIso=toIsoDate(addCalendarDays(weekStart,6));
  return tasks
    .filter(task => {
      if(task.type !== "capacity" || !isDeliveryTask(task)) return false;
      const iso=toIsoDate(scheduledTaskDate(task));
      return iso >= startIso && iso <= endIso;
    })
    .sort((a,b) => toIsoDate(scheduledTaskDate(a)).localeCompare(toIsoDate(scheduledTaskDate(b))) || String(a.job).localeCompare(String(b.job)));
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
function betaWeekLabel(weekStart=betaWeekStartDate){
  const end=addCalendarDays(weekStart,6);
  const sameMonth=weekStart.getMonth()===end.getMonth() && weekStart.getFullYear()===end.getFullYear();
  if(sameMonth) return `${weekStart.toLocaleDateString("en-AU",{day:"numeric"})}-${end.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
  return `${weekStart.toLocaleDateString("en-AU",{day:"numeric",month:"short"})} - ${end.toLocaleDateString("en-AU",{day:"numeric",month:"short",year:"numeric"})}`;
}
function betaWeekContextLabel(weekStart=betaWeekStartDate,today=new Date()){
  const currentWeek=startOfWeek(today);
  const offset=Math.round(calendarDayDifference(currentWeek,weekStart)/7);
  if(offset === 0) return "THIS WEEK";
  if(offset === 1) return "NEXT WEEK";
  if(offset === -1) return "LAST WEEK";
  if(offset > 1) return `${offset} WEEKS AHEAD`;
  return `${Math.abs(offset)} WEEKS AGO`;
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
  const weekContext=betaWeekContextLabel();
  const range=document.getElementById("betaWeekLabel");
  const context=document.getElementById("betaWeekContext");
  const thisWeekBtn=document.getElementById("betaThisWeekBtn");
  if(range) range.textContent=weekLabel;
  if(context) context.textContent=weekContext;
  if(thisWeekBtn){
    const current=weekContext === "THIS WEEK";
    thisWeekBtn.classList.toggle("active",current);
    thisWeekBtn.setAttribute("aria-pressed",String(current));
  }
  const totalEl=document.getElementById("betaDeliveryCount");
  const readyEl=document.getElementById("betaReadyCount");
  const actionEl=document.getElementById("betaActionCount");
  const urgentEl=document.getElementById("betaUrgentCount");
  if(totalEl) totalEl.textContent=String(deliveries.length);
  if(readyEl) readyEl.textContent=String(ready);
  if(actionEl) actionEl.textContent=String(awaiting);
  if(urgentEl) urgentEl.textContent=String(urgent);
  if(!statuses.length){
    rows.innerHTML=`<div class="beta-empty"><strong>No deliveries this week</strong><span>TrakR could not find any scheduled Delivery tasks between ${escapeHtml(weekLabel)}.</span></div>`;
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
        <div class="beta-delivery-date"><span>Delivery</span><strong>${escapeHtml(betaDateLabel(scheduledTaskDate(task)))}</strong></div>
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
  calculate();
  const task=tasks.find(item=>item.id===taskId);
  if(!task || !isDeliveryTask(task)) return;
  const status=deliveryReadinessStatus(task);
  if(status.incomplete.length){
    const names=status.incomplete.slice(0,4).map(item=>item.name).join(", ");
    const extra=status.incomplete.length>4 ? ` and ${status.incomplete.length-4} more` : "";
    if(!window.confirm(`${status.incomplete.length} production task${status.incomplete.length===1?" is":"s are"} still marked incomplete (${names}${extra}). Confirm this delivery is ready anyway?`)) return;
  }
  task.deliveryReady={
    deliveryDate:toIsoDate(scheduledTaskDate(task)),
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
function buildBetaPrintReportHtml(){
  const deliveries=deliveryTasksForWeek();
  const statuses=deliveries.map(task=>({task,status:deliveryReadinessStatus(task)}));
  const ready=statuses.filter(item=>item.status.key === "ready").length;
  const urgent=statuses.filter(item=>["overdue","due"].includes(item.status.key)).length;
  const weekLabel=betaWeekLabel();
  const weekContext=betaWeekContextLabel();
  const printed=new Date().toLocaleString("en-AU",{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"});
  const rows=statuses.map(({task,status})=>{
    const job=jobById(task.job);
    const production=betaProductionProgress(status).text;
    const confirmed=deliveryReadyCurrent(task);
    const confirmation=confirmed ? betaConfirmationLabel(task) : status.label;
    const builder=job?.builder ? `<div class="subline">${escapeHtml(job.builder)}</div>` : "";
    return `<tr class="status-${escapeHtml(status.key)}">
      <td class="delivery"><strong>${escapeHtml(betaDateLabel(scheduledTaskDate(task)))}</strong></td>
      <td class="job"><strong>${escapeHtml(task.job)}</strong></td>
      <td class="address"><strong>${escapeHtml(job?.address || "No address")}</strong>${builder}</td>
      <td class="ready-by"><strong>${escapeHtml(betaDateLabel(status.readyBy))}</strong></td>
      <td class="production"><span class="production-${production === "Completed" ? "done" : "open"}">${escapeHtml(production)}</span></td>
      <td class="confirmation"><div class="ready-line"><span class="ready-box ${confirmed ? "checked" : ""}">${confirmed ? "&#10003;" : ""}</span><strong>${confirmed ? "READY" : escapeHtml(confirmation)}</strong></div>${confirmed ? `<div class="subline">${escapeHtml(betaConfirmationLabel(task))}</div>` : ""}</td>
    </tr>`;
  }).join("");
  const table=statuses.length ? `<table class="delivery-table">
    <colgroup><col style="width:13%"><col style="width:11%"><col style="width:31%"><col style="width:15%"><col style="width:14%"><col style="width:16%"></colgroup>
    <thead><tr><th>Delivery</th><th>Job</th><th>Address / Builder</th><th>Must be ready</th><th>Production</th><th>Ready</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<div class="empty-report">No Delivery tasks are scheduled for ${escapeHtml(weekLabel)}.</div>`;
  const title=`TrakR Delivery Readiness - ${weekLabel}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>
    @page{size:A4 landscape;margin:8mm}
    *{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    html,body{margin:0;padding:0;background:#fff;color:#142235;font-family:Arial,Helvetica,sans-serif}
    body{font-size:8.8pt}
    .report-header{display:flex;align-items:flex-end;justify-content:space-between;gap:12mm;border-bottom:2.5px solid #17324d;padding-bottom:3.5mm;margin-bottom:3.5mm}
    .brand{font-size:10pt;font-weight:900;letter-spacing:.12em;color:#17324d;text-transform:uppercase}
    h1{margin:1mm 0 0;font-size:19pt;line-height:1.05;letter-spacing:-.02em;color:#0f2438}
    .week{text-align:right}.week-label{font-size:8pt;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#607184}.week strong{display:block;margin-top:1mm;font-size:13pt;color:#0f2438}.printed{margin-top:1mm;font-size:7.5pt;color:#68778a}
    .summary{display:flex;gap:3mm;margin:0 0 3.5mm}.summary-item{display:flex;align-items:baseline;gap:1.5mm;border:1px solid #d6e0e6;border-radius:2mm;background:#f7f9fa;padding:2mm 3mm}.summary-item span{font-size:7pt;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#68778a}.summary-item strong{font-size:11pt;color:#0f2438}
    .delivery-table{width:100%;border-collapse:collapse;table-layout:fixed;border:1px solid #c5d0d7}
    .delivery-table thead{display:table-header-group}
    .delivery-table th{background:#17324d;color:#fff;padding:2.2mm 2mm;text-align:left;font-size:7.2pt;font-weight:900;letter-spacing:.055em;text-transform:uppercase;border-right:1px solid rgba(255,255,255,.18)}
    .delivery-table th:last-child{border-right:0}
    .delivery-table tbody tr{break-inside:avoid;page-break-inside:avoid}
    .delivery-table td{padding:2.5mm 2mm;vertical-align:middle;border-bottom:1px solid #d5dde2;border-right:1px solid #e3e8eb;line-height:1.25}
    .delivery-table td:last-child{border-right:0}.delivery-table tbody tr:last-child td{border-bottom:0}
    .delivery-table td strong{font-size:8.6pt}.job strong{font-size:10pt}.address strong{font-size:8.4pt}
    .subline{margin-top:.8mm;font-size:6.8pt;line-height:1.25;color:#667787}
    .status-ready{background:#f0f8f2}.status-due{background:#fff9e8}.status-overdue{background:#fff0ed}.status-confirm{background:#f4f8ff}
    .production-done{font-weight:900;color:#25663f}.production-open{font-weight:900;color:#a33a2b}
    .ready-line{display:flex;align-items:center;gap:1.5mm}.ready-line strong{font-size:7.5pt!important;line-height:1.1}
    .ready-box{display:inline-flex;align-items:center;justify-content:center;width:4.2mm;height:4.2mm;flex:0 0 4.2mm;border:1.3px solid #6f7d87;border-radius:.8mm;background:#fff;font-size:9pt;font-weight:900;line-height:1}.ready-box.checked{border-color:#2f7b4b;background:#e8f5ec;color:#25663f}
    .empty-report{border:1px solid #ccd6dc;background:#f7f9fa;padding:12mm;text-align:center;font-size:11pt;font-weight:700;color:#68778a}
    .footer{margin-top:3mm;padding-top:2mm;border-top:1px solid #d8e0e5;color:#68778a;font-size:6.8pt;display:flex;justify-content:space-between;gap:8mm}
  </style></head><body>
    <header class="report-header"><div><div class="brand">TrakR</div><h1>Delivery Readiness - Floor Report</h1></div><div class="week"><div class="week-label">${escapeHtml(weekContext)}</div><strong>${escapeHtml(weekLabel)}</strong><div class="printed">Printed ${escapeHtml(printed)}</div></div></header>
    <div class="summary"><div class="summary-item"><span>Deliveries</span><strong>${statuses.length}</strong></div><div class="summary-item"><span>Confirmed ready</span><strong>${ready}</strong></div><div class="summary-item"><span>Due / overdue</span><strong>${urgent}</strong></div></div>
    ${table}
    <footer class="footer"><span>Delivery dates are taken from the calculated TrakR Schedule.</span><span>Ready confirmations are recorded in TrakR.</span></footer>
  </body></html>`;
}
function printBetaDeliveryReport(){
  if(!isAdmin) return;
  const reportWindow=window.open("","trakrDeliveryReadinessReport","width=1200,height=800");
  if(!reportWindow){
    showToast("Print window blocked. Allow pop-ups for TrakR and try again.");
    return;
  }
  reportWindow.document.open();
  reportWindow.document.write(buildBetaPrintReportHtml());
  reportWindow.document.close();
  reportWindow.onafterprint=()=>{try{reportWindow.close();}catch(_error){}};
  window.setTimeout(()=>{
    try{
      reportWindow.focus();
      reportWindow.print();
    }catch(_error){
      showToast("Could not open the print dialog.");
    }
  },150);
}
