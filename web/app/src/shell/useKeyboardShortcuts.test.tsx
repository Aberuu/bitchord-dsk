// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useKeyboardShortcuts();
  const location = useLocation();
  const navigate = useNavigate();
  const fullScreenSearchOpen = useUi((s) => s.fullScreenSearchOpen);
  return (
    <div>
      <span data-testid="path">{`${location.pathname}${location.search}`}</span>
      <button type="button" data-testid="go-search" onClick={() => navigate('/search?q=feast')} />
      <button type="button" data-testid="go-artist" onClick={() => navigate('/artist/UCfeast')} />
      <button type="button" data-testid="go-album" onClick={() => navigate('/album/MPREbfeast')} />
      <button type="button" data-testid="go-settings" onClick={() => navigate('/settings')} />
      <button type="button" data-testid="go-appearance" onClick={() => navigate('/settings/appearance')} />
      {fullScreenSearchOpen && <input type="search" data-music-search="true" data-fullscreen-search="true" />}
      <Routes>
        <Route
          path="/home"
          element={<div key="home">Home</div>}
        />
        <Route
          path="/artist/:id"
          element={<div key="artist">Artist</div>}
        />
        <Route
          path="/album/:id"
          element={<div key="album">Album</div>}
        />
        <Route
          path="/playlist/:id"
          element={<div key="playlist">Playlist</div>}
        />
        <Route
          path="/browse/:id"
          element={<div key="browse">Browse</div>}
        />
        <Route
          path="/library"
          element={<div key="library">Library</div>}
        />
        <Route
          path="/library/:section"
          element={<div key="library-section">Library Section</div>}
        />
        <Route
          path="/settings"
          element={
            <div key="settings">
              <input type="search" placeholder="Search settings" />
            </div>
          }
        />
        <Route
          path="/settings/appearance"
          element={<div key="appearance">Appearance</div>}
        />
        <Route
          path="/settings/sources"
          element={<div key="sources">Sources</div>}
        />
        <Route
          path="/settings/quality"
          element={
            <div key="quality">
              <input type="text" placeholder="Quality input" />
            </div>
          }
        />
        <Route
          path="/search"
          element={
            <div key="search">
              <input type="search" data-music-search="true" defaultValue="old query" />
            </div>
          }
        />
        <Route path="/lyrics" element={<div key="lyrics">Lyrics</div>} />
      </Routes>
    </div>
  );
}

