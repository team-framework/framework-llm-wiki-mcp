'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ExternalLink, LoaderCircle, MessageSquareText, Send, Sparkles, X } from 'lucide-react';
import { headingId, documentHref } from '@/lib/links';
import { WikiMarkdown } from '@/components/wiki-markdown';

type Reasoning = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type Citation = { path: string; title: string; section?: string; url?: string };
type ChatMessage = { role: 'user' | 'assistant'; content: string; sources?: Citation[] };

const reasoningOptions: { value: Reasoning; label: string }[] = [
  { value: 'none', label: '없음' },
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' },
  { value: 'xhigh', label: '매우 높음' },
  { value: 'max', label: '최대' },
];

function citationHref(source: Citation) {
  const suppliedUrl = source.url?.trim();
  if (suppliedUrl?.startsWith('/') && !suppliedUrl.startsWith('//')) return suppliedUrl;
  if (suppliedUrl?.startsWith('https://')) return suppliedUrl;

  const base = documentHref(source.path);
  return source.section ? `${base}#${encodeURIComponent(headingId(source.section))}` : base;
}

function sourceLinkLabel(source: Citation) {
  return source.section ? `${source.title} · ${source.section}` : source.title;
}

export function WikiChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [reasoning, setReasoning] = useState<Reasoning>('low');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<'unauthorized' | 'failed' | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;

    setError(null);
    setDraft('');
    setMessages((current) => [...current, { role: 'user', content: message }]);
    setSending(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          message,
          history: messages.map(({ role, content }) => ({ role, content })),
          reasoning,
        }),
      });

      if (response.status === 401) {
        setError('unauthorized');
        return;
      }
      if (!response.ok) throw new Error('chat request failed');

      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || typeof (result as { answer?: unknown }).answer !== 'string') {
        throw new Error('chat response was invalid');
      }
      const data = result as { answer: string; sources?: unknown };
      const sources = Array.isArray(data.sources)
        ? data.sources.filter((item): item is Citation => {
          if (!item || typeof item !== 'object') return false;
          const source = item as Record<string, unknown>;
          return typeof source.path === 'string'
            && typeof source.title === 'string'
            && (source.section === undefined || typeof source.section === 'string')
            && (source.url === undefined || typeof source.url === 'string');
        })
        : [];

      setMessages((current) => [...current, { role: 'assistant', content: data.answer, sources }]);
    } catch {
      setError('failed');
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <>
      <button
        type="button"
        className="wiki-chat-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={17} aria-hidden="true" /> : <MessageSquareText size={17} aria-hidden="true" />}
        <span>{open ? '닫기' : '위키 Agent'}</span>
      </button>

      {open && (
        <section className="wiki-chat-panel" role="dialog" aria-labelledby="wiki-chat-title">
          <header className="wiki-chat-header">
            <div>
              <p className="wiki-chat-title" id="wiki-chat-title">위키에 물어보기</p>
              <p className="wiki-chat-subtitle">GPT-6 Luna · 문서 근거와 함께 답변합니다</p>
            </div>
            <button className="wiki-icon-button" type="button" aria-label="채팅 닫기" onClick={() => setOpen(false)}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          <div className="wiki-chat-settings">
            <span>추론 수준</span>
            <select
              aria-label="추론 수준 선택"
              value={reasoning}
              onChange={(event) => setReasoning(event.target.value as Reasoning)}
              disabled={sending}
            >
              {reasoningOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>

          <div className="wiki-chat-messages" ref={messagesRef} aria-live="polite">
            {messages.length === 0 ? (
              <div className="wiki-chat-empty">
                <Sparkles size={22} aria-hidden="true" />
                <strong>팀 위키를 함께 살펴볼게요.</strong>
                <span>기술 결정, 프로젝트 맥락, 팀 문서에 대해 질문해 보세요.</span>
              </div>
            ) : messages.map((message, index) => (
              <article
                className={`wiki-chat-message ${message.role === 'user' ? 'wiki-chat-message-user' : 'wiki-chat-message-assistant'}`}
                key={`${message.role}-${index}`}
              >
                {message.role === 'assistant'
                  ? <WikiMarkdown markdown={message.content} />
                  : message.content}
                {message.sources && message.sources.length > 0 && (
                  <div className="wiki-chat-citations" aria-label="참고 문서">
                    {message.sources.map((source, sourceIndex) => {
                      const href = citationHref(source);
                      const external = href.startsWith('https://');
                      return (
                        <a
                          className="wiki-chat-citation"
                          href={href}
                          key={`${source.path}-${source.section ?? sourceIndex}`}
                          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                        >
                          {sourceLinkLabel(source)}
                          {external && <ExternalLink size={12} aria-hidden="true" />}
                        </a>
                      );
                    })}
                  </div>
                )}
              </article>
            ))}
            {sending && (
              <div className="wiki-chat-message wiki-chat-message-assistant" role="status">
                <LoaderCircle size={15} className="animate-spin" aria-hidden="true" /> 답변을 준비하고 있습니다…
              </div>
            )}
          </div>

          {error && (
            <p className="wiki-chat-error" role="alert">
              {error === 'unauthorized'
                ? <>채팅을 사용하려면 <a href="/auth/github/login">GitHub 로그인</a>이 필요합니다.</>
                : '답변을 가져오지 못했습니다. 잠시 후 다시 시도하세요.'}
            </p>
          )}

          <form className="wiki-chat-composer" onSubmit={sendMessage}>
            <textarea
              ref={textareaRef}
              aria-label="위키 Agent에게 질문"
              placeholder="위키에 대해 질문하세요"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              disabled={sending}
            />
            <button className="wiki-chat-send" type="submit" aria-label="질문 보내기" disabled={!draft.trim() || sending}>
              <Send size={17} aria-hidden="true" />
            </button>
          </form>
          <p className="wiki-chat-hint">위키 문서를 참고해 답변합니다. Enter 전송 · Shift + Enter 줄바꿈</p>
        </section>
      )}
    </>
  );
}
