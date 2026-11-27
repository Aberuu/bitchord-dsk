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
  platform: 'windows' | 'macos' | 'linux' | 'android' | 'ios';
  isMobile: boolean;
  appMode?: 'desktop' | 'mobile';
}

export interface UpdateCheckResult {
  status: 'up_to_date' | 'available' | 'mandatory' | 'downloaded' | 'unconfigured' | 'error';
  currentVersion: string;
  latestVersion: string | null;
  majorPatchLag: number;
  maxMajorPatchLag: number;
  mandatory: boolean;
  releaseUrl: string | null;
  installerUrl: string | null;
  installerSha256: string | null;
  installerFileName: string | null;
  downloadedPath: string | null;
  notes: string | null;
}

export interface UpdaterPrefs {
  autoCheckUpdates: boolean;
  autoDownloadUpdates: boolean;
  updateFeedUrl: string | null;
  skippedVersion: string | null;
}

export interface UpdateDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
  phase: 'downloading' | 'verifying' | 'applying' | 'ready' | 'error';
  message: string | null;
}

export interface MobileSyncStatus {
  running: boolean;
  port: number | null;
  localIp: string | null;
  adapterName: string | null;
  partyServerUrl: string | null;
  syncPortalUrl: string | null;
  syncPin: string;
  activeParties: number;
  connectedClients: number;
}

export interface PeerDeviceSummary {
  deviceId: string;
  deviceName: string;
  updatedAtMs: number;
  months: number;
  tracks: number;
  fromVersion: string;
  exportedAt: string;
}

export interface PeerSyncResult {
  deviceId: string;
  deviceName: string;
  months: number;
  tracks: number;
  fromVersion: string;
  exportedAt: string;
  updatedAtMs: number;
}

export interface WatermarkStatus {
  credit: string;
  author: string;
  githubProfileUrl: string;
  githubRepoUrl: string;
  formatted: string;
  integrityValid: boolean;
}

export type DesktopSessionPersistence = 'signed_out' | 'temporary' | 'persistent';

export interface DesktopSessionMeta {
  persistence: DesktopSessionPersistence;
  source: string | null;
  skipSignInPrompt: boolean;
}

export interface GeneratedOneKey {
  key: string;
  hasPin: boolean;
  expiresAtMs: number | null;
  includeSpotify: boolean;
}

export interface UnlockWithOneKeyResult {
  auth: ResultOf<'yt.authState'>;
  persistence: DesktopSessionPersistence;
}

export interface QuickLoginStatus {
  active: boolean;
  code: string | null;
  pairId: string | null;
  qrUrl: string | null;
  lanIp: string | null;
  port: number | null;
  expiresAtMs: number | null;
  keepSignedIn: boolean;
}

export interface QuickLoginCompletedEvent {
  accountName: string;
  keepSignedIn: boolean;
}

export interface DesktopPairingOfferView {
  active: boolean;
  offerId: string | null;
  code: string | null;
  qrUri: string | null;
  lanIp: string | null;
  port: number | null;
  desktopName: string | null;
  includeSpotify: boolean;
  expiresAtMs: number | null;
}

export interface PairedMobileRecord {
  deviceId: string;
  deviceName: string;
  platform: string;
  pairedAtMs: number;
}

