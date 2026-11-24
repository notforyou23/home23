// Local facts only. Discovery never returns configuration values, credentials or app content.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const identifiers=['codex','claude','cursor-agent','t3','hermes','openclaw','grok','gemini','opencode','goose','aider','copilot','pi','ollama','gh'];
async function command(file,args) {
  try {return await run(file,args,{timeout:3500,maxBuffer:2*1024*1024,cwd:os.homedir(),encoding:'utf8'});}
  catch (error) {
    // A signed-out CLI can return its normal status response with a nonzero exit.
    return Number.isInteger(error.code) && !error.killed ? {stdout:error.stdout,stderr:error.stderr} : null;
  }
}
async function installed(name,dirs) {
  for (const d of dirs) {
    const file=path.join(d,name);
    try {await fs.access(file,constants.X_OK);if ((await fs.stat(file)).isFile()) return file;}
    catch { /* Try the next installed location. */ }
  }
}

export async function localToolInventory() {
  const home=os.homedir();
  const dirs=[path.join(home,'.local/bin'),path.join(home,'.t3/bin'),path.join(home,'.grok/bin'),path.join(home,'.opencode/bin'),
    path.dirname(process.execPath),'/opt/homebrew/bin','/usr/local/bin',...(process.env.PATH??'').split(path.delimiter).filter(d=>path.isAbsolute(d))];
  const files=new Map();
  await Promise.all(identifiers.map(async name=>{const file=await installed(name,dirs);if (file) files.set(name,file);}));
  // Run one CLI at a time on a host that may also have a resident model.
  const probe=(name,args)=>files.has(name) ? command(files.get(name),args) : null;
  const codex=await probe('codex',['login','status']);
  const mcp=await probe('codex',['mcp','list','--json']);
  const claude=await probe('claude',['auth','status','--json']);
  const cursor=await probe('cursor-agent',['status']);
  const roots=['/Applications','/Applications/Utilities','/System/Applications','/System/Applications/Utilities',path.join(home,'Applications')];
  const installedApps=(await Promise.all(roots.map(root=>fs.readdir(root).catch(()=>[])))).flat();
  try {await fs.access('/System/Library/CoreServices/Finder.app');installedApps.push('Finder.app');} catch {}
  const auth={};
  if (codex && /logged in|signed in/i.test(codex.stdout+codex.stderr))
    auth.codex=!/not (?:logged|signed) in/i.test(codex.stdout+codex.stderr);
  if (claude) {try{const v=JSON.parse(claude.stdout).loggedIn;if (typeof v==='boolean') auth.claude=v;}catch{}}
  if (cursor && /logged in/i.test(cursor.stdout+cursor.stderr)) auth['cursor-agent']=!/not logged in/i.test(cursor.stdout+cursor.stderr);
  let servers=null;
  if (mcp) {try{servers=JSON.parse(mcp.stdout).map(v=>({name:v.name,enabled:v.enabled===true,auth:v.auth_status}));}catch{}}
  return {host:os.hostname().replace(/\.local\.?$/i,''),platform:os.platform(),architecture:os.arch(),
    harnesses:identifiers.filter(n=>files.has(n)).map(name=>({name,...(name in auth ? {signedIn:auth[name]}:{})})),
    apps:[...new Set(installedApps.filter(s=>!s.startsWith('.') && s.endsWith('.app')).map(s=>s.slice(0,-4)))].sort(),mcp:servers};
}

export function describeInventory(host) {
  const harnesses=host.harnesses.map(h=>h.name+(h.signedIn===true ? ' (signed in)' : h.signedIn===false ? ' (signed out)' : ''));
  const servers=host.mcp?.filter(s=>s.enabled).map(s=>s.name+(s.auth==='not_logged_in' ? ' (sign-in required)' : ''));
  return [host.host+' · '+host.architecture,'Installed commands — '+(harnesses.join(', ')||'none detected'),
    'Configured Codex MCP servers — '+(servers===undefined ? 'inventory unavailable' : servers.join(', ')||'none enabled'),
    'Installed applications — '+(host.apps.join(', ')||'none detected')].join('\n');
}
