// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@/routes';
import { hydratePlaybackSessionFromStorage, usePlayer } from '@/state/player';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Startup Home route & last played track restoration', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    usePlayer.setState({
      queue: [],
      index: -1,
      nowPlaying: null,
      status: 'idle',
      nativeActive: false,
      nativePlayhead: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    usePlayer.setState({
      queue: [],
      index: -1,
      nowPlaying: null,
      status: 'idle',
      nativeActive: false,
      nativePlayhead: null,
    });
  });

  it('always opens /home on reopen even if last-route stored /settings, while keeping last played track', async () => {
    localStorage.setItem('bitchord:last-route', '/settings');
    localStorage.setItem(
      'bitchord:playback-session',
      JSON.stringify({
        queue: [
          {
            entryId: 'e-home-1',
            tier: 'user',
            source: { title: 'Album', type: 'album', id: 'alb-home' },
            track: {
              videoId: 'vid-last-home',
              title: 'Saved Song Before Close',
              artists: [{ name: 'Artist H', id: null }],
              album: { name: 'Album H', id: null },
              durationSec: 210,
              explicit: false,
              thumbnail: null,
              index: 0,
              plays: null,
            },
          },
        ],
        index: 0,
        nowPlaying: {
          videoId: 'vid-last-home',
          title: 'Saved Song Before Close',
          artist: 'Artist H',
          artworkUrl: null,
          durationSec: 210,
          streamInfo: '251 opus',
          stream: null,
        },
        positionSec: 42,
        shuffle: false,
        repeat: 'off',
        savedAtMs: Date.now(),
      }),
    );

    expect(hydratePlaybackSessionFromStorage()).toBe(true);
    expect(usePlayer.getState().nowPlaying?.videoId).toBe('vid-last-home');
    expect(usePlayer.getState().status).toBe('paused');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(router.state.location.pathname).toBe('/home');
    expect(localStorage.getItem('bitchord:last-route')).toBeNull();
  });
});
