import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  isEscBackRoute,
  performBackNavigation,
  useNavigationHistorySync,
} from '@/lib/navigationHistory';
import { getPlayhead, usePlayer } from '@/state/player';
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

function hasBlockingOverlayOpen(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"]:not([data-full-screen]), [role="menu"], [role="alertdialog"]'),
  );
}

function isArrowControlFocused(target: EventTarget | null): boolean {
  const selector = 'button, a, [role="slider"], [role="radiogroup"], [role="menu"], [role="listbox"]';
  return Boolean(targetClosest(target, selector) || targetClosest(document.activeElement, selector));
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
 * Global keyboard shortcuts for playback, navigation, and modal controls.
 */
export function useKeyboardShortcuts() {
  useNavigationHistorySync();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  const lastNonLyricsRef = useRef('/home');
  locationRef.current = location;
  if (location.pathname !== '/lyrics') {
    lastNonLyricsRef.current = `${location.pathname}${location.search}${location.hash}`;
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const ui = useUi.getState();
      if (ui.mandatoryUpdateLocked || document.querySelector('[data-mandatory-update="true"]')) {
        return;
      }
      const player = usePlayer.getState();
      const command = event.metaKey || event.ctrlKey;

      if (isSearchFocusShortcut(event)) {
        event.preventDefault();
        return focusSearch(navigate);
      }
      if (command && !event.shiftKey && (event.key === 'b' || event.key === 'B')) {
        if ((event.target as HTMLElement | null)?.isContentEditable) return;
        event.preventDefault();
        ui.toggleSidebarCompact();
        return;
      }
      if (typing(event.target) || typing(document.activeElement)) return;

      if (event.key === '?' && !command) {
        event.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
        return;
      }

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
        if (ui.shortcutsOpen) {
          event.preventDefault();
          ui.setShortcutsOpen(false);
          return;
        }
        // A menu, listbox dropdown, or dialog over the player closes first, on its own.
        if (
          targetClosest(
            event.target,
            '[role="menu"], [role="listbox"], [role="dialog"]:not([data-full-screen]), [role="alertdialog"]',
          )
        ) {
          return;
        }
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
          ui.quickSignInOpen ||
          ui.updateModalOpen ||
          ui.drawerOpen ||
          document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
        ) {
          return;
        }
        if (isEscBackRoute(locationRef.current.pathname)) {
          if (performBackNavigation(navigate, locationRef.current, 'escape')) {
            event.preventDefault();
          }
        }
        return;
      }

      if (command) {
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
        return;
      }

      if (hasBlockingOverlayOpen()) return;

      switch (event.key) {
        case 'f':
        case 'F':
          if (!ui.fullScreen && !player.nowPlaying) return;
          event.preventDefault();
          ui.setFullScreen(!ui.fullScreen);
          return;
        case 'm':
        case 'M':
          event.preventDefault();
          player.toggleMute();
          return;
        case 's':
        case 'S':
          event.preventDefault();
          player.toggleShuffle();
          return;
        case 'r':
        case 'R':
          event.preventDefault();
          player.cycleRepeat();
          return;
        case 'q':
        case 'Q':
          event.preventDefault();
          if (ui.fullScreen) ui.setFullScreen(false);
          ui.toggleSidePanel('up-next');
          return;
        case 'l':
        case 'L':
          event.preventDefault();
          if (ui.fullScreen) ui.setFullScreen(false);
          void navigate(locationRef.current.pathname === '/lyrics' ? lastNonLyricsRef.current : '/lyrics');
          return;
        case 'o':
        case 'O':
          event.preventDefault();
          ui.setAudioOutputOpen(!ui.audioOutputOpen);
          return;
        case 'p':
        case 'P':
          event.preventDefault();
          ui.setAudioPipelineOpen(!ui.audioPipelineOpen);
          return;
        case 'ArrowLeft': {
          if (isArrowControlFocused(event.target)) return;
          const pos = getPlayhead()?.sec ?? 0;
          event.preventDefault();
          player.seek(Math.max(0, pos - 5));
          return;
        }
        case 'ArrowRight': {
          if (isArrowControlFocused(event.target)) return;
          const pos = getPlayhead()?.sec ?? 0;
          const maxSec = player.nowPlaying?.durationSec ?? pos + 5;
          event.preventDefault();
          player.seek(maxSec > 0 ? Math.min(maxSec, pos + 5) : pos + 5);
          return;
        }
        case 'ArrowUp':
          if (isArrowControlFocused(event.target)) return;
          event.preventDefault();
          player.setVolume(Math.min(1, Number((player.volume + 0.05).toFixed(2))));
          return;
        case 'ArrowDown':
          if (isArrowControlFocused(event.target)) return;
          event.preventDefault();
          player.setVolume(Math.max(0, Number((player.volume - 0.05).toFixed(2))));
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}