describe('useKeyboardShortcuts Ctrl+K', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useUi.setState({
      fullScreen: false,
      fullScreenSearchOpen: false,
      shortcutsOpen: false,
      audioOutputOpen: false,
      audioPipelineOpen: false,
      sidePanel: null,
      mandatoryUpdateLocked: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUi.setState({
      fullScreen: false,
      fullScreenSearchOpen: false,
      shortcutsOpen: false,
      audioOutputOpen: false,
      audioPipelineOpen: false,
      sidePanel: null,
      mandatoryUpdateLocked: false,
    });
    usePlayer.setState({ nowPlaying: null, muted: false, shuffle: false, repeat: 'off', volume: 0.5 });
  });

  it('leaves /settings Search settings, navigates to /search, and focuses & selects music search', async () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/settings']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    const settingsInput = host.querySelector<HTMLInputElement>('input[placeholder="Search settings"]')!;
    act(() => {
      settingsInput.focus();
    });
    expect(document.activeElement).toBe(settingsInput);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 70));
    });

    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/search');
    const musicInput = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    expect(document.activeElement).toBe(musicInput);
    expect(musicInput.selectionStart).toBe(0);
    expect(musicInput.selectionEnd).toBe('old query'.length);
  });

  it('opens in-fullscreen search on Ctrl+K and closes search before closing fullScreen on Escape', async () => {
    act(() => {
      useUi.setState({ fullScreen: true, fullScreenSearchOpen: false });
      root.render(
        <MemoryRouter initialEntries={['/settings']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 70));
    });

    expect(useUi.getState().fullScreen).toBe(true);
    expect(useUi.getState().fullScreenSearchOpen).toBe(true);
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings');
    const fsInput = host.querySelector<HTMLInputElement>('input[data-fullscreen-search="true"]')!;
    expect(document.activeElement).toBe(fsInput);

    act(() => {
      fsInput.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().fullScreenSearchOpen).toBe(false);
    expect(useUi.getState().fullScreen).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().fullScreen).toBe(false);
  });

  it('navigates back to /settings on Escape from settings subpages and back from /settings', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home', '/settings', '/settings/sources']}>
          <Harness />
        </MemoryRouter>,
      );
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings/sources');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/home');
  });

  it('does not navigate away from /settings/* on Escape when a dialog or input is active', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/settings/quality']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    // Focused input blocks Escape back navigation.
    const input = host.querySelector<HTMLInputElement>('input[placeholder="Quality input"]')!;
    act(() => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings/quality');

    // Open dialog blocks Escape back navigation.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    act(() => {
      input.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings/quality');
    dialog.remove();

    // Open drawer blocks Escape back navigation.
    act(() => {
      useUi.setState({ drawerOpen: true });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings/quality');

    // Once overlays are closed, Escape navigates back to /settings.
    act(() => {
      useUi.setState({ drawerOpen: false });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings');
  });

  it('navigates back step-by-step on Escape from Album -> Artist -> Search -> stays on Search, and supports Settings roundtrip without ping-pong', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    const clickNav = (testId: string) => {
      act(() => {
        host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
      });
    };
    const pressEsc = () => {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
    };

    clickNav('go-search');
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/search?q=feast');

    clickNav('go-artist');
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/artist/UCfeast');

    clickNav('go-album');
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/album/MPREbfeast');

    // Visit Settings -> Appearance from Album, then unwind with Escape with zero ping-pong.
    clickNav('go-settings');
    clickNav('go-appearance');
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings/appearance');

    pressEsc();
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/settings');

    pressEsc();
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/album/MPREbfeast');

    pressEsc();
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/artist/UCfeast');

    pressEsc();
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/search?q=feast');

    // Pressing Escape on a root tab does not leave Search unexpectedly.
    pressEsc();
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/search?q=feast');
  });

  it('falls back cleanly on Escape for direct deep links into album, artist, or library section without prior history', () => {
    act(() => {
      root.render(
        <MemoryRouter key="direct-album" initialEntries={['/album/direct123']}>
          <Harness />
        </MemoryRouter>,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/home');

    act(() => {
      root.unmount();
      root = createRoot(host);
      root.render(
        <MemoryRouter key="direct-library" initialEntries={['/library/artists']}>
          <Harness />
        </MemoryRouter>,
      );
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/library');
  });

  it('toggles compact sidebar on Ctrl+B and prevents default bookmark shortcut', () => {
    useUi.setState({ sidebarCompact: false });
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    const openEv = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(openEv);
    });
    expect(openEv.defaultPrevented).toBe(true);
    expect(useUi.getState().sidebarCompact).toBe(true);

    const closeEv = new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(closeEv);
    });
    expect(closeEv.defaultPrevented).toBe(true);
    expect(useUi.getState().sidebarCompact).toBe(false);
  });

  it('handles F fullscreen, M mute, S shuffle, R repeat, Q up-next, L lyrics, O output, P pipeline, and ? modal', () => {
    usePlayer.setState({
      nowPlaying: {
        videoId: 'v1',
        title: 'Track 1',
        artist: 'Artist 1',
        artworkUrl: null,
        durationSec: 200,
        streamInfo: null,
        stream: null,
      },
      muted: false,
      shuffle: false,
      repeat: 'off',
      volume: 0.5,
    });

    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    // F toggles fullscreen when a track is loaded.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().fullScreen).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().fullScreen).toBe(false);

    // M, S, R player controls.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true }));
    });
    expect(usePlayer.getState().muted).toBe(true);
    expect(usePlayer.getState().shuffle).toBe(true);
    expect(usePlayer.getState().repeat).toBe('all');

    // Q toggles Up Next side panel.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().sidePanel).toBe('up-next');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().sidePanel).toBe(null);

    // L toggles Lyrics route.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/lyrics');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe('/home');

    // O and P open Audio Output and Pipeline dialogs.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().audioOutputOpen).toBe(true);
    act(() => {
      useUi.setState({ audioOutputOpen: false });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().audioPipelineOpen).toBe(true);
    act(() => {
      useUi.setState({ audioPipelineOpen: false });
    });

    // ? opens ShortcutsModal and Escape closes it.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().shortcutsOpen).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().shortcutsOpen).toBe(false);
  });

  it('seeks 5s on bare Left/Right, changes volume 5% on Up/Down, respects slider guard and mandatory update lock', () => {
    const seekSpy = vi.spyOn(usePlayer.getState(), 'seek').mockImplementation(() => {});
    usePlayer.setState({
      nowPlaying: {
        videoId: 'v1',
        title: 'Track 1',
        artist: 'Artist 1',
        artworkUrl: null,
        durationSec: 120,
        streamInfo: null,
        stream: null,
      },
      volume: 0.5,
    });

    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <Harness />
        </MemoryRouter>,
      );
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    });
    expect(seekSpy).toHaveBeenCalledWith(5);
    expect(usePlayer.getState().volume).toBeCloseTo(0.55, 2);

    // Focused slider prevents bare arrow hijack.
    const slider = document.createElement('div');
    slider.setAttribute('role', 'slider');
    slider.tabIndex = 0;
    host.appendChild(slider);
    act(() => {
      slider.focus();
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    });
    expect(seekSpy).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().volume).toBeCloseTo(0.55, 2);
    slider.blur();

    // Mandatory update lock blocks all shortcuts including ? and F.
    act(() => {
      useUi.setState({ mandatoryUpdateLocked: true });
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }));
    });
    expect(useUi.getState().shortcutsOpen).toBe(false);
    expect(useUi.getState().fullScreen).toBe(false);

    seekSpy.mockRestore();
  });
});
