export type WebEventFeature =
  | 'web.document_view'
  | 'web.search_open'
  | 'web.citation_open'
  | 'web.chat_popup_open'
  | 'web.chat_split_open'
  | 'web.chat_page_open'
  | 'web.chat_history_open';

export function recordWebEvent(input: {
  feature: WebEventFeature;
  path?: string;
  parentEventId?: string | null;
}) {
  if (typeof window === 'undefined') return;

  const body = {
    feature: input.feature,
    ...(input.path ? { path: input.path } : {}),
    ...(input.parentEventId ? { parent_event_id: input.parentEventId } : {}),
  };

  void fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: true,
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export type MeasurementsReport = {
  schema_version?: number;
  generated_at?: string;
  started_at?: string;
  timezone?: string;
  range?: { start: string; end: string; days: number; today_partial?: boolean };
  retained_days?: number;
  status: 'measured' | 'not_collected' | 'disabled';
  measurement_status?: 'disabled';
  active_people: number | null;
  requests: number | null;
  service_requests?: number | null;
  search_to_open?: { searches: number; searches_with_click: number; rate: number | null };
  retention?: Array<{ day: number; eligible: number; returned: number; rate: number | null; status: string }>;
  features?: Array<{
    release: string;
    client: string;
    feature: string;
    requests: number;
    people: number;
    active_people_denominator: number;
    adoption_rate: number | null;
    errors: number;
    latency_samples?: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p95_status?: string;
    payload_tokens: number | null;
    paired_shadow?: {
      samples: number;
      legacy_tokens: number | null;
      new_tokens: number | null;
      reduction_rate: number | null;
      method: string;
      tokenizer: string;
    };
    provider_actual?: {
      samples: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_samples?: number;
      cached_tokens: number | null;
      reasoning_samples?: number;
      reasoning_tokens: number | null;
    };
    no_results?: number;
    truncated?: number;
  }>;
  daily?: Array<{ day: string; requests: number | null; people: number | null; status?: 'measured' | 'not_collected' }>;
  feedback?: {
    responses: number;
    positive: number;
    negative: number;
    positive_rate: number | null;
    eligible_answers: number;
    response_rate: number | null;
    reasons?: Array<{ reason: string; count: number }>;
    by_release?: Array<{ release: string; responses: number; positive: number }>;
  };
  instrumentation?: { dropped_events_this_process?: number };
  caveats?: string[];
};

export type ProductFeedbackItem = {
  id: string;
  ts: number;
  release: string;
  categories: string[];
  details: string;
  diagnostics?: { page_path: string; viewport_width: number; viewport_height: number } | null;
};