export interface PairingStatusView {
  offer: DesktopPairingOfferView;
  pairedDevices: PairedMobileRecord[];
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

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isTauriDesktop(): boolean {
  return isTauriRuntime();
}

export function isTauriMobile(): boolean {
  if (!isTauriRuntime()) return false;
  if (cachedBootstrap) return cachedBootstrap.isMobile || cachedBootstrap.appMode === 'mobile';
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function isDesktopShell(): boolean {
  return isTauriRuntime() && !isTauriMobile();
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
      document.documentElement.dataset.platform = info.platform;
      if (info.isMobile || info.appMode === 'mobile') {
        document.documentElement.dataset.mobileApp = 'true';
      }
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
  openYtSignIn: (keepSignedIn?: boolean) =>
    invoke<void>('open_yt_sign_in', keepSignedIn === undefined ? {} : { keepSignedIn }),
  signOutYt: () => invoke<void>('sign_out_yt'),
  authGetSessionMeta: () => invoke<DesktopSessionMeta>('auth_get_session_meta'),
  authSetSkipSignInPrompt: (skip: boolean) =>
    invoke<DesktopSessionMeta>('auth_set_skip_sign_in_prompt', { skip }),
  authPromoteTemporarySession: () =>
    invoke<DesktopSessionMeta>('auth_promote_temporary_session'),
  authGenerateOneKey: (
    includeSpotify: boolean,
    ttlMinutes?: number | null,
    pin?: string | null,
  ) =>
    invoke<GeneratedOneKey>('auth_generate_one_key', {
      includeSpotify,
      ttlMinutes: ttlMinutes ?? null,
      pin: pin ?? null,
    }),
  authUnlockWithOneKey: (key: string, pin: string | null, keepSignedIn: boolean) =>
    invoke<UnlockWithOneKeyResult>('auth_unlock_with_one_key', {
      key,
      pin,
      keepSignedIn,
    }),
  authQuickLoginStart: (keepSignedIn: boolean) =>
    invoke<QuickLoginStatus>('auth_quick_login_start', { keepSignedIn }),
  authQuickLoginSetKeep: (keepSignedIn: boolean) =>
    invoke<QuickLoginStatus>('auth_quick_login_set_keep', { keepSignedIn }),
  authQuickLoginStop: () => invoke<QuickLoginStatus>('auth_quick_login_stop'),
  authQuickLoginApprovePeer: (peerUrl: string, code: string, includeSpotify: boolean) =>
    invoke<string>('auth_quick_login_approve_peer', {
      peerUrl,
      code,
      includeSpotify,
    }),
  onQuickLoginCompleted: (listener: (ev: QuickLoginCompletedEvent) => void) =>
    listen<QuickLoginCompletedEvent>('auth://quick-login-completed', (ev) => listener(ev.payload)),
  onSessionMetaChanged: (listener: () => void) =>
    listen<Record<string, unknown>>('auth://session-meta-changed', () => listener()),
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
  castOpenWindowsCast: () => invoke<void>('cast_open_windows_cast'),
  castOpenWindowsCastSettings: () => invoke<void>('cast_open_windows_cast_settings'),
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

  updaterGetPrefs: () => invoke<UpdaterPrefs>('updater_get_prefs'),
  updaterSetPrefs: (patch: {
    autoCheckUpdates?: boolean;
    autoDownloadUpdates?: boolean;
    updateFeedUrl?: string;
    skippedVersion?: string;
  }) =>
    invoke<UpdaterPrefs>('updater_set_prefs', {
      autoCheckUpdates: patch.autoCheckUpdates ?? null,
      autoDownloadUpdates: patch.autoDownloadUpdates ?? null,
      updateFeedUrl: patch.updateFeedUrl ?? null,
      skippedVersion: patch.skippedVersion ?? null,
    }),
  downloadUpdate: (
    installerUrl: string,
    fileName?: string | null,
    expectedSha256?: string | null,
  ) =>
    invoke<string>('download_update', {
      installerUrl,
      fileName: fileName ?? null,
      expectedSha256: expectedSha256 ?? null,
    }),
  installUpdate: (downloadedPath: string) => invoke<void>('install_update', { downloadedPath }),
  exitApp: () => invoke<void>('exit_app'),
  onUpdaterProgress: (listener: (progress: UpdateDownloadProgress) => void) =>
    listen<UpdateDownloadProgress>('updater://progress', (ev) => listener(ev.payload)),

  mobileSyncStatus: () => invoke<MobileSyncStatus>('mobile_sync_status'),
  mobileSyncStartServer: () => invoke<MobileSyncStatus>('mobile_sync_start_server'),
  mobileSyncStopServer: () => invoke<MobileSyncStatus>('mobile_sync_stop_server'),
  mobileSyncRotatePin: () => invoke<MobileSyncStatus>('mobile_sync_rotate_pin'),
  onMobileSyncUpdated: (listener: (res: PeerSyncResult) => void) =>
    listen<PeerSyncResult>('mobile-sync://updated', (ev) => listener(ev.payload)),

  pairingStartDesktopQr: (includeSpotify: boolean) =>
    invoke<DesktopPairingOfferView>('pairing_start_desktop_qr', { includeSpotify }),
  pairingStopDesktopQr: () => invoke<PairingStatusView>('pairing_stop_desktop_qr'),
  pairingStatus: () => invoke<PairingStatusView>('pairing_status'),
  onMobilePaired: (listener: (record: PairedMobileRecord) => void) =>
    listen<PairedMobileRecord>('pairing://mobile-paired', (ev) => listener(ev.payload)),

  statsMergePeerBackup: (rawJson: string, deviceId?: string | null, deviceName?: string | null) =>
    invoke<PeerSyncResult>('stats_merge_peer_backup', {
      rawJson,
      deviceId: deviceId ?? null,
      deviceName: deviceName ?? null,
    }),
  statsListSyncedPeers: () => invoke<PeerDeviceSummary[]>('stats_list_synced_peers'),
  statsRemoveSyncedPeer: (deviceId: string) =>
    invoke<boolean>('stats_remove_synced_peer', { deviceId }),
  statsExportCombinedBackup: () => invoke<string>('stats_export_combined_backup'),
};
