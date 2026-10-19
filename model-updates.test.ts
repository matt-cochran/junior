import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogIds, modelUpdates, piAgentDir } from './model-updates.ts';

const config=(roster:any[]):any=>({ provider:'openrouter', model:roster[0].model, source:'builtin', path:null, routing:'auto', autoUpgrade:false,
 defaultProfile:roster[0].id, roster, rejected:[], pinnedVerdict:{ class:'commodity' } });
const general={ id:'general', provider:'openrouter', model:'deepseek/deepseek-v4.1-flash', strengths:'s', default:true };
const kimi={ id:'long-horizon', provider:'openrouter', model:'moonshotai/kimi-k2.6', strengths:'s' };
const agentDir=(models:string[])=>{ const d=mkdtempSync(join(tmpdir(),'junior-mu-'));
 writeFileSync(join(d,'models-store.json'),JSON.stringify({ openrouter:{ models:models.map((id)=>({ id })) } })); return d; };

test('modelUpdates reports the newest same-lineage release as latest for the default profile',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017','deepseek/deepseek-v4-pro-0813']);
 assert.equal(u.latest,'deepseek/deepseek-v4.1-flash-1017');
});

test('modelUpdates reports no newer release when the pin is current',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4-flash-0731']);
 assert.deepEqual(u.newer,[]);
});

test('modelUpdates marks only the default profile as default',()=>{
 const updates=modelUpdates(config([general,kimi]),[]);
 assert.deepEqual(updates.map((u)=>u.isDefault),[true,false]);
});

test('modelUpdates reports newer releases for a non-default roster profile',()=>{
 const updates=modelUpdates(config([general,kimi]),['moonshotai/kimi-k3']);
 assert.equal(updates[1].latest,'moonshotai/kimi-k3');
});

test('modelUpdates ignores a profile on a non-OpenRouter provider',()=>{
 const [u]=modelUpdates(config([{ ...general, provider:'deepseek' }]),['deepseek/deepseek-v4.1-flash-1017']);
 assert.equal(u.latest,null);
});

test('piAgentDir honours PI_CODING_AGENT_DIR',()=>{
 assert.equal(piAgentDir({ PI_CODING_AGENT_DIR:'/x/agent' }),'/x/agent');
});

test('catalogIds uses the online catalog when it is requested and reachable',async()=>{
 const fetch=async()=>({ status:200, json:async()=>({ data:[{ id:'deepseek/deepseek-v4.1-flash-1017' }] }) });
 const r=await catalogIds({ online:true, fetch, env:{ PI_CODING_AGENT_DIR:agentDir([]) } });
 assert.equal(r.catalog,'online');
});

test('catalogIds falls back to the local Pi catalog when the online catalog is unreachable',async()=>{
 const fetch=async()=>({ status:503, json:async()=>({}) });
 const r=await catalogIds({ online:true, fetch, env:{ PI_CODING_AGENT_DIR:agentDir(['deepseek/deepseek-v4.1-flash']) } });
 assert.deepEqual(r,{ ids:['deepseek/deepseek-v4.1-flash'], catalog:'local' });
});

test('catalogIds reports no catalog when neither source is available',async()=>{
 const r=await catalogIds({ env:{ PI_CODING_AGENT_DIR:mkdtempSync(join(tmpdir(),'junior-mu-')) } });
 assert.equal(r.catalog,null);
});
