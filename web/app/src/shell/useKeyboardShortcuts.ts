import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { findMusicSearchInput, focusAndSelectInput, isSearchFocusShortcut } from './searchShortcut';

/** Typing in a field shouldn't trigger the player. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}

function targetClosest(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null;
}

function attemptFocusMusicSearch() {
  const started = performance.now();
  const attempt = () => {
    const mounted = findMusicSearchInput();
    if (mounted) focusAndSelectInput(mounted);
    else if (performance.now() - started < 3000) setTimeout(attempt, 50);
  };
  attempt();
}

function focusSearch(navigate: ReturnType<typeof useNavigate>) {
  const ui = useUi.getState();
  if (ui.fullScreen) {
    if (!ui.fullScreenSearchOpen) ui.setFullScreenSearchOpen(true);
    attemptFocusMusicSearch();
    return;
  }
  const field = findMusicSearchInput();
  if (field) return focusAndSelectInput(field);
  navigate('/search');
  // The search page is lazy: focus its field once it has rendered (for up to 3 s).
  attemptFocusMusicSearch();
}

/**
 * The web player's shortcuts, which BitChord matches (report §8): Space
 * play/pause; ⌘/Ctrl+→ / ← next/previous; ⌘/Ctrl+↑ / ↓ volume; ⌘/Ctrl+K,
 * ⌘/Ctrl+F, or "/" focuses music search; Esc closes the full-screen player,
 * else the side panel.
 */
export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  const lastNonSettingsRef = useRef('/home');
  locationRef.current = location;
  if (!location.pathname.startsWith('/settings')) {
    lastNonSettingsRef.current = `${location.pathname}${location.search}${location.hash}`;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const player = usePlayer.getState();
      const command = event.metaKey || event.ctrlKey;

      if (isSearchFocusShortcut(event)) {
        event.preventDefault();
        return focusSearch(navigate);
      }
      if (typing(event.target) || typing(document.activeElement)) return;

      if (event.key === ' ' && !command) {
        // A focused button already answers Space itself.
        if (targetClosest(event.target, 'button, a, [role="slider"]')) return;
        event.preventDefault();
        return player.togglePlay();
      }
      if (event.key === '/' && !command) {
        event.preventDefault();
        return focusSearch(navigate);
      }
      if (event.key === 'Escape') {
        const ui = useUi.getState();
        // A menu or dialog over the player closes first, on its own.
        if (targetClosest(event.target, '[role="menu"], [role="dialog"]:not([data-full-screen])')) return;
        if (ui.fullScreen && ui.fullScreenSearchOpen) {
          event.preventDefault();
          ui.setFullScreenSearchOpen(false);
          return;
        }
        if (ui.fullScreen) {
          ui.setFullScreen(false);
          return;
        }
        if (ui.sidePanel) {
          ui.closeSidePanel();
          return;
        }
        if (
          ui.audioOutputOpen ||
          ui.audioPipelineOpen ||
          ui.castModalOpen ||
          ui.drawerOpen ||
          document.querySelector('[role="dialog"], [role="menu"]')
        ) {
          return;
        }
        const { pathname } = locationRef.current;
        if (pathname.startsWith('/settings/')) {
          event.preventDefault();
          void navigate('/settings');
          return;
        }
        if (pathname === '/settings') {
          event.preventDefault();
          void navigate(lastNonSettingsRef.current);
        }
        return;
      }
      if (!command) return;
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          return player.next();
        case 'ArrowLeft':
          event.preventDefault();
          return player.previous();
        case 'ArrowUp':
          event.preventDefault();
          return player.setVolume(player.volume + 0.1);
        case 'ArrowDown':
          event.preventDefault();
          return player.setVolume(player.volume - 0.1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}
