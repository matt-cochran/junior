import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
export function validate(t: any) {
 for (const k of ['id','deliverable','cwd']) if (typeof t[k] !== 'string' || !t[k].trim()) throw Error(`Missing ${k}`);
 if (!/^[a-zA-Z0-9_-]+$/.test(t.id)) throw Error('Invalid id');
 if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((x:any)=>typeof x !== 'string' || !x.trim())) throw Error('Missing acceptance');
 if (!Array.isArray(t.checks) || !t.checks.length) throw Error('Missing checks');
 for (const c of t.checks) if (typeof c.command !== 'string' || !Array.isArray(c.args) || c.args.some((x:any)=>typeof x !== 'string')) throw Error('Invalid check');
 return t;
}
export function run(t:any, mock=false) {
 validate(t);
 const cwd=resolve(t.cwd), dir=join(cwd,'.delivery',t.id,String(Date.now()));
 mkdirSync(dir,{recursive:true});
 const prompt=`Implement this deliverable within its constraints. Run checks and report gaps. Do not commit or push.\n${JSON.stringify(t)}`;
 const worker:any=mock ? {status:0,stdout:'Simulation only; no implementation performed.'} : spawnSync('pi',['--provider','openrouter','--model',t.model || 'deepseek/deepseek-v4.1-flash','--print',prompt],{cwd,encoding:'utf8',timeout:600000,maxBuffer:8388608});
 writeFileSync(join(dir,'worker.log'),`${worker.stdout || ''}\n${worker.stderr || ''}`);
 const checks=worker.status !== 0 ? [] : t.checks.map((c:any,i:number)=>{
 const r=spawnSync(c.command,c.args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8388608});
 writeFileSync(join(dir,`check-${i}.log`),`${r.stdout || ''}\n${r.stderr || ''}`);
 return {...c,exitCode:r.status,error:r.error?.message};
 });
 const result={id:t.id,simulated:mock,status:worker.status !== 0 ? 'worker_failed' : checks.some((c:any)=>c.exitCode !== 0) ? 'checks_failed' : mock ? 'simulation_passed' : 'ready_for_review',workerExitCode:worker.status,workerError:worker.error?.message || (worker.status !== 0 ? (String(worker.stderr || '').includes('No API key found for openrouter') ? 'OpenRouter authentication missing. Start pi and use /login to configure OpenRouter, then retry.' : 'Pi failed; inspect worker.log.') : undefined),checks,artifactDir:dir};
 writeFileSync(join(dir,'result.json'),JSON.stringify(result,null,2));
 return result;
}
if (process.argv[1]?.endsWith('/worker.ts')) {
 try {
 const [command,path,flag]=process.argv.slice(2);
 if (!path || !['validate','run'].includes(command)) throw Error('Usage: node worker.ts validate|run task.json [--mock]');
 const t=validate(JSON.parse(readFileSync(path,'utf8')));
 const result:any=command==='validate' ? {valid:true,id:t.id} : run(t,flag==='--mock');
 console.log(JSON.stringify(result,null,2));
 if(result.status && !['simulation_passed','ready_for_review'].includes(result.status)) process.exitCode=1;
 } catch(e) {console.error(String(e));process.exitCode=1;}
}

