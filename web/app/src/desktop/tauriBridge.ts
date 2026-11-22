import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  BridgeCallError,
  type Bridge,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeMethod,
  type CallOptions,
  type ParamsOf,
  type ResultOf,
} from '@bitchord/shared/bridge';

export interface DesktopBootstrap {
  proxyBaseUrl: string;
  vibrancyMode: string;
  minimizeToTray: boolean;
  version: string;
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'available' | 'unconfigured' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
}

export interface SmtcMetadataPayload {
  title: string;
  artist?: string | null;
  album?: string | null;
  coverUrl?: string | null;
  durationMs?: number | null;
}

export interface SmtcPlaybackPayload {
  status: string;
  positionMs?: number | null;
}

export interface DesktopMediaAction {
  action: 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'stop' | 'seek';
  positionMs?: number | null;
}

export interface ScrobbleState {
  lastfmConfigured: boolean;
  lastfmConnected: boolean;
  lastfmUsername: string | null;
  lastfmEndpoint: string;
  listenbrainzConnected: boolean;
  primaryArtistOnly: boolean;
}

export interface ScrobbleConfigUpdate {
  lastfmEndpoint?: string;
  lastfmApiKey?: string;
  lastfmApiSecret?: string;
  listenbrainzToken?: string;
  primaryArtistOnly?: boolean;
}

export interface ScrobbleTrackPayload {
  title: string;
  artist: string;
  album?: string | null;
  durationMs?: number | null;
  positionMs?: number | null;
  startedAtMs?: number | null;
}

export interface DownloadedTrack {
  videoId: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  artworkUrl: string | null;
  filePath: string;
  format: string;
  bitrateKbps: number | null;
  fileSizeBytes: number;
  downloadedAt: number;
}

export interface DownloadRequestPayload {
  videoId: string;
  title: string;
  artist: string;
  album?: string | null;
  durationSec: number;
  artworkUrl?: string | null;
  streamUrl: string;
  mimeType: string;
  contentLength?: number | null;
  bitrateKbps?: number | null;
}

export interface DownloadProgress {
  videoId: string;
  status: 'downloading' | 'done' | 'error';
  progress: number;
  error: string | null;
}

export interface LocalTrack {
  id: string;
  filePath: string;
  folderPath: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number;
  sampleRateHz: number | null;
  bitDepth: number | null;
  channels: number | null;
  codec: string;
  fileSizeBytes: number;
  coverPath: string | null;
}

export type OutputMode = 'shared' | 'wasapi_exclusive' | 'asio';

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  backend: string;
  supportsExclusive: boolean;
  maxSampleRateHz: number;
}

export interface BitPerfectStatus {
  active: boolean;
  driver: string | null;
  deviceName: string | null;
  sampleRateHz: number;
  outputBits: number;
  sourceBits: number;
  sourceRateHz: number;
  exact: boolean;
  dacLimited: boolean;
  fallbackReason: string | null;
}

export type EqualizerPresetId =
  | 'flat'
  | 'acoustic'
  | 'bass_boost'
  | 'bass_cut'
  | 'vocal'
  | 'treble_boost'
  | 'treble_cut'
  | 'loudness'
  | 'spoken_word'
  | 'electronic'
  | 'rock'
  | 'hip_hop'
  | 'jazz'
  | 'classical'
  | 'small_speakers'
  | 'late_night'
  | 'custom';

export interface EqConfig {
  enabled: boolean;
  mode: 'manual' | 'tone';
  preset: EqualizerPresetId;
  bandsDb: [number, number, number, number, number, number, number];
  toneX: number;
  toneY: number;
  toneFocused: boolean;
}

export interface AudioSettings {
  outputMode: OutputMode;
  deviceId: string | null;
  playbackRate: number;
  sleepTimerEndEpochMs: number | null;
  sleepAfterTrack: boolean;
  eq: EqConfig;
}

export interface NativePlaybackSnapshot {
  active: boolean;
  status: string;
  trackId: string | null;
  positionSec: number;
  durationSec: number;
  volume: number;
  playbackRate: number;
  codec: string | null;
  sampleRateHz: number;
  bitDepth: number;
  channels: number;
  bitPerfect: BitPerfectStatus;
  asioAvailable: boolean;
  eqCurvePoints: [number, number][];
  settings: AudioSettings;
}

interface BridgeInvokeResult {
  ok: boolean;
  result?: unknown;
  errorCode?: BridgeErrorCode;
  errorMessage?: string;
}

export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let cachedBootstrap: DesktopBootstrap | null = null;
let bootstrapPromise: Promise<DesktopBootstrap | null> | null = null;

export function getBootstrapSnapshot(): DesktopBootstrap | null {
  return cachedBootstrap;
}

export function initDesktopBootstrap(): Promise<DesktopBootstrap | null> {
  if (!isTauriDesktop()) return Promise.resolve(null);
  if (cachedBootstrap) return Promise.resolve(cachedBootstrap);
  bootstrapPromise ??= invoke<DesktopBootstrap>('get_desktop_bootstrap')
    .then((info) => {
      cachedBootstrap = info;
      document.documentElement.dataset.desktop = 'true';
      document.documentElement.dataset.vibrancy = info.vibrancyMode;
      return info;
    })
    .catch(() => null);
  return bootstrapPromise;
}

const PROXIED_HOSTS = new Set(['music.youtube.com', 'www.youtube.com', 'youtube.com']);

