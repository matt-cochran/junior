import { spawnSpec } from './cli-entry.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ISOLATION_FLAGS, parsePiCapabilities } from './pi-isolation.ts';

/** Pi itself requires Node 22.19 or newer; the worker is tested on Node 24+. */
export const SUPPORTED_NODE_MIN = '22.19.0';
export const DEFAULT_PROVIDER = 'openrouter';
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const TESTED_PI_VERSION = '1.4.0';
export const DOCTOR_TIMEOUT_MS = 10000;
export const INSTALL_TIMEOUT_MS = 300000;

/** Project Crossmatrix store guidance. The reminder is shown only when the
 * store is missing after an `init` (or a failed `--with-matrix` update). */
export const MATRIX_REMINDER = 'Create the project Crossmatrix store with `junior matrix init` and commit `.crossmatrix/`.';
export const MATRIX_COMMIT = 'Commit the project Crossmatrix store (`.crossmatrix/`) so the team shares it.';
export const MATRIX_UPDATE_SKIP = 'update does not create project state; pass --with-matrix';

/** Packaged delegation skill installed by `init`. The source is resolved from
 * this module's location, never from the caller's working directory. */
export const SKILL_NAME = 'junior';
export const SKILL_FILENAME = 'SKILL.md';
export const SKILL_MANIFEST_FILENAME = '.junior-manifest.json';
export const PACKAGED_SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), 'skills', SKILL_NAME, SKILL_FILENAME);

/** Resolve the CLI entry that ships beside this module: `dist/junior.js` when
 * compiled, or `junior.ts` in a source checkout. The installed skill records
 * this path so it can invoke the packaged CLI without assuming a checkout. */
export function resolveJuniorCliPath(moduleDir:string = dirname(fileURLToPath(import.meta.url))):string {
 const js=join(moduleDir,'junior.js');
 if (existsSync(js)) return js;
 const ts=join(moduleDir,'junior.ts');
 if (existsSync(ts)) return ts;
 return js;
}

export type ExecResult = { status:number|null; stdout?:string; stderr?:string; error?:string };

export type SetupDeps = {
 cwd?:string;
 env?:NodeJS.ProcessEnv;
 /** Injectable process seams so tests never touch the real environment. */
 execPath?:string;
 nodeVersion?:string;
 exec?:(command:string, args:string[], options?:{timeout?:number; env?:NodeJS.ProcessEnv})=>ExecResult;
 readFile?:(path:string, encoding?:string)=>string;
 exists?:(path:string)=>boolean;
 writeFile?:(path:string, data:string)=>void;
 mkdir?:(path:string)=>void;
 /** Pre-resolved Pi package metadata; tests inject it instead of reading disk. */
 installedPi?:{name:string;version:string}|null;
 /** Packaged skill source path; tests inject a fixture instead of the module copy. */
 skillSource?:string;
 /** Managed prebuilt-tool root; tests inject a fixture instead of the user home. */
 toolsRoot?:string;
 /** Injectable HTTP seam for the opt-in online credential check; tests never hit the network. */
 fetch?:FetchLike;
 /** Injectable `/proc/mounts` reader for slow-mount detection; tests never read
  * the host mount table. Defaults to the real file. */
 readMounts?:()=>string;
 /** Injectable project-store creation seam; tests never spawn `crossmatrix-mcp`. */
 matrixInit?:(dir:string)=>{created:string[]};
};

export function readText(deps:SetupDeps, path:string):string {
 return (deps.readFile ?? ((p:string)=>readFileSync(p,'utf8')))(path,'utf8');
}
export function exists(deps:SetupDeps, path:string):boolean {
 return (deps.exists ?? existsSync)(path);
}
export function agentDir(deps:SetupDeps):string {
 const env=deps.env ?? process.env;
 const home=env.HOME || env.USERPROFILE || '';
 return env.PI_CODING_AGENT_DIR || join(home,'.pi','agent');
}
function parseSemver(v:string):[number,number,number] {
 const m=String(v??'').match(/(\d+)\.(\d+)\.(\d+)/);
 return m ? [Number(m[1]),Number(m[2]),Number(m[3])] : [0,0,0];
}
/** Compare dotted versions; returns -1, 0 or 1. */
export function compareSemver(a:string,b:string):number {
 const x=parseSemver(a), y=parseSemver(b);
 for (let i=0;i<3;i++) { if (x[i]!==y[i]) return x[i]<y[i] ? -1 : 1; }
 return 0;
}
function firstSemver(text:string):string|null {
 const m=String(text??'').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
 return m ? m[0] : null;
}

