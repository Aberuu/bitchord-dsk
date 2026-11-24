// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/state/ui';
import { Sidebar } from './Sidebar';
import { SidebarToggleButton } from './SidebarToggleButton';
import { TitleBar } from './TitleBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockDesktop = true;
let mockAuthState: 'signed-out' | 'signed-in' = 'signed-out';

vi.mock('@/desktop/tauriBridge', () => ({
  isTauriDesktop: () => mockDesktop,
  desktopApi: {
    openYtSignIn: vi.fn(async () => {}),
    signOutYt: vi.fn(async () => {}),
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));

vi.mock('@/extension/useYtAuth', () => ({
  useYtAuth: () =>
    mockAuthState === 'signed-in'
      ? {
          state: 'ready',
          auth: {
            browserSignedIn: true,
            connected: true,
            active: { id: 'ch-1', name: 'Saint de Lunatic', avatarUrl: null },
            accounts: [{ name: 'Main', email: null, authUser: 0, channels: [{ id: 'ch-1', name: 'Saint de Lunatic', avatarUrl: null }] }],
            problem: null,
          },
        }
      : {
          state: 'ready',
          auth: {
            browserSignedIn: false,
            connected: false,
            active: null,
            accounts: [],
            problem: null,
          },
        },
  useRefreshYtAuth: () => ({ mutate: vi.fn(), isPending: false }),
  useSelectChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useSetConnected: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/data/music/queries', () => ({
  useSignedIn: () => mockAuthState === 'signed-in',
  useLibraryPlaylists: () => ({
    data: [{ id: 'pl-1', title: 'Late Night Mix' }],
  }),
}));

vi.mock('@/extension/useSpotifyAuth', () => ({
  useSpotifySignedIn: () => false,
}));

vi.mock('@/data/spotify/queries', () => ({
  useSpotifyPlaylists: () => ({ data: [] }),
}));

vi.mock('@/state/sources', () => ({
  useSources: (selector: (s: { webdav: { configured: boolean }; smb: { configured: boolean } }) => unknown) =>
    selector({ webdav: { configured: false }, smb: { configured: false } }),
}));

describe('Sidebar compact mini-rail toggle', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    mockDesktop = true;
    mockAuthState = 'signed-out';
    useUi.setState({ sidebarCompact: false, drawerOpen: false });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  it('toggles sidebarCompact and persists choice in localStorage via TitleBar button', () => {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/home']}>
            <TitleBar />
            <Sidebar />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-controls="main-sidebar"]')!;
    const nav = host.querySelector<HTMLElement>('nav#main-sidebar')!;

    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse sidebar');
    expect(nav.hasAttribute('data-compact')).toBe(false);

    act(() => {
      toggle.click();
    });

    expect(useUi.getState().sidebarCompact).toBe(true);
    expect(localStorage.getItem('bitchord:sidebar-compact')).toBe('1');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand sidebar');
    expect(nav.getAttribute('data-compact')).toBe('true');

    // Preserves scrollbar hiding token and hides wide Sign In pill text visually on sm+.
    expect(nav.innerHTML).toContain('[scrollbar-width:none]');
    const signInBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Sign In"]')!;
    expect(signInBtn.querySelector('span')?.className).toContain('sm:sr-only');

    // Keeps compact GitHub watermark visible.
    expect(host.querySelector('[data-watermark="visible"]')).toBeTruthy();

    act(() => {
      toggle.click();
    });
    expect(useUi.getState().sidebarCompact).toBe(false);
    expect(localStorage.getItem('bitchord:sidebar-compact')).toBe('0');
    expect(nav.hasAttribute('data-compact')).toBe(false);
  });

  it('keeps All Playlists visible while tagging dynamic playlist rows for mini-rail hiding', () => {
    mockAuthState = 'signed-in';
    useUi.setState({ sidebarCompact: true });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/home']}>
            <SidebarToggleButton className="test-toggle" />
            <Sidebar />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const links = Array.from(host.querySelectorAll('a'));
    expect(links.some((a) => a.getAttribute('href') === '/library/playlists')).toBe(true);
    const dynamicPlaylistLink = links.find((a) => a.textContent?.includes('Late Night Mix'));
    expect(dynamicPlaylistLink?.closest('li')?.className).toContain('sm:group-data-[compact=true]/nav:hidden');
    expect(host.querySelector('button[aria-label="Saint de Lunatic account"]')).toBeTruthy();
  });
});
