import { useMutation, useQuery } from '@tanstack/react-query';
import {
  desktopApi,
  isTauriDesktop,
  type AudioDeviceInfo,
  type AudioSettings,
  type NativePlaybackSnapshot,
} from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { syncDesktopOutputRoute, usePlayer } from '@/state/player';

export const DESKTOP_AUDIO_DEVICES_KEY = ['desktop', 'audio', 'devices'] as const;
export const DESKTOP_AUDIO_SNAPSHOT_KEY = ['desktop', 'audio', 'snapshot'] as const;

let knownDeviceIds: Set<string> | null = null;
let autoUsbSelectedId: string | null = null;
let snapshotEpoch = 0;
let refreshInFlight: Promise<void> | null = null;
let refreshQueuedForce = false;
let refreshQueued = false;

async function commitUpdatedSnapshot(
  updated: NativePlaybackSnapshot,
  expectedEpoch?: number,
): Promise<void> {
  if (expectedEpoch !== undefined && expectedEpoch !== snapshotEpoch) {
    return;
  }
  queryClient.setQueryData(DESKTOP_AUDIO_SNAPSHOT_KEY, updated);
  usePlayer.setState({ bitPerfectStatus: updated.bitPerfect });
  await syncDesktopOutputRoute(updated.settings);
}

async function applyPreferUsbDac(
  devices: AudioDeviceInfo[],
  snap: NativePlaybackSnapshot,
  forceExisting: boolean,
  observedEpoch: number,
): Promise<void> {
  const preferUsb = usePlayer.getState().preferUsbDac;
  if (!preferUsb) {
    autoUsbSelectedId = null;
    knownDeviceIds = new Set(devices.map((d) => d.id));
    return;
  }

  const usbDevices = devices.filter((d) => d.isUsbDac);
  const firstUsb = usbDevices[0] ?? null;

  if (knownDeviceIds === null || forceExisting) {
    knownDeviceIds = new Set(devices.map((d) => d.id));
    if (firstUsb && snap.settings.deviceId === null && observedEpoch === snapshotEpoch) {
      autoUsbSelectedId = firstUsb.id;
      const writeEpoch = ++snapshotEpoch;
      const updated = await desktopApi
        .audioUpdateSettings({ ...snap.settings, deviceId: firstUsb.id })
        .catch(() => null);
      if (updated) await commitUpdatedSnapshot(updated, writeEpoch);
    }
    return;
  }

  const newlyConnectedUsb = usbDevices.find((d) => !knownDeviceIds!.has(d.id)) ?? null;
  knownDeviceIds = new Set(devices.map((d) => d.id));

  if (newlyConnectedUsb && observedEpoch === snapshotEpoch) {
    autoUsbSelectedId = newlyConnectedUsb.id;
    const writeEpoch = ++snapshotEpoch;
    const updated = await desktopApi
      .audioUpdateSettings({ ...snap.settings, deviceId: newlyConnectedUsb.id })
      .catch(() => null);
    if (updated) await commitUpdatedSnapshot(updated, writeEpoch);
    return;
  }

  if (autoUsbSelectedId && !devices.some((d) => d.id === autoUsbSelectedId)) {
    autoUsbSelectedId = firstUsb?.id ?? null;
    if (snap.settings.deviceId === null && firstUsb && observedEpoch === snapshotEpoch) {
      const writeEpoch = ++snapshotEpoch;
      const updated = await desktopApi
        .audioUpdateSettings({ ...snap.settings, deviceId: firstUsb.id })
        .catch(() => null);
      if (updated) await commitUpdatedSnapshot(updated, writeEpoch);
    }
  }
}

async function runDesktopAudioRefresh(forcePreferUsb: boolean): Promise<void> {
  const startEpoch = snapshotEpoch;
  const [devices, snap] = await Promise.all([
    desktopApi.audioListDevices().catch(() => null),
    desktopApi.audioSnapshot().catch(() => null),
  ]);
  if (devices) {
    queryClient.setQueryData(DESKTOP_AUDIO_DEVICES_KEY, devices);
  }
  if (snap && startEpoch === snapshotEpoch) {
    await commitUpdatedSnapshot(snap, startEpoch);
  }
  if (devices && snap && startEpoch === snapshotEpoch) {
    await applyPreferUsbDac(devices, snap, forcePreferUsb, startEpoch);
  }
}

export function refreshDesktopAudioState(forcePreferUsb = false): Promise<void> {
  if (!isTauriDesktop()) return Promise.resolve();
  if (refreshInFlight) {
    refreshQueued = true;
    refreshQueuedForce = refreshQueuedForce || forcePreferUsb;
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    let nextForce = forcePreferUsb;
    try {
      do {
        refreshQueued = false;
        refreshQueuedForce = false;
        await runDesktopAudioRefresh(nextForce);
        nextForce = refreshQueuedForce;
      } while (refreshQueued);
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export function bindDesktopAudioHotplug(): () => void {
  if (!isTauriDesktop()) return () => {};
  let active = true;
  let unlistenTauri: (() => void) | null = null;

  void refreshDesktopAudioState();

  void desktopApi
    .onAudioDevicesChanged(() => {
      if (active) void refreshDesktopAudioState();
    })
    .then((fn) => {
      if (active) unlistenTauri = fn;
      else fn();
    });

  const onMediaDeviceChange = () => {
    if (active) void refreshDesktopAudioState();
  };
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', onMediaDeviceChange);
  }

  return () => {
    active = false;
    unlistenTauri?.();
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', onMediaDeviceChange);
    }
  };
}

export function useDesktopAudioDevices({
  enabled = true,
  live = false,
}: {
  enabled?: boolean;
  live?: boolean;
} = {}) {
  const desktop = isTauriDesktop();
  const active = desktop && enabled;

  const devicesQuery = useQuery({
    queryKey: DESKTOP_AUDIO_DEVICES_KEY,
    queryFn: () => desktopApi.audioListDevices(),
    enabled: active,
    staleTime: live ? 0 : 10_000,
    refetchOnMount: live ? 'always' : true,
  });

  const snapQuery = useQuery({
    queryKey: DESKTOP_AUDIO_SNAPSHOT_KEY,
    queryFn: () => desktopApi.audioSnapshot(),
    enabled: active,
    staleTime: live ? 0 : 5_000,
    refetchOnMount: live ? 'always' : true,
  });

  const updateAudio = useMutation({
    mutationFn: async (next: AudioSettings) => {
      const epoch = ++snapshotEpoch;
      const updated = await desktopApi.audioUpdateSettings(next);
      return { updated, epoch };
    },
    onSuccess: async ({ updated, epoch }) => {
      // Clear auto-USB tracking if the user explicitly picks Default or a non-USB device.
      if (updated.settings.deviceId !== autoUsbSelectedId) {
        autoUsbSelectedId = null;
      }
      await commitUpdatedSnapshot(updated, epoch);
    },
  });

  return {
    desktop,
    devicesQuery,
    snapQuery,
    updateAudio,
    refresh: () => refreshDesktopAudioState(),
  };
}
