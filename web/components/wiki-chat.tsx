'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ExternalLink, History, LoaderCircle, Maximize2, MessageSquareText, Minimize2, Plus, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { friendlyDocumentTitle, headingId, documentHref } from '@/lib/links';
import { WikiMarkdown } from '@/components/wiki-markdown';
import { recordWebEvent } from '@/lib/measurements';
import { useChatPopupSize } from './chat-popup-resize';

type Reasoning = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Citation = { path: string; title: string; section?: string; url?: string };
type FeedbackReason = 'correct' | 'missing_context' | 'outdated' | 'irrelevant' | 'slow' | 'other';
type FeedbackChoice = 'positive' | 'negative';
type ChatMessage = {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  author?: string;
  sources?: Citation[];
  measurementId?: string;
  canFeedback?: boolean;
  feedbackChoice?: FeedbackChoice;
  feedbackReason?: FeedbackReason;
  feedbackSaved?: boolean;
  feedbackSaving?: boolean;
  feedbackError?: boolean;
};
type Conversation = {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  version: number;
  message_count: number;
};
type MessagePage = { conversation: Conversation; messages: ChatMessage[]; nextBeforeSeq: string | null };
type PanelMode = 'closed' | 'popup' | 'split' | 'mobile-full';
type Notice = { kind: 'info' | 'error'; text: string; retry?: boolean };

const reasoningOptions: { value: Reasoning; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '매우 높음' },
  { value: 'max', label: '최대' },
];

const feedbackReasons: { value: FeedbackReason; label: string }[] = [
  { value: 'correct', label: '정확하고 도움이 됐어요' },
  { value: 'missing_context', label: '맥락이 부족해요' },
  { value: 'outdated', label: '내용이 오래됐어요' },
  { value: 'irrelevant', label: '질문과 맞지 않아요' },
  { value: 'slow', label: '응답이 늦었어요' },
  { value: 'other', label: '기타' },
];

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function timestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function parseConversation(value: unknown): Conversation | null {
  const item = objectValue(value);
  if (!item || typeof item.id !== 'string') return null;
  return {
    id: item.id,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : '새 대화',
    created_at: timestampValue(item.created_at),
    updated_at: timestampValue(item.updated_at),
    version: typeof item.version === 'number' && Number.isFinite(item.version) ? item.version : 0,
    message_count: typeof item.message_count === 'number' && Number.isFinite(item.message_count) ? item.message_count : 0,
  };
}

function parseCitation(value: unknown): Citation | null {
  const item = objectValue(value);
  if (!item || typeof item.path !== 'string' || typeof item.title !== 'string') return null;
  return {
    path: item.path,
    title: item.title,
    ...(typeof item.section === 'string' ? { section: item.section } : {}),
    ...(typeof item.url === 'string' ? { url: item.url } : {}),
  };
}

function parseMessage(value: unknown): ChatMessage | null {
  const item = objectValue(value);
  if (!item || (item.role !== 'user' && item.role !== 'assistant') || typeof item.content !== 'string') return null;
  const seq = typeof item.seq === 'number' && Number.isFinite(item.seq) ? item.seq : 0;
  const sources = Array.isArray(item.sources) ? item.sources.map(parseCitation).filter((source): source is Citation => source !== null) : [];
  return {
    id: typeof item.id === 'string' ? item.id : String(item.seq ?? item.role) + '-' + item.role,
    seq,
    role: item.role,
    content: item.content,
    ...(typeof item.author === 'string' && item.author.trim() ? { author: item.author } : {}),
    ...(sources.length ? { sources } : {}),
    ...(typeof item.measurement_id === 'string' ? { measurementId: item.measurement_id } : {}),
    ...(item.can_feedback === true ? { canFeedback: true } : {}),
  };
}

function parseMessagePage(value: unknown): MessagePage | null {
  const item = objectValue(value);
  const conversation = parseConversation(item?.conversation);
  if (!item || !conversation || !Array.isArray(item.messages)) return null;
  const messages = item.messages.map(parseMessage).filter((message): message is ChatMessage => message !== null).sort((a, b) => a.seq - b.seq);
  const next = item.next_before_seq;
  return {
    conversation,
    messages,
    nextBeforeSeq: typeof next === 'string' || typeof next === 'number' ? String(next) : null,
  };
}

function citationHref(source: Citation) {
  const suppliedUrl = source.url?.trim();
  if (suppliedUrl?.startsWith('/') && !suppliedUrl.startsWith('//')) return suppliedUrl;
  if (suppliedUrl?.startsWith('https://')) return suppliedUrl;
  const base = documentHref(source.path);
  return source.section ? base + '#' + encodeURIComponent(headingId(source.section)) : base;
}

function withConversation(href: string, conversationId?: string) {
  if (!conversationId || !href.startsWith('/docs') || href.startsWith('//')) return href;
  const [pathAndSearch, hash] = href.split('#', 2);
  const queryIndex = pathAndSearch.indexOf('?');
  const pathname = queryIndex < 0 ? pathAndSearch : pathAndSearch.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? '' : pathAndSearch.slice(queryIndex + 1));
  params.set('conversation', conversationId);
  return pathname + '?' + params.toString() + (hash ? '#' + hash : '');
}

