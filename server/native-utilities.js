import { authorizeThreadTarget, nativeFail, nativeFailure, assertKnownKeys, requirePlainObject, validateThreadId } from "./native-capabilities.js";
import { digestParams, digestState, principalFromScope } from "./native-confirmations.js";

const READS=new Set(["tools.mcp","tools.skills","tools.plugins","tools.apps","memory.read","plan.describe","thread.status"]);
const WRITES=new Set(["memory.enable","memory.disable","plan.set","thread.compact","review.start"]);
const bounded=(value,limit=200)=>typeof value==="string"?value.slice(0,limit):"";
const folderScoped=scope=>Boolean(scope?.threadFilterCwd||scope?.threadFilterCwds?.length);
const running=thread=>thread?.status==="active"||thread?.status?.type==="active";
const stateVersion=thread=>digestState([thread.id,thread.cwd,thread.model??null,thread.reasoningEffort??null,thread.status??null]);
export function createNativeUtilities({callNative,authorizeThread,confirmations}){
 const supports=action=>READS.has(action)||WRITES.has(action);
 const authorize=(scope,id)=>authorizeThreadTarget({authorizeThread,scope,threadId:id});
 const call=async(method,params)=>{try{return await callNative(method,params);}catch(error){throw nativeFailure(error);}};
 function validate(action,params={}){
  requirePlainObject(params);
  const allowed=action==="plan.set"?["mode","expectedModel","expectedEffort"]:action==="review.start"?["target","branch","sha"]:[];
  assertKnownKeys(params,allowed);
  if(action==="plan.set"){
   if(!["plan","default"].includes(params.mode)||typeof params.expectedModel!=="string"||!params.expectedModel||params.expectedModel.length>300
     ||(params.expectedEffort!==null&&params.expectedEffort!==undefined&&(typeof params.expectedEffort!=="string"||params.expectedEffort.length>60)))throw nativeFail(400,"INVALID_MODE");
  }
  if(action==="review.start"){
   if(!["uncommittedChanges","baseBranch","commit"].includes(params.target))throw nativeFail(400,"INVALID_REVIEW_TARGET");
   if(params.target==="baseBranch"&&(typeof params.branch!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(params.branch)||params.branch.includes("..")))throw nativeFail(400,"INVALID_BRANCH");
   if(params.target==="commit"&&(typeof params.sha!=="string"||!/^[a-f0-9]{7,64}$/i.test(params.sha)))throw nativeFail(400,"INVALID_COMMIT");
  }
  return {...params};
 }
 async function read(scope,action,thread){
  if(folderScoped(scope)&&["tools.mcp","tools.plugins","tools.apps"].includes(action))throw nativeFail(403,"THREAD_SCOPE_FORBIDDEN");
  if(action==="thread.status")return {status:thread.status,model:bounded(thread.model,300),effort:thread.reasoningEffort??null};
  if(action==="memory.read"){
   const result=await call("thread/memory/read",{threadId:thread.id});
   return {summary:result.summary===null?null:bounded(result.summary,24000)};
  }
  if(action==="plan.describe"){
   const result=await call("collaborationMode/list",{});
   return {modes:(result.data||[]).filter(row=>["plan","default"].includes(row.mode)).map(row=>({mode:row.mode,name:bounded(row.name)})),model:bounded(thread.model,300),effort:thread.reasoningEffort??null};
  }
  if(action==="tools.mcp"){
   const result=await call("mcpServerStatus/list",{limit:100});
   return {entries:(result.data||[]).slice(0,100).map(row=>({name:bounded(row.name),status:bounded(row.authStatus),tools:Object.keys(row.tools||{}).slice(0,200).map(name=>bounded(name))})),truncated:Boolean(result.nextCursor)};
  }
  if(action==="tools.skills"){
   const result=await call("skills/list",{cwds:[thread.cwd],forceReload:false});
   return {entries:(result.data||[]).flatMap(row=>(row.skills||[]).slice(0,200).map(skill=>({name:bounded(skill.name),description:bounded(skill.description,2000),enabled:skill.enabled!==false}))).slice(0,300)};
  }
  if(action==="tools.plugins"){
   const result=await call("plugin/list",{cwds:[thread.cwd],forceRefetch:false});
   return {entries:(result.marketplaces||[]).flatMap(market=>(market.plugins||[]).map(plugin=>({id:bounded(plugin.id),name:bounded(plugin.name||plugin.displayName),installed:plugin.installed===true}))).slice(0,300)};
  }
  if(action==="tools.apps"){
   const result=await call("app/list",{threadId:thread.id,limit:100,forceRefetch:false});
   return {entries:(result.data||[]).slice(0,100).map(app=>({id:bounded(app.id),name:bounded(app.name),enabled:app.isEnabled===true})),truncated:Boolean(result.nextCursor)};
  }
  throw nativeFail(400,"UNKNOWN_ACTION");
 }
 async function prepareConfirmation(scope,{action,threadId,params={}}){
  if(!WRITES.has(action))throw nativeFail(400,"CONFIRMATION_NOT_REQUIRED");validateThreadId(threadId);const normalized=validate(action,params),thread=await authorize(scope,threadId);
  if(running(thread))throw nativeFail(409,"THREAD_BUSY");
  const receipt=await confirmations.issue({principal:principalFromScope(scope),action,threadId,paramsDigest:digestParams(normalized),stateDigest:stateVersion(thread)});
  return {confirmationId:receipt.id,action,threadId,expiresAt:receipt.expiresAt};
 }
 async function execute(scope,{action,threadId,params={},confirmationId}){
  if(!supports(action))throw nativeFail(400,"UNKNOWN_ACTION");validateThreadId(threadId);const normalized=validate(action,params),thread=await authorize(scope,threadId);
  if(READS.has(action)){const result=await read(scope,action,thread);const fresh=await authorize(scope,threadId);if(fresh.cwd!==thread.cwd)throw nativeFail(409,"THREAD_CONTEXT_CHANGED");return {ok:true,action,threadId,...result};}
  if(running(thread))throw nativeFail(409,"THREAD_BUSY");
  if(!confirmationId)throw nativeFail(400,"CONFIRMATION_REQUIRED");
  await confirmations.consume({id:confirmationId,principal:principalFromScope(scope),action,threadId,paramsDigest:digestParams(normalized),stateDigest:stateVersion(thread)});
  const fresh=await authorize(scope,threadId);if(stateVersion(fresh)!==stateVersion(thread))throw nativeFail(409,"THREAD_CONTEXT_CHANGED");
  if(action==="plan.set"){
   const modes=await call("collaborationMode/list",{});if(!modes.data?.some(row=>row.mode===params.mode))throw nativeFail(501,"NATIVE_UNSUPPORTED");
   const latest=await authorize(scope,threadId);if(stateVersion(latest)!==stateVersion(fresh))throw nativeFail(409,"THREAD_CONTEXT_CHANGED");
   if(fresh.model!==params.expectedModel||(fresh.reasoningEffort??null)!==(params.expectedEffort??null))throw nativeFail(409,"THREAD_CONTEXT_CHANGED");
   await call("thread/settings/update",{threadId,collaborationMode:{mode:params.mode,settings:{model:fresh.model,reasoning_effort:fresh.reasoningEffort??null,developer_instructions:null}}});
  }else if(action.startsWith("memory."))await call("thread/memoryMode/set",{threadId,mode:action==="memory.enable"?"enabled":"disabled"});
  else if(action==="thread.compact")await call("thread/compact/start",{threadId});
  else if(action==="review.start"){
   const target={type:params.target,...(params.target==="baseBranch"?{branch:params.branch}:{}),...(params.target==="commit"?{sha:params.sha}:{})};
   await call("review/start",{threadId,target,delivery:"inline"});
  }
  return {ok:true,action,threadId,status:"accepted"};
 }
 return {supports,execute,prepareConfirmation,describe:()=>[...READS,...WRITES].map(id=>({id,mutating:WRITES.has(id),requiresConfirmation:WRITES.has(id)}))};
}
