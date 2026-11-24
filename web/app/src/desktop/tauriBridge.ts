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
  audioTapUrl: string;
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

export interface WatermarkStatus {
  credit: string;
  author: string;
  githubProfileUrl: string;
  githubRepoUrl: string;
  formatted: string;
  integrityValid: boolean;
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

export type AudioDeviceKind = 'speakers' | 'headphones' | 'usb_dac' | 'bluetooth' | 'hdmi' | 'other';

export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
  backend: string;
  supportsExclusive: boolean;
  maxSampleRateHz: number;
  kind: AudioDeviceKind;
  isUsbDac: boolean;
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

export interface AsioClockSourceInfo {
  index: number;
  name: string;
  isCurrent: boolean;
}

export interface AsioDriverCapabilities {
  id: string;
  name: string;
  minBufferSamples: number;
  maxBufferSamples: number;
  preferredBufferSamples: number;
  granularity: number;
  currentSampleRateHz: number;
  maxSampleRateHz: number;
  supportedSampleRates: number[];
  supportsNativeDsd: boolean;
  maxDsdRateHz: number;
  outputChannels: number;
  sampleTypeName: string;
  clockSources: AsioClockSourceInfo[];
}

export interface AudioSettings {
  outputMode: OutputMode;
  deviceId: string | null;
  playbackRate: number;
  sleepTimerEndEpochMs: number | null;
  sleepAfterTrack: boolean;
  eq: EqConfig;
  asioBufferSamples?: number | null;
  asioClockSource?: number | null;
}

export interface NativePlaybackSnapshot {
  active: boolean;
  tapActive: boolean;
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
  asioBufferSamples?: number | null;
  asioNativeDsd?: boolean;
  asioSampleType?: string | null;
  asioClockSources?: AsioClockSourceInfo[];
  asioActiveClockSource?: number | null;
  eqCurvePoints: [number, number][];
  settings: AudioSettings;
}

export type CastProtocol = 'chromecast' | 'dlna';

export interface CastSupportStatus {
  supported: boolean;
  reason: string | null;
  localIp: string | null;
  adapterName: string | null;
  protocols: string[];
}

export interface CastDevice {
  id: string;
  name: string;
  model: string | null;
  manufacturer: string | null;
  protocol: CastProtocol;
  host: string;
  port: number;
  avTransportUrl?: string | null;
  renderingControlUrl?: string | null;
}

export interface CastSessionState {
  connected: boolean;
  connecting: boolean;
  device: CastDevice | null;
  trackId: string | null;
  status: string;
  positionSec: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  error: string | null;
}

export interface AddonQualityOption {
  value: string;
  label: string;
}

export interface AddonConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  pickedQuality: string | null;
  qualityOptions: AddonQualityOption[];
  allowDownloads: boolean;
  checkValidLossless: boolean;
  bitchordAuth: boolean;
  version: string;
  defaultSettings: Record<string, string>;
}

export type AddonHealthStatus =
  | { state: 'ok'; detail: string; latencyMs: number }
  | { state: 'rejected'; reason: string }
  | { state: 'unreachable'; reason: string };

export interface AddonProbeResult {
  config: AddonConfig;
  health: AddonHealthStatus;
}

export interface WebDavStatusView {
  configured: boolean;
  url: string;
  username: string;
  hasPassword: boolean;
}

export interface SmbStatusView {
  configured: boolean;
  host: string;
  share: string;
  basePath: string;
  username: string;
  hasPassword: boolean;
}

export interface SourcesSnapshot {
  addons: AddonConfig[];
  jiosaavnEnabled: boolean;
  trackLengthToleranceSec: number;
  webdav: WebDavStatusView;
  smb: SmbStatusView;
}

export interface SourceCandidateTrack {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  artist: string;
  album: string | null;
  durationSec: number | null;
  explicit: boolean;
  artworkUrl: string | null;
  streamUrl: string | null;
  headers: Record<string, string>;
  mimeType: string | null;
  format: string | null;
  codec: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  lossless: boolean;
}

export interface ResolvedSourceStream {
  sourceId: string;
  sourceName: string;
  trackId: string;
  url: string;
  headers: Record<string, string>;
  mimeType: string | null;
  format: string | null;
  codec: string | null;
  bitrateKbps: number | null;
  sampleRateHz: number | null;
  bitDepth: number | null;
  lossless: boolean;
}

export interface RegisteredSourceStreamPayload {
  proxyUrl: string;
  proxyKey: string;
  stream: ResolvedSourceStream;
}

export interface RemoteTrackItem {
  id: string;
  sourceKind: 'webdav' | 'smb';
  title: string;
  artist: string;
  album: string | null;
  fileName: string;
  codec: string;
  sizeBytes: number;
  relPath: string;
  proxyKey: string;
  streamProxyUrl: string;
  artworkProxyUrl: string | null;
}

