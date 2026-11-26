import { useEffect, useRef } from 'react';
import {
  NavigationType,
  useLocation,
  useNavigate,
  useNavigationType,
  type NavigateFunction,
} from 'react-router';
import { create } from 'zustand';

export interface HistoryEntry {
  key: string;
  path: string;
  pathname: string;
}

const ROOT_TABS = ['/home', '/search', '/new', '/library', '/spotify'];

function fullPathOf(loc: { pathname: string; search?: string; hash?: string }): string {
  return `${loc.pathname}${loc.search ?? ''}${loc.hash ?? ''}`;
}

export function isRootTabPath(pathname: string): boolean {
  return ROOT_TABS.includes(pathname);
}

/**
 * Detail, drill-down, Lyrics, and Settings routes where pressing Escape navigates back
 * once no modal, menu, search dropdown, input, or fullscreen player is open.
 */
export function isEscBackRoute(pathname: string): boolean {
  if (!pathname || pathname === '/') return false;
  if (isRootTabPath(pathname)) return false;
  return (
    pathname.startsWith('/album/') ||
    pathname.startsWith('/artist/') ||
    pathname.startsWith('/playlist/') ||
    pathname.startsWith('/spotify/playlist/') ||
    pathname.startsWith('/browse/') ||
    pathname.startsWith('/library/') ||
    pathname.startsWith('/invite/') ||
    pathname === '/lyrics' ||
    pathname === '/replay' ||
    pathname === '/extension' ||
    pathname === '/debug' ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  );
}

export function getFallbackBackTarget(pathname: string, lastNonSettingsPath: string): string {
  if (pathname.startsWith('/settings/')) return '/settings';
  if (pathname === '/settings') {
    return lastNonSettingsPath && !lastNonSettingsPath.startsWith('/settings')
      ? lastNonSettingsPath
      : '/home';
  }
  if (pathname.startsWith('/library/')) return '/library';
  if (pathname.startsWith('/spotify/playlist/')) return '/spotify';
  return '/home';
}

function browserHistoryIdx(): number | null {
  if (typeof window === 'undefined') return null;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === 'number' ? idx : null;
}

interface NavigationHistoryState {
  items: HistoryEntry[];
  cursor: number;
  lastNonSettingsPath: string;
  scrollPositions: Record<string, number>;
}

const INITIAL_STATE: NavigationHistoryState = {
  items: [],
  cursor: 0,
  lastNonSettingsPath: '/home',
  scrollPositions: {},
};

export const useNavigationHistory = create<NavigationHistoryState>()(() => INITIAL_STATE);

export function resetNavigationHistory(): void {
  useNavigationHistory.setState({
    items: [],
    cursor: 0,
    lastNonSettingsPath: '/home',
    scrollPositions: {},
  });
}

function readMainScrollTop(): number {
  if (typeof document === 'undefined') return 0;
  return document.getElementById('scrollable-page')?.scrollTop ?? 0;
}

function restoreMainScrollTop(targetTop: number): void {
  if (typeof document === 'undefined') return;
  const apply = () => {
    const el = document.getElementById('scrollable-page');
    if (el) el.scrollTop = targetTop;
  };
  apply();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => apply());
  }
}

function hasPoppableHistory(state: NavigationHistoryState): boolean {
  if (state.cursor > 0) return true;
  const idx = browserHistoryIdx();
  return idx !== null && idx > 0;
}

export function useCanGoBack(): boolean {
  return useNavigationHistory((state) => {
    if (hasPoppableHistory(state)) return true;
    const current = state.items[state.cursor]?.pathname;
    return current ? isEscBackRoute(current) : false;
  });
}

export function useCurrentRoutePath(): string {
  return useNavigationHistory((state) => state.items[state.cursor]?.pathname ?? '/home');
}

export function performBackNavigation(
  navigate: NavigateFunction,
  currentLocation: { pathname: string; search?: string; hash?: string },
  source: 'button' | 'escape' = 'button',
): boolean {
  const state = useNavigationHistory.getState();
  const pathname = currentLocation.pathname;
  const canPop = hasPoppableHistory(state);
  const prevItem = state.cursor > 0 ? state.items[state.cursor - 1] : undefined;

  if (pathname.startsWith('/settings/')) {
    if (prevItem?.pathname === '/settings') {
      navigate(-1);
    } else {
      // Replace direct Settings subpage jumps (e.g. Sidebar -> Audio & EQ) so a subsequent Back/Esc exits Settings without bouncing back.
      navigate('/settings', { replace: canPop });
    }
    return true;
  }

  if (pathname === '/settings') {
    const nonSettingsPrev = prevItem && !prevItem.pathname.startsWith('/settings');
    if (canPop && nonSettingsPrev) {
      navigate(-1);
    } else {
      const target = getFallbackBackTarget(pathname, state.lastNonSettingsPath);
      navigate(target, { replace: false });
    }
    return true;
  }

  if (source === 'escape' && !isEscBackRoute(pathname)) {
    return false;
  }

  if (canPop) {
    navigate(-1);
    return true;
  }

  if (isEscBackRoute(pathname)) {
    const target = getFallbackBackTarget(pathname, state.lastNonSettingsPath);
    navigate(target, { replace: true });
    return true;
  }

  return false;
}

