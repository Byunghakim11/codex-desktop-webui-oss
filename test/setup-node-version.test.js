import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const setupUrl=new URL("../scripts/setup.js",import.meta.url);
const installerUrl=new URL("../scripts/install-desktop-bridge.ps1",import.meta.url);
test("unsupported Node setup exits before subprocesses, token creation or global linking",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cw-node-gate-"));
  try{
    for(const version of ["20.19.0","22.12.0","22.12.9","invalid"]){
      const dataDir=path.join(root,version.replaceAll(".","-"));
      const code=`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});
        Object.defineProperty(process,'version',{value:${JSON.stringify(`v${version}`)}});
        const forbidden=()=>{throw Error('UNEXPECTED_SETUP_SIDE_EFFECT');};
        cp.spawnSync=forbidden;for(const key of ['mkdirSync','writeFileSync','renameSync','chmodSync'])fs[key]=forbidden;
        syncBuiltinESMExports();await import(${JSON.stringify(setupUrl.href)});`;
      const result=spawnSync(process.execPath,["--input-type=module","-e",code],{encoding:"utf8",env:{...process.env,CODEX_WEBUI_DATA_DIR:dataDir},timeout:5000,windowsHide:true});
      assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/Node\.js 22\.13\.0 or newer is required/);
      assert.doesNotMatch(result.stderr,/UNEXPECTED_SETUP_SIDE_EFFECT/);assert.equal(fs.existsSync(dataDir),false);
    }
  }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith("cw-node-gate-"));fs.rmSync(root,{recursive:true,force:true});}
});

test("bridge installer Node gate rejects old versions before installation and accepts boundary versions",{skip:process.platform!=="win32"},()=>{
  const source=fs.readFileSync(installerUrl,"utf8"),start=source.search(/^\$Node(?:Major|Version)Text\s*=/m),end=source.indexOf("$BrokerPath =",start);
  assert.ok(start>=0&&end>start);const gate=source.slice(start,end);
  assert.ok(source.indexOf("New-Item -ItemType Directory",end)>end);
  const pwsh=process.env.CODEX_WEBUI_TEST_PWSH||"pwsh";
  for(const [version,accepted]of [["20.19.0",false],["22.12.0",false],["22.13.0",true],["24.0.0",true]]){
    // Run only the actual validation block against a synthetic version probe.
    // No installer setup, compiler, environment mutation or filesystem block runs.
    const command=`$ErrorActionPreference='Stop';$NodePath={ $global:LASTEXITCODE=0; if(($args -join ' ') -like '*split*') { '${version.split(".")[0]}' } else { '${version}' } };try { ${gate}\nWrite-Output 'GATE_ACCEPTED' } catch { Write-Output $_.Exception.Message; exit 23 }`;
    const result=spawnSync(pwsh,["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",windowsHide:true,timeout:10000});
    assert.equal(result.status,accepted?0:23,`${result.stdout}\n${result.stderr}`);
    if(accepted)assert.match(result.stdout,/GATE_ACCEPTED/);else assert.match(result.stdout,/Node\.js 22\.13\.0 or newer is required/);
  }
});
