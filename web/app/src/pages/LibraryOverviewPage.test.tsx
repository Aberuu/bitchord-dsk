// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryOverviewPage from './LibraryOverviewPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/data/music/queries', () => ({
  useLibraryPlaylists: () => ({ data: [], isPending: false }),
  useSignedIn: () => false,
}));

vi.mock('@/extension/useYtAuth', () => ({
  useYtAuth: () => ({ state: 'signed-out', auth: null }),
}));

vi.mock('@/extension/useSpotifyAuth', () => ({
  useSpotifySignedIn: () => true,
}));

vi.mock('@/desktop/tauriBridge', () => ({
  isTauriDesktop: () => true,
  desktopApi: {
    downloadsList: async () => [],
    localListTracks: async () => [],
  },
}));

vi.mock('@/desktop/statsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/desktop/statsApi')>();
  return {
    ...actual,
    statsApi: {
      onUpdated: () => () => {},
      getSummary: async () => ({
        period: 'all_time',
        label: 'All time',
        totalMs: 120000,
        totalPlays: 4,
        distinctSongs: 2,
        distinctArtists: 2,
        distinctAlbums: 2,
        peakHour: 15,
        busiestDay: '2026-11-23',
        busiestDayMs: 60000,
        memberSince: '11/26',
        songs: [
          { videoId: 's1', title: 'Song One', artist: 'Artist A', ms: 60000, plays: 2, artworkUrl: null },
          { videoId: 's2', title: 'Song Two', artist: 'Artist B', ms: 60000, plays: 2, artworkUrl: null },
        ],
        artists: [
          { title: 'Artist A', ms: 60000, plays: 2, artworkUrl: null, browseId: null },
          { title: 'Artist B', ms: 60000, plays: 2, artworkUrl: null, browseId: null },
        ],
        albums: [
          { title: 'Album A', subtitle: 'Artist A', ms: 60000, plays: 2, artworkUrl: null, browseId: null },
          { title: 'Album B', subtitle: 'Artist B', ms: 60000, plays: 2, artworkUrl: null, browseId: null },
        ],
      }),
    },
  };
});

describe('LibraryOverviewPage hairline row anchoring', () => {
  let host: HTMLDivElement;
  let root: Root;
  let qc: QueryClient;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('gives every hairline-* row relative positioning so ::before dividers do not escape to <main> top', async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter>
            <LibraryOverviewPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(async () => {
      await act(async () => {
        await Promise.resolve();
      });
      expect(host.querySelectorAll('[class*="hairline-"]').length).toBe(9);
    });

    const hairlineEls = Array.from(host.querySelectorAll<HTMLElement>('[class*="hairline-"]'));
    for (const el of hairlineEls) {
      expect(el.classList.contains('relative')).toBe(true);
    }
  });
});
