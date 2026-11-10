export const COMPANION_DEFAULTS = Object.freeze({mirror:"",hermes:""});

export function safeCompanionUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}

export function companionShortcut(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.editing || event.repeat) return null;
  return {"2":"mirror","3":"hermes"}[event.key] || null;
}

export function createCompanionApps({container,document:doc=document,t}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("codex-companion-urls") || "{}"); } catch {}
  const urls = Object.fromEntries(Object.entries(COMPANION_DEFAULTS).map(([key,value]) => [key,safeCompanionUrl(saved?.[key],key) || value]));
  const names = {mirror:"Mirror",hermes:"Hermes"};
  const label=(key,fallback)=>{const value=t(`apps.${key}`);return value&&value!==`apps.${key}`?value:fallback;};
  const inputs=new Map();
  const details = doc.createElement("details");details.className="companion-menu";
  const summary=doc.createElement("summary");summary.textContent=t("apps.title");details.append(summary);
  const links=doc.createElement("nav");links.setAttribute("aria-label",t("apps.title"));
  const linkNodes = new Map();
  for (const [index,key] of ["mirror","hermes"].entries()) {
    const link=doc.createElement("a");link.target="_blank";link.rel="noopener noreferrer";link.textContent=`${names[key]} ↗`;
    link.title=`Alt+${index+2}`;link.addEventListener("click",event=>{if(!urls[key]){event.preventDefault();details.open=true;inputs.get(key).focus();}else details.open=false;});
    links.append(link);linkNodes.set(key,link);
  }
  const hint=doc.createElement("small");hint.textContent=t("apps.separateLogin");
  const form=doc.createElement("form");
  for(const key of ["mirror","hermes"]){
    const field=doc.createElement("label");field.textContent=label(`${key}Url`,`${names[key]} URL`);
    const input=doc.createElement("input");input.type="url";input.placeholder="https://example.com/";input.value=urls[key];input.maxLength=2048;input.setAttribute("aria-label",field.textContent);field.append(input);inputs.set(key,input);form.append(field);
  }
  const button=doc.createElement("button");button.type="submit";button.textContent=t("apps.save");
  const status=doc.createElement("small");status.setAttribute("role","status");
  function update(){
    for(const [key,link]of linkNodes){if(urls[key]){link.href=urls[key];link.removeAttribute("aria-disabled");}else{link.removeAttribute("href");link.setAttribute("aria-disabled","true");}}
    status.textContent=Object.values(urls).some(Boolean)?label("companionConfigured","Addresses are stored only in this browser. Each app opens separately; no embedded connection is made."):label("companionUnconfigured","No companion addresses configured. Enter an address to enable each link.");
  }
  form.addEventListener("submit",event=>{
    event.preventDefault();const next={};
    for(const [key,input]of inputs){
      input.removeAttribute("aria-invalid");const value=input.value.trim(),url=value?safeCompanionUrl(value,key):"";
      if(value&&!url){input.setAttribute("aria-invalid","true");input.focus();status.textContent=label("companionInvalid","Use HTTPS without credentials, query parameters or fragments. Leave blank to disable.");return;}
      next[key]=url;
    }
    Object.assign(urls,next);let saved=true;
    try{localStorage.setItem("codex-companion-urls",JSON.stringify(urls));}catch{saved=false;}
    update();if(!saved)status.textContent=label("companionStorageUnavailable","Addresses work in this tab, but this browser could not save the preferences.");
  });
  form.append(button,status);details.append(links,hint,form);container.append(details);update();
  doc.addEventListener("keydown",event=>{
    const target=event.target;const key=companionShortcut({altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,key:event.key,isComposing:event.isComposing,repeat:event.repeat,editing:Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"]'))});
    if(!key)return;event.preventDefault();if(!urls[key]){details.open=true;inputs.get(key).focus();return;}linkNodes.get(key).click();
  });
  doc.addEventListener("click",event=>{if(!details.contains(event.target))details.open=false;});
  doc.addEventListener("keydown",event=>{if(event.key==="Escape"&&details.open){details.open=false;summary.focus();}});
  return {urls};
}
