import test from 'node:test';
import assert from 'node:assert/strict';
import { MeasurementStore, WikiMeasurements, kstDay, type MeasurementActor } from '../src/measurements.js';
import type { WikiService } from '../src/wiki.js';

const secret='private-test-identity-key-at-least-32-characters';
const actor=(identity:string,kind:'person'|'service'='person'):MeasurementActor=>({identity,kind,client:'web'});
const event={feature:'web.search',status:'ok' as const,latency_ms:15};

test('events retain numeric facts without raw identity, question, arbitrary string, or unknown usage',()=>{
  const store=new MeasurementStore(':memory:',secret,'test-release');
  try {
    store.record(actor('private-user'),{...event,payload_tokens:80,provider_input:100,provider_output:20,reason:'PRIVATE_QUERY',query:'PRIVATE_QUERY',document_hash:'/private/path',legacy_tokens:NaN} as any);
    const row=store.db.prepare('SELECT * FROM events').get() as any;
    assert.ok(!JSON.stringify(row).includes('PRIVATE_QUERY'));
    assert.ok(!JSON.stringify(row).includes('private-user'));
    assert.ok(!JSON.stringify(row).includes('/private/path'));
    assert.notEqual(store.actorKey('42','github'),store.actorKey('42','discord'));
    assert.notEqual(store.actorKey('42','github','service'),store.actorKey('42','github','person'));
    const report=store.report();
    assert.equal(report.features[0].provider_actual.cached_tokens,null);
    assert.equal(report.features[0].provider_actual.reasoning_tokens,null);
    assert.equal(report.features[0].p95_ms,null);
    assert.equal(report.features[0].paired_shadow.samples,0);
  } finally {store.close();}
});

test('retention uses completed KST days and excludes machine, validation and immature cohorts',()=>{
  let now=Date.parse('2026-10-01T10:00:00+09:00');
  const store=new MeasurementStore(':memory:',secret,'release','production',()=>now);
  try {
    store.record(actor('a'),event);store.record(actor('machine','service'),event);store.record(actor('integration-smoke'),event);
    now=Date.parse('2026-10-03T10:00:00+09:00');store.record(actor('b'),event);
    now=Date.parse('2026-10-08T10:00:00+09:00');store.record(actor('a'),event);
    now=Date.parse('2026-10-10T23:59:00+09:00');
    assert.deepEqual(store.report().retention.find(r=>r.day===7),{day:7,eligible:1,returned:1,rate:1,status:'measured'});
    assert.equal(store.report().active_people,2);
    assert.equal(kstDay(Date.parse('2026-10-10T15:00:00Z')),'2026-10-11');
    now=Date.parse('2026-10-11T00:00:01+09:00');
    assert.equal(store.report().retention.find(r=>r.day===7)?.eligible,2);
  } finally {store.close();}
});

test('feedback enforces ownership and service exclusion; revisions count as one response',()=>{
  const store=new MeasurementStore(':memory:',secret,'r');
  try {
    const id=store.record(actor('a'),{...event,feature:'web.chat'})!;
    assert.equal(store.feedback('b',id,'positive'),false);
    assert.equal(store.feedback('a',id,'negative','outdated'),true);
    assert.equal(store.feedback('a',id,'positive','correct'),true);
    const machine=store.record(actor('a','service'),{...event,feature:'web.chat'})!;
    assert.equal(store.feedback('a',machine,'positive'),false);
    const validation=store.record(actor('integration-smoke'),{...event,feature:'web.chat'})!;
    store.feedback('integration-smoke',validation,'positive');
    const report=store.report();assert.equal(report.feedback.responses,1);assert.equal(report.feedback.eligible_answers,1);
    assert.equal(report.feedback.positive_rate,1);
  } finally {store.close();}
});

test('paired token savings and search conversion use paired samples and distinct owned search events',()=>{
  const store=new MeasurementStore(':memory:',secret,'r');
  try {
    const search=store.record(actor('a'),{...event,payload_tokens:20,legacy_tokens:100,baseline_method:'same_evidence_documents_legacy_full_read'})!;
    store.record(actor('a'),{...event,payload_tokens:500});
    store.record(actor('a'),{...event,feature:'web.search_open',parent_event_id:search});
    store.record(actor('a'),{...event,feature:'web.search_open',parent_event_id:search});
    assert.equal(store.hasEvent('b',search,'web.search'),false);
    const report=store.report();
    assert.equal(report.features.find(f=>f.feature==='web.search')?.paired_shadow.reduction_rate,.8);
    assert.deepEqual(report.search_to_open,{searches:2,searches_with_click:1,rate:.5});
  } finally {store.close();}
});