function sourceLinkLabel(source: Citation) {
  const title = friendlyDocumentTitle(source.title, source.path);
  return source.section ? title + ' · ' + source.section : title;
}

function dateLabel(timestamp: number) {
  try {
    return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp);
  } catch {
    return '';
  }
}

function conversationHref(path: string, conversationId?: string | null, from?: string) {
  const params = new URLSearchParams();
  if (conversationId) params.set('conversation', conversationId);
  if (from) params.set('from', from);
  const query = params.toString();
  return path + (query ? '?' + query : '');
}

type ChatSurfaceProps = {
  variant: 'popup' | 'split' | 'mobile-full' | 'full';
  messages: ChatMessage[];
  activeConversation: Conversation | null;
  conversations: Conversation[];
  conversationsLoading: boolean;
  conversationsLoadingMore: boolean;
  conversationCursor: string | null;
  historyError: string | null;
  messagesLoading: boolean;
  loadingOlder: boolean;
  olderCursor: string | null;
  sending: boolean;
  pendingMessage: string | null;
  draft: string;
  reasoning: Reasoning;
  notice: Notice | null;
  authRequired: boolean;
  splitRatio: number;
  pathname: string;
  onClose: () => void;
  onOpenSplit: () => void;
  onOpenPopup: () => void;
  onOpenFullPage: () => void;
  onReturnToDocs: () => void;
  onNewConversation: () => void;
  onSelectConversation: (id: string) => void;
  onLoadConversations: () => void;
  onLoadOlder: () => void;
  onDraftChange: (value: string) => void;
  onReasoningChange: (value: Reasoning) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onFeedback: (messageId: string, patch: Partial<ChatMessage>, save?: boolean) => void;
  formRef: React.RefObject<HTMLFormElement | null>;
};