let activeSyncMounts = 0;

/**
 * Syncs React Router location transitions and `#scrollable-page` vertical scroll
 * positions into `useNavigationHistory`. Safe under React 19 StrictMode and Vitest.
 */
export function useNavigationHistorySync(): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const prevRef = useRef<{ key: string; pathname: string; search: string } | null>(null);

  useEffect(() => {
    activeSyncMounts += 1;
    return () => {
      activeSyncMounts = Math.max(0, activeSyncMounts - 1);
      if (activeSyncMounts === 0) {
        resetNavigationHistory();
      }
    };
  }, []);

  useEffect(() => {
    const el = document.getElementById('scrollable-page');
    if (!el) return;
    const activeKey = location.key || fullPathOf(location);
    const onScroll = () => {
      const current = useNavigationHistory.getState();
      if (current.scrollPositions[activeKey] === el.scrollTop) return;
      useNavigationHistory.setState({
        scrollPositions: { ...current.scrollPositions, [activeKey]: el.scrollTop },
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [location]);

  useEffect(() => {
    const path = fullPathOf(location);
    const key = location.key || path;
    const entry: HistoryEntry = { key, path, pathname: location.pathname };
    const state = useNavigationHistory.getState();
    const nextNonSettings = !location.pathname.startsWith('/settings') ? path : state.lastNonSettingsPath;
    const prev = prevRef.current;

    if (prev && prev.key === key && state.items[state.cursor]?.path === path) {
      if (nextNonSettings !== state.lastNonSettingsPath) {
        useNavigationHistory.setState({ lastNonSettingsPath: nextNonSettings });
      }
      return;
    }

    const updatedScrolls = { ...state.scrollPositions };
    if (prev && navigationType === NavigationType.Push) {
      updatedScrolls[prev.key] = updatedScrolls[prev.key] ?? readMainScrollTop();
    }

    if (state.items.length === 0) {
      useNavigationHistory.setState({
        items: [entry],
        cursor: 0,
        lastNonSettingsPath: nextNonSettings,
        scrollPositions: updatedScrolls,
      });
      prevRef.current = { key, pathname: location.pathname, search: location.search };
      return;
    }

    if (navigationType === NavigationType.Push) {
      const trimmed = state.items.slice(0, state.cursor + 1);
      const top = trimmed[trimmed.length - 1];
      if (top && top.path === entry.path) {
        useNavigationHistory.setState({
          lastNonSettingsPath: nextNonSettings,
          scrollPositions: updatedScrolls,
        });
      } else {
        trimmed.push(entry);
        useNavigationHistory.setState({
          items: trimmed,
          cursor: trimmed.length - 1,
          lastNonSettingsPath: nextNonSettings,
          scrollPositions: updatedScrolls,
        });
      }
      if (prev && prev.pathname !== location.pathname && !location.search.includes('focus=')) {
        restoreMainScrollTop(0);
      }
    } else if (navigationType === NavigationType.Replace) {
      const nextItems = [...state.items];
      nextItems[state.cursor] = entry;
      useNavigationHistory.setState({
        items: nextItems,
        lastNonSettingsPath: nextNonSettings,
        scrollPositions: updatedScrolls,
      });
    } else {
      // NavigationType.Pop: match adjacent step first, then scan history.
      let nextCursor = state.cursor;
      if (
        state.cursor > 0 &&
        (state.items[state.cursor - 1]?.key === key || state.items[state.cursor - 1]?.path === path)
      ) {
        nextCursor = state.cursor - 1;
      } else if (
        state.cursor + 1 < state.items.length &&
        (state.items[state.cursor + 1]?.key === key || state.items[state.cursor + 1]?.path === path)
      ) {
        nextCursor = state.cursor + 1;
      } else {
        const idx = state.items.findLastIndex((it) => it.key === key || it.path === path);
        if (idx >= 0) {
          nextCursor = idx;
        } else {
          useNavigationHistory.setState({
            items: [entry],
            cursor: 0,
            lastNonSettingsPath: nextNonSettings,
            scrollPositions: updatedScrolls,
          });
          prevRef.current = { key, pathname: location.pathname, search: location.search };
          return;
        }
      }

      const nextItems = [...state.items];
      nextItems[nextCursor] = entry;
      useNavigationHistory.setState({
        items: nextItems,
        cursor: nextCursor,
        lastNonSettingsPath: nextNonSettings,
        scrollPositions: updatedScrolls,
      });

      if (!location.search.includes('focus=')) {
        restoreMainScrollTop(updatedScrolls[key] ?? 0);
      }
    }

    prevRef.current = { key, pathname: location.pathname, search: location.search };
  }, [location, navigationType]);
}