export function shouldProxyUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.pathname.startsWith('/api/jnn/')) return false;
    return PROXIED_HOSTS.has(parsed.hostname) || parsed.hostname.endsWith('.googlevideo.com');
  } catch {
    return false;
  }
}

export function proxyUrl(raw: string): string {
  if (!cachedBootstrap?.proxyBaseUrl || !shouldProxyUrl(raw)) return raw;
  return `${cachedBootstrap.proxyBaseUrl}/proxy?url=${encodeURIComponent(raw)}`;
}

export async function proxyUrlAsync(raw: string): Promise<string> {
  if (!cachedBootstrap && isTauriDesktop()) await initDesktopBootstrap();
  return proxyUrl(raw);
}

export function createTauriBridge(): Bridge {
  return {
    transport: 'tauri',
    async call<M extends BridgeMethod>(method: M, params: ParamsOf<M>, _options?: CallOptions): Promise<ResultOf<M>> {
      const reply = await invoke<BridgeInvokeResult>('bridge_call', { method, params });
      if (reply.ok) return reply.result as ResultOf<M>;
      throw new BridgeCallError(reply.errorCode ?? 'internal', reply.errorMessage ?? 'Desktop bridge call failed');
    },
    subscribe(listener: (event: BridgeEvent) => void): () => void {
      let active = true;
      let unlisten: UnlistenFn | null = null;
      void listen<BridgeEvent>('bridge://event', (ev) => {
        if (active && ev.payload && typeof ev.payload.event === 'string') {
          listener(ev.payload);
        }
      }).then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
      return () => {
        active = false;
        unlisten?.();
      };
    },
  };
}

export const desktopApi = {
  openYtSignIn: () => invoke<void>('open_yt_sign_in'),
  signOutYt: () => invoke<void>('sign_out_yt'),
  setMinimizeToTray: (enabled: boolean) => invoke<boolean>('set_minimize_to_tray', { enabled }),
  checkForUpdates: () => invoke<UpdateCheckResult>('check_for_updates'),

  smtcUpdateMetadata: (meta: SmtcMetadataPayload) => invoke<void>('smtc_update_metadata', { meta }),
  smtcUpdatePlayback: (playback: SmtcPlaybackPayload) => invoke<void>('smtc_update_playback', { playback }),
  onMediaAction: (listener: (action: DesktopMediaAction) => void) =>
    listen<DesktopMediaAction>('desktop://media-action', (ev) => listener(ev.payload)),

  scrobbleGetState: () => invoke<ScrobbleState>('scrobble_get_state'),
  scrobbleUpdateConfig: (update: ScrobbleConfigUpdate) => invoke<ScrobbleState>('scrobble_update_config', { update }),
  scrobbleDisconnectLastfm: () => invoke<ScrobbleState>('scrobble_disconnect_lastfm'),
  scrobbleLastfmStart: () => invoke<{ token: string; authUrl: string }>('scrobble_lastfm_start'),
  scrobbleLastfmFinish: (token: string) => invoke<ScrobbleState>('scrobble_lastfm_finish', { token }),
  scrobbleNowPlaying: (track: ScrobbleTrackPayload) => invoke<void>('scrobble_now_playing', { track }),
  scrobbleSubmit: (track: ScrobbleTrackPayload) => invoke<void>('scrobble_submit', { track }),

  downloadsList: () => invoke<DownloadedTrack[]>('downloads_list'),
  downloadsStart: (req: DownloadRequestPayload) => invoke<DownloadedTrack>('downloads_start', { req }),
  downloadsDelete: (videoId: string) => invoke<void>('downloads_delete', { videoId }),
  downloadsMediaUrl: (videoId: string) => invoke<string | null>('downloads_media_url', { videoId }),
  onDownloadProgress: (listener: (p: DownloadProgress) => void) =>
    listen<DownloadProgress>('downloads://progress', (ev) => listener(ev.payload)),

  localListFolders: () => invoke<string[]>('local_list_folders'),
  localAddFolder: (folder: string) => invoke<LocalTrack[]>('local_add_folder', { folder }),
  localRemoveFolder: (folder: string) => invoke<void>('local_remove_folder', { folder }),
  localScan: () => invoke<LocalTrack[]>('local_scan'),
  localListTracks: () => invoke<LocalTrack[]>('local_list_tracks'),
  localMediaUrl: (id: string) => invoke<string | null>('local_media_url', { id }),

  audioListDevices: () => invoke<AudioDeviceInfo[]>('audio_list_devices'),
  audioSnapshot: () => invoke<NativePlaybackSnapshot>('audio_snapshot'),
  audioUpdateSettings: (settings: AudioSettings) => invoke<NativePlaybackSnapshot>('audio_update_settings', { settings }),
  audioPlayFile: (trackId: string, filePath: string) =>
    invoke<NativePlaybackSnapshot>('audio_play_file', { trackId, filePath }),
  audioQueueGaplessNext: (trackId: string, filePath: string) =>
    invoke<void>('audio_queue_gapless_next', { trackId, filePath }),
  audioPause: () => invoke<void>('audio_pause'),
  audioResume: () => invoke<void>('audio_resume'),
  audioStop: () => invoke<void>('audio_stop'),
  audioSeek: (seconds: number) => invoke<void>('audio_seek', { seconds }),
  audioSetVolume: (volume: number, muted: boolean) => invoke<void>('audio_set_volume', { volume, muted }),
  onNativeTrackEnded: (listener: (trackId: string) => void) =>
    listen<{ trackId: string }>('audio://track-ended', (ev) => listener(ev.payload.trackId)),
};
