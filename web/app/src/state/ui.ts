import { create } from 'zustand';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';

export type SidePanel = 'up-next' | 'lyrics' | null;
export type ThemePreference = 'system' | 'light' | 'dark';

interface UiState {
  sidePanel: SidePanel;
  toggleSidePanel: (panel: Exclude<SidePanel, null>) => void;
  closeSidePanel: () => void;
  fullScreen: boolean;
  setFullScreen: (open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  installBannerDismissed: boolean;
  dismissInstallBanner: () => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  minimizeToTray: boolean;
  setMinimizeToTray: (enabled: boolean) => void;
}

const BANNER_KEY = 'bitchord:install-banner-dismissed';
const THEME_KEY = 'bitchord:theme';
const TRAY_KEY = 'bitchord:minimize-to-tray';

function readTheme(): ThemePreference {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
}

function readMinimizeToTray(): boolean {
  const saved = localStorage.getItem(TRAY_KEY);
  return saved === null ? true : saved === '1';
}

export const useUi = create<UiState>()((set) => ({
  sidePanel: null,
  toggleSidePanel: (panel) => set((s) => ({ sidePanel: s.sidePanel === panel ? null : panel })),
  closeSidePanel: () => set({ sidePanel: null }),
  fullScreen: false,
  setFullScreen: (fullScreen) => set({ fullScreen }),
  drawerOpen: false,
  setDrawerOpen: (drawerOpen) => set({ drawerOpen }),
  installBannerDismissed: sessionStorage.getItem(BANNER_KEY) === '1',
  dismissInstallBanner: () => {
    sessionStorage.setItem(BANNER_KEY, '1');
    set({ installBannerDismissed: true });
  },
  theme: readTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },
  minimizeToTray: readMinimizeToTray(),
  setMinimizeToTray: (enabled) => {
    localStorage.setItem(TRAY_KEY, enabled ? '1' : '0');
    set({ minimizeToTray: enabled });
    if (isTauriDesktop()) void desktopApi.setMinimizeToTray(enabled).catch(() => {});
  },
}));

if (import.meta.env.DEV) Object.assign(window, { __bcUi: useUi });
