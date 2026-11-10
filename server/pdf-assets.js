import path from "node:path";
import { readFileSync } from "node:fs";

export function pdfAssetRoot(nodeModules,sourceRoot,override) {
  for(const root of [override,path.join(nodeModules,"pdfjs-dist"),path.join(sourceRoot,".vendor/pdfjs-dist")].filter(Boolean)){
    try{if(JSON.parse(readFileSync(path.join(root,"package.json"),"utf8")).version==="6.5.438")return root;}catch{/* Missing/unpinned assets fail closed. */}
  }return null;
}

export function pdfAsset(pathname,root) {
  if(!root)return null;
  const fixed={"/vendor/pdfjs/pdf.mjs":"build/pdf.min.mjs","/vendor/pdfjs/pdf.worker.mjs":"build/pdf.worker.min.mjs"};
  let relative=fixed[pathname];
  if(!relative){const match=/^\/vendor\/pdfjs\/(cmaps|standard_fonts)\/([A-Za-z0-9_-]+\.(?:bcmap|pfb|ttf))$/.exec(pathname);if(!match)return null;relative=`${match[1]}/${match[2]}`;}
  return {relative,path:path.join(root,...relative.split("/")),mime:relative.endsWith(".mjs")?"text/javascript; charset=utf-8":"application/octet-stream"};
}
