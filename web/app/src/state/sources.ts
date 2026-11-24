import { create } from 'zustand';
import {
  desktopApi,
  isTauriDesktop,
  type AddonConfig,
  type AddonHealthStatus,
  type AddonProbeResult,
  type SmbStatusView,
  type SourcesSnapshot,
  type WebDavStatusView,
} from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';

export const DEFAULT_TRACK_LENGTH_TOLERANCE_SEC = 5;
export const MIN_TRACK_LENGTH_TOLERANCE_SEC = 0;
export const MAX_TRACK_LENGTH_TOLERANCE_SEC = 10;

export type AddonLiveStatus = { state: 'checking' } | AddonHealthStatus;

interface SourcesStoreState {
  loaded: boolean;
  addons: AddonConfig[];
  jiosaavnEnabled: boolean;
  trackLengthToleranceSec: number;
  webdav: WebDavStatusView;
  smb: SmbStatusView;
  healthByAddonId: Record<string, AddonLiveStatus>;

  loadFromBackend: () => Promise<void>;
  applySnapshot: (snapshot: SourcesSnapshot) => void;
  setAddonsOrderOrUpdate: (next: AddonConfig[]) => Promise<void>;
  toggleAddonEnabled: (id: string, enabled: boolean) => Promise<void>;
  setAddonQuality: (id: string, pickedQuality: string | null) => Promise<void>;
  upsertAddon: (config: AddonConfig, health?: AddonHealthStatus) => Promise<void>;
  removeAddon: (id: string) => Promise<void>;
  reorderAddon: (fromIndex: number, toIndex: number) => Promise<void>;
  probeAllAddons: () => Promise<void>;
  setJiosaavnEnabled: (enabled: boolean) => Promise<void>;
  setTrackLengthToleranceSec: (seconds: number) => Promise<void>;

  identifyAddon: (url: string, existingId?: string | null) => Promise<AddonProbeResult>;
  testWebDav: (url: string, username: string, password?: string | null) => Promise<void>;
  saveWebDav: (url: string, username: string, password?: string | null) => Promise<void>;
  disconnectWebDav: () => Promise<void>;

  testSmb: (
    host: string,
    share: string,
    basePath: string,
    username: string,
    password?: string | null,
  ) => Promise<void>;
  saveSmb: (
    host: string,
    share: string,
    basePath: string,
    username: string,
    password?: string | null,
  ) => Promise<void>;
  disconnectSmb: () => Promise<void>;
}

const EMPTY_WEBDAV: WebDavStatusView = {
  configured: false,
  url: '',
  username: '',
  hasPassword: false,
};

const EMPTY_SMB: SmbStatusView = {
  configured: false,
  host: '',
  share: '',
  basePath: '',
  username: '',
  hasPassword: false,
};

const LOCAL_PREFS_KEY = 'bitchord:sources:ui';

interface LocalSourcePrefsFallback {
  addons?: AddonConfig[];
  jiosaavnEnabled?: boolean;
  trackLengthToleranceSec?: number;
}

function readLocalFallback(): LocalSourcePrefsFallback {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_PREFS_KEY) ?? '{}') as LocalSourcePrefsFallback;
  } catch {
    return {};
  }
}

function writeLocalFallback(state: Pick<SourcesStoreState, 'addons' | 'jiosaavnEnabled' | 'trackLengthToleranceSec'>) {
  try {
    localStorage.setItem(
      LOCAL_PREFS_KEY,
      JSON.stringify({
        addons: state.addons,
        jiosaavnEnabled: state.jiosaavnEnabled,
        trackLengthToleranceSec: state.trackLengthToleranceSec,
      }),
    );
  } catch {
    // Ignore storage quota issues.
  }
}

export function addonHasLosslessCapability(config: AddonConfig): boolean {
  if (config.checkValidLossless) return true;
  const check = (value: string) => /lossless|flac|hi-res|hires|alac/i.test(value);
  if (check(config.name)) return true;
  return config.qualityOptions.some((o) => check(o.value) || check(o.label));
}

export function normalizeTolerance(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_TRACK_LENGTH_TOLERANCE_SEC;
  return Math.max(
    MIN_TRACK_LENGTH_TOLERANCE_SEC,
    Math.min(MAX_TRACK_LENGTH_TOLERANCE_SEC, Math.round(seconds)),
  );
}

const initialLocal = readLocalFallback();