function HistoryPanel(props: Pick<ChatSurfaceProps,
  'conversations' | 'conversationsLoading' | 'conversationsLoadingMore' | 'conversationCursor'
  | 'historyError' | 'activeConversation' | 'onSelectConversation' | 'onLoadConversations' | 'sending'
>) {
  const [search, setSearch] = useState('');
  const searchId = useId();
  const query = search.trim().toLocaleLowerCase('ko-KR');
  const visible = props.conversations.filter((conversation) => conversation.title.toLocaleLowerCase('ko-KR').includes(query));

  return (
    <aside className="wiki-chat-history-panel" aria-label="팀 공유 대화 목록">
      <div className="wiki-chat-history-heading">
        <strong>팀 대화</strong>
        <span>{props.conversations.length.toLocaleString('ko-KR')}개</span>
      </div>
      <label className="wiki-chat-history-search-label" htmlFor={searchId}>불러온 대화 검색</label>
      <input
        id={searchId}
        className="wiki-chat-history-search"
        type="search"
        placeholder="대화 제목 검색"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="wiki-chat-history-list">
        {props.conversationsLoading && props.conversations.length === 0 && <p className="wiki-chat-history-status" role="status">팀 대화를 불러오고 있습니다…</p>}
        {props.historyError && <p className="wiki-chat-history-status error" role="alert">{props.historyError}</p>}
        {!props.conversationsLoading && !props.historyError && visible.length === 0 && (
          <p className="wiki-chat-history-status">{query ? '검색한 대화가 없습니다.' : '아직 팀 대화가 없습니다.'}</p>
        )}
        {visible.length > 0 && (
          <ul className="wiki-chat-history-items">
            {visible.map((conversation) => (
              <li key={conversation.id}>
                <button
                  className={'wiki-chat-history-item' + (props.activeConversation?.id === conversation.id ? ' selected' : '')}
                  type="button"
                  aria-current={props.activeConversation?.id === conversation.id ? 'true' : undefined}
                  onClick={() => props.onSelectConversation(conversation.id)}
                  disabled={props.sending}
                >
                  <strong>{conversation.title}</strong>
                  <span>{dateLabel(conversation.updated_at)} · {conversation.message_count.toLocaleString('ko-KR')}개 메시지</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.conversationCursor && (
        <button
          className="wiki-chat-history-more"
          type="button"
          onClick={props.onLoadConversations}
          disabled={props.conversationsLoadingMore}
        >
          {props.conversationsLoadingMore ? <><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> 불러오는 중…</> : '이전 대화 더 보기'}
        </button>
      )}
    </aside>
  );
}

function ChatMessageView({ message, conversationId, onFeedback }: {
  message: ChatMessage;
  conversationId?: string;
  onFeedback: ChatSurfaceProps['onFeedback'];
}) {
  const reasonId = useId();

  return (
    <article className={'wiki-chat-message wiki-chat-message-' + message.role} data-message-id={message.id}>
      {message.author && message.role === 'user' && <span className="wiki-chat-message-author">{message.author}</span>}
      {message.role === 'assistant' ? <WikiMarkdown markdown={message.content} /> : message.content}
      {message.sources && message.sources.length > 0 && (
        <div className="wiki-chat-citations" aria-label="참고 문서">
          {message.sources.map((source, sourceIndex) => {
            const href = withConversation(citationHref(source), conversationId);
            const external = href.startsWith('https://');
            const citationContent = (
              <>
                {sourceLinkLabel(source)}
                {external && <ExternalLink size={12} aria-hidden="true" />}
              </>
            );
            const onClick = () => recordWebEvent({
                  feature: 'web.citation_open',
                  path: source.path,
                  parentEventId: message.measurementId,
                });
            return external ? (
              <a className="wiki-chat-citation" href={href} key={source.path + '-' + (source.section ?? sourceIndex)} target="_blank" rel="noopener noreferrer" onClick={onClick}>
                {citationContent}
              </a>
            ) : (
              <Link className="wiki-chat-citation" href={href} key={source.path + '-' + (source.section ?? sourceIndex)} onClick={onClick}>
                {citationContent}
              </Link>
            );
          })}
        </div>
      )}
      {message.role === 'assistant' && message.measurementId && message.canFeedback && (
        <div className="wiki-answer-feedback" aria-label="답변 평가">
          {message.feedbackSaved ? (
            <span className="wiki-answer-feedback-saved" role="status">평가를 기록했습니다.</span>
          ) : (
            <>
              <button
                type="button"
                className={message.feedbackChoice === 'positive' ? 'selected' : ''}
                aria-pressed={message.feedbackChoice === 'positive'}
                onClick={() => onFeedback(message.id, { feedbackChoice: 'positive', feedbackError: false }, true)}
                disabled={message.feedbackSaving}
              >
                <ThumbsUp size={14} aria-hidden="true" /> 도움이 됐어요
              </button>
              <button
                type="button"
                className={message.feedbackChoice === 'negative' ? 'selected' : ''}
                aria-pressed={message.feedbackChoice === 'negative'}
                onClick={() => onFeedback(message.id, { feedbackChoice: 'negative', feedbackError: false })}
                disabled={message.feedbackSaving}
              >
                <ThumbsDown size={14} aria-hidden="true" /> 아쉬워요
              </button>
              {message.feedbackChoice === 'negative' && (
                <div className="wiki-answer-feedback-reason">
                  <label htmlFor={reasonId}>어떤 점이 아쉬웠나요?</label>
                  <select
                    id={reasonId}
                    value={message.feedbackReason ?? ''}
                    onChange={(event) => onFeedback(message.id, { feedbackReason: event.target.value ? event.target.value as FeedbackReason : undefined })}
                    disabled={message.feedbackSaving}
                  >
                    <option value="">이유 선택 (선택 사항)</option>
                    {feedbackReasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
                  </select>
                  <button type="button" onClick={() => onFeedback(message.id, {}, true)} disabled={message.feedbackSaving}>
                    {message.feedbackSaving ? '기록 중…' : '평가 보내기'}
                  </button>
                </div>
              )}
            </>
          )}
          {message.feedbackError && <span className="wiki-answer-feedback-error" role="alert">평가를 기록하지 못했습니다. 다시 시도해 주세요.</span>}
        </div>
      )}
    </article>
  );
}

function ChatSurface(props: ChatSurfaceProps) {
  const titleId = useId();
  const { sizeStyle, resizeHandle } = useChatPopupSize(props.variant === 'popup');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pendingScrollRef = useRef<{ height: number; top: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(props.variant === 'full');
  const isFull = props.variant === 'full';
  const showHistory = historyOpen;
  const isMobileFull = props.variant === 'mobile-full';
  const pathLabel = props.pathname.startsWith('/docs') ? '문서와 함께' : '위키와 함께';

  useEffect(() => {
    if (window.matchMedia('(max-width: 760px)').matches) setHistoryOpen(false);
  }, []);

  useEffect(() => {
    if (!isFull && document.activeElement?.getAttribute('aria-label') === '위키 Agent 열기') textareaRef.current?.focus();
  }, [isFull]);

  useLayoutEffect(() => {
    const target = messagesRef.current;
    if (!target) return;
    if (pendingScrollRef.current && !props.loadingOlder) {
      const before = pendingScrollRef.current;
      target.scrollTop = before.top + target.scrollHeight - before.height;
      pendingScrollRef.current = null;
      return;
    }
    if (!props.messagesLoading && !props.loadingOlder) target.scrollTop = target.scrollHeight;
  }, [props.messages.length, props.messagesLoading, props.loadingOlder, props.pendingMessage]);

  function loadOlder() {
    const target = messagesRef.current;
    if (target) pendingScrollRef.current = { height: target.scrollHeight, top: target.scrollTop };
    props.onLoadOlder();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      props.formRef.current?.requestSubmit();
    }
  }

  const classes = [
    'wiki-chat-panel',
    'wiki-chat-panel-' + props.variant,
    isFull ? 'wiki-chat-panel-full' : '',
  ].filter(Boolean).join(' ');

  return (
    <section
      className={classes}
      role={isFull ? 'main' : 'dialog'}
      aria-labelledby={titleId}
      style={props.variant === 'popup' ? sizeStyle : undefined}
      onKeyDown={(event) => {
        if (!isFull && event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented && !document.querySelector('dialog[open]')) props.onClose();
      }}
    >
      {props.variant === 'popup' && resizeHandle}
      <header className="wiki-chat-header">
        <div className="wiki-chat-heading">
          <p className="wiki-chat-title" id={titleId}>위키 Agent</p>
          <p className="wiki-chat-subtitle">문서 근거와 팀 대화 기록을 함께 확인합니다</p>
        </div>
        <div className="wiki-chat-toolbar" aria-label="대화 도구">
          {(
            <button
              className="wiki-icon-button"
              type="button"
              aria-label={showHistory ? '대화 목록 닫기' : '팀 대화 목록 열기'}
              aria-expanded={showHistory}
              title="팀 대화 목록"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History size={17} aria-hidden="true" />
            </button>
          )}
          <button className="wiki-icon-button" type="button" aria-label="새 대화" title="새 대화" onClick={props.onNewConversation} disabled={props.sending}>
            <Plus size={18} aria-hidden="true" />
          </button>
          {props.variant === 'popup' && (
            <button className="wiki-chat-toolbar-wide" type="button" onClick={props.onOpenSplit} title="문서와 나란히 보기">
              문서와 나란히
            </button>
          )}
          {props.variant === 'split' && (
            <button className="wiki-icon-button" type="button" aria-label="작은 대화 창으로 전환" title="작은 대화 창" onClick={props.onOpenPopup}>
              <Minimize2 size={17} aria-hidden="true" />
            </button>
          )}
          {!isFull && (
            <button className="wiki-icon-button" type="button" aria-label="전체 화면 대화 열기" title="전체 화면" onClick={props.onOpenFullPage}>
              <Maximize2 size={17} aria-hidden="true" />
            </button>
          )}
          {isFull ? (
            <button className="wiki-chat-return-link" type="button" onClick={props.onReturnToDocs}>문서로 돌아가기</button>
          ) : (
            <button className="wiki-icon-button" type="button" aria-label="위키 Agent 닫기" title="닫기" onClick={props.onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <div className={'wiki-chat-body' + (showHistory ? ' wiki-chat-body-with-history' : '')}>
        {showHistory && (
          <HistoryPanel
            conversations={props.conversations}
            conversationsLoading={props.conversationsLoading}
            conversationsLoadingMore={props.conversationsLoadingMore}
            conversationCursor={props.conversationCursor}
            historyError={props.historyError}
            activeConversation={props.activeConversation}
            onSelectConversation={(id) => {
              props.onSelectConversation(id);
              if (props.variant === 'popup' || window.matchMedia('(max-width: 760px)').matches) setHistoryOpen(false);
            }}
            onLoadConversations={props.onLoadConversations}
            sending={props.sending}
          />
        )}

        <div className="wiki-chat-conversation">
          <div className="wiki-chat-settings">
            <label htmlFor={titleId + '-reasoning'}>추론 수준</label>
            <select
              id={titleId + '-reasoning'}
              aria-label="추론 수준 선택"
              value={props.reasoning}
              onChange={(event) => props.onReasoningChange(event.target.value as Reasoning)}
              disabled={props.sending}
            >
              {reasoningOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>

          <p className="wiki-chat-shared-notice" role="note">
            이 대화 기록은 로그인한 팀원이 함께 볼 수 있습니다. 민감한 정보는 입력하지 마세요.
          </p>

          {props.notice && (
            <p className={'wiki-chat-error wiki-chat-notice-' + props.notice.kind} role={props.notice.kind === 'error' ? 'alert' : 'status'}>
              {props.notice.text}
              {props.notice.retry && (
                <button type="button" onClick={() => props.formRef.current?.requestSubmit()} disabled={props.sending}>이 질문 다시 보내기</button>
              )}
            </p>
          )}
          {props.authRequired && (
            <p className="wiki-chat-error wiki-chat-auth" role="alert">
              대화 기록을 보려면 <a href="/auth/github/login">GitHub 로그인</a>이 필요합니다.
            </p>
          )}

          <div className="wiki-chat-messages" ref={messagesRef} aria-live="polite" aria-busy={props.messagesLoading || props.sending}>
            {props.olderCursor && (
              <button className="wiki-chat-load-older" type="button" onClick={loadOlder} disabled={props.loadingOlder || props.messagesLoading}>
                {props.loadingOlder ? <><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> 이전 메시지를 불러옵니다…</> : '이전 메시지 불러오기'}
              </button>
            )}
            {props.messagesLoading && props.messages.length === 0 ? (
              <p className="wiki-chat-loading" role="status"><LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> 대화를 불러오고 있습니다…</p>
            ) : props.messages.length === 0 && !props.pendingMessage ? (
              <div className="wiki-chat-empty">
                <strong>무엇을 찾고 있나요?</strong>
                <span>위키에 질문하거나 팀 대화를 이어가세요.</span>
              </div>
            ) : (
              <>
                {props.messages.map((message) => (
                  <ChatMessageView key={message.id} message={message} conversationId={props.activeConversation?.id} onFeedback={props.onFeedback} />
                ))}
                {props.pendingMessage && (
                  <>
                    <article className="wiki-chat-message wiki-chat-message-user wiki-chat-message-pending" aria-label="전송 중인 질문">
                      {props.pendingMessage}
                    </article>
                    <div className="wiki-chat-message wiki-chat-message-assistant wiki-chat-pending-answer" role="status">
                      <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> 답변을 준비하고 있습니다…
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <form className="wiki-chat-composer" ref={props.formRef} onSubmit={props.onSubmit}>
            <textarea
              ref={textareaRef}
              aria-label="위키 Agent에게 질문"
              placeholder="위키에 질문하기"
              value={props.draft}
              onChange={(event) => props.onDraftChange(event.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={1}
              disabled={props.sending || props.messagesLoading}
            />
            <button className="wiki-chat-send" type="submit" aria-label="질문 보내기" disabled={!props.draft.trim() || props.sending || props.messagesLoading}>
              {props.sending ? <LoaderCircle size={17} className="animate-spin" aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
            </button>
          </form>
          <p className="wiki-chat-hint">Enter 전송 · Shift + Enter 줄바꿈 · {pathLabel}</p>
        </div>
      </div>
    </section>
  );
}

export function WikiChatApp({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const isStandalone = pathname === '/chat';
  const [mode, setMode] = useState<PanelMode>('closed');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reasoning, setReasoning] = useState<Reasoning>('max');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [canRetrySend, setCanRetrySend] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const previousModeRef = useRef<PanelMode>('closed');
  const formRef = useRef<HTMLFormElement>(null);
  const lastPathRef = useRef<string | null>(null);
  const chatPageMetricRef = useRef(false);
  const splitPointerRef = useRef<number | null>(null);
  const requestRef = useRef<{ requestId: string; conversationId: string; expectedVersion: number; message: string; reasoning: Reasoning } | null>(null);
  const selectionGenerationRef = useRef(0);
  const selectedConversationIdRef = useRef<string | null>(null);
  const olderRequestRef = useRef(0);
  const loadingOlderRef = useRef(false);
  const creatingConversationRef = useRef<Promise<Conversation | null> | null>(null);
  const sendingRef = useRef(false);

  const updateConversationUrl = useCallback((id?: string | null) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('conversation', id);
    else url.searchParams.delete('conversation');
    router.replace(url.pathname + url.search + url.hash, { scroll: false });
  }, [pathname, router]);

  const upsertConversation = useCallback((conversation: Conversation) => {
    setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]
      .sort((a, b) => b.updated_at - a.updated_at));
  }, []);

  const loadConversationPage = useCallback(async (id: string, beforeSeq?: string | null): Promise<MessagePage | null> => {
    const query = new URLSearchParams({ limit: '50' });
    if (beforeSeq) query.set('before_seq', beforeSeq);
    const response = await fetch('/api/chat/conversations/' + encodeURIComponent(id) + '?' + query.toString(), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (response.status === 401) {
      setAuthRequired(true);
      return null;
    }
    if (!response.ok) throw new Error('conversation fetch failed');
    const result = parseMessagePage(await response.json());
    if (!result) throw new Error('conversation response was invalid');
    setAuthRequired(false);
    return result;
  }, []);

  const loadConversationList = useCallback(async (cursor: string | null, append: boolean) => {
    if (append) setConversationsLoadingMore(true);
    else setConversationsLoading(true);
    setHistoryError(null);
    try {
      const query = new URLSearchParams({ limit: '30' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch('/api/chat/conversations?' + query.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.status === 401) {
        setAuthRequired(true);
        setHistoryError('GitHub 로그인 후 팀 대화 기록을 볼 수 있습니다.');
        return;
      }
      if (!response.ok) throw new Error('conversation list failed');
      const result = objectValue(await response.json());
      if (!result || !Array.isArray(result.conversations)) throw new Error('conversation list response was invalid');
      const page = result.conversations.map(parseConversation).filter((item): item is Conversation => item !== null);
      setConversations((current) => {
        // 목록 응답을 기다리는 동안 생성·갱신된 대화는 현재 항목을 유지한다.
        const byId = new Map<string, Conversation>();
        for (const item of [...current, ...page]) {
          const known = byId.get(item.id);
          if (!known || item.version > known.version || (item.version === known.version && item.updated_at >= known.updated_at)) {
            byId.set(item.id, item);
          }
        }
        return [...byId.values()].sort((a, b) => b.updated_at - a.updated_at || b.id.localeCompare(a.id));
      });
      const next = result.next_cursor;
      setConversationCursor(typeof next === 'string' && next ? next : null);
      setAuthRequired(false);
    } catch {
      setHistoryError('팀 대화를 불러오지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setConversationsLoading(false);
      setConversationsLoadingMore(false);
    }
  }, []);

  const selectConversation = useCallback(async (id: string, source: 'history' | 'route' = 'history') => {
    const generation = ++selectionGenerationRef.current;
    olderRequestRef.current++;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    setMessagesLoading(true);
    setNotice(null);
    setPendingMessage(null);
    try {
      const result = await loadConversationPage(id);
      if (!result || generation !== selectionGenerationRef.current) return;
      selectedConversationIdRef.current = id;
      setActiveConversation(result.conversation);
      setMessages(result.messages);
      setOlderCursor(result.nextBeforeSeq);
      setCanRetrySend(false);
      requestRef.current = null;
      upsertConversation(result.conversation);
      updateConversationUrl(id);
      if (source === 'history') {
        recordWebEvent({ feature: 'web.chat_history_open' });
      }
    } catch {
      if (generation === selectionGenerationRef.current) setNotice({ kind: 'error', text: '대화를 열지 못했습니다. 팀 대화 목록에서 다시 선택해 주세요.' });
    } finally {
      if (generation === selectionGenerationRef.current) setMessagesLoading(false);
    }
  }, [loadConversationPage, pathname, updateConversationUrl, upsertConversation]);

  const createConversation = useCallback((): Promise<Conversation | null> => {
    if (creatingConversationRef.current) return creatingConversationRef.current;
    const generation = ++selectionGenerationRef.current;
    olderRequestRef.current++;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    setMessagesLoading(false);
    const pending = (async () => {
      try {
        const response = await fetch('/api/chat/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({}),
        });
        if (response.status === 401) {
          if (generation === selectionGenerationRef.current) setAuthRequired(true);
          return null;
        }
        if (!response.ok) throw new Error('conversation create failed');
        const result = objectValue(await response.json());
        const conversation = parseConversation(result?.conversation);
        if (!conversation) throw new Error('conversation create response was invalid');
        upsertConversation(conversation);
        if (generation === selectionGenerationRef.current) {
          selectedConversationIdRef.current = conversation.id;
          setAuthRequired(false);
          setActiveConversation(conversation);
          setMessages([]);
          setOlderCursor(null);
          setCanRetrySend(false);
          requestRef.current = null;
          updateConversationUrl(conversation.id);
        }
        return conversation;
      } finally {
        creatingConversationRef.current = null;
      }
    })();
    creatingConversationRef.current = pending;
    return pending;
  }, [upsertConversation, updateConversationUrl]);

  useEffect(() => {
    void loadConversationList(null, false);
  }, [loadConversationList]);

  useEffect(() => {
    if (lastPathRef.current === pathname) return;
    const previousPath = lastPathRef.current;
    lastPathRef.current = pathname;
    if (pathname === '/chat') {
      if (!chatPageMetricRef.current) recordWebEvent({ feature: 'web.chat_page_open' });
      chatPageMetricRef.current = true;
    } else {
      chatPageMetricRef.current = false;
    }
    const requestedId = new URLSearchParams(window.location.search).get('conversation');
    if (requestedId && requestedId !== activeConversation?.id) void selectConversation(requestedId, 'route');
    if (!isStandalone && requestedId && mode === 'closed' && previousPath === '/chat') {
      setMode(window.matchMedia('(max-width: 760px)').matches ? 'mobile-full' : 'popup');
    }
  }, [activeConversation?.id, isStandalone, mode, pathname, selectConversation]);

  useEffect(() => {
    function onPopState() {
      const requestedId = new URLSearchParams(window.location.search).get('conversation');
      if (requestedId && requestedId !== activeConversation?.id) void selectConversation(requestedId, 'route');
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [activeConversation?.id, selectConversation]);

  useEffect(() => {
    const wasOpen = mode !== 'closed';
    if (!wasOpen) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && !document.querySelector('dialog[open]') && !isStandalone) setMode('closed');
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isStandalone, mode]);

  useEffect(() => {
    if (mode === 'closed') return;
    const onResize = () => {
      const small = window.matchMedia('(max-width: 760px)').matches;
      if (small && (mode === 'split' || mode === 'popup')) setMode('mobile-full');
      if (!small && mode === 'mobile-full') setMode('popup');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (previousMode !== 'closed' && mode === 'closed' && !isStandalone) launcherRef.current?.focus();
  }, [isStandalone, mode]);

  async function startNewConversation() {
    if (sendingRef.current || creatingConversationRef.current) return;
    setNotice(null);
    try {
      await createConversation();
    } catch {
      setNotice({ kind: 'error', text: '새 대화를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  }

  async function loadOlderMessages() {
    if (!activeConversation || !olderCursor || loadingOlderRef.current || messagesLoading) return;
    const conversationId = activeConversation.id;
    const generation = selectionGenerationRef.current;
    const olderRequest = ++olderRequestRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const result = await loadConversationPage(conversationId, olderCursor);
      if (!result || generation !== selectionGenerationRef.current || olderRequest !== olderRequestRef.current
        || selectedConversationIdRef.current !== conversationId) return;
      setMessages((current) => {
        const ids = new Set(current.map((message) => message.id));
        return [...result.messages.filter((message) => !ids.has(message.id)), ...current].sort((a, b) => a.seq - b.seq);
      });
      setOlderCursor(result.nextBeforeSeq);
    } catch {
      if (olderRequest === olderRequestRef.current) setNotice({ kind: 'error', text: '이전 메시지를 불러오지 못했습니다. 다시 시도해 주세요.' });
    } finally {
      if (olderRequest === olderRequestRef.current) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }

  function updateMessage(messageId: string, patch: Partial<ChatMessage>) {
    setMessages((current) => current.map((message) => message.id === messageId ? { ...message, ...patch } : message));
  }

  async function submitFeedback(messageId: string, patch: Partial<ChatMessage>) {
    const message = messages.find((item) => item.id === messageId);
    const next = { ...message, ...patch } as ChatMessage;
    updateMessage(messageId, { ...patch, feedbackSaving: true, feedbackError: false });
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          event_id: next.measurementId,
          rating: next.feedbackChoice,
          ...(next.feedbackReason ? { reason: next.feedbackReason } : {}),
        }),
      });
      if (!response.ok) throw new Error('feedback request failed');
      updateMessage(messageId, { feedbackSaved: true, feedbackSaving: false, feedbackError: false });
    } catch {
      updateMessage(messageId, { feedbackSaving: false, feedbackError: true });
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sendingRef.current) return;
    sendingRef.current = true;
    setNotice(null);
    setCanRetrySend(false);
    setSending(true);
    setPendingMessage(message);
    let target = activeConversation;
    let generation = selectionGenerationRef.current;
    const isCurrentView = () => generation === selectionGenerationRef.current
      && selectedConversationIdRef.current === (target?.id ?? null);

    try {
      if (!target) {
        const creation = createConversation();
        generation = selectionGenerationRef.current;
        target = await creation;
        if (!target || !isCurrentView()) return;
      }
      let request = requestRef.current;
      if (!request || request.conversationId !== target.id || request.expectedVersion !== target.version
        || request.message !== message || request.reasoning !== reasoning) {
        request = {
          requestId: crypto.randomUUID(),
          conversationId: target.id,
          expectedVersion: target.version,
          message,
          reasoning,
        };
        requestRef.current = request;
      }
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({
          conversation_id: request.conversationId,
          expected_version: request.expectedVersion,
          request_id: request.requestId,
          message: request.message,
          reasoning: request.reasoning,
        }),
      });
      if (response.status === 401) {
        if (isCurrentView()) {
          setAuthRequired(true);
          setNotice({ kind: 'error', text: '대화를 보내려면 GitHub 로그인이 필요합니다.' });
          setCanRetrySend(true);
        }
        return;
      }
      if (response.status === 409) {
        if (requestRef.current?.requestId === request.requestId) requestRef.current = null;
        if (isCurrentView()) setCanRetrySend(false);
        const latest = await loadConversationPage(target.id).catch(() => null);
        if (latest) {
          upsertConversation(latest.conversation);
          if (isCurrentView()) {
            setActiveConversation(latest.conversation);
            setMessages(latest.messages);
            setOlderCursor(latest.nextBeforeSeq);
          }
        }
        await loadConversationList(null, false);
        if (isCurrentView()) setNotice({ kind: 'info', text: '팀 대화가 갱신되어 최신 기록을 불러왔습니다. 내용을 확인한 뒤 질문을 다시 보내 주세요.' });
        return;
      }
      if (!response.ok) throw new Error('chat request failed');
      const value = objectValue(await response.json());
      if (!value || typeof value.answer !== 'string') throw new Error('chat response was invalid');
      const returnedConversation = parseConversation(value.conversation);
      const saved = Array.isArray(value.messages) ? value.messages.map(parseMessage).filter((item): item is ChatMessage => item !== null) : [];
      const userMessage = saved.find((item) => item.role === 'user') ?? {
        id: request.requestId + '-user',
        seq: (target.message_count ?? 0) + 1,
        role: 'user' as const,
        content: message,
      };
      const measurementId = typeof value.measurement_id === 'string' ? value.measurement_id : undefined;
      const sources = Array.isArray(value.sources) ? value.sources.map(parseCitation).filter((item): item is Citation => item !== null) : [];
      const assistantMessage = saved.find((item) => item.role === 'assistant') ?? {
        id: request.requestId + '-assistant',
        seq: userMessage.seq + 1,
        role: 'assistant' as const,
        content: value.answer,
        ...(sources.length ? { sources } : {}),
        ...(measurementId ? { measurementId, canFeedback: true } : {}),
      };
      const updatedConversation = returnedConversation ?? {
        ...target,
        version: target.version + 1,
        message_count: target.message_count + 2,
        updated_at: Date.now(),
        title: target.message_count === 0 ? message.slice(0, 80) : target.title,
      };
      upsertConversation(updatedConversation);
      if (isCurrentView()) {
        setActiveConversation(updatedConversation);
        setMessages((current) => {
          const ids = new Set(current.map((item) => item.id));
          return [...current, ...[userMessage, assistantMessage].filter((item) => !ids.has(item.id))];
        });
        if (requestRef.current?.requestId === request.requestId) requestRef.current = null;
        setCanRetrySend(false);
        setDraft('');
        setAuthRequired(false);
        if (value.history_truncated === true) {
          setNotice({ kind: 'info', text: '대화가 길어 일부 이전 메시지만 답변 문맥에 포함했습니다. 전체 기록은 계속 확인할 수 있습니다.' });
        }
      }
    } catch {
      if (isCurrentView()) {
        setCanRetrySend(true);
        setNotice({ kind: 'error', text: '응답을 확인하지 못했습니다. 같은 질문을 다시 보내면 중복 기록을 만들지 않고 결과를 확인합니다.', retry: true });
      }
    } finally {
      sendingRef.current = false;
      setPendingMessage(null);
      setSending(false);
    }
  }

  function openPopup() {
    const small = window.matchMedia('(max-width: 760px)').matches;
    setMode(small ? 'mobile-full' : 'popup');
    recordWebEvent({ feature: 'web.chat_popup_open' });
    if (activeConversation) updateConversationUrl(activeConversation.id);
  }

  function openSplit() {
    if (window.matchMedia('(max-width: 760px)').matches) {
      setMode('mobile-full');
      return;
    }
    setSplitRatio(0.5);
    setMode('split');
    recordWebEvent({ feature: 'web.chat_split_open' });
  }

  function openFullPage() {
    const from = window.location.pathname + window.location.search + window.location.hash;
    router.push(conversationHref('/chat', activeConversation?.id, from), { scroll: false });
  }

  function returnToDocs() {
    const params = new URLSearchParams(window.location.search);
    const from = params.get('from');
    let destination = '/docs';
    if (from) {
      try {
        const url = new URL(from, window.location.origin);
        if (url.origin === window.location.origin && url.pathname.startsWith('/docs')) destination = url.pathname + url.search + url.hash;
      } catch {
        destination = '/docs';
      }
    }
    const url = new URL(destination, window.location.origin);
    if (activeConversation) url.searchParams.set('conversation', activeConversation.id);
    router.push(url.pathname + url.search + url.hash, { scroll: false });
  }

  function closePanel() {
    setMode('closed');
    updateConversationUrl(null);
  }

  function onDraftChange(value: string) {
    setDraft(value);
    const request = requestRef.current;
    if (request && value.trim() !== request.message) {
      requestRef.current = null;
      setCanRetrySend(false);
      setNotice(null);
    }
  }

  function onSplitPointerDown(event: PointerEvent<HTMLDivElement>) {
    splitPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onSplitPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (splitPointerRef.current !== event.pointerId) return;
    setSplitRatio(Math.min(0.75, Math.max(0.25, event.clientX / window.innerWidth)));
  }

  function onSplitPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (splitPointerRef.current === event.pointerId) splitPointerRef.current = null;
  }

  function onSplitKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setSplitRatio((value) => Math.min(0.75, Math.max(0.25, value + (event.key === 'ArrowLeft' ? -0.05 : 0.05))));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSplitRatio(0.25);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSplitRatio(0.75);
    }
  }

  const surfaceProps: Omit<ChatSurfaceProps, 'variant'> = {
    messages,
    activeConversation,
    conversations,
    conversationsLoading,
    conversationsLoadingMore,
    conversationCursor,
    historyError,
    messagesLoading,
    loadingOlder,
    olderCursor,
    sending,
    pendingMessage,
    draft,
    reasoning,
    notice,
    authRequired,
    splitRatio,
    pathname,
    onClose: closePanel,
    onOpenSplit: openSplit,
    onOpenPopup: openPopup,
    onOpenFullPage: openFullPage,
    onReturnToDocs: returnToDocs,
    onNewConversation: startNewConversation,
    onSelectConversation: (id) => void selectConversation(id, 'history'),
    onLoadConversations: () => void loadConversationList(conversationCursor, true),
    onLoadOlder: () => void loadOlderMessages(),
    onDraftChange,
    onReasoningChange: setReasoning,
    onSubmit: sendMessage,
    onFeedback: (messageId, patch, save) => {
      if (save) void submitFeedback(messageId, patch);
      else updateMessage(messageId, patch);
    },
    formRef,
  };

  const isSplit = !isStandalone && mode === 'split';

  return (
    <div
      className={'wiki-app-shell' + (isSplit ? ' wiki-app-shell-split' : '') + (isStandalone ? ' wiki-app-shell-chat-route' : '')}
      style={isSplit ? { ['--wiki-docs-width' as string]: (splitRatio * 100).toFixed(2) + '%' } : undefined}
    >
      {!isStandalone && <div className="wiki-app-content">{children}</div>}
      {!isStandalone && mode === 'split' && (
        <>
          <div
            className="wiki-chat-resizer"
            role="separator"
            aria-label="문서와 대화 창 크기 조절"
            aria-orientation="vertical"
            aria-valuemin={25}
            aria-valuemax={75}
            aria-valuenow={Math.round(splitRatio * 100)}
            tabIndex={0}
            onPointerDown={onSplitPointerDown}
            onPointerMove={onSplitPointerMove}
            onPointerUp={onSplitPointerUp}
            onPointerCancel={onSplitPointerUp}
            onKeyDown={onSplitKeyDown}
          >
            <span aria-hidden="true" />
          </div>
          <ChatSurface {...surfaceProps} variant="split" />
        </>
      )}
      {!isStandalone && mode === 'popup' && <ChatSurface {...surfaceProps} variant="popup" />}
      {!isStandalone && mode === 'mobile-full' && <ChatSurface {...surfaceProps} variant="mobile-full" />}
      {isStandalone && <ChatSurface {...surfaceProps} variant="full" />}
      {!isStandalone && mode === 'closed' && (
        <button
          ref={launcherRef}
          type="button"
          className="wiki-chat-launcher"
          aria-label="위키 Agent 열기"
          aria-haspopup="dialog"
          aria-expanded={false}
          title="위키 Agent"
          onClick={openPopup}
        >
          <MessageSquareText size={19} aria-hidden="true" />
          <span>위키 Agent</span>
        </button>
      )}
    </div>
  );
}
