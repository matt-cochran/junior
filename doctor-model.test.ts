// Behavioral tests for the doctor model section.
//
// Every scenario is offline and hermetic: the Pi executable, agent directory,
// local model catalog and network seam are all temp-dir or injected fixtures.
// Each test asserts exactly one observable outcome through the public
// `doctor()` report.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, DEFAULT_MODEL } from './setup.ts';

const MODEL = DEFAULT_MODEL;
const NEWER = 'deepseek/deepseek-v4.1-flash-1017';

const okExec=(_cmd:string,args:string[])=>({status:0,stdout:args.includes('--version')?'pi 1.0.3\n':'',stderr:''});
const setupDeps=(cwd:string,over:any={})=>({cwd,env:{PATH:'',HOME:cwd,...(over.env||{})},execPath:join(cwd,'node'),nodeVersion:'26.5.0',exec:okExec,readMounts:()=>'',...over});
const withPiDir=(cwd:string)=>{const bin=join(cwd,'bin');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'pi'),'#!/bin/sh\n');return bin;};
const writeAgent=(cwd:string,over:any={})=>{
 const agent=join(cwd,'agent');mkdirSync(agent,{recursive:true});
 writeFileSync(join(agent,'auth.json'),JSON.stringify(over.auth ?? {openrouter:{type:'api',key:'SUPER-SECRET-VALUE'}}));
 writeFileSync(join(agent,'models-store.json'),JSON.stringify(over.catalog ?? {openrouter:{models:[{id:MODEL,type:'chat'}]}}));
 return agent;
};

/** A ready Pi/credential/catalog fixture, with optional catalog, project config
 * and extra dependency seams. */
const fixture=(over:any={})=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-docmodel-'));
 const bin=withPiDir(cwd);
 const agent=writeAgent(cwd,{catalog:over.catalog});
 if (over.config) writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify(over.config));
 return {cwd,agent,bin,deps:setupDeps(cwd,{env:{PATH:bin,PI_CODING_AGENT_DIR:agent},execPath:join(bin,'node'),...(over.deps||{})})};
};

// --- pinned identity --------------------------------------------------------

test('doctor reports the builtin pinned provider and id', () => {
 const {deps}=fixture();
 const d=doctor(deps);
 assert.deepEqual({provider:d.model.pinned?.provider,id:d.model.pinned?.id},{provider:'openrouter',id:MODEL});
});

test('doctor reports a builtin pin source when no project config exists', () => {
 const {deps}=fixture();
 assert.equal(doctor(deps).model.pinned?.source,'builtin');
});

test('doctor reports a project pin source when delivery.config.json pins the model', () => {
 const {deps}=fixture({config:{provider:'openrouter',model:MODEL}});
 assert.equal(doctor(deps).model.pinned?.source,'project');
});

test('doctor reports the provider and id from a project pin', () => {
 const {deps}=fixture({config:{provider:'openrouter',model:'moonshotai/kimi-k2.7-code'}});
 const d=doctor(deps);
 assert.deepEqual({provider:d.model.pinned?.provider,id:d.model.pinned?.id},{provider:'openrouter',id:'moonshotai/kimi-k2.7-code'});
});

test('doctor reports the project config path that supplied the pin', () => {
 const {cwd,deps}=fixture({config:{provider:'openrouter',model:MODEL}});
 assert.equal(doctor(deps).model.pinned?.path,join(cwd,'delivery.config.json'));
});

test('doctor classifies the pinned openrouter model as commodity', () => {
 const {deps}=fixture();
 assert.equal(doctor(deps).model.policy?.class,'commodity');
});

test('doctor reports the configured routing mode', () => {
 const {deps}=fixture({config:{models:{routing:'shadow'}}});
 assert.equal(doctor(deps).model.routing,'shadow');
});

test('doctor reports the autoUpgrade flag', () => {
 const {deps}=fixture({config:{models:{autoUpgrade:true}}});
 assert.equal(doctor(deps).model.autoUpgrade,true);
});

// --- frontier pin refusal ---------------------------------------------------

test('doctor fails readiness when the pinned model is frontier', () => {
 const {deps}=fixture({config:{provider:'openrouter',model:'anthropic/claude-sonnet-4'},catalog:{openrouter:{models:[{id:'anthropic/claude-sonnet-4'}]}}});
 assert.equal(doctor(deps).ok,false);
});

test('doctor remediates a frontier pin with the commodity policy', () => {
 const {deps}=fixture({config:{provider:'openrouter',model:'anthropic/claude-sonnet-4'},catalog:{openrouter:{models:[{id:'anthropic/claude-sonnet-4'}]}}});
 assert.match(doctor(deps).remediation.join(' '),/commodity\/open-weight/);
});

// --- newer commodity releases ----------------------------------------------

test('doctor lists a newer commodity release for the default profile', () => {
 const {deps}=fixture({catalog:{openrouter:{models:[{id:MODEL},{id:NEWER}]}}});
 const general=doctor(deps).model.newer?.find((u)=>u.profile==='general');
 assert.deepEqual(general?.newer,[NEWER]);
});

test('doctor warns about a newer commodity release', () => {
 const {deps}=fixture({catalog:{openrouter:{models:[{id:MODEL},{id:NEWER}]}}});
 assert.match(doctor(deps).warnings.join(' '),/Newer commodity models available: general deepseek\/deepseek-v4\.1-flash -> deepseek\/deepseek-v4\.1-flash-1017/);
});

test('doctor stays ready when a newer commodity release is available', () => {
 const {deps}=fixture({catalog:{openrouter:{models:[{id:MODEL},{id:NEWER}]}}});
 assert.equal(doctor(deps).ok,true);
});

// --- roster availability ----------------------------------------------------

test('doctor marks a roster profile present in the local catalog as available', () => {
 const {deps}=fixture({catalog:{openrouter:{models:[{id:MODEL},{id:'deepseek/deepseek-v4-pro-0813'}]}}});
 assert.equal(doctor(deps).model.roster?.find((p)=>p.profile==='deep-reasoning')?.available,true);
});

test('doctor marks a roster profile absent from the local catalog as unavailable', () => {
 const {deps}=fixture({catalog:{openrouter:{models:[{id:MODEL}]}}});
 assert.equal(doctor(deps).model.roster?.find((p)=>p.profile==='deep-reasoning')?.available,false);
});

// --- rejected roster entries ------------------------------------------------

test('doctor warns about a rejected roster entry naming its id and reason', () => {
 const {deps}=fixture({config:{models:{roster:[{id:'broken',provider:'',model:'',strengths:''}]}}});
 assert.match(doctor(deps).warnings.join(' '),/broken.*needs provider, model and strengths/);
});

// --- offline guarantee ------------------------------------------------------

test('doctor performs no network access', () => {
 let calls=0;
 const fetch=async()=>{calls+=1;return {status:200,json:async()=>({data:[]})};};
 const {deps}=fixture({deps:{fetch}});
 doctor(deps);
 assert.equal(calls,0);
});
