import {authenticationAccepted} from "./access-auth.js";
export const connectionRuntimeMessages={
 en:{"connectionRuntime.offline":"Network offline · waiting to reconnect","connectionRuntime.retry":"Retry connection","connectionRuntime.reauthenticate":"Renew sign-in in a new tab","connectionRuntime.sidebarLater":"Conversation created. The sidebar will refresh when the list is available.","connectionRuntime.unavailable":"The connection is temporarily unavailable. Your sign-in and drafts are retained.","connectionRuntime.timeout":"The request timed out. The connection may still be available.","connectionRuntime.outcomeUnknown":"Delivery is unconfirmed. Check this conversation in Codex before sending again.","connectionRuntime.notSent":"Not sent: the connection is unavailable.","connectionRuntime.busy":"Too many requests are pending. Please try again shortly."},
 ko:{"connectionRuntime.offline":"네트워크 오프라인 · 재연결 대기 중","connectionRuntime.retry":"연결 다시 시도","connectionRuntime.reauthenticate":"새 탭에서 로그인 갱신","connectionRuntime.sidebarLater":"대화는 생성되었습니다. 목록이 준비되면 사이드바를 갱신합니다.","connectionRuntime.unavailable":"일시적으로 연결할 수 없습니다. 로그인과 작성 내용은 보존됩니다.","connectionRuntime.timeout":"요청 시간이 초과됐습니다. 연결 자체는 유지될 수 있습니다.","connectionRuntime.outcomeUnknown":"전달 결과가 불확실합니다. 다시 보내기 전에 Codex에서 이 대화를 확인하세요.","connectionRuntime.notSent":"연결할 수 없어 전송하지 않았습니다.","connectionRuntime.busy":"처리 중인 요청이 많습니다. 잠시 후 다시 시도하세요."}
};
const reads=new Set(["thread/list","thread/read","thread/resume","thread/turns/list","thread/items/list","thread/queue/list","config/read","model/list","permissionProfile/list","account/read","account/rateLimits/read","webui/attachment-send/status"]);
export const isReadRpc=method=>reads.has(method);
export const rpcDeadlineMs=method=>isReadRpc(method)?45000:120000;
connectionRuntimeMessages.en["connectionRuntime.settingsRetry"]="Retry conversation settings";
connectionRuntimeMessages.en["connectionRuntime.settingsLoading"]="Restoring conversation settings…";
connectionRuntimeMessages.ko["connectionRuntime.settingsRetry"]="대화 설정 다시 불러오기";
connectionRuntimeMessages.ko["connectionRuntime.settingsLoading"]="대화 설정 복구 중…";
export async function fetchConnectionInfo(url,{fetchImpl=fetch,timeoutMs=6500}={}){
 try{
  const response=await fetchImpl(url,{credentials:"same-origin",cache:"no-store",redirect:"manual",signal:AbortSignal.timeout(timeoutMs)});
  if(response.type==="opaqueredirect"||[301,302,303,307,308,401,403].includes(response.status))return {kind:"auth-required",info:null};
  if(!response.ok)return {kind:"unavailable",info:null};
  const info=await response.json();if(authenticationAccepted(info))return {kind:"ready",info};
  if(info?.authenticated===false)return {kind:"auth-required",info};
 }catch{}
 return {kind:"unavailable",info:null};
}
