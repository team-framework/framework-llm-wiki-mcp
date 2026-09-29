import { createHmac, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import type { WikiService } from './wiki.js';
import { hashContent } from './sections.js';

const DAY = 86_400_000;
export const kstDay = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
export type MeasurementActor = { identity: string; kind: 'person' | 'service'; client: 'web' | 'mcp' | 'discord' };
export type Measurement = {
  feature: string; status: 'ok' | 'error'; latency_ms: number; corpus_commit?: string | null;
  payload_tokens?: number; legacy_tokens?: number; baseline_method?: string; result_count?: number;
  truncated?: boolean; retrieval_mode?: string; provider_input?: number; provider_output?: number;
  provider_cached?: number; provider_reasoning?: number; reason?: string; document_hash?: string; parent_event_id?: string; work_ms?: number;
};
const FEATURES = new Set(['web.search','web.chat','web.document_view','web.search_open','web.citation_open',
  'mcp.search_wiki','mcp.read_note','mcp.get_context','mcp.get_note_outline','mcp.read_sections','mcp.get_current_metrics',
  'discord.context','discord.note','discord.outline']);
const ratio = (a: number, b: number) => b ? a / b : null;
const quantile = (values: number[], p: number) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const FEEDBACK_REASONS = new Set(['correct','missing_context','outdated','irrelevant','slow','other']);
export type ProductFeedback = {categories: string[]; details: string; diagnostics?: {page_path: string; viewport_width: number; viewport_height: number}};

/** Only allowlisted aggregate facts enter this database. Never pass prompts or document bodies. */
export class MeasurementStore {
  readonly db: DatabaseSync;
  dropped = 0;
  private lastPrune = 0;
  constructor(readonly filename: string, readonly secret: string, readonly release: string, readonly mode = 'production', readonly now = () => Date.now()) {
    if (secret.length < 32) throw new Error('Measurement identity key must have at least 32 characters');
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
        actor TEXT NOT NULL, actor_kind TEXT NOT NULL, client TEXT NOT NULL, mode TEXT NOT NULL,
        release TEXT NOT NULL, feature TEXT NOT NULL, status TEXT NOT NULL, latency_ms REAL NOT NULL, facts TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_time ON events(ts);
      CREATE INDEX IF NOT EXISTS events_actor ON events(actor, day);
      CREATE TABLE IF NOT EXISTS feedback (event_id TEXT PRIMARY KEY, actor TEXT NOT NULL, ts INTEGER NOT NULL, rating TEXT NOT NULL, reason TEXT);
      CREATE INDEX IF NOT EXISTS feedback_time ON feedback(ts);
      CREATE TABLE IF NOT EXISTS product_feedback (id TEXT PRIMARY KEY,ts INTEGER NOT NULL,actor TEXT NOT NULL,mode TEXT NOT NULL,release TEXT NOT NULL,categories TEXT NOT NULL,details TEXT NOT NULL,diagnostics TEXT);
      CREATE INDEX IF NOT EXISTS product_feedback_time ON product_feedback(ts);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('started_at', new Date(this.now()).toISOString());
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('schema_version', '1');
  }
  actorKey(identity: string, namespace = 'github', kind = 'person') { return createHmac('sha256', this.secret).update(`${kind}:${namespace}:${identity}`).digest('hex'); }
  documentKey(source: string) { return createHmac('sha256', this.secret).update(`document:${source}`).digest('hex'); }
  record(actor: MeasurementActor, value: Measurement): string | null {
    if (!FEATURES.has(value.feature)) return null;
    try {
      const ts = this.now(), id = randomUUID();
      // Destructure explicitly: extra runtime properties cannot leak into stored JSON.
      const { corpus_commit, payload_tokens, legacy_tokens, baseline_method, result_count, truncated, retrieval_mode,
        provider_input, provider_output, provider_cached, provider_reasoning, reason, document_hash, parent_event_id, work_ms } = value;
      const facts = { corpus_commit: typeof corpus_commit==='string' && /^[a-f0-9]{40,64}$/.test(corpus_commit)?corpus_commit:null,
        payload_tokens:number(payload_tokens),legacy_tokens:number(legacy_tokens),result_count:number(result_count),work_ms:number(work_ms),
        baseline_method:baseline_method==='same_evidence_documents_legacy_full_read'?baseline_method:undefined,
        truncated:typeof truncated==='boolean'?truncated:undefined,retrieval_mode:['hybrid','lexical'].includes(retrieval_mode??'')?retrieval_mode:undefined,
        provider_input:number(provider_input),provider_output:number(provider_output),provider_cached:number(provider_cached),provider_reasoning:number(provider_reasoning),
        reason:FEEDBACK_REASONS.has(reason??'')?reason:undefined,document_hash:document_hash&&/^[a-f0-9]{64}$/.test(document_hash)?document_hash:undefined,
        parent_event_id:parent_event_id&&/^[a-f0-9-]{36}$/.test(parent_event_id)?parent_event_id:undefined };
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, ts, kstDay(ts), this.actorKey(actor.identity, 'github', actor.kind), actor.kind,
        actor.client, this.mode === 'production' && actor.identity !== 'integration-smoke' && actor.identity !== 'local-development' ? 'production' : 'validation',
        this.release.slice(0,100), value.feature, value.status, number(value.latency_ms)??0, JSON.stringify(facts));
      if (ts - this.lastPrune > DAY) { try { this.prune(); this.lastPrune = ts; } catch { /* Retention is retried by the hourly timer. */ } }
      return id;
    } catch { this.dropped++; return null; } // Observability failure must not break document access.
  }
  prune() {
    const before = this.now() - 90*DAY;
    this.db.prepare('DELETE FROM feedback WHERE event_id IN (SELECT id FROM events WHERE ts < ?)').run(before);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(before);
    this.db.prepare('DELETE FROM product_feedback WHERE ts < ?').run(before);
  }
  hasEvent(identity: string, eventId: string, feature: string) {
    return Boolean(this.db.prepare("SELECT id FROM events WHERE id=? AND actor=? AND actor_kind='person' AND client='web' AND feature=? AND status='ok'").get(eventId,this.actorKey(identity),feature));
  }
  feedback(identity: string, eventId: string, rating: 'positive' | 'negative', reason?: string) {
    const actor = this.actorKey(identity);
    const row = this.db.prepare("SELECT id FROM events WHERE id=? AND actor=? AND actor_kind='person' AND client='web' AND feature='web.chat' AND status='ok'").get(eventId, actor);
    if (!row) return false;
    this.db.prepare('INSERT INTO feedback VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET ts=excluded.ts,rating=excluded.rating,reason=excluded.reason')
      .run(eventId, actor, this.now(), rating, FEEDBACK_REASONS.has(reason??'')?reason!:null);
    return true;
  }
  productFeedback(identity: string, input: ProductFeedback) {
    const actor=this.actorKey(identity),now=this.now();
    if ((this.db.prepare('SELECT count(*) AS n FROM product_feedback WHERE actor=? AND ts>?').get(actor,now-DAY) as any).n>=10) return null;
    const categories=[...new Set(input.categories)].filter(v=>['bug','search_miss','unclear_docs','good_result','slow','other'].includes(v)).slice(0,3);
    if (!categories.length || !input.details.trim() || input.details.length>4000) throw new Error('Invalid feedback');
    const d=input.diagnostics;
    const diagnostics=d && /^\/docs(?:\/|$)/.test(d.page_path) && !/[?#]/.test(d.page_path) ? {page_path:d.page_path.slice(0,1000),viewport_width:number(d.viewport_width),viewport_height:number(d.viewport_height)}:null;
    const id=randomUUID();
    this.db.prepare('INSERT INTO product_feedback VALUES (?,?,?,?,?,?,?,?)').run(id,now,actor,
      this.mode==='production'&&identity!=='integration-smoke'&&identity!=='local-development'?'production':'validation',this.release.slice(0,100),JSON.stringify(categories),input.details.trim(),diagnostics?JSON.stringify(diagnostics):null);
    return id;
  }
  productFeedbackList(limit=20) {
    return this.db.prepare("SELECT id,ts,release,categories,details,diagnostics FROM product_feedback WHERE mode='production' AND ts>=? ORDER BY ts DESC LIMIT ?").all(this.now()-90*DAY,Math.min(100,Math.max(1,limit))).map((row:any)=>({...row,categories:JSON.parse(row.categories),diagnostics:row.diagnostics?JSON.parse(row.diagnostics):null}));
  }
  report(days = 30) {
    this.prune();
    const end = kstDay(this.now()), start = kstDay(this.now() - (days-1)*DAY);
    const rows = this.db.prepare("SELECT * FROM events WHERE mode='production' ORDER BY ts").all() as any[];
    const selected = rows.filter(row => row.day >= start && row.day <= end);
    const people = selected.filter(row => row.actor_kind === 'person');
    const active = new Set(people.map(row => row.actor));
    const groups = new Map<string, any[]>();
    for (const row of selected) { const key = `${row.release}\0${row.client}\0${row.feature}`; groups.set(key,[...(groups.get(key) ?? []),row]); }
    const features = [...groups.values()].map(group => {
      const facts = group.map(row => JSON.parse(row.facts));
      const paired = facts.filter(f => typeof f.legacy_tokens === 'number' && typeof f.payload_tokens === 'number');
      const baseline = paired.reduce((s,f)=>s+f.legacy_tokens,0), payload = paired.reduce((s,f)=>s+f.payload_tokens,0);
      const provider = facts.filter(f=>typeof f.provider_input === 'number' && typeof f.provider_output === 'number');
      const featurePeople = new Set(group.filter(r=>r.actor_kind==='person').map(r=>r.actor)).size;
      const denominator=new Set(people.filter(r=>r.release===group[0].release && r.client===group[0].client).map(r=>r.actor)).size;
      const successful=group.filter(r=>r.status==='ok');
      const cached=provider.filter(f=>typeof f.provider_cached==='number'),reasoning=provider.filter(f=>typeof f.provider_reasoning==='number');
      return { release: group[0].release, client: group[0].client, feature: group[0].feature, requests: group.length,
        first_seen_at:new Date(group[0].ts).toISOString(),last_seen_at:new Date(group.at(-1).ts).toISOString(),
        corpus_commits:[...new Set(facts.map(f=>f.corpus_commit).filter(Boolean))],
        people: featurePeople, active_people_denominator: denominator, adoption_rate: ratio(featurePeople,denominator),
        errors: group.filter(r=>r.status==='error').length, latency_samples:successful.length,
        p50_ms: quantile(successful.map(r=>r.latency_ms),.5), p95_ms: successful.length>=20?quantile(successful.map(r=>r.latency_ms),.95):null,
        p95_status:successful.length>=20?'measured':'insufficient_samples',
        payload_tokens: facts.some(f=>typeof f.payload_tokens==='number') ? facts.reduce((s,f)=>s+(f.payload_tokens??0),0) : null,
        paired_shadow: { samples: paired.length, legacy_tokens: paired.length ? baseline : null, new_tokens: paired.length ? payload : null,
          reduction_rate: ratio(baseline-payload,baseline), method: 'same_evidence_documents_legacy_full_read', tokenizer: 'o200k_base' },
        provider_actual: { samples: provider.length, input_tokens: provider.length ? provider.reduce((s,f)=>s+f.provider_input,0) : null,
          output_tokens: provider.length ? provider.reduce((s,f)=>s+f.provider_output,0) : null,
          cached_samples:cached.length,cached_tokens:cached.length?cached.reduce((s,f)=>s+f.provider_cached,0):null,
          reasoning_samples:reasoning.length,reasoning_tokens:reasoning.length?reasoning.reduce((s,f)=>s+f.provider_reasoning,0):null },
        no_results: facts.filter(f=>f.result_count===0).length, truncated: facts.filter(f=>f.truncated===true).length };
    });
    const first = new Map<string,string>(), visits = new Map<string,Set<string>>();
    for (const row of rows.filter(r=>r.actor_kind==='person')) {
      if (!first.has(row.actor)) first.set(row.actor,row.day);
      if (!visits.has(row.actor)) visits.set(row.actor,new Set()); visits.get(row.actor)!.add(row.day);
    }
    const retention = [1,7].map(offset => {
      let eligible=0, returned=0;
      for (const [actor,day] of first) {
        const target = new Date(Date.parse(`${day}T00:00:00Z`)+offset*DAY).toISOString().slice(0,10);
        // Today's cohort outcome is incomplete until KST midnight.
        if (day < start || day > end || target >= end) continue;
        eligible++; if (visits.get(actor)!.has(target)) returned++;
      }
      return { day: offset, eligible, returned, rate: ratio(returned,eligible), status: eligible ? 'measured' : 'no_mature_cohort' };
    });
    const daily = [...new Set(selected.map(r=>r.day))].map(day=>({ day, requests:selected.filter(r=>r.day===day).length,
      people:new Set(people.filter(r=>r.day===day).map(r=>r.actor)).size }));
    const feedback = this.db.prepare("SELECT f.rating,f.reason,e.release FROM feedback f JOIN events e ON e.id=f.event_id WHERE e.mode='production' AND e.actor_kind='person' AND e.client='web' AND e.day>=? AND e.day<=?").all(start,end) as any[];
    const chatAnswers = people.filter(r=>r.feature==='web.chat' && r.status==='ok' && r.client==='web').length;
    const positive=feedback.filter(r=>r.rating==='positive').length;
    const searches=new Set(people.filter(r=>r.feature==='web.search'&&r.status==='ok').map(r=>r.id));
    const clicked=new Set(people.filter(r=>r.feature==='web.search_open').map(r=>JSON.parse(r.facts).parent_event_id).filter(id=>searches.has(id)));
    return { schema_version:1, generated_at:new Date(this.now()).toISOString(), started_at:(this.db.prepare("SELECT value FROM metadata WHERE key='started_at'").get() as any).value,
      timezone:'Asia/Seoul', range:{start,end,days,today_partial:true}, retained_days:90, status:selected.length?'measured':'not_collected',
      active_people:selected.length?active.size:null, requests:selected.length?selected.length:null, service_requests:selected.length?selected.filter(r=>r.actor_kind==='service').length:null,
      search_to_open:{searches:searches.size,searches_with_click:clicked.size,rate:ratio(clicked.size,searches.size)},
      retention, features, daily, feedback:{responses:feedback.length,positive,negative:feedback.length-positive,positive_rate:ratio(positive,feedback.length),
        eligible_answers:chatAnswers,response_rate:ratio(feedback.length,chatAnswers),reasons:[...FEEDBACK_REASONS].map(reason=>({reason,count:feedback.filter(f=>f.reason===reason).length})),by_release:[...new Set(feedback.map(f=>f.release))].map(release=>({release,responses:feedback.filter(f=>f.release===release).length,positive:feedback.filter(f=>f.release===release&&f.rating==='positive').length}))},
      instrumentation:{dropped_events_this_process:this.dropped},
      definitions:{version:'1',identity:'github_login_hmac',tokenizer:'o200k_base',tokenizer_package:'gpt-tokenizer@4.0.0',shadow_sample_probability:.2,
        retention:'first_observed_in_retained_90_days_exact_KST_day',latency:'successful_handler_including_measurement_work_excluding_network'},
      caveats:['shadow estimates compare the returned evidence documents, not a historical user session or billing','retention uses first observed activity within the retained 90 days; no cross-client identity matching for Discord','validation and service identities are excluded from people and retention; today is partial'] };
  }
  close() { this.db.close(); }
}

export class WikiMeasurements {
  private corpus = { at:0, commit:null as string|null };
  private readonly legacyCache = new Map<string,number>();
  constructor(readonly store: MeasurementStore, readonly wiki: WikiService, readonly sample = () => Math.random()<.2) {}
  async run<T>(actor: MeasurementActor, feature: string, task: () => Promise<T>): Promise<{value:T;id:string|null}> {
    const start = performance.now();
    let value: T;
    try { value = await task(); }
    catch (error) { this.store.record(actor,{feature,status:'error',latency_ms:performance.now()-start}); throw error; }
    const result = value as any, usage = result?.usage;
    const measure: Measurement = {feature,status:'ok',latency_ms:performance.now()-start,work_ms:performance.now()-start,
      result_count:Array.isArray(result)?result.length:result?.evidence?.length, truncated:result?.truncated??result?.context_truncated,
      retrieval_mode:result?.retrieval?.mode,provider_input:usage?.input_tokens,provider_output:usage?.output_tokens,
      provider_cached:usage?.input_tokens_details?.cached_tokens,provider_reasoning:usage?.output_tokens_details?.reasoning_tokens};
    try {
      measure.payload_tokens=countTokens(JSON.stringify(value));
      if (Date.now()-this.corpus.at>60_000) this.corpus={at:Date.now(),commit:(await this.wiki.status()).wiki_commit};
      measure.corpus_commit=this.corpus.commit;
      const evidence = result?.evidence;
      if (Array.isArray(evidence) && evidence.length && this.sample()) {
        const paths = [...new Set(evidence.map((item:any)=>item.path))] as string[];
        let baseline=0, paired=true;
        for (const source of paths) {
          const note=await this.wiki.getNote(source);
          if (evidence.some((item:any)=>item.path===source && item.note_hash!==note.note_hash)) { paired=false; break; }
          const {note_hash:_hash,display:_display,...legacy}=note;
          const serialized=JSON.stringify(legacy,null,2),cacheKey=hashContent(serialized);
          if (!this.legacyCache.has(cacheKey)) {
            if (this.legacyCache.size>=1024) this.legacyCache.clear();
            this.legacyCache.set(cacheKey,countTokens(serialized));
          }
          baseline+=this.legacyCache.get(cacheKey)!;
        }
        if (paired) { measure.legacy_tokens=baseline; measure.baseline_method='same_evidence_documents_legacy_full_read'; }
      }
    } catch { /* Optional comparison failure leaves the request outcome observable. */ }
    measure.latency_ms=performance.now()-start;
    const id=this.store.record(actor,measure);
    return {value,id};
  }
}
