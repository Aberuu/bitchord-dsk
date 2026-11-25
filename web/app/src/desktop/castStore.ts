import { create } from 'zustand';
import {
  desktopApi,
  isTauriDesktop,
  type CastDevice,
  type CastSessionState,
  type CastSupportStatus,
} from './tauriBridge';

const DEFAULT_SUPPORT: CastSupportStatus = {
  supported: false,
  reason: null,
  localIp: null,
  adapterName: null,
  protocols: [],
};

export const DEFAULT_CAST_SESSION: CastSessionState = {
  connected: false,
  connecting: false,
  device: null,
  trackId: null,
  status: 'idle',
  positionSec: 0,
  durationSec: 0,
  volume: 1,
  muted: false,
  error: null,
};

interface CastStoreState {
  support: CastSupportStatus;
  session: CastSessionState;
  lastUpdatedMs: number;
  devices: CastDevice[];
  scanning: boolean;
  error: string | null;
  setSupport: (support: CastSupportStatus) => void;
  refreshSupport: () => Promise<CastSupportStatus>;
  discoverDevices: () => Promise<void>;
  applySessionEvent: (next: CastSessionState) => void;
  setError: (error: string | null) => void;
  resetSession: () => void;
}

export const useCast = create<CastStoreState>()((set) => ({
  support: DEFAULT_SUPPORT,
  session: DEFAULT_CAST_SESSION,
  lastUpdatedMs: 0,
  devices: [],
  scanning: false,
  error: null,

  setSupport: (support) => set({ support }),

  refreshSupport: async () => {
    if (!isTauriDesktop()) {
      const next = await probeBrowserCastSupport();
      set({ support: next });
      return next;
    }
    try {
      const status = await desktopApi.castSupportStatus();
      set({ support: status });
      return status;
    } catch {
      set({ support: DEFAULT_SUPPORT });
      return DEFAULT_SUPPORT;
    }
  },

  discoverDevices: async () => {
    if (!isTauriDesktop()) {
      set({ scanning: false, devices: [] });
      return;
    }
    set({ scanning: true, error: null });
    try {
      const devices = await desktopApi.castDiscover(3000);
      set({ devices, scanning: false });
    } catch (err) {
      set({
        scanning: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  applySessionEvent: (next) =>
    set({
      session: next,
      lastUpdatedMs: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      error: next.error ?? null,
    }),

  setError: (error) => set({ error }),

  resetSession: () =>
    set({
      session: DEFAULT_CAST_SESSION,
      lastUpdatedMs: 0,
      error: null,
    }),
}));

async function probeBrowserCastSupport(): Promise<CastSupportStatus> {
  if (typeof HTMLMediaElement === 'undefined' || !('remote' in HTMLMediaElement.prototype)) {
    return DEFAULT_SUPPORT;
  }
  try {
    const audio = document.createElement('audio') as HTMLAudioElement & {
      remote?: {
        watchAvailability?: (cb: (available: boolean) => void) => Promise<number>;
        cancelWatchAvailability?: (id?: number) => Promise<void>;
      };
    };
    if (!audio.remote?.watchAvailability) {
      return DEFAULT_SUPPORT;
    }
    let available = false;
    const watchId = await audio.remote.watchAvailability((ok) => {
      available = ok;
    });
    void audio.remote.cancelWatchAvailability?.(watchId).catch(() => {});
    return available
      ? {
          supported: true,
          reason: null,
          localIp: null,
          adapterName: 'Browser Remote Playback',
          protocols: ['remote-playback'],
        }
      : DEFAULT_SUPPORT;
  } catch {
    return DEFAULT_SUPPORT;
  }
}

export function getCastPlayhead(): { sec: number; paused: boolean } | null {
  const { session, lastUpdatedMs } = useCast.getState();
  if (!session.connected) return null;
  const paused = session.status !== 'playing';
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = paused || lastUpdatedMs <= 0 ? 0 : Math.max(0, (now - lastUpdatedMs) / 1000);
  const maxDur = session.durationSec > 0 ? session.durationSec : Number.MAX_SAFE_INTEGER;
  return {
    sec: Math.max(0, Math.min(maxDur, session.positionSec + elapsed)),
    paused,
  };
}
