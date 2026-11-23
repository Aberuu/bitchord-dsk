// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/data/music/types';
import { asEntry } from '@/playback/queue/timeline';
import { usePlayer } from '@/state/player';
import { UpNext } from './UpNext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function track(videoId: string, title: string): Track {
  return {
    videoId,
    title,
    artists: [{ name: `Artist ${videoId}`, id: null }],
    album: null,
    durationSec: 185,
    explicit: false,
    thumbnail: null,
    index: null,
    plays: null,
  };
}

function makePointer(type: string, init: { clientX?: number; clientY?: number; button?: number; pointerType?: string }): Event {
  if (typeof PointerEvent !== 'undefined') {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: init.pointerType ?? 'mouse',
      button: init.button ?? 0,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    });
  }
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: init.button ?? 0,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
  });
  Object.assign(ev, { pointerType: init.pointerType ?? 'mouse', pointerId: 1 });
  return ev;
}

function mockRowRects(container: HTMLElement) {
  const rows = Array.from(container.querySelectorAll<HTMLLIElement>('li[data-queue-index]'));
  rows.forEach((row, idx) => {
    const isAutoplay = row.dataset.queueSection === 'autoplay';
    const top = 100 + idx * 55 + (isAutoplay ? 50 : 0);
    row.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + 55,
        left: 0,
        right: 300,
        width: 300,
        height: 55,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

describe('UpNext pointer drag-and-drop and keyboard reordering', () => {
  let host: HTMLDivElement;
  let root: Root;
  const originalJumpTo = usePlayer.getState().jumpTo;
  const jumpSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    jumpSpy.mockReset();

    usePlayer.setState({
      queue: [
        asEntry(track('t0', 'Now Playing'), 'context', { title: 'Mix', type: 'queue' }, 't0'),
        asEntry(track('t1', 'First Song'), 'user', { title: 'Mix', type: 'queue' }, 't1'),
        asEntry(track('t2', 'Second Song'), 'user', { title: 'Mix', type: 'queue' }, 't2'),
        asEntry(track('t3', 'Context Song'), 'context', { title: 'Mix', type: 'queue' }, 't3'),
        asEntry(track('t4', 'AutoPlay Song'), 'autoplay', { title: 'Radio', type: 'radio' }, 't4'),
      ],
      index: 0,
      jumpTo: jumpSpy,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    usePlayer.setState({ queue: [], index: -1, jumpTo: originalJumpTo });
    vi.useRealTimers();
  });

  it('reorders queue rows via pointer drag on the handle without triggering jumpTo', () => {
    act(() => root.render(<UpNext />));
    mockRowRects(host);

    const handle1 = host.querySelector<HTMLButtonElement>('li[data-entry-id="t1"] [data-drag-handle="true"]')!;
    expect(handle1).toBeTruthy();

    act(() => {
      handle1.dispatchEvent(makePointer('pointerdown', { clientX: 280, clientY: 120 }));
    });
    act(() => {
      window.dispatchEvent(makePointer('pointermove', { clientX: 280, clientY: 255 }));
    });

    const dragged = host.querySelector<HTMLLIElement>('li[data-entry-id="t1"]')!;
    const dropRow = host.querySelector<HTMLLIElement>('li[data-entry-id="t3"]')!;
    expect(dragged.hasAttribute('data-dragging')).toBe(true);
    expect(dropRow.getAttribute('data-drop-edge')).toBe('bottom');

    act(() => {
      window.dispatchEvent(makePointer('pointerup', { clientX: 280, clientY: 255 }));
    });

    // Simulate synthetic click right after pointerup to verify click suppression works.
    const titleButton = host.querySelector<HTMLButtonElement>('li[data-entry-id="t1"] button[aria-label="Play First Song"]')!;
    act(() => {
      titleButton.click();
    });

    expect(jumpSpy).not.toHaveBeenCalled();
    expect(usePlayer.getState().queue.map((e) => e.entryId)).toEqual(['t0', 't2', 't3', 't1', 't4']);

    act(() => {
      vi.advanceTimersByTime(100);
      titleButton.click();
    });
    expect(jumpSpy).toHaveBeenCalledWith(3);
  });

  it('allows dragging from the row body itself and moves an AutoPlay row into Up Next', () => {
    act(() => root.render(<UpNext />));
    mockRowRects(host);

    const titleButton = host.querySelector<HTMLButtonElement>('li[data-entry-id="t4"] button[aria-label="Play AutoPlay Song"]')!;
    act(() => {
      titleButton.dispatchEvent(makePointer('pointerdown', { clientX: 120, clientY: 390 }));
      window.dispatchEvent(makePointer('pointermove', { clientX: 120, clientY: 110 }));
      window.dispatchEvent(makePointer('pointerup', { clientX: 120, clientY: 110 }));
    });

    const queue = usePlayer.getState().queue;
    expect(queue.map((e) => e.entryId)).toEqual(['t0', 't4', 't1', 't2', 't3']);
    expect(queue[1]!.tier).toBe('user');
  });

  it('supports keyboard Alt+ArrowUp / Alt+ArrowDown reordering on the drag handle', () => {
    act(() => root.render(<UpNext />));

    const handle1 = host.querySelector<HTMLButtonElement>('li[data-entry-id="t1"] [data-drag-handle="true"]')!;
    act(() => {
      handle1.focus();
      handle1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    });

    expect(usePlayer.getState().queue.map((e) => e.entryId)).toEqual(['t0', 't2', 't1', 't3', 't4']);

    const movedHandle = host.querySelector<HTMLButtonElement>('li[data-entry-id="t1"] [data-drag-handle="true"]')!;
    act(() => {
      movedHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    });

    expect(usePlayer.getState().queue.map((e) => e.entryId)).toEqual(['t0', 't1', 't2', 't3', 't4']);
  });

  it('opens Liquid Glass row context menu on right-click with identical options to the 3-dot menu', () => {
    act(() => root.render(<UpNext />));

    const row = host.querySelector<HTMLLIElement>('li[data-entry-id="t2"]')!;
    const ctxEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 210, clientY: 190, button: 2 });
    act(() => {
      row.dispatchEvent(ctxEvent);
    });

    expect(ctxEvent.defaultPrevented).toBe(true);
    expect(jumpSpy).not.toHaveBeenCalled();
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain('glass-menu');
    const items = Array.from(menu!.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Play Now', 'Play Next', 'Remove from Up Next']);

    act(() => {
      items[2]!.click();
    });
    expect(usePlayer.getState().queue.map((e) => e.entryId)).toEqual(['t0', 't1', 't3', 't4']);
  });
});
