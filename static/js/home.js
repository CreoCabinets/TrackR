/* Home */
function setHomeWeek(week){
  homeWeek = week;
  document.getElementById("homeThisWeek").classList.toggle("active", week === "this");
  document.getElementById("homeNextWeek").classList.toggle("active", week === "next");
  renderHome();
}
function selectedHomeWeekRange(){
  const start = addCalendarDays(startOfWeek(new Date()), homeWeek === "next" ? 7 : 0);
  return {start,end:addCalendarDays(start,6),startIso:toIsoDate(start),endIso:toIsoDate(addCalendarDays(start,6))};
}
function departmentBooked(startIso,endIso){
  calculate();
  const totals = {Drafting:0,"Cabinet Making":0,Machining:0,"Installer / Site":0};
  tasks.filter(task => task.type === "capacity").forEach(task => {
    (task.parts || []).forEach(part => {
      if (part.date >= startIso && part.date <= endIso && task.department in totals) totals[task.department] += Number(part.minutes || 0);
    });
  });
  return totals;
}
function departmentCapacity(startDate,endDate){
  const totals = {Drafting:0,"Cabinet Making":0,Machining:0,"Installer / Site":0};
  people.filter(person => employeeCountsCapacity(person) && person.role in totals).forEach(person => {
    for (let cursor = new Date(startDate); cursor <= endDate; cursor = addCalendarDays(cursor,1)) totals[person.role] += capacityForDate(person,cursor);
  });
  return totals;
}
function jobTouchesWeek(job,startIso,endIso){
  if (job.installDate && job.installDate >= startIso && job.installDate <= endIso) return true;
  return tasks.some(task => {
    if (task.job !== job.id) return false;
    if ((task.type === "milestone" || task.type === "admin") && task.date >= startIso && task.date <= endIso) return true;
    return (task.parts || []).some(part => part.date >= startIso && part.date <= endIso);
  });
}
function renderHome(){
  const range = selectedHomeWeekRange();
  const booked = departmentBooked(range.startIso,range.endIso);
  const cap = departmentCapacity(range.start,range.end);
  const d = Math.round(booked.Drafting);
  const c = Math.round(booked["Cabinet Making"]);
  const m = Math.round(booked.Machining);
  const i = Math.round(booked["Installer / Site"]);
  const totalBooked = d+c+m+i;
  const totalCap = cap.Drafting + cap["Cabinet Making"] + cap.Machining + cap["Installer / Site"];
  const dEnd = totalCap ? Math.min(360,(d/totalCap)*360) : 0;
  const cEnd = totalCap ? Math.min(360,((d+c)/totalCap)*360) : 0;
  const mEnd = totalCap ? Math.min(360,((d+c+m)/totalCap)*360) : 0;
  const iEnd = totalCap ? Math.min(360,((d+c+m+i)/totalCap)*360) : 0;
  document.getElementById("homeDonut").style.background = `conic-gradient(#4a84d8 0deg ${dEnd}deg,#3f9a63 ${dEnd}deg ${cEnd}deg,#9d62d3 ${cEnd}deg ${mEnd}deg,#e07a5f ${mEnd}deg ${iEnd}deg,#ebe7df ${iEnd}deg 360deg)`;
  document.getElementById("homeBookedTotal").textContent = fmt(totalBooked);
  document.getElementById("homeCapacityTotal").textContent = `of ${fmt(totalCap)} capacity`;
  document.getElementById("homeDrafting").textContent = `${fmt(d)} / ${fmt(cap.Drafting)}`;
  document.getElementById("homeCabinet").textContent = `${fmt(c)} / ${fmt(cap["Cabinet Making"])}`;
  document.getElementById("homeMachining").textContent = `${fmt(m)} / ${fmt(cap.Machining)}`;
  document.getElementById("homeInstaller").textContent = `${fmt(i)} / ${fmt(cap["Installer / Site"])}`;
  document.getElementById("homeJobsTitle").textContent = homeWeek === "this" ? "This week’s jobs" : "Next week’s jobs";
  const homeQuery = searchValue("homeSearch");
  const relevant = jobs.filter(job => jobTouchesWeek(job,range.startIso,range.endIso) && jobMatchesQuery(job,homeQuery));
  const container = document.getElementById("homeJobs");
  container.innerHTML = relevant.map((job, idx) => {
    const jobTasks = tasks.filter(task => task.job === job.id && ((task.date >= range.startIso && task.date <= range.endIso) || (task.parts || []).some(part => part.date >= range.startIso && part.date <= range.endIso))).slice(0,6);
    return `<div class="home-job ${idx === 0 ? "open" : ""}">
      <div class="home-job-head" data-home-toggle>
        <div><div class="home-job-title">${escapeHtml(job.id)} · ${escapeHtml(job.address)}</div><div class="home-job-sub">${escapeHtml(job.builder || "No builder/client")} · ${jobTasks.length} scheduled items · ${escapeHtml(job.status || "Active")}</div></div>
        <span>⌃</span>
      </div>
      <div class="home-job-detail">
        ${jobTasks.map(task => `<div class="mini-detail"><span>${escapeHtml(task.name)}</span><strong>${(task.assigned || []).length ? (task.assigned || []).map(escapeHtml).join(", ") : "Calendar"}</strong></div>`).join("") || `<div class="note">No scheduled items in this week.</div>`}
      </div>
    </div>`;
  }).join("") || `<div class="note">${homeQuery ? "No jobs match this search in the selected week." : "No jobs are scheduled in this week."}</div>`;
  container.querySelectorAll("[data-home-toggle]").forEach(element => element.addEventListener("click", () => element.parentElement.classList.toggle("open")));
}
