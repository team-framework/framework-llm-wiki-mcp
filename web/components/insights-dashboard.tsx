'use client';

import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { MeasurementsReport, ProductFeedbackItem } from '@/lib/measurements';

type Days = '7' | '30' | '90';

const ranges: { value: Days; label: string }[] = [
  { value: '7', label: '7일' },
  { value: '30', label: '30일' },
  { value: '90', label: '90일' },
];

const categoryLabels: Record<string, string> = {
  bug: '오류',
  search_miss: '검색 누락',
  unclear_docs: '설명 개선',
  good_result: '좋은 결과',
  slow: '느린 응답',
  other: '기타',
};

const reasonLabels: Record<string, string> = {
  correct: '정확함',
  missing_context: '맥락 부족',
  outdated: '오래된 내용',
  irrelevant: '질문과 무관',
  slow: '느린 응답',
  other: '기타',
};

const caveatLabels: Record<string, string> = {
  'shadow estimates compare the returned evidence documents, not a historical user session or billing': '동일 evidence 문서의 전체 읽기와 새 payload를 비교한 shadow 추정치입니다. 과거 사용자 세션이나 결제액을 나타내지 않습니다.',
  'retention uses first observed activity within the retained 90 days; no cross-client identity matching for Discord': '재방문은 보관된 90일 안에서 처음 관측한 활동일을 기준으로 합니다. Discord와 웹 계정을 연결하지 않습니다.',
  'validation and service identities are excluded from people and retention; today is partial': '검증용·서비스 계정은 사용자 수와 재방문 집계에서 제외했습니다. 오늘 수치는 부분 집계입니다.',
};

const numberFormat = new Intl.NumberFormat('ko-KR');
const percent = (value: number | null | undefined) => value === null || value === undefined ? null : `${(value * 100).toFixed(1)}%`;
const count = (value: number | null | undefined) => value === null || value === undefined ? null : numberFormat.format(value);

function reportStatusLabel(report: MeasurementsReport) {
  if (report.status === 'disabled') return '계측을 사용할 수 없습니다.';
  if (report.status === 'not_collected') return '아직 수집 전입니다. 팀의 사용 기록이 생기면 이 기간에 표시됩니다.';
  return '선택한 기간의 집계입니다. 오늘은 진행 중인 날짜입니다.';
}

function displayed(value: number | null | undefined, report: MeasurementsReport, suffix = '') {
  if (report.status === 'disabled') return '사용 불가';
  if (report.status === 'not_collected') return '아직 수집 전';
  if (value === null || value === undefined) return '표본 없음';
  return `${count(value)}${suffix}`;
}

function percentLabel(value: number | null | undefined, report: MeasurementsReport) {
  if (report.status === 'disabled') return '사용 불가';
  if (report.status === 'not_collected') return '아직 수집 전';
  return percent(value) ?? '표본 없음';
}

