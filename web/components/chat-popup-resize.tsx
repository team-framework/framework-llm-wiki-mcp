'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type KeyboardEvent } from 'react';

type Size = { width: number; height: number };
type Drag = { pointerId: number; x: number; y: number; width: number; height: number };

const DEFAULT: Size = { width: 420, height: 560 };
const MIN = 320;
const EDGE = 20;
const STORAGE_KEY = 'framework-wiki-chat-popup-size';

function fit(size: Size): Size {
  if (typeof window === 'undefined') return size;
  const maxWidth = Math.max(1, window.innerWidth - EDGE * 2);
  const maxHeight = Math.max(1, window.innerHeight - EDGE * 2);
  return {
    width: Math.min(Math.max(size.width, Math.min(MIN, maxWidth)), maxWidth),
    height: Math.min(Math.max(size.height, Math.min(MIN, maxHeight)), maxHeight),
  };
}

export function useChatPopupSize(active: boolean) {
  const [size, setSize] = useState<Size>(DEFAULT);
  const drag = useRef<Drag | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!active) return;
    if (!initialized.current) {
      initialized.current = true;
      try {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Size> | null;
        if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
          setSize(fit({ width: Math.round(saved.width!), height: Math.round(saved.height!) }));
        } else setSize(fit(DEFAULT));
      } catch { setSize(fit(DEFAULT)); }
    }
    const onResize = () => setSize((current) => fit(current));
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('resize', onResize); drag.current = null; };
  }, [active]);

  useEffect(() => {
    if (!active || !initialized.current) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(size)); } catch { /* Private browsing may reject storage. */ }
  }, [active, size]);

  const resetSize = useCallback(() => setSize(fit(DEFAULT)), []);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ...fit(size) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    setSize(fit({ width: start.width + start.x - event.clientX, height: start.height + start.y - event.clientY }));
  };
  const endPointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Home') {
      event.preventDefault(); resetSize(); return;
    }
    const step = event.shiftKey ? 96 : 24;
    const delta: Record<string, Size> = {
      ArrowLeft: { width: step, height: 0 }, ArrowRight: { width: -step, height: 0 },
      ArrowUp: { width: 0, height: step }, ArrowDown: { width: 0, height: -step },
    };
    const change = delta[event.key];
    if (!change) return;
    event.preventDefault();
    setSize((current) => fit({ width: current.width + change.width, height: current.height + change.height }));
  };

  const sizeStyle: CSSProperties = { width: size.width, height: size.height, right: EDGE, bottom: EDGE };
  const resizeHandle = (
    <button
      type="button"
      aria-label="채팅 창 크기 조절"
      aria-description="드래그하거나 방향키로 크기를 조절합니다. Shift를 누르면 빠르게 조절하고 Home을 누르면 원래 크기로 돌아갑니다."
      title="드래그 또는 방향키로 크기 조절 · Home 초기화"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={onKeyDown}
      style={{ position: 'absolute', zIndex: 9, top: 8, left: 8, display: 'inline-flex', alignItems: 'center',
        gap: 3, height: 30, padding: '0 6px', border: '1px solid var(--color-fd-border)', borderRadius: 7,
        background: 'var(--wiki-panel)', color: 'var(--color-fd-muted-foreground)', cursor: 'nwse-resize',
        touchAction: 'none', userSelect: 'none', fontSize: 11, whiteSpace: 'nowrap' }}
    >
      <span aria-hidden="true">↖</span><span aria-hidden="true">크기 조절</span>
    </button>
  );

  return { sizeStyle, resizeHandle, resetSize };
}