test('optional comparison and retention failure preserve successful request events',async()=>{
  const store=new MeasurementStore(':memory:',secret,'r');
  const wiki={status:async()=>{throw new Error('git unavailable');}} as unknown as WikiService;
  try {
    store.prune=()=>{throw new Error('temporary maintenance failure');};
    const measured=await new WikiMeasurements(store,wiki,()=>true).run(actor('a'),'web.search',async()=>[]);
    assert.ok(measured.id);assert.equal(store.dropped,0);
    assert.equal((store.db.prepare('SELECT count(*) AS n FROM events').get() as any).n,1);
    await assert.rejects(new WikiMeasurements(store,wiki).run(actor('a'),'web.chat',async()=>{throw new Error('provider unavailable');}));
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM events WHERE status='error'").get() as any).n,1);
  } finally {store.close();}
});

test('missing observations remain null, product feedback is limited, and old rows expire',()=>{
  let now=Date.parse('2026-10-01T00:00:00Z');
  const store=new MeasurementStore(':memory:',secret,'r','production',()=>now);
  try {
    assert.equal(store.report().status,'not_collected');assert.equal(store.report().active_people,null);
    for(let i=0;i<10;i++) assert.ok(store.productFeedback('a',{categories:['bug'],details:'버튼이 가려집니다.'}));
    assert.equal(store.productFeedback('a',{categories:['bug'],details:'한도 초과'}),null);
    store.record(actor('a'),event);
    assert.equal(store.productFeedbackList().length,10);
    assert.ok(!JSON.stringify(store.productFeedbackList()).includes(store.actorKey('a')));
    now+=91*86400000;store.prune();
    assert.equal(store.productFeedbackList().length,0);assert.equal(store.report().status,'not_collected');
  } finally {store.close();}
});

test('daily reports distinguish unobserved days from measured person and service activity',()=>{
  let now=Date.parse('2026-09-29T10:00:00+09:00');
  const store=new MeasurementStore(':memory:',secret,'r','production',()=>now);
  try {
    const empty=store.report(30);
    assert.equal(empty.status,'not_collected');
    assert.equal(empty.daily.length,30);
    assert.equal(empty.daily[0].day,'2026-08-31');
    assert.equal(empty.daily.at(-1)?.day,'2026-09-29');
    assert.ok(empty.daily.every(row=>row.requests===null && row.people===null && row.status==='not_collected'));

    now=Date.parse('2026-09-26T10:00:00+09:00');
    store.record(actor('b'),{...event,status:'error'});
    now=Date.parse('2026-09-27T10:00:00+09:00');
    store.record(actor('integration-smoke'),event);
    now=Date.parse('2026-09-28T10:00:00+09:00');
    store.record(actor('machine','service'),event);
    now=Date.parse('2026-09-29T10:00:00+09:00');
    store.record(actor('a'),event);
    store.record(actor('a'),{...event,status:'error'});
    store.record(actor('b'),{...event,status:'error'});
    const measured=store.report(30);
    assert.equal(measured.status,'measured');
    assert.deepEqual(measured.daily.find(row=>row.day==='2026-09-26'),{day:'2026-09-26',requests:1,people:1,status:'measured'});
    assert.deepEqual(measured.daily.find(row=>row.day==='2026-09-27'),{day:'2026-09-27',requests:null,people:null,status:'not_collected'});
    assert.deepEqual(measured.daily.find(row=>row.day==='2026-09-28'),{day:'2026-09-28',requests:1,people:0,status:'measured'});
    assert.deepEqual(measured.daily.find(row=>row.day==='2026-09-29'),{day:'2026-09-29',requests:3,people:2,status:'measured'});
    assert.ok(measured.daily.filter(row=>row.day<'2026-09-26').every(row=>row.requests===null && row.people===null && row.status==='not_collected'));

    now=Date.parse('2026-09-30T00:00:01+09:00');
    const next=store.report(7);
    assert.deepEqual(next.daily.at(-1),{day:'2026-09-30',requests:null,people:null,status:'not_collected'});
    assert.equal(next.daily.find(row=>row.day==='2026-09-29')?.requests,3);
  } finally {store.close();}
});
