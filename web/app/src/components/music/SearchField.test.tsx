// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Suggestions } from '@/data/music/types';
import { SearchField } from './SearchField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSuggestions: Suggestions = {
  queries: [
    { text: 'janji palsu', typed: 'janji palsu', rest: '' },
    { text: 'janji palsu hindia', typed: 'janji palsu', rest: ' hindia' },
  ],
  items: [
    { kind: 'artist', id: 'art-1', title: 'Hindia', subtitle: 'Artist', artists: [], album: null, thumbnail: null, wide: false, durationSec: null, explicit: false },
    { kind: 'video', id: 'vid-1', title: 'Janji Palsu (Live)', subtitle: 'Hindia · 56K views', artists: [{ name: 'Hindia', id: null }], album: null, thumbnail: null, wide: true, durationSec: 210, explicit: false },
    { kind: 'song', id: 'song-1', title: 'Janji Palsu', subtitle: 'Hindia · Janji Palsu', artists: [{ name: 'Hindia', id: null }], album: null, thumbnail: null, wide: false, durationSec: 205, explicit: false },
    { kind: 'song', id: 'song-2', title: 'Balasan Janji Palsumu', subtitle: 'Leon · Silauan Mengilau', artists: [{ name: 'Leon', id: null }], album: null, thumbnail: null, wide: false, durationSec: 230, explicit: false },
  ],
};

const playTrackSpy = vi.fn();

vi.mock('@/data/music/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/music/queries')>();
  return {
    ...actual,
    useSignedIn: () => false,
    useSuggestions: (q: string) => ({
      data: q.trim().length > 0 ? mockSuggestions : undefined,
    }),
  };
});

vi.mock('./play', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./play')>();
  return {
    ...actual,
    playTrack: (...args: unknown[]) => playTrackSpy(...args),
  };
});

describe('SearchField', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    playTrackSpy.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders song suggestions at the top before other entities and text query completions below', () => {
    const onSearch = vi.fn();
    act(() => {
      root.render(
        <MemoryRouter>
          <SearchField initial="janji palsu" onSearch={onSearch} />
        </MemoryRouter>,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    expect(input).toBeTruthy();

    act(() => {
      input.focus();
    });

    const options = Array.from(host.querySelectorAll<HTMLLIElement>('[role="listbox"] [role="option"]'));
    expect(options.map((el) => el.textContent?.trim())).toEqual([
      'Janji PalsuHindia · Janji Palsu',
      'Balasan Janji PalsumuLeon · Silauan Mengilau',
      'Janji Palsu (Live)Hindia · 56K views',
      'HindiaArtist',
      'janji palsu',
      'janji palsu hindia',
    ]);
    expect(host.querySelectorAll('[role="listbox"] [role="presentation"]').length).toBe(1);

    // ArrowDown -> Enter picks the leading song directly.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');

    const form = host.querySelector('form')!;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(playTrackSpy).toHaveBeenCalledTimes(1);
    expect(playTrackSpy.mock.calls[0]![0]).toMatchObject({ kind: 'song', id: 'song-1' });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it('closes dropdown and blurs search input when pressing Escape after focusing', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <SearchField initial="janji palsu" onSearch={vi.fn()} />
        </MemoryRouter>,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    act(() => {
      input.focus();
    });
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[role="listbox"]')).toBeTruthy();

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      input.dispatchEvent(esc);
    });

    expect(esc.defaultPrevented).toBe(true);
    expect(input.value).toBe('janji palsu');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).not.toBe(input);
  });

  it('opens Liquid Glass TrackMenu on right-click of a song suggestion row', () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <SearchField initial="janji palsu" onSearch={vi.fn()} />
        </MemoryRouter>,
      );
    });

    const input = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    act(() => {
      input.focus();
    });

    const firstSongOption = host.querySelector<HTMLLIElement>('[role="listbox"] [role="option"]')!;
    const ctx = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 250, clientY: 180, button: 2 });
    act(() => {
      firstSongOption.dispatchEvent(ctx);
    });

    expect(ctx.defaultPrevented).toBe(true);
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).toBeTruthy();
    expect(menu?.className).toContain('glass-menu');
    expect(Array.from(menu!.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim())).toEqual([
      'Play Next',
      'Add to Queue',
    ]);
  });
});
