import { authenticatedUrl } from "./access-auth.js";

const WRITE_PATHS = Object.freeze({
  context: "/api/project-files/write-context",
  mkdir: "/api/project-files/mkdir",
  editOpen: "/api/project-files/edit-open",
  saveText: "/api/project-files/save-text",
  status: "/api/project-files/write-status",
  upload: "/api/project-files/upload"
});
const WRITE_KINDS = new Set(["upload", "mkdir", "save-text", "edit-open"]);
const RESULT_KEYS = ["version", "size", "text", "editable", "bom", "eol", "reason"];
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_OPAQUE_ID = /^[A-Za-z0-9._~-]{1,256}$/;
const SAFE_STATUS = /^[a-z][a-z0-9_-]{0,31}$/;
const OPERATION_ID = /^[0-9a-f]{32}$/;
const MAX_PATH = 4096;
const MAX_TEXT = 8 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 120000;

function fail(code, status = 0, extra) {
  return Object.assign(new Error(code), { code, status }, extra);
}
function invalidArgument() { return fail("INVALID_ARGUMENT", 400); }
function invalidResponse() { return fail("INVALID_RESPONSE", 502); }
function accessRequired(status = 401) { return fail("FILE_ACCESS_REQUIRED", status || 401); }
function networkError() { return fail("NETWORK_ERROR", 0); }
function abortError() {
  if (typeof DOMException === "function") return new DOMException("Aborted", "AbortError");
  return Object.assign(new Error("Aborted"), { name: "AbortError", code: "ABORTED" });
}
function statusCode(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? `HTTP_${status}` : "FILES_UNAVAILABLE";
}
function errorFrom(status, parsed) {
  if ([401, 403].includes(status)) return accessRequired(status);
  const valid = parsed?.ok && parsed.value && typeof parsed.value.error === "string" && SAFE_ERROR_CODE.test(parsed.value.error);
  const code = valid ? parsed.value.error : statusCode(status);
  const extra = {};
  if (parsed?.ok && parsed.value && typeof parsed.value.recoveryId === "string" && SAFE_OPAQUE_ID.test(parsed.value.recoveryId)) extra.recoveryId = parsed.value.recoveryId;
  return fail(code, status, extra);
}
function pickKeys(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidArgument();
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw invalidArgument();
  return input;
}
function safePath(value, allowEmpty = false) {
  if (typeof value !== "string" || value.length > MAX_PATH) throw invalidArgument();
  if (value === "" && allowEmpty) return value;
  if (!value || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) throw invalidArgument();
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) throw invalidArgument();
  if (value.split("/").some(part => part === "" || part === "." || part === "..")) throw invalidArgument();
  return value;
}
function safeContextId(value) {
  if (typeof value !== "string" || !SAFE_OPAQUE_ID.test(value)) throw invalidArgument();
  return value;
}
function safeOperationId(value) {
  if (typeof value !== "string") throw invalidArgument();
  const normalized = value.toLowerCase();
  if (!OPERATION_ID.test(normalized)) throw invalidArgument();
  return normalized;
}
function newOperationId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && /^[0-9a-f-]{36}$/i.test(uuid)) return uuid.replace(/-/g, "").toLowerCase();
  let result = "";
  for (let index = 0; index < 32; index += 1) result += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return result;
}
function contentTypeOf(headers) {
  try { return String(headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase(); }
  catch { return ""; }
}
async function jsonBody(response) {
  if (contentTypeOf(response?.headers) !== "application/json") return { ok: false, value: null };
  try { return { ok: true, value: await response.json() }; }
  catch { return { ok: false, value: null }; }
}
function normalizeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw invalidResponse();
  const output = {};
  for (const key of RESULT_KEYS) {
    if (result[key] === undefined) continue;
    const value = result[key];
    if (key === "version") {
      if (!(typeof value === "string" || Number.isSafeInteger(value) || (value===null && result.editable===false))) throw invalidResponse();
    } else if (key === "size") {
      if (!Number.isSafeInteger(value) || value < 0) throw invalidResponse();
    } else if (key === "text") {
      if (typeof value !== "string") throw invalidResponse();
    } else if (key === "editable" || key === "bom") {
      if (typeof value !== "boolean") throw invalidResponse();
    } else if (key === "reason" && value === null) {
      // Native editable text has no restriction reason.
    } else if (key === "eol" || key === "reason") {
      if (typeof value !== "string" || value.length > 512) throw invalidResponse();
    }
    output[key] = value;
  }
  return output;
}
function normalizeWriteDto(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
    const operationId = safeOperationId(value.operationId);
    if (typeof value.status !== "string" || !SAFE_STATUS.test(value.status)) throw invalidResponse();
    if (typeof value.kind !== "string" || !WRITE_KINDS.has(value.kind)) throw invalidResponse();
    const path = safePath(value.path, true);
    const output = { operationId, status: value.status, kind: value.kind, path, result: normalizeResult(value.result) };
    if (value.recoveryId !== undefined) {
      if (typeof value.recoveryId !== "string" || !SAFE_OPAQUE_ID.test(value.recoveryId)) throw invalidResponse();
      output.recoveryId = value.recoveryId;
    }
    if (value.cached !== undefined) {
      if (typeof value.cached !== "boolean") throw invalidResponse();
      output.cached = value.cached;
    }
    return output;
  } catch (error) {
    if (error?.code === "INVALID_RESPONSE") throw error;
    throw invalidResponse();
  }
}
function normalizeContext(value) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
    if (typeof value.contextId !== "string" || !SAFE_OPAQUE_ID.test(value.contextId)) throw invalidResponse();
    if (typeof value.threadId !== "string" || !value.threadId || value.threadId.length > 256) throw invalidResponse();
    if (!(typeof value.rootRevision === "string" || Number.isSafeInteger(value.rootRevision))) throw invalidResponse();
    if (typeof value.parentPath !== "string" || value.parentPath.length > MAX_PATH) throw invalidResponse();
    if (!(typeof value.expiresAt === "string" || Number.isSafeInteger(value.expiresAt))) throw invalidResponse();
    return {
      contextId: value.contextId,
      threadId: value.threadId,
      rootRevision: value.rootRevision,
      parentPath: value.parentPath,
      expiresAt: value.expiresAt
    };
  } catch (error) {
    if (error?.code === "INVALID_RESPONSE") throw error;
    throw invalidResponse();
  }
}
function validateContextInput(input) {
  pickKeys(input, ["threadId", "rootRevision", "parentPath"]);
  if (typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 256) throw invalidArgument();
  if (!(typeof input.rootRevision === "string" || Number.isSafeInteger(input.rootRevision))) throw invalidArgument();
  if (typeof input.parentPath !== "string") throw invalidArgument();
  return { threadId: input.threadId, rootRevision: input.rootRevision, parentPath: safePath(input.parentPath, true) };
}
function validateMkdirInput(input) {
  pickKeys(input, ["contextId", "path", "operationId"]);
  return { contextId: safeContextId(input.contextId), path: safePath(input.path), ...(input.operationId!==undefined?{operationId:safeOperationId(input.operationId)}:{}) };
}
function validateEditOpenInput(input) {
  pickKeys(input, ["contextId", "path"]);
  return { contextId: safeContextId(input.contextId), path: safePath(input.path) };
}
function validateSaveTextInput(input) {
  pickKeys(input, ["contextId", "path", "text", "expectedVersion", "operationId"]);
  if (typeof input.text !== "string" || input.text.length > MAX_TEXT) throw invalidArgument();
  if (!(typeof input.expectedVersion === "string" || Number.isSafeInteger(input.expectedVersion))) throw invalidArgument();
  return {
    contextId: safeContextId(input.contextId),
    path: safePath(input.path),
    text: input.text,
    expectedVersion: input.expectedVersion,
    ...(input.operationId!==undefined?{operationId:safeOperationId(input.operationId)}:{})
  };
}
function validateStatusInput(input) {
  pickKeys(input, ["contextId", "path", "operationId", "kind"]);
  if (typeof input.kind !== "string" || !WRITE_KINDS.has(input.kind)) throw invalidArgument();
  return {
    contextId: safeContextId(input.contextId),
    path: safePath(input.path, true),
    operationId: safeOperationId(input.operationId),
    kind: input.kind
  };
}
function validateUploadInput(input) {
  pickKeys(input, ["contextId", "path", "operationId", "file", "onProgress"]);
  const file = input.file;
  if (!file || typeof file !== "object" || !Number.isSafeInteger(file.size) || file.size < 0) throw invalidArgument();
  if (input.onProgress !== undefined && typeof input.onProgress !== "function") throw invalidArgument();
  const declared = typeof file.type === "string" ? file.type.trim() : "";
  const type = declared && !/[\r\n]/.test(declared) ? declared : "application/octet-stream";
  return {
    contextId: safeContextId(input.contextId),
    path: safePath(input.path),
    operationId: safeOperationId(input.operationId),
    file,
    onProgress: input.onProgress,
    contentType: type
  };
}