export interface CastLoadRequest {
  device: CastDevice;
  trackId: string;
  title: string;
  artist: string;
  album?: string | null;
  artworkUrl?: string | null;
  streamUrl?: string | null;
  localFilePath?: string | null;
  mimeType: string;
  durationSec: number;
  startSec: number;
  autoplay: boolean;
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
  watermarkStatus: () => invoke<WatermarkStatus>('get_watermark_status'),

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
  audioPlayFile: (trackId: string, filePath: string, startSec?: number | null) =>
    invoke<NativePlaybackSnapshot>('audio_play_file', {
      trackId,
      filePath,
      startSec: startSec ?? null,
    }),
  audioQueueGaplessNext: (trackId: string, filePath: string) =>
    invoke<void>('audio_queue_gapless_next', { trackId, filePath }),
  audioPause: () => invoke<void>('audio_pause'),
  audioResume: () => invoke<void>('audio_resume'),
  audioStop: () => invoke<void>('audio_stop'),
  audioSeek: (seconds: number) => invoke<void>('audio_seek', { seconds }),
  audioSetVolume: (volume: number, muted: boolean) => invoke<void>('audio_set_volume', { volume, muted }),
  audioStartTap: () => invoke<NativePlaybackSnapshot>('audio_start_tap'),
  audioStopTap: () => invoke<NativePlaybackSnapshot>('audio_stop_tap'),
  audioFlushTap: () => invoke<void>('audio_flush_tap'),
  audioProbeAsioDriver: (deviceId?: string | null) =>
    invoke<AsioDriverCapabilities>('audio_probe_asio_driver', { deviceId: deviceId ?? null }),
  audioOpenAsioControlPanel: (deviceId?: string | null) =>
    invoke<void>('audio_open_asio_control_panel', { deviceId: deviceId ?? null }),
  onAudioDevicesChanged: (listener: () => void) =>
    listen<Record<string, unknown>>('audio://devices-changed', () => listener()),
  onNativeTrackEnded: (listener: (trackId: string) => void) =>
    listen<{ trackId: string }>('audio://track-ended', (ev) => listener(ev.payload.trackId)),

  castSupportStatus: () => invoke<CastSupportStatus>('cast_support_status'),
  castGetState: () => invoke<CastSessionState>('cast_get_state'),
  castDiscover: (timeoutMs?: number) => invoke<CastDevice[]>('cast_discover', { timeoutMs }),
  castLoadMedia: (request: CastLoadRequest) => invoke<CastSessionState>('cast_load_media', { request }),
  castPlay: () => invoke<void>('cast_play'),
  castPause: () => invoke<void>('cast_pause'),
  castSeek: (seconds: number) => invoke<void>('cast_seek', { seconds }),
  castSetVolume: (volume: number) => invoke<void>('cast_set_volume', { volume }),
  castDisconnect: () => invoke<void>('cast_disconnect'),
  onCastState: (listener: (state: CastSessionState) => void) =>
    listen<CastSessionState>('cast://state', (ev) => listener(ev.payload)),
  onCastTrackEnded: (listener: (trackId: string) => void) =>
    listen<{ trackId: string }>('cast://track-ended', (ev) => listener(ev.payload.trackId)),

  sourcesGetState: () => invoke<SourcesSnapshot>('sources_get_state'),
  sourcesSetAddons: (addons: AddonConfig[]) => invoke<SourcesSnapshot>('sources_set_addons', { addons }),
  sourcesSetJiosaavn: (enabled: boolean) => invoke<SourcesSnapshot>('sources_set_jiosaavn', { enabled }),
  sourcesSetTolerance: (seconds: number) => invoke<SourcesSnapshot>('sources_set_tolerance', { seconds }),
  sourcesIdentifyAddon: (url: string, existingId?: string | null) =>
    invoke<AddonProbeResult>('sources_identify_addon', { url, existingId: existingId ?? null }),
  sourcesProbeAddon: (addonId: string) =>
    invoke<AddonHealthStatus>('sources_probe_addon', { addonId }),
  sourcesSearchSource: (sourceId: string, query: string, title?: string | null, artist?: string | null) =>
    invoke<SourceCandidateTrack[]>('sources_search_source', {
      sourceId,
      query,
      title: title ?? null,
      artist: artist ?? null,
    }),
  sourcesResolveCandidate: (candidate: SourceCandidateTrack) =>
    invoke<RegisteredSourceStreamPayload>('sources_resolve_candidate', { candidate }),

  webdavTest: (url: string, username: string, password?: string | null) =>
    invoke<void>('webdav_test', { url, username, password: password ?? null }),
  webdavSave: (url: string, username: string, password?: string | null) =>
    invoke<SourcesSnapshot>('webdav_save', { url, username, password: password ?? null }),
  webdavDisconnect: () => invoke<SourcesSnapshot>('webdav_disconnect'),
  webdavListTracks: () => invoke<RemoteTrackItem[]>('webdav_list_tracks'),

  smbTest: (host: string, share: string, basePath: string, username: string, password?: string | null) =>
    invoke<void>('smb_test', { host, share, basePath, username, password: password ?? null }),
  smbSave: (host: string, share: string, basePath: string, username: string, password?: string | null) =>
    invoke<SourcesSnapshot>('smb_save', { host, share, basePath, username, password: password ?? null }),
  smbDisconnect: () => invoke<SourcesSnapshot>('smb_disconnect'),
  smbListTracks: () => invoke<RemoteTrackItem[]>('smb_list_tracks'),

  audioPlayRemoteSource: (
    trackId: string,
    proxyKey: string,
    ext?: string | null,
    startSec?: number | null,
  ) =>
    invoke<NativePlaybackSnapshot>('audio_play_remote_source', {
      trackId,
      proxyKey,
      ext: ext ?? null,
      startSec: startSec ?? null,
    }),
};
