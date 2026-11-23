// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicItem, Track } from '@/data/music/types';
import { usePlayer } from '@/state/player';
import { computePointMenuPosition } from './contextMenu';
import { TrackLockup } from './music/Lockups';
import { TrackList } from './music/TrackList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeTrack(id: string, title: string): Track {
  return {
    videoId: id,
    title,
    artists: [{ name: 'Hindia', id: null }],
    album: { name: 'Lagipula', id: null },
    durationSec: 215,
    explicit: false,
    thumbnail: null,
    index: 1,
    plays: null,
  };
}

describe('computePointMenuPosition', () => {
  it('opens at cursor when space fits on bottom-right', () => {
    expect(computePointMenuPosition({ x: 320, y: 240 }, { width: 200, height: 150 }, { width: 1280, height: 820 })).toEqual({
      left: 320,
      top: 240,
      maxHeight: 804,
    });
  });

  it('flips left and up near bottom-right viewport edges', () => {
    expect(computePointMenuPosition({ x: 1220, y: 780 }, { width: 200, height: 160 }, { width: 1280, height: 820 })).toEqual({
      left: 1020,
      top: 620,
      maxHeight: 804,
    });
  });

  it('clamps safely inside narrow 390px viewports', () => {
    const flipped = computePointMenuPosition({ x: 350, y: 800 }, { width: 220, height: 180 }, { width: 390, height: 844 });
    expect(flipped).toEqual({ left: 130, top: 620, maxHeight: 828 });

    const clampedEdge = computePointMenuPosition({ x: 180, y: 40 }, { width: 220, height: 180 }, { width: 390, height: 844 });
    expect(clampedEdge).toEqual({ left: 8, top: 40, maxHeight: 828 });
  });
});

describe('right-click context menu parity with 3-dot TrackMenu', () => {
  let host: HTMLDivElement;
  let root: Root;
  let qc: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    usePlayer.setState({ queue: [], index: -1 });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    usePlayer.setState({ queue: [], index: -1 });
  });

  it('opens Liquid Glass TrackMenu on right-click in TrackList matching the 3-dot menu', () => {
    const t = makeTrack('v-track-1', 'Janji Palsu');
    const playNextSpy = vi.fn();
    const originalPlayNext = usePlayer.getState().playNext;
    usePlayer.setState({ playNext: playNextSpy });

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <TrackList tracks={[t]} variant="album" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const row = host.querySelector<HTMLElement>('[role="table"] [data-variant="album"]')!;
    expect(row).toBeTruthy();

    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 220, button: 2 });
    act(() => {
      row.dispatchEvent(ev);
    });

    expect(ev.defaultPrevented).toBe(true);
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain('glass-menu');
    expect(menu?.style.left).toBe('180px');
    expect(menu?.style.top).toBe('220px');

    const items = Array.from(menu!.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Play Next', 'Add to Queue']);

    act(() => {
      items[0]!.click();
    });
    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(playNextSpy.mock.calls[0]![0]).toEqual([t]);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    usePlayer.setState({ playNext: originalPlayNext });
  });

  it('opens Liquid Glass TrackMenu on right-click in TrackLockup', () => {
    const item: MusicItem = {
      kind: 'song',
      id: 'song-lockup-1',
      title: 'Rumah ke Rumah',
      subtitle: 'Hindia',
      artists: [{ name: 'Hindia', id: null }],
      album: null,
      thumbnail: null,
      wide: false,
      durationSec: 260,
      explicit: false,
    };

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <TrackLockup item={item} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const card = host.firstElementChild as HTMLElement;
    expect(card.className).toContain('hover:bg-tracklist-hover');
    expect(card.className).toContain('data-open:bg-tracklist-hover');
    act(() => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 160, button: 2 }));
    });
    expect(card.hasAttribute('data-open')).toBe(true);

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain('glass-menu');
    expect(Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())).toEqual([
      'Play Next',
      'Add to Queue',
    ]);
  });
});