export const useSources = create<SourcesStoreState>((set, get) => ({
  loaded: false,
  addons: initialLocal.addons ?? [],
  jiosaavnEnabled: initialLocal.jiosaavnEnabled ?? false,
  trackLengthToleranceSec: normalizeTolerance(
    initialLocal.trackLengthToleranceSec ?? DEFAULT_TRACK_LENGTH_TOLERANCE_SEC,
  ),
  webdav: EMPTY_WEBDAV,
  smb: EMPTY_SMB,
  healthByAddonId: {},

  applySnapshot(snapshot) {
    set({
      loaded: true,
      addons: snapshot.addons,
      jiosaavnEnabled: snapshot.jiosaavnEnabled,
      trackLengthToleranceSec: normalizeTolerance(snapshot.trackLengthToleranceSec),
      webdav: snapshot.webdav,
      smb: snapshot.smb,
    });
    writeLocalFallback({
      addons: snapshot.addons,
      jiosaavnEnabled: snapshot.jiosaavnEnabled,
      trackLengthToleranceSec: snapshot.trackLengthToleranceSec,
    });
  },

  async loadFromBackend() {
    if (!isTauriDesktop()) {
      set({ loaded: true });
      return;
    }
    const snap = await desktopApi.sourcesGetState();
    get().applySnapshot(snap);
  },

  async setAddonsOrderOrUpdate(next) {
    set({ addons: next });
    writeLocalFallback({ ...get(), addons: next });
    if (isTauriDesktop()) {
      const snap = await desktopApi.sourcesSetAddons(next);
      get().applySnapshot(snap);
    }
  },

  async toggleAddonEnabled(id, enabled) {
    const next = get().addons.map((a) => (a.id === id ? { ...a, enabled } : a));
    await get().setAddonsOrderOrUpdate(next);
  },

  async setAddonQuality(id, pickedQuality) {
    const next = get().addons.map((a) => (a.id === id ? { ...a, pickedQuality } : a));
    await get().setAddonsOrderOrUpdate(next);
  },

  async upsertAddon(config, health) {
    const current = get().addons;
    const exists = current.some((a) => a.id === config.id);
    const next = exists ? current.map((a) => (a.id === config.id ? config : a)) : [...current, config];
    if (health) {
      set((s) => ({
        healthByAddonId: { ...s.healthByAddonId, [config.id]: health },
      }));
    }
    await get().setAddonsOrderOrUpdate(next);
  },

  async removeAddon(id) {
    const next = get().addons.filter((a) => a.id !== id);
    set((s) => {
      const copy = { ...s.healthByAddonId };
      delete copy[id];
      return { healthByAddonId: copy };
    });
    await get().setAddonsOrderOrUpdate(next);
  },

  async reorderAddon(fromIndex, toIndex) {
    const current = [...get().addons];
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= current.length ||
      toIndex >= current.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = current.splice(fromIndex, 1);
    if (!moved) return;
    current.splice(toIndex, 0, moved);
    await get().setAddonsOrderOrUpdate(current);
  },

  async probeAllAddons() {
    if (!isTauriDesktop()) return;
    const addons = get().addons;
    if (!addons.length) return;
    set((s) => {
      const checking = { ...s.healthByAddonId };
      for (const a of addons) checking[a.id] = { state: 'checking' };
      return { healthByAddonId: checking };
    });
    await Promise.all(
      addons.map(async (addon) => {
        try {
          const result = await desktopApi.sourcesProbeAddon(addon.id);
          set((s) => ({
            healthByAddonId: { ...s.healthByAddonId, [addon.id]: result },
          }));
        } catch (err) {
          set((s) => ({
            healthByAddonId: {
              ...s.healthByAddonId,
              [addon.id]: {
                state: 'unreachable',
                reason: err instanceof Error ? err.message : String(err),
              },
            },
          }));
        }
      }),
    );
  },

  async setJiosaavnEnabled(enabled) {
    set({ jiosaavnEnabled: enabled });
    writeLocalFallback({ ...get(), jiosaavnEnabled: enabled });
    if (isTauriDesktop()) {
      const snap = await desktopApi.sourcesSetJiosaavn(enabled);
      get().applySnapshot(snap);
    }
  },

  async setTrackLengthToleranceSec(seconds) {
    const normalized = normalizeTolerance(seconds);
    set({ trackLengthToleranceSec: normalized });
    writeLocalFallback({ ...get(), trackLengthToleranceSec: normalized });
    if (isTauriDesktop()) {
      const snap = await desktopApi.sourcesSetTolerance(normalized);
      get().applySnapshot(snap);
    }
  },

  async identifyAddon(url, existingId = null) {
    if (!isTauriDesktop()) {
      throw new Error('Testing and adding HTTP addons requires BitChord Desktop.');
    }
    return desktopApi.sourcesIdentifyAddon(url, existingId);
  },

  async testWebDav(url, username, password = null) {
    if (!isTauriDesktop()) {
      throw new Error('Testing WebDAV connections requires BitChord Desktop.');
    }
    await desktopApi.webdavTest(url, username, password);
  },

  async saveWebDav(url, username, password = null) {
    if (!isTauriDesktop()) {
      throw new Error('Saving WebDAV credentials requires BitChord Desktop.');
    }
    const snap = await desktopApi.webdavSave(url, username, password);
    get().applySnapshot(snap);
    void queryClient.invalidateQueries({ queryKey: ['desktop', 'remote', 'webdav'] });
  },

  async disconnectWebDav() {
    if (!isTauriDesktop()) {
      set({ webdav: EMPTY_WEBDAV });
      return;
    }
    const snap = await desktopApi.webdavDisconnect();
    get().applySnapshot(snap);
    void queryClient.invalidateQueries({ queryKey: ['desktop', 'remote', 'webdav'] });
  },

  async testSmb(host, share, basePath, username, password = null) {
    if (!isTauriDesktop()) {
      throw new Error('Testing SMB shares requires BitChord Desktop.');
    }
    await desktopApi.smbTest(host, share, basePath, username, password);
  },

  async saveSmb(host, share, basePath, username, password = null) {
    if (!isTauriDesktop()) {
      throw new Error('Saving SMB credentials requires BitChord Desktop.');
    }
    const snap = await desktopApi.smbSave(host, share, basePath, username, password);
    get().applySnapshot(snap);
    void queryClient.invalidateQueries({ queryKey: ['desktop', 'remote', 'smb'] });
  },

  async disconnectSmb() {
    if (!isTauriDesktop()) {
      set({ smb: EMPTY_SMB });
      return;
    }
    const snap = await desktopApi.smbDisconnect();
    get().applySnapshot(snap);
    void queryClient.invalidateQueries({ queryKey: ['desktop', 'remote', 'smb'] });
  },
}));

export function summarizeSourcePriority(state: Pick<SourcesStoreState, 'addons' | 'jiosaavnEnabled'>): string {
  const names: string[] = [];
  for (const a of state.addons) {
    if (a.enabled) names.push(a.name || a.baseUrl);
  }
  if (state.jiosaavnEnabled) names.push('JioSaavn');
  names.push('YouTube Music');
  return names.join(' · ');
}
