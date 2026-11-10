import fs from "node:fs/promises";
import path from "node:path";
import { safeRelativePath, hiddenProjectPath, fileError } from "./file-preview-policy.js";

export function nativeRecordedChanges(turns) {
  const changes=[];
  for(const turn of turns.slice(0,20))for(const item of (turn.items||[]).slice(-200).reverse())if(item.type==="fileChange"&&item.status==="completed")for(const change of (item.changes||[]).slice(-100).reverse()){
    if(change.kind?.move_path)changes.push({path:change.path,kind:"delete",turnId:turn.id});
    changes.push({path:change.kind?.move_path||change.path,kind:change.kind?.type,turnId:turn.id});if(changes.length>=1000)return changes.slice(0,1000);
  }return changes;
}

export async function searchProjectFiles(files,scope,query,signal) {
  const term=typeof query.search==="string"?query.search.trim():"";
  if(!term||term.length>100||!query.rootRevision)throw fileError(400,"SEARCH_INVALID");
  if(files.discovering>=2)throw fileError(429,"FILES_BUSY");files.discovering++;
  const check=()=>{if(signal?.aborted)throw fileError(499,"SEARCH_CANCELLED");};
  try{
    check();const context=await files.context(scope,query),queue=[{path:"",depth:0}],entries=[];let scanned=0,visited=0,truncated=false;
    while(queue.length&&visited<32&&scanned<5000&&entries.length<100){
      check();const directory=queue.shift(),opened=await files.open(scope,{...query,path:directory.path},"directory");visited++;
      try{
        const dir=await fs.opendir(opened.target);
        for await(const entry of dir){
          check();if(scanned>=5000||entries.length>=100){truncated=true;break;}scanned++;
          const relative=[directory.path,entry.name].filter(Boolean).join("/");
          try{safeRelativePath(relative);}catch{continue;}
          if(hiddenProjectPath(relative)||entry.isSymbolicLink()||(!entry.isDirectory()&&!entry.isFile()))continue;
          const stat=await fs.lstat(path.join(opened.target,entry.name),{bigint:true}).catch(()=>null);
          if(!stat||stat.isSymbolicLink()||(stat.isFile()&&stat.nlink!==1n))continue;
          const kind=stat.isDirectory()?"directory":"file";
          if(entry.name.toLocaleLowerCase().includes(term.toLocaleLowerCase()))entries.push({name:entry.name,label:relative,path:relative,kind,size:stat.isFile()?Number(stat.size):null});
          if(kind==="directory"){if(directory.depth<8)queue.push({path:relative,depth:directory.depth+1});else truncated=true;}
        }
        if(!opened.lease.alive)throw fileError(409,"PROJECT_CHANGED");
      }finally{await opened.close();}
    }
    check();await files.context(scope,query);
    return {context:files.publicContext(context),entries,visited,scanned,truncated:truncated||queue.length>0};
  }finally{files.discovering--;}
}

export async function recordedArtifacts(files,scope,query) {
  if(!query.rootRevision)throw fileError(400,"REVISION_REQUIRED");const context=await files.context(scope,query);
  const changes=await files.readChanges(query.threadId),entries=[],seen=new Set();
  const root=context.root.replace(/^[a-z]:/i,drive=>drive.toUpperCase());
  for(const change of changes.slice(0,1000)){
    if(typeof change?.path!=="string"||change.path.length>4096||!["add","update","delete"].includes(change.kind))continue;let relative=change.path;
    if(path.isAbsolute(relative)){const target=path.normalize(relative).replace(/^[a-z]:/i,drive=>drive.toUpperCase());if(!target.startsWith(root+path.sep))continue;relative=target.slice(root.length+1);}
    relative=relative.replace(/\\/g,"/");try{safeRelativePath(relative);}catch{continue;}
    if(!relative||hiddenProjectPath(relative)||seen.has(relative))continue;seen.add(relative);
    if(change.kind==="delete")continue;
    entries.push({path:relative,name:path.posix.basename(relative),label:relative,kind:"file",turnId:typeof change.turnId==="string"?change.turnId.slice(0,256):"",source:"native-fileChange"});if(entries.length>=100)break;
  }
  await files.context(scope,query);return {context:files.publicContext(context),entries,source:"native-fileChange",turnLimit:20,truncated:entries.length===100||changes.length>=1000};
}
