export const MANIFEST_REFRESH_MS=30000;
export const BACKGROUND_REFRESH_MS=6000;
export async function restoreOwnedThread(candidates,openThread,currentVersion) {
  let version=currentVersion();
  for(const candidate of candidates){
    if(currentVersion()!==version)return {opened:false,cancelled:true,version};
    const request=openThread(candidate);version=currentVersion();const opened=await request;
    if(currentVersion()!==version)return {opened:false,cancelled:true,version};
    if(opened)return {opened:true,cancelled:false,version};
  }return {opened:false,cancelled:false,version};
}
export async function loadInitialView({loadManifest,loadSettings,openExplicit,openFallback,afterSettings,onError,onSettingsSettled=()=>{}}) {
  const foreground=Promise.resolve().then(openExplicit).catch(error=>{onError(error);return false;});
  const settings=Promise.resolve().then(loadSettings).then(afterSettings).catch(onError).finally(onSettingsSettled);
  // Keep the slow manifest behind foreground setup even if the native engine
  // processes requests serially; it must not block a later resume/settings read.
  const manifest=foreground.then(loadManifest).then(()=>true).catch(error=>{onError(error);return false;});
  const [,opened]=await Promise.all([settings,foreground]);
  if(!opened&&await manifest)await openFallback();
}
export function shouldRecoverThread({working,lastPushAt,lastRecoveryAt,now=Date.now()}) {
  return !working||!lastPushAt||now-lastPushAt>=2500||!lastRecoveryAt||now-lastRecoveryAt>=8000;
}
export async function recoverThreadPage({working,knownTurnIds,read,stillCurrent=()=>true}) {
  let page=await read(working?1:6),latestOnly=working;if(!stillCurrent())return null;
  const head=page?.data?.[0],unknownHead=Boolean(head?.id&&!knownTurnIds.has(head.id));
  const status=typeof head?.status==="object"?head.status.type:head?.status;
  if(working&&(unknownHead||!["inProgress","running"].includes(status))){page=await read(6);latestOnly=false;}
  if(!stillCurrent())return null;
  const finalHead=page?.data?.[0],backfill=Boolean(finalHead?.id&&!knownTurnIds.has(finalHead.id));
  const resetWindow=backfill&&knownTurnIds.size>0&&!(page?.data||[]).some(turn=>knownTurnIds.has(turn.id));
  return {page,latestOnly,backfill,resetWindow};
}
export function latestCachedPage(existing,page) {
  const incoming=page.data||[],head=incoming[0]?.id,index=head?(existing?.turns||[]).findIndex(turn=>turn.id===head):-1;
  if(index>=0){const ids=new Set(incoming.map(turn=>turn.id));return {...existing,turns:[...incoming,...existing.turns.slice(index).filter(turn=>!ids.has(turn.id))]};}
  return {turns:incoming,nextCursor:page.nextCursor||null,shallow:Boolean(page.nextCursor)};
}
