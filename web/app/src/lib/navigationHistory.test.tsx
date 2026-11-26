// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetNavigationHistory, useNavigationHistorySync } from './navigationHistory';
import { BackButton } from '@/shell/BackButton';
import { MobileTopBar } from '@/shell/MobileTopBar';
import { SubpageHeader } from '@/components/SubpageHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function NavHarness() {
  useNavigationHistorySync();
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div>
      <MobileTopBar />
      <div className="bar">
        <BackButton className="back-btn" />
      </div>
      <main id="scrollable-page">
        <span data-testid="route">{`${location.pathname}${location.search}`}</span>
        <button type="button" data-testid="nav-search" onClick={() => navigate('/search?q=feast')} />
        <button type="button" data-testid="nav-artist" onClick={() => navigate('/artist/UCfeast')} />
        <button type="button" data-testid="nav-album" onClick={() => navigate('/album/MPREbfeast')} />
        <button type="button" data-testid="nav-discord" onClick={() => navigate('/settings/discord')} />
        <Routes>
          <Route path="/home" element={<div>Home</div>} />
          <Route path="/search" element={<div>Search</div>} />
          <Route path="/artist/:id" element={<div>Artist</div>} />
          <Route path="/album/:id" element={<div>Album</div>} />
          <Route path="/settings" element={<div>Settings</div>} />
          <Route path="/settings/discord" element={<SubpageHeader title="Discord" backTo="/settings" />} />
        </Routes>
      </main>
    </div>
  );
}

describe('BackButton, MobileTopBar Back, SubpageHeader & scroll restoration', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetNavigationHistory();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetNavigationHistory();
    vi.restoreAllMocks();
  });

  it('tracks navigation stack, steps back via UI BackButton, and restores #scrollable-page scrollTop', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <NavHarness />
        </MemoryRouter>,
      );
    });

    const backBtn = host.querySelector<HTMLButtonElement>('.back-btn')!;
    const main = host.querySelector<HTMLElement>('#scrollable-page')!;
    expect(backBtn.disabled).toBe(true);

    // Navigate Home -> Search -> Artist (.Feast) and scroll down on Artist before opening Album.
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="nav-search"]')!.click();
    });
    expect(backBtn.disabled).toBe(false);

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="nav-artist"]')!.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/artist/UCfeast');

    act(() => {
      main.scrollTop = 420;
      main.dispatchEvent(new Event('scroll'));
    });

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="nav-album"]')!.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/album/MPREbfeast');
    expect(main.scrollTop).toBe(0);

    // Click UI BackButton from Album -> returns to Artist and restores 420px scrollTop.
    act(() => {
      backBtn.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/artist/UCfeast');
    expect(main.scrollTop).toBe(420);

    // Click UI BackButton on MobileTopBar from Artist -> returns to Search results.
    const mobileBack = host.querySelector<HTMLButtonElement>('header button[aria-label="Back"]')!;
    expect(mobileBack).toBeTruthy();
    act(() => {
      mobileBack.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/search?q=feast');

    // Back one more time returns to Home and disables BackButton.
    act(() => {
      backBtn.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/home');
    expect(backBtn.disabled).toBe(true);
  });

  it('replaces direct Settings subpage jump with /settings so subsequent Back returns to prior artist page', () => {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/home']}>
          <NavHarness />
        </MemoryRouter>,
      );
    });

    const backBtn = host.querySelector<HTMLButtonElement>('.back-btn')!;
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="nav-artist"]')!.click();
    });
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="nav-discord"]')!.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/settings/discord');

    const subpageBack = host.querySelector<HTMLButtonElement>('button[aria-label="Back to Settings"]')!;
    act(() => {
      subpageBack.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/settings');

    act(() => {
      backBtn.click();
    });
    expect(host.querySelector('[data-testid="route"]')?.textContent).toBe('/artist/UCfeast');
  });
});
