// Behavioral tests for the doctor gateways section.
//
// Every scenario is offline and hermetic: the Pi executable, agent directory,
// project config, gateway key environment and auth file are all temp-dir or
// injected fixtures, so no test reads a real HOME. Each test asserts exactly
// one observable outcome through the public `doctor()` report.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor, DEFAULT_MODEL } from './setup.ts';

const MODEL = DEFAULT_MODEL;

const okExec=(_cmd:string,args:string[])=>({status:0,stdout:args.includes('--version')?'pi 1.0.3\n':'',stderr:''});

/** A ready Pi/credential/catalog fixture with injectable config, gateway auth
 * entries and gateway key environment. `auth` defaults to an OpenRouter key so
 * the baseline report is ready unless a test removes it. */
const fixture=(over:any={})=>{
 const cwd=mkdtempSync(join(tmpdir(),'delivery-docgw-'));
 const bin=join(cwd,'bin');mkdirSync(bin,{recursive:true});writeFileSync(join(bin,'pi'),'#!/bin/sh\n');
 const agent=join(cwd,'agent');mkdirSync(agent,{recursive:true});
 writeFileSync(join(agent,'auth.json'),JSON.stringify(over.auth ?? {openrouter:{type:'api',key:'SUPER-SECRET-VALUE'}}));
 writeFileSync(join(agent,'models-store.json'),JSON.stringify(over.catalog ?? {openrouter:{models:[{id:MODEL,type:'chat'}]}}));
 if (over.config) writeFileSync(join(cwd,'delivery.config.json'),JSON.stringify(over.config));
 const deps={cwd,env:{PATH:bin,HOME:cwd,PI_CODING_AGENT_DIR:agent,...(over.env||{})},execPath:join(bin,'node'),nodeVersion:'26.5.0',exec:okExec,readMounts:()=>'',...(over.deps||{})};
 return {cwd,agent,deps};
};
const kindOf=(d:any,kind:string)=>d.gateways.kinds.find((k:any)=>k.kind===kind);

// --- table surface ----------------------------------------------------------

test('doctor lists the openrouter and typesafe gateway kinds in order', () => {
 const {deps}=fixture();
 assert.deepEqual(doctor(deps).gateways.kinds.map((k)=>k.kind),['openrouter','typesafe']);
});

test('doctor reports the key environment variable for the openrouter gateway', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'openrouter').keyEnv,'OPENROUTER_API_KEY');
});

test('doctor reports the key environment variable for the typesafe gateway', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'typesafe').keyEnv,'TYPESAFE_JEV_API_KEY');
});

// --- configured / source ----------------------------------------------------

test('doctor reports the openrouter gateway configured when its key is in the environment', () => {
 const {deps}=fixture({env:{OPENROUTER_API_KEY:'or-env-key'}});
 assert.equal(kindOf(doctor(deps),'openrouter').configured,true);
});

test('doctor reports source env when the openrouter key is in the environment', () => {
 const {deps}=fixture({env:{OPENROUTER_API_KEY:'or-env-key'}});
 assert.equal(kindOf(doctor(deps),'openrouter').source,'env');
});

test('doctor reports the openrouter gateway configured when only auth.json holds its key', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'openrouter').configured,true);
});

test('doctor reports source auth when only auth.json holds the openrouter key', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'openrouter').source,'auth');
});

test('doctor reports source env when the typesafe key is in the environment', () => {
 const {deps}=fixture({env:{TYPESAFE_JEV_API_KEY:'ts-env-key'}});
 assert.equal(kindOf(doctor(deps),'typesafe').source,'env');
});

test('doctor reports the typesafe gateway unconfigured when no key resolves', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'typesafe').configured,false);
});

test('doctor reports a null source for an unconfigured gateway', () => {
 const {deps}=fixture();
 assert.equal(kindOf(doctor(deps),'typesafe').source,null);
});

// --- jev provider -----------------------------------------------------------

test('doctor defaults the jev provider to auto when the project config has no jev section', () => {
 const {deps}=fixture();
 assert.equal(doctor(deps).gateways.jev.provider,'auto');
});

test('doctor reads the jev provider from delivery.config.json', () => {
 const {deps}=fixture({config:{jev:{provider:'typesafe'}},env:{TYPESAFE_JEV_API_KEY:'ts-env-key'}});
 assert.equal(doctor(deps).gateways.jev.provider,'typesafe');
});

test('doctor resolves an auto provider to typesafe when the typesafe key resolves', () => {
 const {deps}=fixture({env:{TYPESAFE_JEV_API_KEY:'ts-env-key'}});
 assert.equal(doctor(deps).gateways.jev.resolved,'typesafe');
});

test('doctor resolves an auto provider to openrouter when only the openrouter key resolves', () => {
 const {deps}=fixture();
 assert.equal(doctor(deps).gateways.jev.resolved,'openrouter');
});

test('doctor resolves an auto provider to null when no gateway key resolves', () => {
 const {deps}=fixture({auth:{}});
 assert.equal(doctor(deps).gateways.jev.resolved,null);
});

// --- explicit provider without a key ---------------------------------------

test('doctor reports the gateway error when jev.provider typesafe has no key', () => {
 const {deps}=fixture({config:{jev:{provider:'typesafe'}}});
 assert.equal(doctor(deps).gateways.jev.error,'Jev provider typesafe requires TYPESAFE_JEV_API_KEY to be configured');
});

test('doctor reports no resolved gateway when jev.provider typesafe has no key', () => {
 const {deps}=fixture({config:{jev:{provider:'typesafe'}}});
 assert.equal(doctor(deps).gateways.jev.resolved,null);
});

test('doctor remediation names TYPESAFE_JEV_API_KEY when jev.provider typesafe has no key', () => {
 const {deps}=fixture({config:{jev:{provider:'typesafe'}}});
 assert.match(doctor(deps).remediation.join(' '),/TYPESAFE_JEV_API_KEY/);
});

test('doctor reports an invalid jev.provider in the gateway error instead of throwing', () => {
 const {deps}=fixture({config:{jev:{provider:'litellm'}}});
 assert.match(doctor(deps).gateways.jev.error as string,/Invalid jev\.provider litellm/);
});

// --- key secrecy and readiness independence --------------------------------

test('doctor never includes a gateway key value in its report', () => {
 const {deps}=fixture({env:{OPENROUTER_API_KEY:'or-secret-value',TYPESAFE_JEV_API_KEY:'ts-secret-value'}});
 assert.doesNotMatch(JSON.stringify(doctor(deps)),/or-secret-value|ts-secret-value/);
});

test('doctor stays ready when jev.provider typesafe has no key', () => {
 const {deps}=fixture({config:{jev:{provider:'typesafe'}}});
 assert.equal(doctor(deps).ok,true);
});