/** Resolve a bare executable name on the injected PATH. */
export function whichOnPath(name:string, pathEnv:string|undefined, deps:SetupDeps = {}):string|null {
 const dirs=String(pathEnv ?? '').split(delimiter).filter(Boolean);
 for (const d of dirs) {
  const candidate=join(d,name);
  if (exists(deps,candidate)) return candidate;
 }
 return null;
}

/** Read the installed Pi package name/version from the local package.json for diagnostics.
 * This is the authoritative tested version used by `init --install`. */
export function discoverInstalledPi(deps:SetupDeps = {}):{name:string;version:string;packageJsonPath:string}|null {
 const execPath=deps.execPath ?? process.execPath;
 const candidates=[];
 const env=deps.env ?? process.env;
 if (env.PI_PACKAGE_DIR) candidates.push(join(env.PI_PACKAGE_DIR,'package.json'));
 candidates.push(join(dirname(execPath),'..','lib','node_modules','@earendil-works','pi-coding-agent','package.json'));
 for (const p of candidates) {
  try {
   const j=JSON.parse(readText(deps,p));
   if (j?.name === PI_PACKAGE && typeof j.version==='string' && /^\d+\.\d+\.\d+$/.test(j.version)) return {name:j.name,version:j.version,packageJsonPath:p};
  } catch { /* try the next candidate */ }
 }
 return null;
}

export type PiVersionStatus = 'match' | 'patch' | 'minor' | 'major' | 'older' | 'unknown';
export type PiProbeStatus = 'ok' | 'blocked' | 'failed' | 'missing';
export type PiCheck = {
 found:boolean;
 executable:string|null;
 version:string|null;
 location:string|null;
 pathMismatch:boolean;
 /** The Pi version pinned by the project config or the built-in tested default. */
 testedVersion:string;
 /** True only when the installed version equals the tested version exactly. */
 versionMatch:boolean;
 /** Patch differences are informational; major/minor or older versions warn. */
 versionStatus:PiVersionStatus;
 versionWarning:boolean;
 versionNote?:string;
 note?:string;
 /** How the bounded `pi --version` probe concluded. `blocked` means the host
  * refused to spawn the probe (for example EPERM); it does not mean Pi is
  * missing or unusable. */
 probeStatus:PiProbeStatus;
 probeBlocked:boolean;
 /** Isolation flags the installed Pi help advertises, including `--tools`.
  * `supported` is null when the help probe failed (see `note`): unknown, not
  * missing, so doctor does not advise an update it cannot justify. */
 isolation:{ supported:boolean|null; missing:string[] };
};

/** Classify an installed Pi version against the tested pin without blocking any
 * command: an equal version matches, a newer patch is informational, and a
 * major/minor difference or an older install is a (nonblocking) warning. */
function isBlockedProbeError(error:string|undefined):boolean {
 return /\bEPERM\b/i.test(String(error ?? ''));
}

function classifyPiVersion(installed:string|null, tested:string):{status:PiVersionStatus; match:boolean; warning:boolean; note?:string} {
 if (!installed) return {status:'unknown', match:false, warning:false};
 const a=parseSemver(installed), b=parseSemver(tested);
 if (a[0]===b[0] && a[1]===b[1] && a[2]===b[2]) return {status:'match', match:true, warning:false};
 if (compareSemver(installed,tested) < 0) return {status:'older', match:false, warning:true,
  note:`installed pi ${installed} is older than the tested ${tested}`};
 if (a[0]===b[0] && a[1]===b[1]) return {status:'patch', match:false, warning:false,
  note:`installed pi ${installed} differs from the tested ${tested} by a patch release`};
 if (a[0]===b[0]) return {status:'minor', match:false, warning:true,
  note:`installed pi ${installed} is a newer minor release than the tested ${tested}`};
 return {status:'major', match:false, warning:true,
  note:`installed pi ${installed} is a newer major release than the tested ${tested}`};
}

/** Resolve `pi`, run a bounded `pi --version`, and detect a PATH/nvm mismatch
 * where `pi` and the running `node` live in different directories. */
