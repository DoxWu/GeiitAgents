import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { expect } from '@playwright/test';

const output=path.resolve('../../.tools/unified-workbench-native-20261029');
await mkdir(output,{recursive:true});
const profile=await mkdtemp(path.join(output,'webview-'));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const app=spawn(path.resolve('src-tauri/target-dev/release/geiit-workbench.exe'),[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:profile,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}});
let launchError;app.on('error',error=>{launchError=error;});
try{
  await expect.poll(async()=>{if(launchError)throw launchError;if(app.exitCode!==null)throw new Error('Native app exited');try{const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();return list.some(page=>page.type==='page'&&page.url.startsWith('http'));}catch{return false;}},{timeout:30000}).toBe(true);
  const validation=spawn(process.execPath,['scripts/verify-unified-workbench.mjs'],{windowsHide:true,stdio:'inherit',env:{...process.env,WORKBENCH_CDP_URL:`http://127.0.0.1:${port}`,WORKBENCH_PRODUCTION:'1',WORKBENCH_REVIEW_OUTPUT:output}});
  const status=await new Promise((resolve,reject)=>{validation.on('error',reject);validation.on('exit',resolve);});
  if(status!==0)throw new Error(`Native validation failed (${status})`);
}finally{
  if(app.pid&&app.exitCode===null)await new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(app.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.on('error',resolve);stop.on('exit',resolve);});
}
