// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Suggestions } from '@/data/music/types';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { FullScreenPlayer } from './FullScreenPlayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockSuggestions: Suggestions = {
  queries: [{ text: 'tarot', typed: 'tarot', rest: '' }],
  items: [
    {
      kind: 'song',
      id: 'song-fs-1',
      title: 'Tarot',
      subtitle: '.Feast',
      artists: [{ name: '.Feast', id: null }],
      album: null,
      thumbnail: null,
      wide: false,
      durationSec: 210,
      explicit: false,
    },
  ],
};

const playTrackSpy = vi.fn();
let mockVideoId: string | null = null;

vi.mock('@/data/apple/motionArt', () => ({
  useTrackMotion: () => null,
}));

vi.mock('@/desktop/useAudioPipeline', () => ({
  useAudioPipeline: () => ({ activeDeviceName: 'Speakers' }),
}));

vi.mock('@/state/video', () => ({
  claimVideoSurface: () => () => {},
  qualityLabel: (height: number) => `${height}p`,
  setVideoQuality: () => {},
  useHasVideo: (videoId: string | null | undefined) => !!videoId && mockVideoId === videoId,
  useVideo: Object.assign(
    (selector: (s: { heights: number[]; quality: 'auto' | number; activeHeight: number | null; videoId: string | null }) => unknown) =>
      selector({ heights: [], quality: 'auto', activeHeight: null, videoId: mockVideoId }),
    { getState: () => ({ videoId: mockVideoId }) },
  ),
}));

vi.mock('@/data/music/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/music/queries')>();
  return {
    ...actual,
    useSignedIn: () => false,
    useSuggestions: (q: string) => ({ data: q.trim() ? mockSuggestions : undefined }),
  };
});

vi.mock('@/components/music/play', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/music/play')>();
  return {
    ...actual,
    playTrack: (...args: unknown[]) => playTrackSpy(...args),
  };
});

vi.mock('./LyricsPanel', () => ({
  LyricsPanel: () => <div data-testid="mock-lyrics" />,
}));

vi.mock('./MeshBackdrop', () => ({
  MeshBackdrop: () => <div data-testid="mock-mesh" />,
}));

vi.mock('./NerdStats', () => ({
  MixWindowHighlight: () => null,
  NerdStats: () => null,
}));

describe('FullScreenPlayer exit animation and Ctrl+K search', () => {
  let host: HTMLDivElement;
  let root: Root;
  let qc: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    playTrackSpy.mockReset();
    mockVideoId = null;

    useUi.setState({ fullScreen: true, fullScreenSearchOpen: false });
    usePlayer.setState({
      nowPlaying: {
        videoId: 'v-now',
        title: 'Janji Palsu',
        artist: 'Hindia',
        artworkUrl: null,
        durationSec: 205,
        streamInfo: null,
        stream: null,
      },
      status: 'playing',
      queue: [],
      index: -1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUi.setState({ fullScreen: false, fullScreenSearchOpen: false });
    usePlayer.setState({ nowPlaying: null, queue: [], index: -1 });
    vi.useRealTimers();
  });

  function renderFs(exiting: boolean, onExited = vi.fn()) {
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/home']}>
            <FullScreenPlayer exiting={exiting} onExited={onExited} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return onExited;
  }

  it('plays reverse exit animation before unmounting and ignores child animationend events', () => {
    const onExited = renderFs(false);
    const dialog = host.querySelector<HTMLElement>('[data-full-screen]')!;
    expect(dialog.className).toContain('animate-enter');
    expect(dialog.hasAttribute('data-exiting')).toBe(false);

    renderFs(true, onExited);
    expect(dialog.getAttribute('data-exiting')).toBe('true');
    expect(dialog.className).toContain('animate-exit');

    // Child animationend must not dismiss early.
    const child = dialog.querySelector('[aria-label="Lyrics"]')!;
    act(() => {
      child.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(onExited).not.toHaveBeenCalled();

    // Own animationend notifies host immediately (native CSS animationend bubbles).
    act(() => {
      dialog.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it('falls back cleanly to timer if browser animationend does not fire', () => {
    const onExited = renderFs(false);
    renderFs(true, onExited);
    act(() => {
      vi.advanceTimersByTime(270);
    });
    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it('opens in-fullscreen search overlay, plays chosen song without leaving fullscreen, and cancels cleanly on Escape', () => {
    renderFs(false);

    const searchBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Search music"]')!;
    act(() => {
      searchBtn.click();
    });
    expect(useUi.getState().fullScreenSearchOpen).toBe(true);

    const fsInput = host.querySelector<HTMLInputElement>('input[data-fullscreen-search="true"]')!;
    expect(fsInput).toBeTruthy();

    act(() => {
      fsInput.focus();
      const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setNative.call(fsInput, 'tarot');
      fsInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const firstSong = host.querySelector<HTMLLIElement>('[role="listbox"] [role="option"]')!;
    expect(firstSong.textContent).toContain('Tarot');
    act(() => {
      firstSong.click();
    });

    expect(playTrackSpy).toHaveBeenCalledTimes(1);
    expect(useUi.getState().fullScreenSearchOpen).toBe(false);
    expect(useUi.getState().fullScreen).toBe(true);

    // Reopen and cancel with Escape -> stays in FullScreenPlayer.
    act(() => {
      useUi.getState().setFullScreenSearchOpen(true);
    });
    const reopenedInput = host.querySelector<HTMLInputElement>('input[data-fullscreen-search="true"]')!;
    act(() => {
      reopenedInput.focus();
      reopenedInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().fullScreenSearchOpen).toBe(false);
    expect(useUi.getState().fullScreen).toBe(true);
  });

  it('anchors theater video bottom scrim to bottom-0 without cutting off controls above footer', () => {
    mockVideoId = 'v-now';
    renderFs(false);

    const dialog = host.querySelector<HTMLElement>('[data-full-screen]')!;
    const scrim = dialog.querySelector<HTMLElement>('[data-theater-scrim="true"]')!;
    expect(scrim).toBeTruthy();
    expect(scrim.className).toContain('bottom-0');
    expect(scrim.className).not.toContain('bottom-16');

    const controlsSection = dialog.querySelector<HTMLElement>('section[aria-label="Player"]')!;
    const controlsWrapper = controlsSection.parentElement!;
    expect(controlsWrapper.className).toContain('flex-1');
    expect(controlsWrapper.className).not.toContain('bottom-16');

    const footer = dialog.querySelector('footer');
    expect(footer).toBeTruthy();
  });
});
