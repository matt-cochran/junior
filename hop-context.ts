import {readFileSync,realpathSync,statSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectHop} from './tools/tools.ts';

/** One compact, integrity-checked context shared by manager, Jev and executor. */
export function loadHopContext(path:string) {
 const full=resolve(path), root=dirname(full), report=inspectHop(full);
 const latest=new Map<string,any>();
 for(const snapshot of report.snapshots) latest.set(snapshot.tool,snapshot);
 const snapshots=[...latest.values()].map(snapshot=>{
  const location=resolve(root,snapshot.path), rel=relative(root,location);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('../')) throw Error('HOP snapshot escapes its state directory');
  const actual=realpathSync(location), actualRelative=relative(realpathSync(root),actual);
  if(isAbsolute(actualRelative)||actualRelative==='..'||actualRelative.startsWith('../')) throw Error('HOP snapshot symlink escapes its state directory');
  if(statSync(actual).size>8*1024*1024) throw Error('HOP snapshot exceeds the 8 MiB limit');
  const bytes=readFileSync(actual);
  const digest=createHash('sha256').update(bytes).digest('hex');
  if(snapshot.sha256.replace(/^sha256:/,'')!==digest) throw Error(`HOP snapshot integrity failed: ${snapshot.id}`);
  const text=bytes.toString('utf8');
  return {...snapshot,path:location,content:text.slice(0,8192),truncated:text.length>8192};
 });
 return {schemaVersion:1,from:full,projectId:report.projectId,revision:report.revision,
  managerAcceptance:report.managerAcceptance,acceptedRevision:report.acceptedRevision,
  toolSourceVersions:report.toolSourceVersions,toolSourceShas:report.toolSourceShas,
  snapshotCount:report.snapshotCount,snapshots,unresolved:report.unresolved.slice(-10),
  unresolvedCount:report.unresolved.length,note:report.note};
}