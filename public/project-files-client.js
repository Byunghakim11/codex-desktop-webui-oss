import { authenticatedUrl } from "./access-auth.js";

export function projectDownloadUrl(query,authMode,base=globalThis.location?.origin) {
  if(authMode!=="cloudflare-access")return null;
  const url=new URL("/api/project-files/download",base);
  for(const key of ["threadId","path","rootRevision"])url.searchParams.set(key,query[key]);
  return url.pathname+url.search;
}
export function createProjectFilesClient({getToken,getAuthMode,fetchImpl=globalThis.fetch}) {
  let singlePreview=true;
  return {
    async openPreview(query,signal) {
      if(!singlePreview)return this.get("preview",query,signal);
      const params=new URLSearchParams();for(const [key,value]of Object.entries(query))if(value!=null)params.set(key,value);
      const response=await fetchImpl(authenticatedUrl(`/api/project-files/preview-open?${params}`,getToken()),{credentials:"same-origin",cache:"no-store",redirect:"manual",signal});
      const abandon=async()=>{try{await response.body?.cancel();}catch{/* An already consumed/aborted body may be locked. */}};
      if(response.status===404){await abandon();singlePreview=false;return this.get("preview",query,signal);}
      if(response.type==="opaqueredirect"||[401,403].includes(response.status)){await abandon();throw Object.assign(new Error("FILE_ACCESS_REQUIRED"),{status:response.status||401});}
      if(!response.ok){await abandon();throw Object.assign(new Error("PREVIEW_UNAVAILABLE"),{status:response.status});}
      const type=(response.headers.get("content-type")||"").split(";")[0];
      if(type==="application/json")return response.json();
      try {
      const header=response.headers.get("x-codex-preview")||"";if(header.length>512)throw new Error("PREVIEW_UNAVAILABLE");
      const meta=JSON.parse(header),valid=meta.kind==="pdf"?type==="application/pdf":["image/png","image/jpeg","image/gif"].includes(type)&&meta.kind==="image";
      if(!valid||meta.mime!==type||!Number.isSafeInteger(meta.size)||meta.size<0||meta.size>(meta.kind==="pdf"?25:20)*1048576)throw new Error("PREVIEW_UNAVAILABLE");
      const blob=await response.blob();if(blob.size!==meta.size)throw Object.assign(new Error("FILE_CHANGED"),{status:409});return {...meta,blob};
      }catch(error){await abandon();if(error.name==="AbortError")throw error;throw Object.assign(new Error("PREVIEW_UNAVAILABLE"),{status:error.status});}
    },
    async get(action,query,signal) {
      const params=new URLSearchParams();for(const [key,value]of Object.entries(query))if(value!=null)params.set(key,value);
      const response=await fetchImpl(authenticatedUrl(`/api/project-files/${action}?${params}`,getToken()),{credentials:"same-origin",cache:"no-store",redirect:"manual",signal});
      if(response.type==="opaqueredirect"||[401,403].includes(response.status))throw Object.assign(new Error("FILE_ACCESS_REQUIRED"),{status:response.status||401});
      if(!response.ok) {const value=await response.json().catch(()=>({}));throw Object.assign(new Error(value.error||"FILES_UNAVAILABLE"),{status:response.status});}
      if(action==="content") {const blob=await response.blob();if(blob.size>(blob.type==="application/pdf"?25:20)*1048576)throw new Error("PREVIEW_TOO_LARGE");return blob;}
      return response.json();
    },
    downloadUrl:query=>projectDownloadUrl(query,getAuthMode()),
    async downloadTicket(query,signal){
      const response=await fetchImpl(authenticatedUrl("/api/project-files/download-ticket",getToken()),{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"manual",headers:{"Content-Type":"application/json","X-Codex-Files":"1"},body:JSON.stringify(query),signal});
      if(response.type==="opaqueredirect"||!response.ok)throw Object.assign(new Error("DOWNLOAD_UNAVAILABLE"),{status:response.type==="opaqueredirect"?401:response.status});
      const result=await response.json(),base=globalThis.location?.origin||"http://localhost",url=new URL(result.url,base);
      if(url.origin!==base||url.pathname!=="/api/project-files/download"||![...url.searchParams.keys()].every(key=>key==="ticket")||!/^[\w-]{32}$/.test(url.searchParams.get("ticket")||"")||url.hash)throw new Error("DOWNLOAD_UNAVAILABLE");
      return url.pathname+url.search;
    }
  };
}
