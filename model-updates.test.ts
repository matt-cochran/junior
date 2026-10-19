import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogIds, modelUpdates, piAgentDir, priceComparable, priceDelta, readCachedCatalog } from './model-updates.ts';

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
 assert.deepEqual(r,{ ids:['deepseek/deepseek-v4.1-flash'], catalog:'local', prices:{}, sources:{} });
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

// --- price parity ----------------------------------------------------------

const pinPrice={ inputPerM:0.033, outputPerM:0.08, cacheReadPerM:null };

test('priceComparable is true for ratios 1.2/1.1 at tolerance 1.25',()=>{
 assert.equal(priceComparable({ inputRatio:1.2, outputRatio:1.1 },1.25),true);
});

test('priceComparable is false for ratios 4.57/7.5 at tolerance 1.25',()=>{
 assert.equal(priceComparable({ inputRatio:4.57, outputRatio:7.5 },1.25),false);
});

test('priceComparable is false when only the output ratio exceeds the tolerance',()=>{
 assert.equal(priceComparable({ inputRatio:1.1, outputRatio:1.6 },1.25),false);
});

test('priceComparable is null when the input ratio is unknown',()=>{
 assert.equal(priceComparable({ inputRatio:null, outputRatio:1.1 },1.25),null);
});

test('priceComparable is null when the output ratio is unknown',()=>{
 assert.equal(priceComparable({ inputRatio:1.1, outputRatio:null },1.25),null);
});

test('modelUpdates marks a newer release within tolerance as comparable',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017'],{ prices:{ [general.model]:pinPrice, 'deepseek/deepseek-v4.1-flash-1017':{ inputPerM:0.04, outputPerM:0.09, cacheReadPerM:null } } });
 assert.equal(u.comparable,true);
});

test('modelUpdates marks a pricier newer release as not comparable',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017'],{ prices:{ [general.model]:pinPrice, 'deepseek/deepseek-v4.1-flash-1017':{ inputPerM:0.15, outputPerM:0.6, cacheReadPerM:null } } });
 assert.equal(u.comparable,false);
});

test('modelUpdates reports a null comparable verdict when the newer price is unknown',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017'],{ prices:{ [general.model]:pinPrice } });
 assert.equal(u.comparable,null);
});

test('modelUpdates carries the update price delta on the entry',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017'],{ prices:{ [general.model]:pinPrice, 'deepseek/deepseek-v4.1-flash-1017':{ inputPerM:0.04, outputPerM:0.09, cacheReadPerM:null } } });
 assert.equal(u.price.inputRatio,1.21);
});

test('modelUpdates honours a roster price tolerance wider than the default',()=>{
 const relaxed={ ...config([general]), priceTolerance:2 };
 const [u]=modelUpdates(relaxed,['deepseek/deepseek-v4.1-flash-1017'],{ prices:{ [general.model]:pinPrice, 'deepseek/deepseek-v4.1-flash-1017':{ inputPerM:0.06, outputPerM:0.12, cacheReadPerM:null } } });
 assert.equal(u.comparable,true);
});

test('modelUpdates reports the endpoint provider on the price delta',()=>{
 const [u]=modelUpdates(config([general]),['deepseek/deepseek-v4.1-flash-1017'],{
  prices:{ [general.model]:pinPrice, 'deepseek/deepseek-v4.1-flash-1017':{ inputPerM:0.04, outputPerM:0.09, cacheReadPerM:null } },
  sources:{ 'deepseek/deepseek-v4.1-flash-1017':{ priceSource:'endpoint', provider:'Relace' } },
 });
 assert.equal(u.price.provider,'Relace');
});

// --- catalog endpoint prices -----------------------------------------------

const routedFetch=(catalogBody:any, endpointBody:any)=>async(url:string)=>{
 if (url.endsWith('/endpoints')) return { status:200, json:async()=>endpointBody };
 return { status:200, json:async()=>catalogBody };
};

const pricedCatalog={ data:[
 { id:'deepseek/deepseek-v4.1-flash', pricing:{ prompt:'0.000000033', completion:'0.00000008' } },
 { id:'deepseek/deepseek-v4.1-flash-1017', pricing:{ prompt:'0.00000015', completion:'0.0000006' } },
] };

const relaceEndpoints={ data:{ endpoints:[
 { provider_name:'Expensive', pricing:{ prompt:'0.00000015', completion:'0.0000006' }, supported_parameters:['tools'] },
 { provider_name:'Relace', pricing:{ prompt:'0.00000005', completion:'0.0000001' }, supported_parameters:['tools'] },
] } };

test('catalogIds prefers the cheapest tools-capable endpoint price over the headline price',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const r=await catalogIds({ online:true, fetch:routedFetch(pricedCatalog,relaceEndpoints), cachePath, config:config([general]) });
 assert.deepEqual(r.prices['deepseek/deepseek-v4.1-flash-1017'],{ inputPerM:0.05, outputPerM:0.1, cacheReadPerM:null });
});

test('catalogIds records the endpoint price source for a newest candidate',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const r=await catalogIds({ online:true, fetch:routedFetch(pricedCatalog,relaceEndpoints), cachePath, config:config([general]) });
 assert.equal(r.sources['deepseek/deepseek-v4.1-flash-1017']?.priceSource,'endpoint');
});

test('catalogIds records the endpoint provider for a newest candidate',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const r=await catalogIds({ online:true, fetch:routedFetch(pricedCatalog,relaceEndpoints), cachePath, config:config([general]) });
 assert.equal(r.sources['deepseek/deepseek-v4.1-flash-1017']?.provider,'Relace');
});

test('catalogIds keeps the headline price source when an endpoint has no tools',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 const noTools={ data:{ endpoints:[{ provider_name:'NoTools', pricing:{ prompt:'0.00000001', completion:'0.00000001' }, supported_parameters:[] }] } };
 const r=await catalogIds({ online:true, fetch:routedFetch(pricedCatalog,noTools), cachePath, config:config([general]) });
 assert.equal(r.sources['deepseek/deepseek-v4.1-flash-1017']?.priceSource,'headline');
});

test('catalogIds writes the endpoint-adjusted price into the cache',async()=>{
 const cachePath=join(mkdtempSync(join(tmpdir(),'junior-mu-')),'model-catalog.json');
 await catalogIds({ online:true, fetch:routedFetch(pricedCatalog,relaceEndpoints), cachePath, config:config([general]) });
 assert.equal(JSON.parse(readFileSync(cachePath,'utf8')).prices['deepseek/deepseek-v4.1-flash-1017'].inputPerM,0.05);
});