function formatKst(timestamp: number | string | undefined) {
  if (timestamp === undefined) return '확인할 수 없음';
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '확인할 수 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function makeDays(start: string | undefined, end: string | undefined, days: number) {
  if (!start || !end) return [];
  const result: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (cursor <= stop && result.length < days) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function TableEmpty({ children, colSpan }: { children: string; colSpan: number }) {
  return <tr><td colSpan={colSpan}>{children}</td></tr>;
}

export function InsightsDashboard() {
  const [days, setDays] = useState<Days>('30');
  const [reload, setReload] = useState(0);
  const [report, setReport] = useState<MeasurementsReport | null>(null);
  const [feedback, setFeedback] = useState<ProductFeedbackItem[]>([]);
  const [feedbackDisabled, setFeedbackDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedbackLoading, setFeedbackLoading] = useState(true);
  const [error, setError] = useState<'unauthorized' | 'failed' | null>(null);
  const [feedbackError, setFeedbackError] = useState<'unauthorized' | 'failed' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/measurements?days=${days}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error('unauthorized');
        if (!response.ok) throw new Error('failed');
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || !['measured', 'not_collected', 'disabled'].includes(String((value as { status?: unknown }).status))) {
          throw new Error('failed');
        }
        setReport(value as MeasurementsReport);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error && reason.message === 'unauthorized' ? 'unauthorized' : 'failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, reload]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/product-feedback?limit=20', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error('unauthorized');
        if (!response.ok) throw new Error('failed');
        const value: unknown = await response.json();
        setFeedbackDisabled(Boolean(value && typeof value === 'object' && (value as { measurement_status?: unknown }).measurement_status === 'disabled'));
        const items = value && typeof value === 'object' && Array.isArray((value as { feedback?: unknown }).feedback)
          ? (value as { feedback: unknown[] }).feedback
          : [];
        setFeedback(items.filter((item): item is ProductFeedbackItem => Boolean(
          item && typeof item === 'object'
          && typeof (item as ProductFeedbackItem).id === 'string'
          && typeof (item as ProductFeedbackItem).details === 'string'
          && typeof (item as ProductFeedbackItem).ts === 'number',
        )));
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setFeedbackError(reason instanceof Error && reason.message === 'unauthorized' ? 'unauthorized' : 'failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setFeedbackLoading(false);
      });
    return () => controller.abort();
  }, []);

  function downloadJson() {
    if (!report) return;
    const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `wiki-measurements-${days}d-${report.range?.end ?? 'latest'}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (error === 'unauthorized' || feedbackError === 'unauthorized') {
    return (
      <div className="wiki-insights-status error" role="alert">
        사용 현황을 보려면 팀 계정으로 로그인하세요. <a href="/auth/github/login">GitHub 로그인</a>
      </div>
    );
  }

  const rows = report?.features ?? [];
  const daily = report?.daily ?? [];
  const byDay = new Map(daily.map((item) => [item.day, item]));
  const chartDays = makeDays(report?.range?.start, report?.range?.end, Number(days));
  const maxRequests = Math.max(1, ...chartDays.map((day) => byDay.get(day)?.requests ?? 0));

  return (
    <div className="wiki-insights">
      <div className="wiki-insights-header">
        <div>
          <div className="wiki-insights-generated">
            {report?.generated_at ? `마지막 집계 · ${formatKst(report.generated_at)} KST` : '집계 정보를 불러오고 있습니다.'}
          </div>
          {report?.range && <div className="wiki-insights-generated">집계 범위 · {report.range.start} ~ {report.range.end} · {report.timezone ?? 'Asia/Seoul'}</div>}
        </div>
        <div className="wiki-insights-actions">
          <label className="sr-only" htmlFor="wiki-insights-days">집계 기간</label>
          <select id="wiki-insights-days" value={days} onChange={(event) => setDays(event.target.value as Days)}>
            {ranges.map((range) => <option key={range.value} value={range.value}>{range.label}</option>)}
          </select>
          <button type="button" onClick={downloadJson} disabled={!report}>
            <Download size={14} aria-hidden="true" /> JSON 저장
          </button>
          <button type="button" onClick={() => setReload((current) => current + 1)} disabled={loading} aria-label="사용 현황 새로고침">
            <RefreshCw size={14} aria-hidden="true" /> 새로고침
          </button>
        </div>
      </div>

      {loading && <p className="wiki-insights-status" role="status">사용 현황을 불러오고 있습니다…</p>}
      {error === 'failed' && <p className="wiki-insights-status error" role="alert">사용 현황을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.</p>}
      {report && <p className="wiki-insights-status" role="status">{reportStatusLabel(report)}</p>}
      {report?.status === 'disabled' && <p className="wiki-insights-status">이 서버에는 계측 저장소가 설정되지 않았습니다.</p>}

      {report && (
        <>
          <section className="wiki-insights-kpis" aria-label="기간별 요약">
            <article className="wiki-insights-card">
              <span className="wiki-insights-kpi-label">활동한 팀원</span>
              <strong className="wiki-insights-kpi-value">{displayed(report.active_people, report)}</strong>
              <span className="wiki-insights-kpi-note">선택 기간에 위키를 사용한 계정</span>
            </article>
            <article className="wiki-insights-card">
              <span className="wiki-insights-kpi-label">전체 요청</span>
              <strong className="wiki-insights-kpi-value">{displayed(report.requests, report)}</strong>
              <span className="wiki-insights-kpi-note">사용자와 서비스 요청</span>
            </article>
            <article className="wiki-insights-card">
              <span className="wiki-insights-kpi-label">검색 후 문서 열기</span>
              <strong className="wiki-insights-kpi-value">{percentLabel(report.search_to_open?.rate, report)}</strong>
              <span className="wiki-insights-kpi-note">
                {report.status === 'not_collected' ? '검색 이벤트를 기록하면 비율을 표시합니다.' : report.search_to_open
                  ? `${count(report.search_to_open.searches_with_click)} / ${count(report.search_to_open.searches)}건의 검색에서 열기 기록`
                  : '표본 없음'}
              </span>
            </article>
            <article className="wiki-insights-card">
              <span className="wiki-insights-kpi-label">챗봇 답변 평가</span>
              <strong className="wiki-insights-kpi-value">{percentLabel(report.feedback?.positive_rate, report)}</strong>
              <span className="wiki-insights-kpi-note">
                {report.status === 'not_collected' ? '아직 수집 전' : report.feedback
                  ? `${count(report.feedback.positive)} 긍정 · ${count(report.feedback.negative)} 부정 · 응답 ${count(report.feedback.responses)}건`
                  : '표본 없음'}
              </span>
            </article>
          </section>

          <section className="wiki-insights-section">
            <h2>날짜별 사용량</h2>
            <p>막대는 기록된 하루 요청 수입니다. 점으로 표시한 날짜에는 관측 자료가 없습니다. 배포 전과 수집 중단 기간을 사용량 0으로 해석하지 않습니다.</p>
            {report.status !== 'measured' || chartDays.length === 0 ? (
              <div className="wiki-insights-status">{report.status === 'disabled' ? '사용할 수 있는 집계가 없습니다.' : '아직 수집 전'}</div>
            ) : (
              <div className="wiki-daily-chart" role="list" aria-label="날짜별 요청량">
                {chartDays.map((day) => {
                  const value = byDay.get(day) ?? { requests: null, people: null };
                  const missing = value.requests === null;
                  const height = value.requests ? Math.max(4, (value.requests / maxRequests) * 100) : 1;
                  const description = missing ? `${day}: 관측 자료 없음` : `${day}: 기록된 요청 ${count(value.requests)}건, 활동 팀원 ${count(value.people)}명`;
                  return (
                    <div
                      className="wiki-daily-column"
                      key={day}
                      role="listitem"
                      tabIndex={0}
                      aria-label={description}
                      title={description}
                    >
                      <div className="wiki-daily-bar-track">{missing ? <span aria-hidden="true">·</span> : <span className="wiki-daily-bar" style={{ height: `${height}%` }} />}</div>
                      <span className="wiki-daily-label">{day.slice(5)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="wiki-insights-section">
            <h2>재방문</h2>
            <p>최초 관측일을 기준으로 집계합니다. 하루·일주일이 모두 지난 팀원만 비율의 분모에 넣습니다. 오늘 결과는 KST 자정까지 확정하지 않습니다.</p>
            <div className="wiki-retention-grid">
              {[1, 7].map((day) => {
                const item = report.retention?.find((entry) => entry.day === day);
                const mature = item?.status === 'measured' && (item.eligible ?? 0) > 0;
                return (
                  <article className="wiki-insights-card" key={day}>
                    <span className="wiki-insights-kpi-label">D{day} 재방문율</span>
                    <strong className="wiki-retention-value">{report.status === 'disabled' ? '사용 불가' : report.status === 'not_collected' ? '아직 수집 전' : mature ? percent(item.rate) : '성숙한 코호트 없음'}</strong>
                    <div className="wiki-retention-count">
                      집계 대상 {report.status === 'disabled' ? '사용 불가' : report.status === 'not_collected' ? '아직 수집 전' : count(item?.eligible) ?? '표본 없음'}명 · 재방문 {report.status === 'disabled' ? '사용 불가' : report.status === 'not_collected' ? '아직 수집 전' : count(item?.returned) ?? '표본 없음'}명
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="wiki-insights-section">
            <h2>릴리스·기능별 통계</h2>
            <p>사람 사용량과 서비스 요청을 분리해 보고, 지연 시간 P95는 성공 표본 20건 이상일 때만 표시합니다.</p>
            <div className="wiki-table-scroll">
              <table className="wiki-insights-table">
                <thead><tr>
                  <th>릴리스 · 기능</th><th>클라이언트</th><th>요청</th><th>사용자 / 활성 사용자</th><th>채택률</th><th>오류</th><th>P50 / P95</th><th>검색 무결과 / 잘림</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <TableEmpty colSpan={8}>{report.status === 'disabled' ? '계측 저장소를 사용할 수 없습니다.' : '아직 수집 전'}</TableEmpty>
                  ) : rows.map((item, index) => (
                    <tr key={`${item.release}-${item.client}-${item.feature}-${index}`}>
                      <td><strong>{item.release}</strong><br /><code>{item.feature}</code></td>
                      <td>{item.client}</td>
                      <td>{count(item.requests)}</td>
                      <td>{count(item.people)} / {count(item.active_people_denominator)}</td>
                      <td>{percent(item.adoption_rate) ?? '표본 없음'}</td>
                      <td>{count(item.errors)}</td>
                      <td>{item.p95_status === 'not_applicable' || ['web.document_view','web.search_open','web.citation_open'].includes(item.feature) ? '측정 대상 아님' : <>{item.p50_ms === null ? '표본 없음' : `${count(item.p50_ms)} ms`} / {item.p95_ms === null ? (item.p95_status === 'insufficient_samples' ? '표본 부족' : '표본 없음') : `${count(item.p95_ms)} ms`}</>}</td>
                      <td>{item.feature.includes('search') ? `${count(item.no_results ?? 0)} / ${count(item.truncated ?? 0)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="wiki-insights-section">
            <h2>토큰 사용량</h2>
            <p>동일 evidence 비교는 반환한 문서를 기준으로 한 shadow 추정치입니다. Provider 실제 사용량은 응답에 포함된 입력·출력·캐시·추론 토큰 메타데이터로 집계합니다.</p>
            <div className="wiki-table-scroll">
              <table className="wiki-insights-table">
                <thead><tr>
                  <th>릴리스 · 기능</th><th>Shadow 비교 표본</th><th>기존 전체 읽기</th><th>새 payload</th><th>추정 감소율</th><th>Provider 표본</th><th>실제 입력</th><th>실제 출력</th><th>캐시 입력</th><th>추론</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? (
                    <TableEmpty colSpan={10}>{report.status === 'disabled' ? '계측 저장소를 사용할 수 없습니다.' : '아직 수집 전'}</TableEmpty>
                  ) : rows.map((item, index) => {
                    const shadow = item.paired_shadow;
                    const provider = item.provider_actual;
                    return (
                      <tr key={`${item.release}-${item.feature}-tokens-${index}`}>
                        <td><strong>{item.release}</strong><br /><code>{item.feature}</code></td>
                        <td>{count(shadow?.samples) ?? '표본 없음'}</td>
                        <td>{count(shadow?.legacy_tokens) ?? '표본 없음'}</td>
                        <td>{count(shadow?.new_tokens) ?? '표본 없음'}</td>
                        <td>{percent(shadow?.reduction_rate) ?? '표본 없음'}</td>
                        <td>{count(provider?.samples) ?? '표본 없음'}</td>
                        <td>{count(provider?.input_tokens) ?? '표본 없음'}</td>
                        <td>{count(provider?.output_tokens) ?? '표본 없음'}</td>
                        <td>{count(provider?.cached_tokens) ?? '표본 없음'}</td>
                        <td>{count(provider?.reasoning_tokens) ?? '표본 없음'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p>Shadow 방식 · 동일 evidence 문서의 전체 읽기와 새 payload 비교. `o200k_base` 토큰 수는 결제액이 아닙니다. Provider 열은 실제 호출 usage 기준입니다.</p>
          </section>

          <section className="wiki-insights-section">
            <h2>답변 평가와 이유</h2>
            {report.feedback ? (
              <div className="wiki-insights-card">
              {report.status === 'not_collected' ? (
                <p>아직 수집 전</p>
              ) : (
                <>
                  <p>평가 응답률 {percent(report.feedback.response_rate) ?? (report.status === 'disabled' ? '사용 불가' : '표본 없음')} · 대상 답변 {report.status === 'disabled' ? '사용 불가' : count(report.feedback.eligible_answers)}개</p>
                  <p>이유별 응답 · {(report.feedback.reasons ?? []).map((item) => `${reasonLabels[item.reason] ?? item.reason} ${count(item.count)}건`).join(' · ') || '표본 없음'}</p>
                </>
              )}
            </div>
          ) : <div className="wiki-insights-status">{report.status === 'not_collected' ? '아직 수집 전' : report.status === 'disabled' ? '계측 저장소를 사용할 수 없습니다.' : '표본 없음'}</div>}
          </section>

          <section className="wiki-insights-section" aria-labelledby="wiki-team-feedback-title">
            <h2 id="wiki-team-feedback-title">최근 팀 의견</h2>
            <p>작성자 정보는 표시하지 않습니다. 팀이 제출한 의견을 위키 개선에 활용합니다.</p>
            {feedbackLoading && <p className="wiki-insights-status" role="status">의견을 불러오고 있습니다…</p>}
            {feedbackError === 'failed' && <p className="wiki-insights-status error" role="alert">최근 의견을 불러오지 못했습니다.</p>}
            {!feedbackLoading && feedbackDisabled && <p className="wiki-insights-status">이 서버에서는 팀 의견 수집을 사용할 수 없습니다.</p>}
            {!feedbackLoading && !feedbackDisabled && feedback.length === 0 && <p className="wiki-insights-status">최근 의견이 없습니다.</p>}
            {feedback.length > 0 && (
              <div className="wiki-feedback-review-list">
                {feedback.map((item) => (
                  <article className="wiki-feedback-review-item" key={item.id}>
                    <div className="wiki-feedback-review-meta">
                      <span className="wiki-feedback-review-categories">{item.categories.map((category) => categoryLabels[category] ?? category).join(' · ')}</span>
                      <span>{formatKst(item.ts)} · {item.release}</span>
                    </div>
                    <p className="wiki-feedback-review-details">{item.details}</p>
                    {item.diagnostics && <p className="wiki-feedback-review-diagnostics">{item.diagnostics.page_path} · 화면 {item.diagnostics.viewport_width} × {item.diagnostics.viewport_height}</p>}
                  </article>
                ))}
              </div>
            )}
          </section>

          {report.caveats && report.caveats.length > 0 && (
            <section className="wiki-insights-section">
              <h2>집계 기준</h2>
              <ul>{report.caveats.map((caveat) => <li key={caveat}>{caveatLabels[caveat] ?? caveat}</li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
