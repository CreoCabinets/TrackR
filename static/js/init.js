function parseUiArgs(element,eventType){
  const key=`${eventType}Args`;
  const raw=element.dataset[key];
  if(!raw) return [];
  try{
    const parsed=JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  }catch(error){
    console.error(`Invalid ${eventType} action arguments`,raw,error);
    return [];
  }
}
function invokeUiAction(element,eventType,event){
  const action=element.dataset[`${eventType}Action`];
  if(!action) return;
  const fn=window[action];
  if(typeof fn !== "function"){
    console.error(`Unknown UI action: ${action}`);
    return;
  }
  if(element.dataset.stopPropagation === "true") event.stopPropagation();
  if(element.dataset.preventDefault === "true") event.preventDefault();
  const args=parseUiArgs(element,eventType);
  if(element.dataset[`${eventType}PassValue`] === "true") args.push(element.value);
  try{
    const result=fn(...args);
    if(result && typeof result.catch === "function") result.catch(error=>{console.error(error);showToast(error?.message || "Action failed");});
  }catch(error){
    console.error(error);
    showToast(error?.message || "Action failed");
  }
}
function setupUiActions(){
  document.addEventListener("click",event=>{
    const element=event.target.closest("[data-click-action]");
    if(element) invokeUiAction(element,"click",event);
  });
  document.addEventListener("change",event=>{
    const element=event.target.closest("[data-change-action]");
    if(element) invokeUiAction(element,"change",event);
  });
  document.addEventListener("input",event=>{
    const element=event.target.closest("[data-input-action]");
    if(element) invokeUiAction(element,"input",event);
  });
}

setupUiActions();
setupScrollSync();
setupAddJobPdfDrop();
showView("home");
loadSavedState();