export function projectDownloadUrl(query,authMode,base=globalThis.location?.origin) {
  if(authMode!=="cloudflare-access")return null;
  const url=new URL("/api/project-files/download",base);
  for(const key of ["threadId","path","rootRevision"])url.searchParams.set(key,query[key]);
  return url.pathname+url.search;
}
export function createProjectFilesClient({getToken,getAuthMode,fetchImpl=globalThis.fetch,xhrFactory=()=>new globalThis.XMLHttpRequest()}) {
  let singlePreview=true;
  const baseOrigin=()=>globalThis.location?.origin||"http://localhost";
  async function readWriteJson(response) {
    if(response.type==="opaqueredirect")throw accessRequired(401);
    const status=Number(response.status)||0;
    if([401,403].includes(status))throw accessRequired(status);
    if(!response.ok)throw errorFrom(status,await jsonBody(response));
    const parsed=await jsonBody(response);
    if(!parsed.ok)throw invalidResponse();
    return parsed.value;
  }
  async function postJson(path,body,signal) {
    let response;
    try {
      response=await fetchImpl(authenticatedUrl(path,getToken()),{
        method:"POST",
        credentials:"same-origin",
        cache:"no-store",
        redirect:"manual",
        headers:{"Content-Type":"application/json","X-Codex-Files":"1"},
        body:JSON.stringify(body),
        signal
      });
    } catch(error) {
      if(error?.name==="AbortError")throw error;
      throw networkError();
    }
    return readWriteJson(response);
  }
  function sameUploadUrl(value) {
    if(typeof value!=="string"||!value)return true;
    try {
      const base=baseOrigin(),url=new URL(value,base);
      return url.origin===new URL(base).origin&&url.pathname===WRITE_PATHS.upload&&!url.hash;
    } catch { return false; }
  }
  return {
    async recoveryDownload(input,signal) {
      const body=validateStatusInput(input), params=new URLSearchParams(body);
      const response=await fetchImpl(authenticatedUrl(`/api/project-files/write-recovery?${params}`,getToken()),{credentials:"same-origin",cache:"no-store",redirect:"error",signal});
      if(!response.ok)throw Object.assign(new Error("RECOVERY_UNAVAILABLE"),{status:response.status});
      return response.blob();
    },
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
    },
    async writeContext(input,signal) {
      const body=validateContextInput(input);
      return normalizeContext(await postJson(WRITE_PATHS.context,body,signal));
    },
    async mkdir(input,signal) {
      const body=validateMkdirInput(input);
      const operationId=body.operationId||newOperationId();
      const value=await postJson(WRITE_PATHS.mkdir,{contextId:body.contextId,path:body.path,operationId},signal);
      return normalizeWriteDto(value);
    },
    async editOpen(input,signal) {
      const body=validateEditOpenInput(input);
      const value=await postJson(WRITE_PATHS.editOpen,{contextId:body.contextId,path:body.path},signal);
      return normalizeWriteDto(value);
    },
    async saveText(input,signal) {
      const body=validateSaveTextInput(input);
      const operationId=body.operationId||newOperationId();
      const value=await postJson(WRITE_PATHS.saveText,{contextId:body.contextId,path:body.path,operationId,text:body.text,expectedVersion:body.expectedVersion},signal);
      return normalizeWriteDto(value);
    },
    async operationStatus(input,signal) {
      const body=validateStatusInput(input);
      const params=new URLSearchParams();
      params.set("contextId",body.contextId);
      params.set("path",body.path);
      params.set("operationId",body.operationId);
      params.set("kind",body.kind);
      let response;
      try {
        response=await fetchImpl(authenticatedUrl(`${WRITE_PATHS.status}?${params}`,getToken()),{credentials:"same-origin",cache:"no-store",redirect:"manual",signal});
      } catch(error) {
        if(error?.name==="AbortError")throw error;
        throw networkError();
      }
      return normalizeWriteDto(await readWriteJson(response));
    },
    uploadFile(input,signal) {
      let body;
      try { body=validateUploadInput(input); } catch(error) { return Promise.reject(error); }
      if(signal?.aborted)return Promise.reject(abortError());
      let url;
      try { url=authenticatedUrl(WRITE_PATHS.upload,getToken()); } catch { return Promise.reject(networkError()); }
      let xhr;
      try { xhr=xhrFactory(); } catch { return Promise.reject(networkError()); }
      if(!xhr||typeof xhr.open!=="function"||typeof xhr.send!=="function")return Promise.reject(networkError());
      return new Promise((resolve,reject)=>{
        let settled=false,abortListener=null;
        const cleanup=()=>{
          settled=true;
          if(abortListener&&typeof signal?.removeEventListener==="function")signal.removeEventListener("abort",abortListener);
          abortListener=null;
        };
        const succeed=value=>{ if(settled)return; cleanup(); resolve(value); };
        const failUpload=error=>{ if(settled)return; cleanup(); reject(error); };
        const readHeader=name=>{
          try { return typeof xhr.getResponseHeader==="function"?xhr.getResponseHeader(name):null; }
          catch { return null; }
        };
        try {
          xhr.open("POST",url,true);
          xhr.timeout=UPLOAD_TIMEOUT_MS;
          if(typeof xhr.setRequestHeader==="function") {
            xhr.setRequestHeader("x-codex-files","1");
            xhr.setRequestHeader("x-write-context",body.contextId);
            xhr.setRequestHeader("x-file-path",encodeURIComponent(body.path));
            xhr.setRequestHeader("x-operation-id",body.operationId);
            xhr.setRequestHeader("content-type",body.contentType);
          }
          if(xhr.upload) {
            xhr.upload.onprogress=event=>{
              if(typeof body.onProgress!=="function")return;
              try { body.onProgress({ loaded:Number(event?.loaded)||0, total:Number(event?.total)||0, lengthComputable:Boolean(event?.lengthComputable) }); }
              catch { /* Consumer progress callbacks cannot fail the transfer. */ }
            };
          }
          xhr.onload=()=>{
            try {
              if(!sameUploadUrl(xhr.responseURL)){failUpload(accessRequired(401));return;}
              const status=Number(xhr.status)||0;
              if([401,403].includes(status)){failUpload(accessRequired(status));return;}
              if(status===0){failUpload(networkError());return;}
              const type=contentTypeOf({get:name=>readHeader(name)});
              let parsed=null,valid=false;
              if(type==="application/json") {
                try { parsed=JSON.parse(String(xhr.responseText??"")); valid=true; }
                catch { valid=false; }
              }
              if(status<200||status>=300){failUpload(errorFrom(status,{ok:valid,value:parsed}));return;}
              if(!valid){failUpload(invalidResponse());return;}
              succeed(normalizeWriteDto(parsed));
            } catch {
              failUpload(invalidResponse());
            }
          };
          xhr.ontimeout=()=>failUpload(fail("UPLOAD_TIMEOUT",408));
          xhr.onerror=()=>failUpload(networkError());
          xhr.onabort=()=>failUpload(abortError());
          if(signal&&typeof signal.addEventListener==="function") {
            abortListener=()=>{ try { xhr.abort(); } catch { /* XHR may already be closed. */ } failUpload(abortError()); };
            signal.addEventListener("abort",abortListener,{once:true});
          }
          if(signal?.aborted){failUpload(abortError());return;}
          xhr.send(body.file);
        } catch {
          failUpload(networkError());
        }
      });
    }
  };
}
