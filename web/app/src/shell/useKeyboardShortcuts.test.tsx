// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUi } from '@/state/ui';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useKeyboardShortcuts();
  const location = useLocation();
  const fullScreenSearchOpen = useUi((s) => s.fullScreenSearchOpen);
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      {fullScreenSearchOpen && <input type="search" data-music-search="true" data-fullscreen-search="true" />}
      <Routes>
        <Route
          path="/home"
          element={<div key="home">Home</div>}
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
    useUi.setState({ fullScreen: false, fullScreenSearchOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUi.setState({ fullScreen: false, fullScreenSearchOpen: false });
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
});