export function checkPi(deps:SetupDeps = {}, testedVersion:string = TESTED_PI_VERSION):PiCheck {
 const env=deps.env ?? process.env;
 const executable=whichOnPath('pi',env.PATH,deps);
 const requiredIsolation=[...ISOLATION_FLAGS, '--tools'];
 if (!executable) return {found:false, executable:null, version:null, location:null, pathMismatch:false,
  testedVersion, versionMatch:false, versionStatus:'unknown', versionWarning:false,
  probeStatus:'missing', probeBlocked:false,
  isolation:{supported:false, missing:requiredIsolation}};
 const exec=deps.exec ?? ((c:string,a:string[],o?:any)=>asSpawn(c,a,o));
 const execOptions={timeout:DOCTOR_TIMEOUT_MS, env:{...env, PI_OFFLINE:'1', PI_SKIP_VERSION_CHECK:'1'}};
 let version:string|null=null;
 let note:string|undefined;
 let versionProbeBlocked=false;
 try {
  const r=exec('pi',['--offline','--no-approve','--version'],execOptions);
  if (r.error) {
   note=`pi --version failed: ${r.error}`;
   versionProbeBlocked=isBlockedProbeError(r.error) || isBlockedProbeError(r.stderr);
  } else if (r.status !== 0) {
   note=`pi --version exited ${r.status}`;
   versionProbeBlocked=isBlockedProbeError(r.stderr);
  } else version=firstSemver(r.stdout || '');
 } catch (e) {
  const message=e instanceof Error ? e.message : String(e);
  note=`pi --version failed: ${message}`;
  versionProbeBlocked=isBlockedProbeError(message);
 }
 let capabilities:{ flags:ReadonlySet<string> }|null=null;
 try {
  const r=exec('pi',['--offline','--no-approve','--help'],execOptions);
  if (r.error) note=note ?? `pi --help failed: ${r.error}`;
  else if (r.status !== 0) note=note ?? `pi --help exited ${r.status}`;
  else capabilities=parsePiCapabilities(r.stdout || '');
 } catch (e) {
  note=note ?? `pi --help failed: ${e instanceof Error ? e.message : String(e)}`;
 }
 const missingIsolation=capabilities ? requiredIsolation.filter((flag)=>!capabilities!.flags.has(flag)) : [];
 const location=dirname(executable);
 const nodeDir=dirname(deps.execPath ?? process.execPath);
 const pathMismatch=location !== nodeDir;
 if (pathMismatch) note=`pi resolves from ${location} but node runs from ${nodeDir}; a different PATH or nvm version may hide the global install`;
 const pairing=classifyPiVersion(version,testedVersion);
 const probeStatus:PiProbeStatus=version ? 'ok' : versionProbeBlocked ? 'blocked' : 'failed';
 return {found:true, executable, version, location, pathMismatch,
  testedVersion, versionMatch:pairing.match, versionStatus:pairing.status, versionWarning:pairing.warning,
  ...(pairing.note?{versionNote:pairing.note}:{}), ...(note?{note}:{}),
  probeStatus, probeBlocked:probeStatus === 'blocked',
  isolation:{supported:capabilities ? missingIsolation.length === 0 : null, missing:missingIsolation}};
}

export function asSpawn(command:string, args:string[], options:any):ExecResult {
 // Kept behind the injectable seam; only `doctor`/`init --install` reach it.
 const spec=spawnSpec(command,args);
 const r=spawnSync(spec.command,spec.args,{encoding:'utf8', ...options, shell:spec.shell});
 return { status:r.status, stdout:r.stdout || '', stderr:r.stderr || '', error:r.error?.message };
}
export type Defaults = { provider:string; model:string; source:'builtin'|'project'; path:string|null };

/** Load project defaults for `run`. An explicit task provider/model always
 * takes precedence; the built-in defaults apply when no project config exists. */
export function loadDefaults(cwd:string, deps:SetupDeps = {}):Defaults {
 const path=join(cwd,'delivery.config.json');
 if (exists(deps,path)) {
  try {
   const j=JSON.parse(readText(deps,path));
   const provider=typeof j?.provider==='string' && j.provider.trim() ? j.provider : DEFAULT_PROVIDER;
   const model=typeof j?.model==='string' && j.model.trim() ? j.model : DEFAULT_MODEL;
   return {provider, model, source:'project', path};
  } catch { /* a malformed config falls back to built-ins */ }
 }
 return {provider:DEFAULT_PROVIDER, model:DEFAULT_MODEL, source:'builtin', path:null};
}
