import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogIds, modelUpdates, piAgentDir, priceDelta, readCachedCatalog } from './model-updates.ts';

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
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const r=await catalogIds({ online:true, fetch, cachePath, env:{ PI_CODING_AGENT_DIR:agentDir([]) } });
 assert.equal(r.catalog,'online');
});

test('catalogIds falls back to the local Pi catalog when the online catalog is unreachable',async()=>{
 const fetch=async()=>({ status:503, json:async()=>({}) });
 const r=await catalogIds({ online:true, fetch, env:{ PI_CODING_AGENT_DIR:agentDir(['deepseek/deepseek-v4.1-flash']) } });
 assert.deepEqual(r,{ ids:['deepseek/deepseek-v4.1-flash'], catalog:'local', prices:{} });
});

test('catalogIds reports no catalog when neither source is available',async()=>{
 const r=await catalogIds({ env:{ PI_CODING_AGENT_DIR:mkdtempSync(join(tmpdir(),'junior-mu-')) } });
 assert.equal(r.catalog,null);
});

test('catalogIds writes the online catalog ids to the cache path',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const fetch=async()=>({ status:200, json:async()=>({ data:[{ id:'deepseek/deepseek-v4.1-flash-1017' }] }) });
 await catalogIds({ online:true, fetch, cachePath });
 assert.deepEqual(JSON.parse(readFileSync(cachePath,'utf8')).ids,['deepseek/deepseek-v4.1-flash-1017']);
});

test('readCachedCatalog returns null for a cache older than maxAgeMs',()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 writeFileSync(cachePath,JSON.stringify({ checkedAt:1000, ids:['deepseek/deepseek-v4.1-flash-1017'] }));
 assert.equal(readCachedCatalog({}, { cachePath, now:()=>1000+8*24*60*60*1000 }),null);
});

test('readCachedCatalog returns null for a malformed cache file',()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 writeFileSync(cachePath,'{ not json');
 assert.equal(readCachedCatalog({}, { cachePath }),null);
});

// --- model pricing ---------------------------------------------------------

const pricedFetch=(body:any)=>async()=>({ status:200, json:async()=>body });

test('catalogIds returns the online catalog prices keyed by id',async()=>{
 const fetch=pricedFetch({ data:[{ id:'a/b', pricing:{ prompt:'0.000000033', completion:'0.00000008', input_cache_read:'0.00000001' } }] });
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const r=await catalogIds({ online:true, fetch, cachePath });
 assert.deepEqual(r.prices,{ 'a/b':{ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:0.01 } });
});

test('catalogIds writes the online catalog prices into the cache',async()=>{
 const fetch=pricedFetch({ data:[{ id:'a/b', pricing:{ prompt:'0.000000033', completion:'0.00000008' } }] });
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 await catalogIds({ online:true, fetch, cachePath });
 assert.deepEqual(JSON.parse(readFileSync(cachePath,'utf8')).prices,{ 'a/b':{ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:null } });
});

test('catalogIds returns the local catalog prices keyed by id',async()=>{
 const d=agentDir([]);
 writeFileSync(join(d,'models-store.json'),JSON.stringify({ openrouter:{ models:[{ id:'a/b', cost:{ input:0.033, output:0.08, cacheRead:0.01 } }] } }));
 const r=await catalogIds({ env:{ PI_CODING_AGENT_DIR:d } });
 assert.deepEqual(r.prices,{ 'a/b':{ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:0.01 } });
});

test('readCachedCatalog returns empty prices for a cache without prices',()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 writeFileSync(cachePath,JSON.stringify({ checkedAt:1000, ids:['a/b'] }));
 const cached=readCachedCatalog({}, { cachePath, now:()=>1000 });
 assert.deepEqual(cached?.prices,{});
});

test('priceDelta marks a more expensive target as pricier',()=>{
 const d=priceDelta({ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:null },{ inputPerM:0.15, outputPerM:0.6, cacheReadPerM:null });
 assert.equal(d.pricier,true);
});

test('priceDelta reports the input ratio rounded to two decimals',()=>{
 const d=priceDelta({ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:null },{ inputPerM:0.15, outputPerM:0.6, cacheReadPerM:null });
 assert.equal(d.inputRatio,4.55);
});

test('priceDelta returns a null pricier verdict when a price is unknown',()=>{
 const d=priceDelta(null,{ inputPerM:0.15, outputPerM:0.6, cacheReadPerM:null });
 assert.equal(d.pricier,null);
});
