'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquarePlus, X } from 'lucide-react';

const categories = [
  { value: 'bug', label: '오류' },
  { value: 'search_miss', label: '검색 누락' },
  { value: 'unclear_docs', label: '설명 개선' },
  { value: 'good_result', label: '좋은 결과' },
  { value: 'slow', label: '느린 응답' },
  { value: 'other', label: '기타' },
] as const;

type Category = typeof categories[number]['value'];

export function WikiFeedbackWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Category[]>([]);
  const [details, setDetails] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstCategoryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => firstCategoryRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, [open]);

  function close() {
    if (sending) return;
    setOpen(false);
  }

  function toggleCategory(category: Category) {
    setNotice(null);
    setSelected((current) => {
      if (current.includes(category)) return current.filter((item) => item !== category);
      if (current.length >= 3) return current;
      return [...current, category];
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    if (selected.length === 0) {
      setNotice({ kind: 'error', text: '의견 유형을 하나 이상 선택해 주세요.' });
      return;
    }
    if (!details.trim() || details.trim().length > 4000) {
      setNotice({ kind: 'error', text: '의견 내용을 1~4,000자로 입력해 주세요.' });
      return;
    }

    setSending(true);
    setNotice(null);
    const payload = {
      categories: selected,
      details: details.trim(),
      ...(includeDiagnostics && pathname.startsWith('/docs') ? {
        diagnostics: {
          page_path: pathname,
          viewport_width: Math.min(10000, Math.max(320, Math.round(window.innerWidth))),
          viewport_height: Math.min(10000, Math.max(200, Math.round(window.innerHeight))),
        },
      } : {}),
    };

    try {
      const response = await fetch('/api/product-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(payload),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = result && typeof result === 'object' && typeof (result as { message?: unknown }).message === 'string'
          ? (result as { message: string }).message
          : response.status === 401 ? '로그인 후 의견을 보낼 수 있습니다.' : '의견을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.';
        throw new Error(message);
      }
      if (!result || typeof result !== 'object' || typeof (result as { feedback_id?: unknown }).feedback_id !== 'string') {
        throw new Error('현재 이 환경에서는 의견 수집을 사용할 수 없습니다.');
      }
      setNotice({ kind: 'success', text: '의견을 보냈습니다. 팀이 위키 개선을 위해 검토합니다.' });
      setSelected([]);
      setDetails('');
      setIncludeDiagnostics(false);
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '의견을 보내지 못했습니다.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="wiki-feedback-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setNotice(null);
          setOpen(true);
        }}
      >
        <MessageSquarePlus size={17} aria-hidden="true" />
        <span>의견 보내기</span>
      </button>

      <dialog
        ref={dialogRef}
        className="wiki-feedback-dialog"
        aria-labelledby="wiki-feedback-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
      >
        <div className="wiki-feedback-panel">
          <header className="wiki-feedback-header">
            <div>
              <p className="wiki-feedback-eyebrow">Framework 위키</p>
              <h2 id="wiki-feedback-title">위키 의견 보내기</h2>
              <p>팀이 위키 개선을 위해 검토합니다.</p>
            </div>
            <button className="wiki-icon-button" type="button" aria-label="의견 창 닫기" onClick={close} disabled={sending}>
              <X size={18} aria-hidden="true" />
            </button>
          </header>

          <form onSubmit={submit}>
            <fieldset className="wiki-feedback-category-group">
              <legend>유형을 선택해 주세요 <span>최대 3개 · {selected.length}/3</span></legend>
              <div className="wiki-feedback-categories">
                {categories.map((category, index) => (
                  <button
                    key={category.value}
                    ref={index === 0 ? firstCategoryRef : undefined}
                    className={`wiki-feedback-pill${selected.includes(category.value) ? ' selected' : ''}`}
                    type="button"
                    aria-pressed={selected.includes(category.value)}
                    onClick={() => toggleCategory(category.value)}
                    disabled={sending || (!selected.includes(category.value) && selected.length >= 3)}
                  >
                    {category.label}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="wiki-feedback-details-label" htmlFor="wiki-feedback-details">무엇을 개선하면 좋을까요?</label>
            <textarea
              id="wiki-feedback-details"
              value={details}
              onChange={(event) => setDetails(event.target.value)}
              placeholder="불편했던 점이나 도움이 된 내용을 적어 주세요."
              maxLength={4000}
              minLength={1}
              required
              rows={7}
              disabled={sending}
            />
            <div className="wiki-feedback-character-count">{details.length.toLocaleString('ko-KR')} / 4,000자</div>

            <label className="wiki-feedback-diagnostics">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
                disabled={sending}
              />
              <span>현재 페이지 경로와 화면 크기를 함께 보냅니다.</span>
            </label>

            {notice && (
              <p className={`wiki-feedback-notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
                {notice.text}
                {notice.kind === 'error' && notice.text.includes('로그인') && <> <a href="/auth/github/login">GitHub 로그인</a></>}
              </p>
            )}

            <footer className="wiki-feedback-footer">
              <button className="wiki-feedback-cancel" type="button" onClick={close} disabled={sending}>닫기</button>
              <button className="wiki-feedback-submit" type="submit" disabled={sending}>
                {sending ? '보내는 중…' : '의견 보내기'}
              </button>
            </footer>
          </form>
        </div>
      </dialog>
    </>
  );
}
