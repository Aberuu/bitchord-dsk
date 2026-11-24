import type { DetectedExtension } from '@bitchord/shared/bridge';
import { create } from 'zustand';
import type { Track } from '@/data/music/types';
import { isBitPerfectBypassActive, isExclusiveOutputMode } from '@/desktop/bitPerfectMode';
import {
  desktopApi,
  isTauriDesktop,
  type AudioDeviceInfo,
  type AudioSettings,
  type BitPerfectStatus,
  type NativePlaybackSnapshot,
  type RemoteTrackItem,
} from '@/desktop/tauriBridge';
import {
  extensionForResolvedStream,
  listEligibleSourceIds,
  resolveReplacementSource,
  type ReplacementResolveOptions,
  type ResolvedPlaybackSource,
} from '@/playback/sourceResolver';
import { useSources } from '@/state/sources';
import { DESKTOP_AUDIO_DEVICES_KEY } from '@/desktop/useDesktopAudioDevices';
import { extensionQueryKey } from '@/extension/useExtension';
import { artworkAtPixels } from '@/lib/artwork';
import { queryClient } from '@/lib/queryClient';
import { extendStation } from '@/playback/queue/builder';
import {
  applyJump,
  asEntry,
  BACK_RESTARTS_AFTER_SEC,
  buildContextQueue,
  buildOneOffQueue,
  moveUpcomingEntry,
  playedUserQueueIndices,
  sectionedOrder,
  shuffledStartingOrder,
  shuffledUpcomingOrder,
  upcomingUserQueueIndices,
  userQueueInsertionIndex,
  type QueueEntry,
  type QueueSection,
  type QueueSource,
} from '@/playback/queue/timeline';
import { trackLog } from '@/playback/trackLog';
import { DEFAULT_EQ_CONFIG, type EqConfig } from '@/playback/webAudioEq';
import type { LoadedTrack, StreamStats, YouTubeEngine } from '@/playback/youtube/engine';
import type { AutomixGraph, AutoDJSnapshot } from '@/playback/automix';

export interface NowPlaying {
  videoId: string;
  title: string;
  artist: string;
  /** Largest available; size it for display with sizedArtwork(). */
  artworkUrl: string | null;
  durationSec: number;
  /** "251 opus 140kbps via VISIONOS", once known; for the debug panel. */
  streamInfo: string | null;
  /** The audio stream field by field, once known; for stats for nerds. */
  stream: (StreamStats & { client: string }) | null;
}

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';

/** Crossfade lengths offered, in seconds; 0 is off. */
export const CROSSFADE_CHOICES = [0, 3, 6, 9, 12] as const;

export type OutputPrecision = 'pcm16' | 'float32';
export type StreamingQuality = 'lossless' | 'high' | 'normal';
export type AutomixPerformance = 'low' | 'balanced' | 'high';

interface Settings {
  shuffle: boolean;
  repeat: RepeatMode;
  /** Keep playing similar music (YouTube Music radio) when the queue runs out. */
  autoplay: boolean;
  volume: number;
  muted: boolean;
  crossfadeSec: number;
  /** AutoMix: beat-matched, phrase-aligned DJ blends between tracks (playback/automix). Overrides crossfadeSec. */
  automix: boolean;
  /** AutoMix's blend length, in bars: a maximum, shortened for weak beat grids. */
  automixBars: number;
  automixPerformance: AutomixPerformance;
  /** Stats for nerds: the stream's codec, bitrate and sample rate, and what Automix is doing, under the artist. */
  showNerdStats: boolean;
  /** Playback speed multiplier (0.5x to 2.0x). */
  playbackRate: number;
  /** 10-slot Web Audio & native Rust equalizer configuration. */
  eq: EqConfig;
  balance: number;
  outputPrecision: OutputPrecision;
  preferUsbDac: boolean;
  loudnessNormalization: boolean;
  skipSilence: boolean;
  spatialAudio: boolean;
  directSourceStream: boolean;
  streamingQuality: StreamingQuality;
}

export interface NativePlayheadState {
  trackId?: string | null;
  positionSec: number;
  durationSec: number;
  playbackRate: number;
  updatedAtMs: number;
  paused: boolean;
}

interface PlayerState extends Settings {
  /** The whole timeline: what played, what plays, what's next (playback/queue/timeline.ts). */
  queue: QueueEntry[];
  /** The playing entry in [queue]; -1 when nothing is loaded. */
  index: number;
  nowPlaying: NowPlaying | null;
  status: PlayerStatus;
  error: string | null;
  /** Bumped whenever the audio element in front changes (crossfade swaps them). */
  deck: number;
  /** AutoMix's loop, while it runs: what it plans and when. */
  automixState: AutoDJSnapshot | null;
  /** A loop mix is playing from its decks: read the position from getPlayhead(), not the element. */
  mixing: boolean;
  sleepTimerEndMs: number | null;
  sleepAfterTrack: boolean;
  desktopOutputMode: AudioSettings['outputMode'];
  bitPerfectStatus: BitPerfectStatus | null;
  nativeActive: boolean;
  nativePlayhead: NativePlayheadState | null;
  registerLocalTracks: (tracks: { id: string; filePath: string; codec?: string }[]) => void;
  registerRemoteTracks: (tracks: RemoteTrackItem[]) => void;

  /** Plays [tracks] as the context (an album, a playlist), from [startIndex]. */
  playTracks: (tracks: Track[], startIndex: number, source: QueueSource) => void;
  /** Plays one song on its own (search, home); AutoPlay carries on after it. */
  playTrack: (track: Track, source: QueueSource) => void;
  /** Plays a bare video id (the Debug page). */
  playVideo: (videoId: string, hint?: Partial<Omit<NowPlaying, 'videoId'>>) => Promise<void>;
  playNext: (tracks: Track[], source?: QueueSource | null) => void;
  addToQueue: (tracks: Track[], source?: QueueSource | null) => void;
  /** Tapping a row in Up Next (QueueTimeline.computeJumpOrder). */
  jumpTo: (index: number) => void;
  removeAt: (index: number) => void;
  /** Moves an upcoming row; both indices are into [queue] and after the playing one. */
  move: (from: number, to: number, targetSection?: QueueSection) => void;
  /** "Clear": the upcoming hand-queued tracks. The album or playlist and AutoPlay stay. */
  clearUpNext: () => void;
  next: () => void;
  previous: () => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setAutoplay: (on: boolean) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  setCrossfade: (seconds: number) => void;
  setAutomix: (on: boolean) => void;
  setAutomixBars: (bars: number) => void;
  setAutomixPerformance: (perf: AutomixPerformance) => void;
  setShowNerdStats: (on: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setSleepTimer: (option: number | 'track' | null) => void;
  setEq: (patch: Partial<EqConfig>) => void;
  setBalance: (balance: number) => void;
  setOutputPrecision: (precision: OutputPrecision) => void;
  setPreferUsbDac: (on: boolean) => void;
  setLoudnessNormalization: (on: boolean) => void;
  setSkipSilence: (on: boolean) => void;
  setSpatialAudio: (on: boolean) => void;
  setDirectSourceStream: (on: boolean) => void;
  setStreamingQuality: (quality: StreamingQuality) => void;
}

const SETTINGS_KEY = 'bitchord:player';
const SESSION_KEY = 'bitchord:playback-session';
const MAX_PERSISTED_QUEUE = 80;
const SESSION_SAVE_DEBOUNCE_MS = 400;
const SESSION_PLAYING_TICK_MS = 5000;

const DEFAULT_SETTINGS: Settings = {
  shuffle: false,
  repeat: 'off',
  autoplay: true,
  volume: 1,
  muted: false,
  crossfadeSec: 0,
  automix: false,
  automixBars: 16,
  automixPerformance: 'balanced',
  showNerdStats: false,
  playbackRate: 1,
  eq: DEFAULT_EQ_CONFIG,
  balance: 0,
  outputPrecision: 'float32',
  preferUsbDac: false,
  loudnessNormalization: true,
  skipSilence: false,
  spatialAudio: false,
  directSourceStream: false,
  streamingQuality: 'lossless',
};

interface PersistedSettings extends Partial<Settings> {
  directSourceStreamMigratedV2?: boolean;
  preferUsbDacDefaultOffV2?: boolean;
}

function loadSettings(): Settings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as PersistedSettings;
    const migratedDirect = parsed.directSourceStreamMigratedV2
      ? (parsed.directSourceStream ?? false)
      : false;
    const migratedPreferUsb = parsed.preferUsbDacDefaultOffV2
      ? (parsed.preferUsbDac ?? false)
      : false;
    const resolved: Settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      directSourceStream: migratedDirect,
      preferUsbDac: migratedPreferUsb,
      eq: { ...DEFAULT_EQ_CONFIG, ...(parsed.eq ?? {}) },
    };
    if (
      (!parsed.directSourceStreamMigratedV2 || !parsed.preferUsbDacDefaultOffV2) &&
      localStorage.getItem(SETTINGS_KEY) !== null
    ) {
      saveSettings(resolved);
    }
    return resolved;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(state: Settings) {
  const {
    shuffle,
    repeat,
    autoplay,
    volume,
    muted,
    crossfadeSec,
    automix,
    automixBars,
    automixPerformance,
    showNerdStats,
    playbackRate,
    eq,
    balance,
    outputPrecision,
    preferUsbDac,
    loudnessNormalization,
    skipSilence,
    spatialAudio,
    directSourceStream,
    streamingQuality,
  } = state;
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      shuffle,
      repeat,
      autoplay,
      volume,
      muted,
      crossfadeSec,
      automix,
      automixBars,
      automixPerformance,
      showNerdStats,
      playbackRate,
      eq,
      balance,
      outputPrecision,
      preferUsbDac,
      preferUsbDacDefaultOffV2: true,
      loudnessNormalization,
      skipSilence,
      spatialAudio,
      directSourceStream,
      directSourceStreamMigratedV2: true,
      streamingQuality,
    }),
  );
}

interface PersistedPlaybackSession {
  version: 1;
  queue: QueueEntry[];
  index: number;
  nowPlaying: NowPlaying | null;
  positionSec: number;
  updatedAtMs: number;
}

function sanitizePersistedSession(
  raw: unknown,
): { queue: QueueEntry[]; index: number; nowPlaying: NowPlaying | null; positionSec: number } {
  if (!raw || typeof raw !== 'object') {
    return { queue: [], index: -1, nowPlaying: null, positionSec: 0 };
  }
  const obj = raw as Partial<PersistedPlaybackSession>;
  if (!Array.isArray(obj.queue) || obj.queue.length === 0) {
    return { queue: [], index: -1, nowPlaying: null, positionSec: 0 };
  }
  const validQueue = obj.queue.filter(
    (entry): entry is QueueEntry =>
      Boolean(
        entry &&
          typeof entry === 'object' &&
          typeof entry.entryId === 'string' &&
          entry.track &&
          typeof entry.track.videoId === 'string' &&
          typeof entry.track.title === 'string',
      ),
  );
  if (!validQueue.length || typeof obj.index !== 'number' || obj.index < 0 || obj.index >= validQueue.length) {
    return { queue: [], index: -1, nowPlaying: null, positionSec: 0 };
  }
  const activeEntry = validQueue[obj.index]!;
  const pos =
    typeof obj.positionSec === 'number' && Number.isFinite(obj.positionSec) && obj.positionSec > 0
      ? obj.positionSec
      : 0;
  const savedNp = obj.nowPlaying;
  const restoredNp: NowPlaying =
    savedNp && savedNp.videoId === activeEntry.track.videoId
      ? {
          videoId: activeEntry.track.videoId,
          title: savedNp.title || activeEntry.track.title,
          artist:
            savedNp.artist ||
            activeEntry.track.artists.map((a) => a.name).join(', '),
          artworkUrl: savedNp.artworkUrl ?? activeEntry.track.thumbnail ?? null,
          durationSec:
            typeof savedNp.durationSec === 'number' && savedNp.durationSec > 0
              ? savedNp.durationSec
              : (activeEntry.track.durationSec ?? 0),
          streamInfo: null,
          stream: null,
        }
      : hintOf(activeEntry.track);
  const boundedPos =
    restoredNp.durationSec > 0 ? Math.min(pos, restoredNp.durationSec) : pos;

  return {
    queue: validQueue,
    index: obj.index,
    nowPlaying: restoredNp,
    positionSec: boundedPos,
  };
}

function loadPlaybackSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { queue: [] as QueueEntry[], index: -1, nowPlaying: null as NowPlaying | null, positionSec: 0 };
    return sanitizePersistedSession(JSON.parse(raw));
  } catch {
    return { queue: [] as QueueEntry[], index: -1, nowPlaying: null as NowPlaying | null, positionSec: 0 };
  }
}

// ---- Decks: two engines, so a crossfade can play the next track under this one ------------

interface Deck {
  engine: YouTubeEngine;
  audio: HTMLAudioElement;
  /** The crossfade's share of the volume, 0 to 1. */
  gain: number;
  loadedTrackId: string | null;
  directUrlActive: boolean;
}

let decks: Deck[] | null = null;
let decksPromise: Promise<Deck[]> | null = null;
let active = 0;
let pendingStartSec = 0;
let activeUpgradeCancel: (() => void) | null = null;

function cancelQualityUpgrade() {
  if (!activeUpgradeCancel) return;
  const cancel = activeUpgradeCancel;
  activeUpgradeCancel = null;
  cancel();
}

function silenceDeck(deck: Deck) {
  deck.loadedTrackId = null;
  deck.audio.pause();
  void deck.engine.stop().catch(() => {});
  if (deck.directUrlActive) {
    deck.audio.removeAttribute('src');
    deck.audio.load();
    deck.directUrlActive = false;
  }
}

/** The audio element in front, if playback has started at least once. */
export function getAudio(): HTMLAudioElement | null {
  return decks?.[active]?.audio ?? null;
}

export interface CastHooks {
  isConnected(): boolean;
  getPlayhead(): { sec: number; paused: boolean } | null;
  loadTrack(opts: {
    trackId: string;
    title: string;
    artist: string;
    album: string | null;
    artworkUrl: string | null;
    durationSec: number;
    startSec: number;
    autoplay: boolean;
  }): Promise<void>;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
}

let castHooks: CastHooks | null = null;
export function setCastHooks(hooks: CastHooks | null): void {
  castHooks = hooks;
}

/** Where the song in front is, in seconds, and whether it's moving. */
export function getPlayhead(): { sec: number; paused: boolean } | null {
  if (castHooks?.isConnected()) {
    return castHooks.getPlayhead();
  }
  const { mixing, nowPlaying, status, nativeActive, nativePlayhead } = usePlayer.getState();
  if (!nowPlaying) return null;
  if (status === 'loading') {
    return { sec: pendingStartSec, paused: true };
  }
  if (nativeActive && nativePlayhead) {
    if (nativePlayhead.trackId && nativePlayhead.trackId !== nowPlaying.videoId) {
      return { sec: pendingStartSec, paused: true };
    }
    const elapsed = nativePlayhead.paused
      ? 0
      : ((performance.now() - nativePlayhead.updatedAtMs) / 1000) * nativePlayhead.playbackRate;
    const sec = Math.max(
      0,
      Math.min(nativePlayhead.durationSec || Number.MAX_SAFE_INTEGER, nativePlayhead.positionSec + elapsed),
    );
    return { sec, paused: nativePlayhead.paused };
  }
  if (mixing && graph) {
    const sec = graph.dj.mixPlayhead(nowPlaying.videoId);
    if (sec !== null) return { sec, paused: false };
  }
  const front = decks?.[active];
  if (!front || front.loadedTrackId !== nowPlaying.videoId) {
    if (restoredPositionSec !== null) {
      return { sec: restoredPositionSec, paused: true };
    }
    return { sec: pendingStartSec, paused: true };
  }
  return { sec: front.audio.currentTime, paused: front.audio.paused };
}

export function getAudioContextSampleRate(): number | null {
  return graph?.ctx.sampleRate ?? null;
}

const localTrackMeta = new Map<string, { filePath: string; codec?: string }>();
const remoteTrackMeta = new Map<
  string,
  { proxyUrl: string; proxyKey: string; codec: string; fileName: string; sourceKind: 'webdav' | 'smb' }
>();
let localHandoffInFlight = false;

function extensionFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const clean = name.split(/[?#]/)[0] ?? name;
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = clean.slice(dot + 1).trim().toLowerCase();
  return ext || null;
}

function getActiveOutputDevice(settings: AudioSettings | null): AudioDeviceInfo | null {
  const devices = queryClient.getQueryData<AudioDeviceInfo[]>(DESKTOP_AUDIO_DEVICES_KEY) ?? [];
  if (!devices.length) return null;
  if (settings?.deviceId) {
    return devices.find((d) => d.id === settings.deviceId) ?? null;
  }
  return devices.find((d) => d.isDefault) ?? devices[0] ?? null;
}

function getCachedAudioSettings(): AudioSettings | null {
  return queryClient.getQueryData<NativePlaybackSnapshot>(['desktop', 'audio', 'snapshot'])?.settings ?? null;
}

function bitPerfectBypassActive(explicitSettings?: AudioSettings | null): boolean {
  const mode =
    explicitSettings?.outputMode ??
    getCachedAudioSettings()?.outputMode ??
    usePlayer.getState().desktopOutputMode;
  return isBitPerfectBypassActive({ outputMode: mode }, usePlayer.getState().bitPerfectStatus);
}

function applyEffectivePlaybackRate(explicitSettings?: AudioSettings | null) {
  const rate = bitPerfectBypassActive(explicitSettings) ? 1 : usePlayer.getState().playbackRate;
  for (const d of decks ?? []) {
    d.audio.playbackRate = rate;
    d.audio.preservesPitch = true;
  }
}

async function resolveDesktopAudioSettings(): Promise<AudioSettings | null> {
  if (!isTauriDesktop()) return null;
  const cached = getCachedAudioSettings();
  if (cached) return cached;
  const snap = await desktopApi.audioSnapshot().catch(() => null);
  if (snap) {
    queryClient.setQueryData(['desktop', 'audio', 'snapshot'], snap);
    usePlayer.setState({
      bitPerfectStatus: snap.bitPerfect,
      desktopOutputMode: snap.settings.outputMode,
    });
  }
  return snap?.settings ?? null;
}

function desktopTapWanted(settings: AudioSettings | null = getCachedAudioSettings()): boolean {
  if (!isTauriDesktop() || !settings) return false;
  return settings.deviceId !== null || settings.outputMode !== 'shared';
}

export async function syncDesktopOutputRoute(explicitSettings?: AudioSettings): Promise<void> {
  if (!isTauriDesktop()) return;
  const settings = explicitSettings ?? (await resolveDesktopAudioSettings());
  if (settings) {
    usePlayer.setState({ desktopOutputMode: settings.outputMode });
  }

  const bypass = bitPerfectBypassActive(settings);
  if (bypass) {
    cancelCrossfade();
    graph?.dj.stop();
  }
  applyEffectivePlaybackRate(settings);
  applyCurrentDsp(graph, settings);
  applyVolumes();

  const state = usePlayer.getState();
  const entry = state.queue[state.index];
  const isDirectRoutedTrack =
    !!entry &&
    (entry.track.videoId.startsWith('local:') ||
      entry.track.videoId.startsWith('webdav:') ||
      entry.track.videoId.startsWith('smb:')) &&
    state.nowPlaying?.videoId === entry.track.videoId;
  const isLoaded =
    state.status === 'playing' || state.status === 'paused' || state.status === 'buffering';
  const exclusive = isExclusiveOutputMode(settings?.outputMode);
  if (
    isDirectRoutedTrack &&
    isLoaded &&
    !localHandoffInFlight &&
    ((exclusive && !state.nativeActive) || (!exclusive && state.nativeActive))
  ) {
    const resumeSec = getPlayhead()?.sec ?? 0;
    const wasPlaying = state.status === 'playing' || state.status === 'buffering';
    localHandoffInFlight = true;
    try {
      await startAt(state.index, { startSec: resumeSec, autoplay: wasPlaying });
    } finally {
      localHandoffInFlight = false;
    }
    return;
  }

  if (usePlayer.getState().nativeActive) return;

  const wantTap = desktopTapWanted(settings);
  if (!wantTap) {
    if (graph?.tap?.isEnabled) {
      await graph.tap.setRouting(false);
    }
    syncAutomix(settings);
    return;
  }

  if (!decks) return;
  const g = await ensureAutomix();
  if (!g) return;
  void g.ctx.resume();
  applyCurrentDsp(g, settings);
  applyVolumes();
  await g.tap?.setRouting(true);
  if (bypass) {
    g.dj.stop();
  } else {
    syncAutomix(settings);
  }
}

export function handleNativeTrackEnded(trackId: string): void {
  const state = usePlayer.getState();
  if (!state.nativeActive || state.nowPlaying?.videoId !== trackId) return;
  endedListeners.forEach((listener) => listener());
  void advance(true).then(intent);
}

export function syncNativePlayheadFromSnapshot(snap: NativePlaybackSnapshot): void {
  const state = usePlayer.getState();
  if (!state.nativeActive || !snap.active) return;
  if (snap.trackId && state.nowPlaying && snap.trackId !== state.nowPlaying.videoId) return;
  usePlayer.setState({
    bitPerfectStatus: snap.bitPerfect,
    desktopOutputMode: snap.settings.outputMode,
    nativePlayhead: {
      trackId: snap.trackId ?? state.nowPlaying?.videoId ?? null,
      positionSec: snap.positionSec,
      durationSec: snap.durationSec,
      playbackRate: isBitPerfectBypassActive(snap.settings, snap.bitPerfect) ? 1 : snap.playbackRate,
      updatedAtMs: performance.now(),
      paused: snap.status !== 'playing',
    },
  });
}

function applyCurrentDsp(g: AutomixGraph | null, explicitSettings?: AudioSettings | null) {
  if (!g) return;
  if (bitPerfectBypassActive(explicitSettings)) {
    g.eq.applyDsp({
      eq: DEFAULT_EQ_CONFIG,
      balance: 0,
      spatialAudio: false,
      loudnessNormalization: false,
    });
    return;
  }
  const s = usePlayer.getState();
  g.eq.applyDsp({
    eq: s.eq,
    balance: s.balance,
    spatialAudio: s.spatialAudio,
    loudnessNormalization: s.loudnessNormalization,
  });
}

function needsWebAudioGraph(explicitSettings?: AudioSettings | null): boolean {
  const tap = desktopTapWanted(explicitSettings);
  if (bitPerfectBypassActive(explicitSettings)) return tap;
  const s = usePlayer.getState();
  return s.automix || s.eq.enabled || s.spatialAudio || Math.abs(s.balance) > 0.01 || tap;
}
export function getMixBeat(): { phase: number | null } | null {
  return graph?.dj.mixBeat() ?? null;
}

function getDecks(): Promise<Deck[]> {
  decksPromise ??= (async () => {
    // Shaka, YouTube.js and googlevideo are the heavy part of the app; they
    // load on the first play, not with the page (prompt §3).
    const { YouTubeEngine } = await import('@/playback/youtube/engine');
    decks = [0, 1].map((n) => {
      const audio = new Audio();
      audio.preload = 'auto';
      // Media from another origin is silent inside an AudioContext unless it
      // is fetched with CORS (prompt §6, the Web Audio caveat).
      audio.crossOrigin = 'anonymous';
      const engine = new YouTubeEngine(audio);
      const deck: Deck = {
        engine,
        audio,
        gain: 1,
        loadedTrackId: null,
        directUrlActive: false,
      };
      engine.onFatal = (videoId, message) => {
        if (decks?.[active] !== deck || deck.loadedTrackId !== videoId) return;
        trackLog.e(`stopped: ${message}`, videoId);
        usePlayer.setState({ status: 'error', error: message });
      };
      engine.onRecovered = (track) => {
        if (decks?.[active] !== deck || deck.loadedTrackId !== track.videoId) return;
        // Keep YouTube Music's title and artist: without the queue's track the
        // video's own ("Doja Cat - Woman" by "dojacatVEVO") would replace them.
        const { queue, index } = usePlayer.getState();
        const entry = queue[index];
        applyTrack(track, entry?.track.videoId === track.videoId ? entry.track : undefined);
      };
      bindElement(deck, n);
      return deck;
    });
    applyVolumes();
    // For browser-driven tests: the elements aren't in the DOM.
    if (import.meta.env.DEV) Object.defineProperty(window, '__bcAudio', { get: getAudio, configurable: true });
    return decks;
  })();
  return decksPromise;
}

function applyVolumes() {
  const { volume, muted, bitPerfectStatus } = usePlayer.getState();
  const bypassVolume = bitPerfectStatus?.active === true;
  const level = bypassVolume ? 1 : muted ? 0 : Math.min(1, Math.max(0, volume));
  if (graph) {
    // Routed through Web Audio: the elements stay at 1 and the graph carries volume and the fade.
    const now = graph.ctx.currentTime;
    graph.master.gain.setTargetAtTime(level, now, 0.015);
    (decks ?? []).forEach((deck, n) => {
      deck.audio.volume = 1;
      graph!.decks[n]!.fader.gain.setTargetAtTime(bypassVolume ? 1 : deck.gain, now, 0.015);
    });
    return;
  }
  for (const deck of decks ?? []) deck.audio.volume = level * (bypassVolume ? 1 : deck.gain);
}

// ---- AutoMix (playback/automix): the two decks routed through Web Audio, mixed like a DJ ----

let graph: AutomixGraph | null = null;
let graphPromise: Promise<AutomixGraph | null> | null = null;
/** The track AutoMix loaded on the back deck, for the handoff. */
let mixLoaded: { videoId: string; track: LoadedTrack } | null = null;
/**
 * A loop mix is running: the decks carry the sound and both elements are
 * paused or started by the mix, so their pause, waiting and ended events
 * aren't the user's and mustn't move the player.
 */
let holding = false;

/** Builds the Web Audio graph and the mix loop over the decks, once. */
function ensureAutomix(): Promise<AutomixGraph | null> {
  const all = decks;
  if (!all) return Promise.resolve(null);
  graphPromise ??= import('@/playback/automix').then(({ createAutomixGraph, analyzer }) => {
    const built = createAutomixGraph(
      all.map((d) => d.audio),
      (routed) => ({
        front: () => routed[active]!,
        back: () => routed[1 - active]!,
        current: () => {
          // A party doesn't mix: every member would blend on their own clock (the phone stops too).
          if (partyHooks?.inParty()) return null;
          const { queue, index, status } = usePlayer.getState();
          const entry = queue[index];
          return entry && status === 'playing' ? queued(entry) : null;
        },
        next: () => {
          const plan = planNext(true);
          return plan?.kind === 'index' ? queued(plan.queue[plan.index]!) : null;
        },
        loadBack: async (videoId) => {
          const back = all[1 - active]!;
          back.gain = 1;
          back.directUrlActive = false;
          back.loadedTrackId = null;
          applyVolumes();
          try {
            const track = await back.engine.load(videoId, { autoplay: false });
            back.loadedTrackId = videoId;
            mixLoaded = { videoId, track };
            return true;
          } catch (error) {
            if (!(error instanceof Error && error.name === 'SupersededError')) {
              trackLog.w(`automix couldn't load the next track: ${String(error)}`, videoId);
            }
            return false;
          }
        },
        handoff: automixHandoff,
        sungSpans,
        hold: (on) => {
          holding = on;
          usePlayer.setState(on ? { status: 'playing', mixing: true } : { mixing: false });
        },
        finished: () => {
          void all[1 - active]!.engine.stop().catch(() => {});
        },
      }),
      (snap) => usePlayer.setState({ automixState: snap }),
    );
    graph = built;
    applyCurrentDsp(built);
    applyVolumes();
    if (import.meta.env.DEV) Object.assign(window, { __bcAutomix: built, __bcAnalyzer: analyzer });
    return built;
  });
  return graphPromise;
}

function queued(entry: QueueEntry) {
  return { videoId: entry.track.videoId, title: entry.track.title, artist: artistNames(entry.track) };
}

/** How long the loop mix waits for a song's lyrics before planning from the vocal mask alone. */
const LYRICS_WAIT_MS = 8000;

/**
 * Where a queued song is sung, from its synced lyrics (the same lookup, and
 * cache, as the lyrics panel). Null when it has no synced lyrics or they
 * don't arrive in time; the loop mix then falls back on the vocal mask.
 */
async function sungSpans(videoId: string) {
  const { queue } = usePlayer.getState();
  const track = queue.find((e) => e.track.videoId === videoId)?.track;
  if (!track) return null;
  const [{ lookupLyrics }, { endMs, hasKnownEnd, isGap }, { sungSpansFromLines }] = await Promise.all([
    import('@/lyrics/repository'),
    import('@/lyrics/model'),
    import('@/playback/automix'),
  ]);
  const found = await Promise.race([
    lookupLyrics({
      videoId,
      title: track.title,
      artist: artistNames(track),
      durationMs: Math.round((track.durationSec ?? 0) * 1000),
      album: track.album?.name ?? null,
    }).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), LYRICS_WAIT_MS)),
  ]);
  if (!found?.synced) return null;
  return sungSpansFromLines(
    found.lines.map((l) => ({ timeMs: l.timeMs, endMs: hasKnownEnd(l) ? endMs(l) : null, blank: isGap(l) })),
  );
}

/** The blend's midpoint: the incoming track is the one playing now, as far as everything else knows. */
function automixHandoff() {
  if (!decks) return;
  const loaded = mixLoaded;
  mixLoaded = null;
  const plan = planNext(true);
  const entry = plan?.kind === 'index' ? plan.queue[plan.index] : undefined;
  if (!plan || plan.kind !== 'index' || !entry || !loaded || entry.track.videoId !== loaded.videoId) {
    trackLog.w('automix handoff found the queue moved; playing on', loaded?.videoId ?? null);
    graph?.dj.cancel();
    return;
  }
  active = 1 - active;
  decks[active]!.loadedTrackId = entry.track.videoId;
  usePlayer.setState((s) => ({ queue: plan.queue, index: plan.index, deck: s.deck + 1, status: 'playing' }));
  applyTrack(loaded.track, entry.track);
  afterTrackStarted();
  intent();
}

function syncAutomix(explicitSettings?: AudioSettings | null) {
  const bypass = bitPerfectBypassActive(explicitSettings);
  if (bypass) {
    cancelCrossfade();
  }
  if (!needsWebAudioGraph(explicitSettings)) {
    graph?.dj.stop();
    applyCurrentDsp(graph, explicitSettings);
    return;
  }
  void ensureAutomix().then((g) => {
    const state = usePlayer.getState();
    if (!g) return;
    void g.ctx.resume();
    applyCurrentDsp(g, explicitSettings);
    if (desktopTapWanted(explicitSettings) && !state.nativeActive) {
      void g.tap?.setRouting(true);
    } else if (g.tap?.isEnabled) {
      void g.tap.setRouting(false);
    }
    if (state.automix && !bitPerfectBypassActive(explicitSettings)) {
      g.dj.transitionBars = state.automixBars;
      g.dj.start();
    } else {
      g.dj.stop();
    }
  });
}

function extensionReady(): boolean {
  const detected = queryClient.getQueryData<DetectedExtension | null>(extensionQueryKey);
  return !!detected?.info.capabilities.includes('yt');
}

const artistNames = (track: Track) => track.artists.map((a) => a.name).join(', ');

function hintOf(track: Track): NowPlaying {
  return {
    videoId: track.videoId,
    title: track.title,
    artist: artistNames(track),
    artworkUrl: track.thumbnail,
    durationSec: track.durationSec ?? 0,
    streamInfo: null,
    stream: null,
  };
}

// ---- Listen Together's two doors (playback/PartySync.kt) ----------------------------
//
// Every user action reports an intent through [partyHooks]; that is how the
// party hears about it. What the party does to this player goes through
// [partyPlayer] instead, which reports nothing, so a correction can never
// come back around as a control.

export interface PartyHooks {
  /** The user did something to playback, or the queue moved on by itself. */
  onIntent(): void;
  /** True when a resume must wait for the party's scheduled start (partySync starts it). */
  shouldDeferPlay(): boolean;
  /** A listener in a host-locked party: play/pause is theirs alone. True when handled. */
  onLockedTransport(playing: boolean): boolean;
  /** In a party, AutoPlay is the party's: one elected member tops up the shared queue. */
  inParty(): boolean;
}

let partyHooks: PartyHooks | null = null;
export function setPartyHooks(hooks: PartyHooks | null): void {
  partyHooks = hooks;
}
const intent = () => partyHooks?.onIntent();

// ---- Store ------------------------------------------------------------------------

/** Each load gets a number; an answer for an older one is dropped. */
let loadToken = 0;
/** Canonical positions of the queue before shuffle, for turning it off again. */
let canonical: Map<string, number> | null = null;
const initialSession = loadPlaybackSession();
let restoredPositionSec: number | null =
  initialSession.nowPlaying ? initialSession.positionSec : null;
let sessionSaveTimer = 0;

export function flushPlaybackSession(): void {
  if (sessionSaveTimer) {
    window.clearTimeout(sessionSaveTimer);
    sessionSaveTimer = 0;
  }
  if (partyHooks?.inParty()) return;
  try {
    const { queue, index, nowPlaying } = usePlayer.getState();
    if (!queue.length || index < 0 || !nowPlaying) {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    let sliceStart = 0;
    let sliceEnd = queue.length;
    if (queue.length > MAX_PERSISTED_QUEUE) {
      sliceStart = Math.max(0, Math.min(index - 20, queue.length - MAX_PERSISTED_QUEUE));
      sliceEnd = sliceStart + MAX_PERSISTED_QUEUE;
    }
    const slicedQueue = queue.slice(sliceStart, sliceEnd);
    const savedIndex = index - sliceStart;
    const headSec = getPlayhead()?.sec;
    const positionSec =
      typeof headSec === 'number' && Number.isFinite(headSec) && headSec >= 0
        ? headSec
        : (restoredPositionSec ?? 0);

    const payload: PersistedPlaybackSession = {
      version: 1,
      queue: slicedQueue,
      index: savedIndex,
      nowPlaying,
      positionSec,
      updatedAtMs: Date.now(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable or quota exceeded.
  }
}

function schedulePlaybackSessionSave(): void {
  if (sessionSaveTimer) return;
  sessionSaveTimer = window.setTimeout(() => {
    sessionSaveTimer = 0;
    flushPlaybackSession();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

export function hydratePlaybackSessionFromStorage(): boolean {
  const restored = loadPlaybackSession();
  if (!restored.nowPlaying || restored.index < 0 || !restored.queue.length) {
    return false;
  }
  restoredPositionSec = restored.positionSec;
  usePlayer.setState({
    queue: restored.queue,
    index: restored.index,
    nowPlaying: restored.nowPlaying,
    status: 'paused',
    error: null,
    nativeActive: false,
    nativePlayhead: null,
  });
  updateMediaSession(restored.nowPlaying);
  return true;
}

export const usePlayer = create<PlayerState>()((set, get) => ({
  ...loadSettings(),
  queue: initialSession.queue,
  index: initialSession.index,
  nowPlaying: initialSession.nowPlaying,
  status: initialSession.nowPlaying ? 'paused' : 'idle',
  error: null,
  deck: 0,
  automixState: null,
  mixing: false,
  sleepTimerEndMs: null,
  sleepAfterTrack: false,
  desktopOutputMode: 'shared',
  bitPerfectStatus: null,
  nativeActive: false,
  nativePlayhead: null,

  registerLocalTracks(tracks) {
    for (const t of tracks) {
      localTrackMeta.set(t.id, { filePath: t.filePath, codec: t.codec });
    }
  },

  registerRemoteTracks(tracks) {
    for (const t of tracks) {
      remoteTrackMeta.set(t.id, {
        proxyUrl: t.streamProxyUrl,
        proxyKey: t.proxyKey,
        codec: t.codec,
        fileName: t.fileName,
        sourceKind: t.sourceKind,
      });
    }
  },

  playTracks(tracks, startIndex, source) {
    if (!tracks.length) return;
    const { queue, index, shuffle } = get();
    const built = buildContextQueue(queue, index, tracks, startIndex, source);
    if (shuffle) {
      canonical = positions(built.timeline);
      set({ queue: shuffledStartingOrder(built.timeline, built.startIndex) });
      void startAt(0);
    } else {
      canonical = null;
      set({ queue: built.timeline });
      void startAt(built.startIndex);
    }
    intent();
  },

  playTrack(track, source) {
    const { queue, index } = get();
    canonical = null;
    set({ queue: buildOneOffQueue(queue, index, track, source) });
    void startAt(0);
    intent();
  },

  async playVideo(videoId, hint = {}) {
    get().playTrack(
      {
        videoId,
        title: hint.title ?? '',
        artists: hint.artist ? [{ name: hint.artist, id: null }] : [],
        album: null,
        durationSec: hint.durationSec ?? null,
        explicit: false,
        thumbnail: hint.artworkUrl ?? null,
        index: null,
        plays: null,
      },
      { title: 'Debug', type: 'other' },
    );
  },

  playNext(tracks, source = null) {
    insertUser(tracks, source, true);
    intent();
  },

  addToQueue(tracks, source = null) {
    insertUser(tracks, source, false);
    intent();
  },

  jumpTo(target) {
    const { queue, index } = get();
    if (target === index) return;
    const jumped = applyJump(queue, index, target);
    if (!jumped) return;
    set({ queue: jumped.timeline });
    void startAt(jumped.index);
    intent();
  },

  removeAt(at) {
    const { queue, index } = get();
    if (at === index || at < 0 || at >= queue.length) return;
    set({ queue: queue.filter((_, i) => i !== at), index: at < index ? index - 1 : index });
    void refillAutoplay();
    intent();
  },

  move(from, to, targetSection) {
    const { queue, index } = get();
    const next = moveUpcomingEntry(queue, index, from, to, targetSection);
    if (!next) return;
    set({ queue: next });
    intent();
  },

  clearUpNext() {
    const { queue, index } = get();
    const drop = new Set(upcomingUserQueueIndices(queue.map((e) => e.tier), index));
    set({ queue: queue.filter((_, i) => !drop.has(i)) });
    intent();
  },

  next() {
    void advance(false).then(intent);
  },

  previous() {
    const { index, queue, repeat } = get();
    const head = getPlayhead();
    if (head && head.sec > BACK_RESTARTS_AFTER_SEC) return get().seek(0);
    if (index > 0) void startAt(index - 1);
    else if (repeat === 'all' && queue.length > 1) void startAt(queue.length - 1);
    else return get().seek(0);
    intent();
  },

  togglePlay() {
    const { nowPlaying, status, index, nativeActive, nativePlayhead } = get();
    if (!nowPlaying) return;

    if (castHooks?.isConnected()) {
      const pausing = status === 'playing' || status === 'buffering';
      if (pausing) {
        castHooks.pause();
        set({ status: 'paused' });
      } else {
        castHooks.play();
        set({ status: 'playing' });
      }
      intent();
      return;
    }

    if (nativeActive) {
      const head = getPlayhead();
      const currentSec = head?.sec ?? nativePlayhead?.positionSec ?? 0;
      const durSec = nativePlayhead?.durationSec ?? nowPlaying.durationSec;
      const activeRate = bitPerfectBypassActive() ? 1 : get().playbackRate;
      const resuming = status !== 'playing';
      if (partyHooks?.onLockedTransport(resuming)) return;
      if (!resuming) {
        cancelQualityUpgrade();
        void desktopApi.audioPause().catch(() => {});
        set({
          status: 'paused',
          nativePlayhead: {
            trackId: nowPlaying.videoId,
            positionSec: currentSec,
            durationSec: durSec,
            playbackRate: activeRate,
            updatedAtMs: performance.now(),
            paused: true,
          },
        });
      } else {
        if (!partyHooks?.shouldDeferPlay()) {
          void desktopApi.audioResume().catch(() => {});
          set({
            status: 'playing',
            nativePlayhead: {
              trackId: nowPlaying.videoId,
              positionSec: currentSec,
              durationSec: durSec,
              playbackRate: activeRate,
              updatedAtMs: performance.now(),
              paused: false,
            },
          });
        }
      }
      intent();
      return;
    }

    // A loop mix holds both elements paused: settle it onto a playing song first.
    if (graph?.dj.loopMixing) cancelCrossfade();
    const audio = getAudio();
    const hasLoadedAudio = Boolean(audio && decks?.[active]?.loadedTrackId === nowPlaying.videoId);
    const resuming = !hasLoadedAudio || !audio || audio.paused || status === 'error';
    // A routed graph left suspended (no gesture when it was built) would play silence.
    if (resuming) void graph?.ctx.resume();
    // A listener in a party the host has locked: the press moves this device alone.
    if (partyHooks?.onLockedTransport(resuming)) return;
    if (!hasLoadedAudio || !audio || status === 'error') {
      // A stopped, failed, or restored session track starts again from its saved timestamp.
      const startSec = restoredPositionSec ?? (hasLoadedAudio ? (audio?.currentTime ?? 0) : 0);
      restoredPositionSec = null;
      void startAt(index, { startSec });
    } else if (audio.paused) {
      // In a party, a resume waits for the instant the server schedules for everyone.
      if (!partyHooks?.shouldDeferPlay()) void audio.play().catch((e: unknown) => trackLog.w(`play() refused: ${String(e)}`));
    } else {
      cancelQualityUpgrade();
      cancelCrossfade();
      audio.pause();
      graph?.tap?.flush();
    }
    intent();
  },

  seek(seconds) {
    const { nativeActive, nativePlayhead, nowPlaying, status } = get();
    if (castHooks?.isConnected()) {
      const dur = nowPlaying?.durationSec ?? seconds;
      const clamped = Math.max(0, Math.min(seconds, dur || seconds));
      castHooks.seek(clamped);
      flushPlaybackSession();
      intent();
      return;
    }
    if (nativeActive) {
      cancelQualityUpgrade();
      const dur = nativePlayhead?.durationSec ?? nowPlaying?.durationSec ?? seconds;
      const clamped = Math.max(0, Math.min(seconds, dur || seconds));
      void desktopApi.audioSeek(clamped).catch(() => {});
      set({
        nativePlayhead: {
          trackId: nowPlaying?.videoId ?? nativePlayhead?.trackId ?? null,
          positionSec: clamped,
          durationSec: dur,
          playbackRate: bitPerfectBypassActive() ? 1 : get().playbackRate,
          updatedAtMs: performance.now(),
          paused: status !== 'playing',
        },
      });
      flushPlaybackSession();
      intent();
      return;
    }
    const audio = getAudio();
    if (!audio || (nowPlaying && decks?.[active]?.loadedTrackId !== nowPlaying.videoId)) {
      if (restoredPositionSec !== null && nowPlaying) {
        const dur = nowPlaying.durationSec || seconds;
        restoredPositionSec = Math.max(0, Math.min(seconds, dur > 0 ? dur : seconds));
        flushPlaybackSession();
        intent();
      }
      return;
    }
    cancelQualityUpgrade();
    cancelCrossfade();
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || seconds));
    graph?.tap?.flush();
    updatePositionState();
    flushPlaybackSession();
    intent();
  },

  toggleShuffle() {
    const { queue, index, shuffle } = get();
    const head = queue.slice(0, index + 1);
    const upcoming = queue.slice(index + 1);
    if (!shuffle) {
      canonical = positions(queue);
      const order = shuffledUpcomingOrder(upcoming.map((e) => e.tier));
      set({ shuffle: true, queue: [...head, ...order.map((i) => upcoming[i]!)] });
    } else {
      // Back to the order the queue had, by section; tracks added since keep their place at the end.
      const known = canonical ?? new Map<string, number>();
      const restored = upcoming
        .map((entry, i) => ({ i, at: known.get(entry.entryId) ?? Number.MAX_SAFE_INTEGER - upcoming.length + i }))
        .sort((a, b) => a.at - b.at)
        .map((x) => x.i);
      const order = sectionedOrder(restored, upcoming.map((e) => e.tier));
      canonical = null;
      set({ shuffle: false, queue: [...head, ...order.map((i) => upcoming[i]!)] });
    }
    saveSettings(get());
  },

  cycleRepeat() {
    const repeat: RepeatMode = { off: 'all', all: 'one', one: 'off' }[get().repeat] as RepeatMode;
    set({ repeat });
    saveSettings(get());
    if (repeat === 'off') void refillAutoplay(true);
  },

  setAutoplay(autoplay) {
    set({ autoplay });
    saveSettings(get());
    if (autoplay) void refillAutoplay(true);
    else {
      // Turning it off takes the radio out of what's to come.
      const { queue, index } = get();
      set({ queue: queue.filter((e, i) => i <= index || e.tier !== 'autoplay') });
    }
  },

  setVolume(volume) {
    const casting = castHooks?.isConnected() ?? false;
    if (!casting && get().bitPerfectStatus?.active) return;
    const nextVol = Math.min(1, Math.max(0, volume));
    set({ volume: nextVol, muted: false });
    applyVolumes();
    saveSettings(get());
    if (casting) {
      castHooks?.setVolume(nextVol);
      return;
    }
    if (isTauriDesktop()) {
      void desktopApi.audioSetVolume(nextVol, false).catch(() => {});
    }
  },

  toggleMute() {
    const casting = castHooks?.isConnected() ?? false;
    if (!casting && get().bitPerfectStatus?.active) return;
    const nextMuted = !get().muted;
    set({ muted: nextMuted });
    applyVolumes();
    saveSettings(get());
    if (casting) {
      castHooks?.setVolume(nextMuted ? 0 : get().volume);
      return;
    }
    if (isTauriDesktop()) {
      void desktopApi.audioSetVolume(get().volume, nextMuted).catch(() => {});
    }
  },

  setCrossfade(crossfadeSec) {
    set({ crossfadeSec, automix: false });
    saveSettings(get());
    syncAutomix();
  },

  setAutomix(automix) {
    set({ automix, automixState: automix ? get().automixState : null });
    saveSettings(get());
    syncAutomix();
  },

  setAutomixBars(automixBars) {
    set({ automixBars });
    saveSettings(get());
    if (graph) graph.dj.transitionBars = automixBars;
  },

  setAutomixPerformance(automixPerformance) {
    set({ automixPerformance });
    saveSettings(get());
  },

  setShowNerdStats(showNerdStats) {
    set({ showNerdStats });
    saveSettings(get());
  },

  setPlaybackRate(rate) {
    if (bitPerfectBypassActive()) return;
    const clamped = Math.min(2, Math.max(0.5, Number(rate.toFixed(2))));
    set({ playbackRate: clamped });
    applyEffectivePlaybackRate();
    saveSettings(get());
    if (isTauriDesktop()) {
      void desktopApi
        .audioSnapshot()
        .then((snap) => desktopApi.audioUpdateSettings({ ...snap.settings, playbackRate: clamped }))
        .then((updated) => {
          queryClient.setQueryData(['desktop', 'audio', 'snapshot'], updated);
          syncNativePlayheadFromSnapshot(updated);
        })
        .catch(() => {});
    }
  },

  setSleepTimer(option) {
    if (option === null) {
      set({ sleepTimerEndMs: null, sleepAfterTrack: false });
    } else if (option === 'track') {
      set({ sleepTimerEndMs: null, sleepAfterTrack: true });
    } else {
      set({ sleepTimerEndMs: Date.now() + option * 60_000, sleepAfterTrack: false });
    }
  },

  setEq(patch) {
    const nextEq: EqConfig = { ...get().eq, ...patch };
    set({ eq: nextEq });
    saveSettings(get());
    if (graph) {
      applyCurrentDsp(graph);
    } else if (needsWebAudioGraph()) {
      syncAutomix();
    }
    if (isTauriDesktop()) {
      void desktopApi
        .audioSnapshot()
        .then((snap) => desktopApi.audioUpdateSettings({ ...snap.settings, eq: nextEq }))
        .then((updated) => {
          queryClient.setQueryData(['desktop', 'audio', 'snapshot'], updated);
          set({
            bitPerfectStatus: updated.bitPerfect,
            desktopOutputMode: updated.settings.outputMode,
          });
        })
        .catch(() => {});
    }
  },

  setBalance(balance) {
    const clamped = Math.min(1, Math.max(-1, Number(balance.toFixed(2))));
    set({ balance: clamped });
    saveSettings(get());
    if (graph) applyCurrentDsp(graph);
    else if (needsWebAudioGraph()) syncAutomix();
  },

  setOutputPrecision(outputPrecision) {
    set({ outputPrecision });
    saveSettings(get());
  },

  setPreferUsbDac(preferUsbDac) {
    set({ preferUsbDac });
    saveSettings(get());
  },

  setLoudnessNormalization(loudnessNormalization) {
    set({ loudnessNormalization });
    saveSettings(get());
    if (graph) applyCurrentDsp(graph);
  },

  setSkipSilence(skipSilence) {
    set({ skipSilence });
    saveSettings(get());
  },

  setSpatialAudio(spatialAudio) {
    set({ spatialAudio });
    saveSettings(get());
    if (graph) applyCurrentDsp(graph);
    else if (needsWebAudioGraph()) syncAutomix();
  },

  setDirectSourceStream(directSourceStream) {
    set({ directSourceStream });
    saveSettings(get());
  },

  setStreamingQuality(streamingQuality) {
    set({ streamingQuality });
    saveSettings(get());
  },
}));

// For browser-driven tests, next to __bcAudio.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __bcPlayer: usePlayer,
    // AutoMix's analysis self-test: expect BPM ≈ 123.93 and Camelot 8A.
    __automixSelfTest: () => import('@/playback/automix/analysis/selftest').then((m) => m.analysisSelfTest()),
  });
}

function positions(queue: readonly QueueEntry[]): Map<string, number> {
  return new Map(queue.map((e, i) => [e.entryId, i]));
}

function insertUser(tracks: Track[], source: QueueSource | null, isNext: boolean) {
  if (!tracks.length) return;
  const { queue, index } = usePlayer.getState();
  const entries = tracks.map((t) => asEntry(t, 'user', source));
  if (index < 0) {
    usePlayer.setState({ queue: entries });
    void startAt(0);
    return;
  }
  const at = userQueueInsertionIndex(queue, index, isNext);
  usePlayer.setState({ queue: [...queue.slice(0, at), ...entries, ...queue.slice(at)] });
}

// ---- Loading and moving through the queue -------------------------------------------

/** Stops any local audio deck or WASAPI stream before transferring playback to a TV. */
export async function silenceLocalOutputForCast(): Promise<void> {
  cancelQualityUpgrade();
  cancelCrossfade();
  graph?.dj.stop();
  if (decks) {
    for (const d of decks) {
      silenceDeck(d);
    }
  }
  if (graph?.tap?.isEnabled) {
    await graph.tap.setRouting(false).catch(() => {});
  }
  if (usePlayer.getState().nativeActive) {
    await desktopApi.audioStop().catch(() => {});
    usePlayer.setState({
      nativeActive: false,
      nativePlayhead: null,
      bitPerfectStatus: null,
    });
  }
}

function silenceLocalAudioImmediate(): void {
  if (decks) {
    for (const d of decks) {
      silenceDeck(d);
    }
  }
  graph?.tap?.flush();
  if (isTauriDesktop() && usePlayer.getState().nativeActive) {
    void desktopApi.audioStop().catch(() => {});
    usePlayer.setState({
      nativeActive: false,
      nativePlayhead: null,
      bitPerfectStatus: null,
    });
  }
}

export async function resumeLocalAfterCast(startSec: number, autoplay: boolean): Promise<void> {
  const { index } = usePlayer.getState();
  if (index >= 0) {
    await startAt(index, { startSec, autoplay });
  }
}

export function handleCastTrackEnded(trackId: string): void {
  const state = usePlayer.getState();
  if (state.nowPlaying?.videoId !== trackId) return;
  endedListeners.forEach((listener) => listener());
  void advance(true).then(intent);
}

const FAST_SOURCE_RACE_MS = 2500;
const DIRECT_SOURCE_WAIT_MS = 12_000;
const BACKGROUND_SOURCE_LOOKUP_MS = 25_000;
const MIN_REMAINING_FOR_UPGRADE_SEC = 20;
const UPGRADE_MICRO_FADE_MS = 80;
const UPGRADE_STEP_MS = 20;
const UPGRADE_PREBUFFER_TIMEOUT_MS = 12_000;

function formatReplacementMeta(replacement: ResolvedPlaybackSource) {
  const { payload } = replacement;
  const streamMeta = payload.stream;
  const codecLabel =
    streamMeta.codec ??
    streamMeta.format?.toUpperCase() ??
    (streamMeta.lossless ? 'FLAC' : 'Audio');
  const detailParts = [codecLabel];
  if (streamMeta.bitrateKbps) detailParts.push(`${streamMeta.bitrateKbps} kbps`);
  else if (streamMeta.sampleRateHz) detailParts.push(`${+(streamMeta.sampleRateHz / 1000).toFixed(1)} kHz`);
  detailParts.push(`via ${streamMeta.sourceName}`);
  const streamStats: StreamStats & { client: string } = {
    codec: codecLabel,
    itag: null,
    bitrateKbps: streamMeta.bitrateKbps,
    sampleRateHz: streamMeta.sampleRateHz,
    channels: 2,
    mode: 'direct',
    client: streamMeta.sourceName,
  };
  return {
    payload,
    streamMeta,
    codecLabel,
    streamInfo: detailParts.join(' · '),
    streamStats,
  };
}

function waitForAudioReady(
  audio: HTMLAudioElement,
  eventName: 'loadedmetadata' | 'canplay',
  isAlreadyReady: () => boolean,
  timeoutMs: number,
  onRegisterAbort: (abort: () => void) => void,
): Promise<void> {
  if (isAlreadyReady()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener(eventName, onReady);
      audio.removeEventListener('error', onError);
    };
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('Replacement stream failed to load'));
    const timer = window.setTimeout(() => finish(new Error('Replacement stream prebuffer timed out')), timeoutMs);
    audio.addEventListener(eventName, onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    onRegisterAbort(() => finish(new Error('SupersededError')));
  });
}

async function beginNativeTrackPlayback(params: {
  entry: QueueEntry;
  token: number;
  startSec: number;
  autoplay: boolean;
  playNative: () => Promise<NativePlaybackSnapshot>;
  codecHint?: string | null;
  bitrateKbps?: number | null;
  sourceLabel?: string | null;
}): Promise<void> {
  const { entry, token, startSec, autoplay, playNative, codecHint, bitrateKbps, sourceLabel } = params;
  if (decks) {
    for (const d of decks) {
      silenceDeck(d);
    }
  }
  if (graph?.tap?.isEnabled) {
    await graph.tap.setRouting(false);
  }
  if (token !== loadToken) return;
  const curState = usePlayer.getState();
  await desktopApi.audioSetVolume(curState.volume, curState.muted).catch(() => {});
  const played = await playNative();
  if (token !== loadToken) {
    void desktopApi.audioStop().catch(() => {});
    return;
  }
  if (!autoplay) await desktopApi.audioPause().catch(() => {});
  queryClient.setQueryData(['desktop', 'audio', 'snapshot'], played);
  const dur = played.durationSec || entry.track.durationSec || 0;
  const effectiveRate = isBitPerfectBypassActive(played.settings, played.bitPerfect) ? 1 : played.playbackRate;
  const driverLabel = played.bitPerfect.exact
    ? 'WASAPI Bit-Exact'
    : (played.bitPerfect.driver ?? 'WASAPI Exclusive');
  const resolvedCodec = codecHint ?? played.codec ?? 'PCM';
  usePlayer.setState({
    nativeActive: true,
    nativePlayhead: {
      trackId: entry.track.videoId,
      positionSec: startSec,
      durationSec: dur,
      playbackRate: effectiveRate,
      updatedAtMs: performance.now(),
      paused: !autoplay,
    },
    desktopOutputMode: played.settings.outputMode,
    bitPerfectStatus: played.bitPerfect,
    nowPlaying: {
      ...hintOf(entry.track),
      durationSec: dur,
      streamInfo: sourceLabel
        ? `${resolvedCodec} · ${driverLabel} via ${sourceLabel}`
        : `${resolvedCodec} · ${driverLabel}`,
      stream: {
        codec: resolvedCodec,
        itag: null,
        bitrateKbps: bitrateKbps ?? null,
        sampleRateHz: played.sampleRateHz,
        channels: played.channels,
        mode: 'direct',
        client: sourceLabel ? `${sourceLabel} (${driverLabel})` : driverLabel,
      },
    },
    status: autoplay ? 'playing' : 'paused',
    error: null,
  });
  applyVolumes();
  updateMediaSession(usePlayer.getState().nowPlaying);
  afterTrackStarted();
}

async function beginAudioElementPlayback(params: {
  deck: Deck;
  entry: QueueEntry;
  url: string;
  token: number;
  startSec: number;
  autoplay: boolean;
  settings: AudioSettings | null;
  streamInfo: string;
  streamStats: (StreamStats & { client: string }) | null;
}): Promise<void> {
  const { deck, entry, url, token, startSec, autoplay, settings, streamInfo, streamStats } = params;
  if (token !== loadToken) return;
  deck.loadedTrackId = null;
  await deck.engine.stop().catch(() => {});
  if (token !== loadToken) return;
  deck.directUrlActive = true;
  deck.audio.src = url;
  applyEffectivePlaybackRate(settings);
  if (startSec > 0) deck.audio.currentTime = startSec;
  if (autoplay) {
    try {
      await deck.audio.play();
    } catch (err) {
      if (token !== loadToken) {
        silenceDeck(deck);
      }
      throw err;
    }
  }
  if (token !== loadToken) {
    silenceDeck(deck);
    return;
  }
  deck.loadedTrackId = entry.track.videoId;
  const dur = Number.isFinite(deck.audio.duration) ? deck.audio.duration : (entry.track.durationSec ?? 0);
  usePlayer.setState({
    nowPlaying: {
      ...hintOf(entry.track),
      durationSec: dur,
      streamInfo,
      stream: streamStats,
    },
    status: autoplay ? 'playing' : 'paused',
  });
  updateMediaSession(usePlayer.getState().nowPlaying);
  afterTrackStarted();
  syncAutomix(settings);
}

async function tryPlayResolvedReplacement(params: {
  deck: Deck;
  entry: QueueEntry;
  replacement: ResolvedPlaybackSource;
  token: number;
  startSec: number;
  autoplay: boolean;
  exclusive: boolean;
  settings: AudioSettings | null;
}): Promise<boolean> {
  const { deck, entry, replacement, token, startSec, autoplay, exclusive, settings } = params;
  const trackId = entry.track.videoId;
  const { payload, streamMeta, codecLabel, streamInfo, streamStats } = formatReplacementMeta(replacement);

  if (exclusive) {
    try {
      await beginNativeTrackPlayback({
        entry,
        token,
        startSec,
        autoplay,
        codecHint: codecLabel,
        bitrateKbps: streamMeta.bitrateKbps,
        sourceLabel: streamMeta.sourceName,
        playNative: () =>
          desktopApi.audioPlayRemoteSource(
            trackId,
            payload.proxyKey,
            extensionForResolvedStream(payload),
            startSec,
          ),
      });
      return true;
    } catch (err) {
      if (token !== loadToken) return true;
      trackLog.w(
        `Native decode failed for ${streamMeta.sourceName}, falling back: ${err instanceof Error ? err.message : String(err)}`,
        trackId,
      );
    }
  }

  try {
    await beginAudioElementPlayback({
      deck,
      entry,
      url: payload.proxyUrl,
      token,
      startSec,
      autoplay,
      settings,
      streamInfo,
      streamStats,
    });
    return true;
  } catch (err) {
    if (token !== loadToken) return true;
    silenceDeck(deck);
    trackLog.w(
      `Source playback failed for ${streamMeta.sourceName}, falling back to YouTube Music: ${err instanceof Error ? err.message : String(err)}`,
      trackId,
    );
    return false;
  }
}

async function upgradeActiveTrackToSource(params: {
  entry: QueueEntry;
  token: number;
  replacement: ResolvedPlaybackSource;
  settings: AudioSettings | null;
}): Promise<void> {
  const { entry, token, replacement, settings } = params;
  const trackId = entry.track.videoId;
  if (token !== loadToken) return;

  const canStillUpgrade = () => {
    if (token !== loadToken) return false;
    const s = usePlayer.getState();
    if (s.nowPlaying?.videoId !== trackId) return false;
    if (s.status !== 'playing' && s.status !== 'buffering') return false;
    if (s.mixing || holding || fade || castHooks?.isConnected()) return false;
    const head = getPlayhead();
    const curSec = head?.sec ?? 0;
    const durSec = s.nowPlaying.durationSec || decks?.[active]?.audio.duration || 0;
    if (durSec > 0 && durSec - curSec < MIN_REMAINING_FOR_UPGRADE_SEC) return false;
    return true;
  };

  if (!canStillUpgrade()) return;

  const { payload, streamMeta, codecLabel, streamInfo, streamStats } = formatReplacementMeta(replacement);
  const exclusive = isExclusiveOutputMode(settings?.outputMode);

  if (exclusive) {
    try {
      const initialSec = getPlayhead()?.sec ?? 0;
      const played = await desktopApi.audioPlayRemoteSource(
        trackId,
        payload.proxyKey,
        extensionForResolvedStream(payload),
        initialSec,
      );
      if (!canStillUpgrade()) {
        void desktopApi.audioStop().catch(() => {});
        return;
      }
      const syncedSec = decks?.[active]?.audio.currentTime ?? (getPlayhead()?.sec ?? initialSec);
      if (syncedSec > 0) {
        await desktopApi.audioSeek(syncedSec).catch(() => {});
      }
      if (decks) {
        for (const d of decks) silenceDeck(d);
      }
      if (graph?.tap?.isEnabled) {
        await graph.tap.setRouting(false).catch(() => {});
      }
      queryClient.setQueryData(['desktop', 'audio', 'snapshot'], played);
      const dur = played.durationSec || usePlayer.getState().nowPlaying?.durationSec || entry.track.durationSec || 0;
      const effectiveRate = isBitPerfectBypassActive(played.settings, played.bitPerfect) ? 1 : played.playbackRate;
      const driverLabel = played.bitPerfect.exact
        ? 'WASAPI Bit-Exact'
        : (played.bitPerfect.driver ?? 'WASAPI Exclusive');
      usePlayer.setState((s) => ({
        nativeActive: true,
        nativePlayhead: {
          trackId,
          positionSec: syncedSec,
          durationSec: dur,
          playbackRate: effectiveRate,
          updatedAtMs: performance.now(),
          paused: false,
        },
        desktopOutputMode: played.settings.outputMode,
        bitPerfectStatus: played.bitPerfect,
        nowPlaying: s.nowPlaying
          ? {
              ...s.nowPlaying,
              durationSec: dur,
              streamInfo: `${codecLabel} · ${driverLabel} via ${streamMeta.sourceName}`,
              stream: {
                codec: codecLabel,
                itag: null,
                bitrateKbps: streamMeta.bitrateKbps ?? null,
                sampleRateHz: played.sampleRateHz,
                channels: played.channels,
                mode: 'direct',
                client: `${streamMeta.sourceName} (${driverLabel})`,
              },
            }
          : s.nowPlaying,
        status: 'playing',
      }));
      applyVolumes();
    } catch (err) {
      if (token === loadToken) {
        trackLog.w(
          `Background native upgrade skipped for ${streamMeta.sourceName}: ${err instanceof Error ? err.message : String(err)}`,
          trackId,
        );
      }
    }
    return;
  }

  const all = await getDecks();
  if (!canStillUpgrade()) return;

  const frontIndex = active;
  const backIndex = 1 - frontIndex;
  const front = all[frontIndex]!;
  const back = all[backIndex]!;

  let rampTimer = 0;
  let eventAbort: (() => void) | null = null;
  let aborted = false;

  const abortUpgrade = () => {
    aborted = true;
    if (rampTimer) {
      window.clearTimeout(rampTimer);
      rampTimer = 0;
    }
    eventAbort?.();
    if (active === frontIndex) {
      silenceDeck(back);
      back.gain = 1;
      front.gain = 1;
      applyVolumes();
    }
  };
  activeUpgradeCancel = abortUpgrade;

  try {
    silenceDeck(back);
    back.gain = 0;
    if (graph) {
      graph.decks[backIndex]?.fader.gain.setValueAtTime(0, graph.ctx.currentTime);
    } else {
      back.audio.volume = 0;
    }
    back.directUrlActive = true;
    back.audio.src = payload.proxyUrl;
    applyEffectivePlaybackRate(settings);

    await waitForAudioReady(
      back.audio,
      'loadedmetadata',
      () => back.audio.readyState >= 1,
      UPGRADE_PREBUFFER_TIMEOUT_MS,
      (fn) => {
        eventAbort = fn;
      },
    );
    if (aborted || !canStillUpgrade()) {
      abortUpgrade();
      return;
    }

    const expectedDur = usePlayer.getState().nowPlaying?.durationSec || front.audio.duration || 0;
    if (Number.isFinite(back.audio.duration) && back.audio.duration > 0 && expectedDur > 0) {
      const maxDrift = Math.max(useSources.getState().trackLengthToleranceSec, 5);
      if (Math.abs(back.audio.duration - expectedDur) > maxDrift) {
        trackLog.w(
          `Upgrade rejected: decoded duration ${Math.round(back.audio.duration)}s differs from ${Math.round(expectedDur)}s`,
          trackId,
        );
        abortUpgrade();
        return;
      }
    }

    back.audio.currentTime = front.audio.currentTime;
    await waitForAudioReady(
      back.audio,
      'canplay',
      () => back.audio.readyState >= 3,
      UPGRADE_PREBUFFER_TIMEOUT_MS,
      (fn) => {
        eventAbort = fn;
      },
    );
    if (aborted || !canStillUpgrade()) {
      abortUpgrade();
      return;
    }

    back.audio.currentTime = front.audio.currentTime;
    await back.audio.play();
    if (aborted || !canStillUpgrade()) {
      abortUpgrade();
      return;
    }

    if (Math.abs(back.audio.currentTime - front.audio.currentTime) > 0.045) {
      back.audio.currentTime = front.audio.currentTime;
    }

    back.loadedTrackId = trackId;
    active = backIndex;
    const verifiedDur = Number.isFinite(back.audio.duration) && back.audio.duration > 0
      ? back.audio.duration
      : expectedDur;

    usePlayer.setState((s) => ({
      deck: s.deck + 1,
      status: 'playing',
      nowPlaying: s.nowPlaying
        ? {
            ...s.nowPlaying,
            durationSec: verifiedDur || s.nowPlaying.durationSec,
            streamInfo,
            stream: streamStats,
          }
        : s.nowPlaying,
    }));

    const fadeStarted = performance.now();
    await new Promise<void>((resolve) => {
      const step = () => {
        if (aborted || token !== loadToken) {
          resolve();
          return;
        }
        const t = Math.min(1, (performance.now() - fadeStarted) / UPGRADE_MICRO_FADE_MS);
        front.gain = Math.cos((t * Math.PI) / 2);
        back.gain = Math.sin((t * Math.PI) / 2);
        applyVolumes();
        if (t < 1) {
          rampTimer = window.setTimeout(step, UPGRADE_STEP_MS);
        } else {
          rampTimer = 0;
          back.gain = 1;
          front.gain = 1;
          silenceDeck(front);
          applyVolumes();
          resolve();
        }
      };
      step();
    });
    trackLog.i(`upgraded active stream to ${streamInfo}`, trackId);
  } catch (err) {
    if (!aborted && token === loadToken) {
      trackLog.w(
        `Background upgrade failed for ${streamMeta.sourceName}: ${err instanceof Error ? err.message : String(err)}`,
        trackId,
      );
    }
    abortUpgrade();
  } finally {
    if (activeUpgradeCancel === abortUpgrade) {
      activeUpgradeCancel = null;
    }
  }
}

/** Loads queue[at] into the deck in front and plays it. `auto` marks a move the player made on its own. */
async function startAt(at: number, { startSec = 0, auto = false, autoplay = true } = {}): Promise<void> {
  const state = usePlayer.getState();
  const entry = state.queue[at];
  if (!entry) return;
  restoredPositionSec = null;
  cancelQualityUpgrade();
  cancelCrossfade();
  const token = ++loadToken;
  pendingStartSec = startSec;
  const trackId = entry.track.videoId;
  const isRemoteFile = trackId.startsWith('webdav:') || trackId.startsWith('smb:');
  const isDirectLibrary = trackId.startsWith('local:') || isRemoteFile;

  silenceLocalAudioImmediate();

  if (castHooks?.isConnected()) {
    usePlayer.setState({ index: at, nowPlaying: hintOf(entry.track), status: 'loading', error: null });
    updateMediaSession(usePlayer.getState().nowPlaying);
    try {
      await silenceLocalOutputForCast();
      if (token !== loadToken) return;
      await castHooks.loadTrack({
        trackId,
        title: entry.track.title,
        artist: artistNames(entry.track),
        album: entry.track.album?.name ?? null,
        artworkUrl: entry.track.thumbnail,
        durationSec: entry.track.durationSec ?? 0,
        startSec,
        autoplay,
      });
      if (token !== loadToken) return;
      usePlayer.setState({
        status: autoplay ? 'playing' : 'paused',
        error: null,
      });
      afterTrackStarted();
    } catch (error) {
      if (token !== loadToken) return;
      const message = error instanceof Error ? error.message : String(error);
      usePlayer.setState({ status: 'error', error: message });
    }
    return;
  }

  usePlayer.setState({ index: at, nowPlaying: hintOf(entry.track), status: 'loading', error: null });
  updateMediaSession(usePlayer.getState().nowPlaying);
  try {
    const settings = await resolveDesktopAudioSettings();
    if (token !== loadToken) return;
    const exclusive = isExclusiveOutputMode(settings?.outputMode);

    if (isTauriDesktop() && trackId.startsWith('local:') && exclusive) {
      let localMeta = localTrackMeta.get(trackId);
      if (!localMeta) {
        const scanned = await desktopApi.localListTracks().catch(() => []);
        if (token !== loadToken) return;
        usePlayer.getState().registerLocalTracks(scanned);
        localMeta = localTrackMeta.get(trackId);
      }
      if (localMeta) {
        const meta = localMeta;
        await beginNativeTrackPlayback({
          entry,
          token,
          startSec,
          autoplay,
          codecHint: meta.codec,
          playNative: () => desktopApi.audioPlayFile(trackId, meta.filePath, startSec),
        });
        return;
      }
    }

    if (isTauriDesktop() && isRemoteFile) {
      let rMeta = remoteTrackMeta.get(trackId);
      if (!rMeta) {
        const list = trackId.startsWith('webdav:')
          ? await desktopApi.webdavListTracks().catch(() => [])
          : await desktopApi.smbListTracks().catch(() => []);
        if (token !== loadToken) return;
        usePlayer.getState().registerRemoteTracks(list);
        rMeta = remoteTrackMeta.get(trackId);
      }
      if (!rMeta) {
        throw new Error(
          trackId.startsWith('webdav:')
            ? 'This WebDAV file is unavailable. Check WebDAV under Settings -> Sources.'
            : 'This SMB file is unavailable. Check SMB under Settings -> Sources.',
        );
      }
      const meta = rMeta;
      const sourceLabel = meta.sourceKind === 'webdav' ? 'WebDAV' : 'SMB';
      if (exclusive) {
        await beginNativeTrackPlayback({
          entry,
          token,
          startSec,
          autoplay,
          codecHint: meta.codec,
          sourceLabel,
          playNative: () =>
            desktopApi.audioPlayRemoteSource(trackId, meta.proxyKey, extensionFromName(meta.fileName), startSec),
        });
        return;
      }
      const all = await getDecks();
      if (token !== loadToken) return;
      const deck = all[active]!;
      silenceDeck(all[1 - active]!);
      deck.gain = 1;
      applyVolumes();
      applyEffectivePlaybackRate(settings);
      graph?.tap?.flush();
      if (desktopTapWanted(settings)) {
        await syncDesktopOutputRoute(settings ?? undefined);
        if (token !== loadToken) return;
      }
      await beginAudioElementPlayback({
        deck,
        entry,
        url: meta.proxyUrl,
        token,
        startSec,
        autoplay,
        settings,
        streamInfo: `${meta.codec} · ${sourceLabel}`,
        streamStats: {
          codec: meta.codec,
          itag: null,
          bitrateKbps: null,
          sampleRateHz: null,
          channels: 2,
          mode: 'direct',
          client: sourceLabel,
        },
      });
      return;
    }

    const all = await getDecks();
    if (token !== loadToken) return;
    const deck = all[active]!;
    silenceDeck(all[1 - active]!);
    deck.gain = 1;
    applyVolumes();
    applyEffectivePlaybackRate(settings);

    graph?.tap?.flush();
    if (desktopTapWanted(settings)) {
      await syncDesktopOutputRoute(settings ?? undefined);
      if (token !== loadToken) return;
    }

    let localMediaUrl: string | null = null;
    if (isTauriDesktop()) {
      if (trackId.startsWith('local:')) {
        localMediaUrl = await desktopApi.localMediaUrl(trackId).catch(() => null);
      } else {
        localMediaUrl = await desktopApi.downloadsMediaUrl(trackId).catch(() => null);
      }
      if (token !== loadToken) return;
    }

    if (localMediaUrl) {
      await beginAudioElementPlayback({
        deck,
        entry,
        url: localMediaUrl,
        token,
        startSec,
        autoplay,
        settings,
        streamInfo: trackId.startsWith('local:') ? 'Local file' : 'Offline download',
        streamStats: null,
      });
      return;
    }

    const { directSourceStream, streamingQuality } = usePlayer.getState();
    let backgroundLookup: Promise<ResolvedPlaybackSource | null> | null = null;

    if (isTauriDesktop() && !isDirectLibrary) {
      if (!useSources.getState().loaded) {
        await useSources.getState().loadFromBackend().catch(() => {});
        if (token !== loadToken) return;
      }
      const baseResolveOpts: ReplacementResolveOptions = {
        streamingQuality,
        outputMode: settings?.outputMode ?? 'shared',
        activeDevice: getActiveOutputDevice(settings ?? null),
        shouldCancel: () => token !== loadToken,
      };
      const hasSources = listEligibleSourceIds(baseResolveOpts).length > 0;

      if (hasSources && directSourceStream) {
        const replacement = await resolveReplacementSource(entry.track, {
          ...baseResolveOpts,
          maxQueriesPerSource: 2,
          timeoutMs: DIRECT_SOURCE_WAIT_MS,
        });
        if (token !== loadToken) return;
        if (replacement) {
          const started = await tryPlayResolvedReplacement({
            deck,
            entry,
            replacement,
            token,
            startSec,
            autoplay,
            exclusive,
            settings,
          });
          if (started) return;
        }
      } else if (hasSources) {
        const inFlight = resolveReplacementSource(entry.track, {
          ...baseResolveOpts,
          maxQueriesPerSource: 2,
          timeoutMs: BACKGROUND_SOURCE_LOOKUP_MS,
        });
        let raceTimer = 0;
        const raceOutcome = await Promise.race([
          inFlight.then((res) => ({ kind: 'resolved' as const, res })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            raceTimer = window.setTimeout(() => resolve({ kind: 'timeout' }), FAST_SOURCE_RACE_MS);
          }),
        ]);
        window.clearTimeout(raceTimer);
        if (token !== loadToken) return;

        if (raceOutcome.kind === 'resolved') {
          if (raceOutcome.res) {
            const started = await tryPlayResolvedReplacement({
              deck,
              entry,
              replacement: raceOutcome.res,
              token,
              startSec,
              autoplay,
              exclusive,
              settings,
            });
            if (started) return;
          }
        } else {
          backgroundLookup = inFlight;
        }
      }
    }

    if (!extensionReady()) {
      usePlayer.setState({
        index: at,
        nowPlaying: { ...hintOf(entry.track), title: entry.track.title || 'Can’t play this here yet' },
        status: 'error',
        error: 'YouTube playback needs the BitChord extension.',
      });
      return;
    }

    deck.directUrlActive = false;
    deck.loadedTrackId = null;
    const track = await deck.engine.load(trackId, { startSec, autoplay });
    if (token !== loadToken) {
      silenceDeck(deck);
      return;
    }
    deck.loadedTrackId = trackId;
    applyEffectivePlaybackRate(settings);
    applyTrack(track, entry.track);
    usePlayer.setState({ status: autoplay ? 'playing' : 'paused' });
    afterTrackStarted();
    syncAutomix(settings);

    if (backgroundLookup && autoplay) {
      void backgroundLookup.then((replacement) => {
        if (replacement && token === loadToken) {
          void upgradeActiveTrackToSource({ entry, token, replacement, settings });
        }
      });
    }
  } catch (error) {
    if (token !== loadToken || (error instanceof Error && error.name === 'SupersededError')) return;
    const message = error instanceof Error ? error.message : String(error);
    usePlayer.setState({ status: 'error', error: message });
    // A track the player reached on its own that can't play is skipped, as on the phone.
    if (auto && planNext(true)) {
      trackLog.w(`skipping: ${message}`, trackId);
      setTimeout(() => {
        if (token === loadToken) void advance(true);
      }, 1500);
    }
  }
}

type NextPlan = { kind: 'repeat-one' } | { kind: 'index'; queue: QueueEntry[]; index: number };

/**
 * What comes after the playing track, without doing it. `auto` is a track
 * ending (repeat-one replays it); a Next tap moves on regardless.
 */
function planNext(auto: boolean): NextPlan | null {
  const { queue, index, repeat } = usePlayer.getState();
  if (auto && repeat === 'one') return { kind: 'repeat-one' };
  if (index + 1 < queue.length) return { kind: 'index', queue, index: index + 1 };
  if (repeat !== 'off' && queue.length) {
    // Round again: the hand-queued tracks have had their turn; the context repeats.
    const tiers = queue.map((e) => e.tier);
    const played = new Set(playedUserQueueIndices(tiers, index));
    const kept = queue.filter((e, i) => !played.has(i) && (e.tier !== 'user' || i > index));
    return kept.length ? { kind: 'index', queue: kept, index: 0 } : null;
  }
  return null;
}

async function advance(auto: boolean): Promise<void> {
  let plan = planNext(auto);
  if (!plan && usePlayer.getState().autoplay) {
    await refillAutoplay(true);
    plan = planNext(auto);
  }
  if (!plan) {
    // The end: leave the last track loaded and paused, as a music app does.
    if (auto) usePlayer.setState({ status: 'paused' });
    return;
  }
  if (plan.kind === 'repeat-one') {
    if (usePlayer.getState().nativeActive) {
      usePlayer.getState().seek(0);
      return;
    }
    const audio = getAudio();
    if (audio) {
      audio.currentTime = 0;
      graph?.tap?.flush();
      void audio.play();
    }
    return;
  }
  usePlayer.setState({ queue: plan.queue });
  await startAt(plan.index, { auto });
}

/** Once a track is under way: prune hand-queued tracks already played, and top up AutoPlay. */
function afterTrackStarted() {
  const { queue, index } = usePlayer.getState();
  const played = new Set(playedUserQueueIndices(queue.map((e) => e.tier), index));
  if (played.size) {
    usePlayer.setState({
      queue: queue.filter((_, i) => !played.has(i)),
      index: index - [...played].filter((i) => i < index).length,
    });
  }
  void refillAutoplay();
}

// ---- AutoPlay ---------------------------------------------------------------------

/**
 * How many AutoPlay tracks wait after the playing one (Autoplay.MAX_QUEUED_AUTOPLAY).
 * Topped back up on every track change, as on the phone: a suggestion that
 * starts playing is replaced by a new one at the end, rather than the whole
 * station arriving in one burst once the queue has run dry.
 */
const MAX_QUEUED_AUTOPLAY = 10;
let refilling: Promise<void> | null = null;
/** The track the last top-up was seeded from, so one track isn't asked about twice. */
let autoplaySeed: string | null = null;
/** Seeds that gave nothing new, so the same empty radio isn't asked for again. */
const exhaustedSeeds = new Set<string>();

/**
 * [anySeed]: when the playing track's radio has nothing new left, seed from
 * the latest earlier track in the queue whose radio still might (the empty
 * queue watchdog, ensureAutoplay).
 */
function refillAutoplay(force = false, anySeed = false): Promise<void> {
  const { autoplay, repeat, queue, index } = usePlayer.getState();
  if (!autoplay || repeat !== 'off' || index < 0) return Promise.resolve();
  // A party's AutoPlay goes through the server (party/partySync.ts), never straight onto this queue.
  if (partyHooks?.inParty()) return Promise.resolve();
  const needed = MAX_QUEUED_AUTOPLAY - queue.slice(index + 1).filter((e) => e.tier === 'autoplay').length;
  if (needed <= 0) return Promise.resolve();
  // Seeded from the playing track (loadAutoplayForCurrentTrack), not the queue's tail.
  const playing = queue[index]?.track;
  let seed = playing;
  if (seed && exhaustedSeeds.has(seed.videoId) && anySeed) {
    seed = queue
      .slice(0, index)
      .reverse()
      .find((e) => !exhaustedSeeds.has(e.track.videoId))?.track;
  }
  if (!playing || !seed || exhaustedSeeds.has(seed.videoId)) return Promise.resolve();
  if (!force && autoplaySeed === seed.videoId) return Promise.resolve();
  autoplaySeed = seed.videoId;
  refilling ??= (async () => {
    try {
      const { fetchRadio } = await import('@/data/music/api');
      const { candidates, seedIsVideo } = await fetchRadio(seed.videoId);
      const current = usePlayer.getState();
      const extra = extendStation(
        current.queue.map((e) => e.track),
        candidates,
        needed,
        seedIsVideo,
      );
      if (!extra.length) {
        exhaustedSeeds.add(seed.videoId);
        return;
      }
      const source: QueueSource = { title: `${seed.title} Radio`, type: 'radio', id: `RDAMVM${seed.videoId}` };
      // Still on the same track? One that moved on gets its own top-up.
      if (current.queue[current.index]?.track.videoId !== playing.videoId || !current.autoplay) {
        autoplaySeed = null;
        return;
      }
      usePlayer.setState({ queue: [...current.queue, ...extra.map((t) => asEntry(t, 'autoplay', source))] });
      trackLog.i(`AutoPlay added ${extra.length} tracks from ${seed.title}'s radio`, seed.videoId);
    } catch (error) {
      trackLog.w(`AutoPlay couldn't load the radio: ${String(error)}`, seed.videoId);
      autoplaySeed = null;
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

/** How often an empty AutoPlay is asked for again while a track plays. */
const EMPTY_RETRY_MS = 15_000;
let lastEmptyRetry = 0;

/**
 * The watchdog for an AutoPlay that is on but has nothing after the playing
 * track. A top-up runs only when a track starts, so a radio that failed to
 * load (a network blip, the extension not ready yet), one dropped because the
 * track changed while it loaded, or a seed whose radio had nothing new left
 * the queue empty until the music stopped. Called as the track plays.
 */
function ensureAutoplay() {
  const { autoplay, repeat, queue, index, status } = usePlayer.getState();
  if (!autoplay || repeat !== 'off' || index < 0 || status !== 'playing' || partyHooks?.inParty()) return;
  if (index + 1 < queue.length || refilling) return;
  const now = Date.now();
  if (now - lastEmptyRetry < EMPTY_RETRY_MS) return;
  lastEmptyRetry = now;
  trackLog.i('AutoPlay is on but nothing is queued; asking for the radio again', queue[index]?.track.videoId ?? null);
  void refillAutoplay(true, true);
}

// ---- Crossfade ----------------------------------------------------------------------

/**
 * The fade is stepped by a timer, not requestAnimationFrame: Chrome stops
 * frames altogether in a background tab, or a window covered by another,
 * which is where music usually plays from. The new track then sat at volume
 * 0 under the old one's end, silent until the tab was looked at again.
 * Timers keep running there (at most a second apart), and each step works
 * the volumes out from the clock, so a late step only lands further along.
 */
const FADE_STEP_MS = 40;

let fade: { token: number; frame: number; pending: boolean } | null = null;

function cancelCrossfade() {
  // AutoMix's blend or preloaded next track goes the same way as a fade: the deck in front plays on.
  if (graph && (graph.dj.mixing || mixLoaded)) {
    mixLoaded = null;
    graph.dj.cancel();
    if (decks) silenceDeck(decks[1 - active]!);
  } else graph?.dj.cancel();
  if (!fade) return;
  clearTimeout(fade.frame);
  const wasPending = fade.pending;
  fade = null;
  if (!decks) return;
  // Whichever deck isn't in front stops; the one in front plays on at full volume.
  silenceDeck(decks[1 - active]!);
  decks[active]!.gain = 1;
  applyVolumes();
  if (wasPending) loadToken++;
}

/** Called as the track in front plays: within the crossfade length of its end, start the next one underneath. */
function maybeCrossfade() {
  const state = usePlayer.getState();
  if (
    !decks ||
    fade ||
    activeUpgradeCancel ||
    state.automix ||
    !state.crossfadeSec ||
    state.status !== 'playing' ||
    bitPerfectBypassActive()
  ) {
    return;
  }
  const front = decks[active]!;
  const remaining = front.audio.duration - front.audio.currentTime;
  if (!Number.isFinite(remaining) || remaining > state.crossfadeSec || remaining < 1) return;
  const plan = planNext(true);
  if (!plan || plan.kind !== 'index') return;

  const back = decks[1 - active]!;
  const entry = plan.queue[plan.index]!;
  const token = ++loadToken;
  fade = { token, frame: 0, pending: true };
  back.loadedTrackId = null;
  back.directUrlActive = false;
  back.gain = 0;
  applyVolumes();
  trackLog.i(`crossfading into the next track over ${Math.round(remaining)}s`, entry.track.videoId);

  back.engine
    .load(entry.track.videoId, { autoplay: true })
    .then((track) => {
      if (!fade || fade.token !== token || !decks) {
        silenceDeck(back);
        return;
      }
      fade.pending = false;
      const from = front;
      const to = back;
      to.loadedTrackId = entry.track.videoId;
      // The new track is the one playing now, as far as everything else knows.
      active = 1 - active;
      usePlayer.setState((s) => ({ queue: plan.queue, index: plan.index, deck: s.deck + 1, status: 'playing' }));
      applyTrack(track, entry.track);
      afterTrackStarted();

      const length = Math.max(0.5, Math.min(from.audio.duration - from.audio.currentTime, usePlayer.getState().crossfadeSec)) * 1000;
      const started = performance.now();
      const step = () => {
        if (!fade || fade.token !== token) return;
        const t = Math.min(1, (performance.now() - started) / length);
        // Equal-power: the sum stays level through the middle.
        from.gain = Math.cos((t * Math.PI) / 2);
        to.gain = Math.sin((t * Math.PI) / 2);
        applyVolumes();
        if (t < 1 && !from.audio.ended) fade.frame = window.setTimeout(step, FADE_STEP_MS);
        else {
          fade = null;
          to.gain = 1;
          from.gain = 1;
          silenceDeck(from);
          applyVolumes();
        }
      };
      step();
    })
    .catch((error: unknown) => {
      if (!fade || fade.token !== token) return;
      trackLog.w(`crossfade load failed: ${String(error)}; the next track starts when this one ends`, entry.track.videoId);
      fade = null;
      back.gain = 1;
      silenceDeck(back);
      applyVolumes();
      // If the track in front already ended while this loaded, move on now.
      if (front.audio.ended) void advance(true);
    });
}

function applyTrack(track: LoadedTrack, from?: Track) {
  const nowPlaying: NowPlaying = {
    videoId: track.videoId,
    // YouTube Music metadata (from the queue) beats the video's own title.
    title: from?.title || track.title,
    // Auto-generated YouTube channels are named "Artist - Topic".
    artist: (from && artistNames(from)) || track.author.replace(/ - Topic$/, ''),
    artworkUrl: from?.thumbnail ?? track.thumbnails[0]?.url ?? null,
    durationSec: track.durationSec || from?.durationSec || 0,
    streamInfo: `${track.format} via ${track.client}`,
    stream: { ...track.stream, client: track.client },
  };
  usePlayer.setState({ nowPlaying, error: null });
  updateMediaSession(nowPlaying);
  followVideo();
}

/** A music video's picture follows the deck in front (playback/youtube/videoDeck.ts, loaded with the engine). */
function followVideo() {
  const deck = decks?.[active];
  if (!deck) return;
  void import('@/playback/youtube/videoDeck').then((m) => m.followVideo(deck.engine, deck.audio));
}

const endedListeners = new Set<() => void>();
/** Called when the track in front plays to its end, before the queue moves on; a repeat-one loop included. */
export function onTrackEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => endedListeners.delete(listener);
}

/** The elements' own events are the source of truth for play state; only the deck owning the active track speaks. */
function bindElement(deck: Deck, n: number) {
  const element = deck.audio;
  const inFront = () => active === n;
  const ownsActiveTrack = () => {
    if (!inFront()) return false;
    if (holding) return true;
    const currentVideoId = usePlayer.getState().nowPlaying?.videoId ?? null;
    return currentVideoId !== null && deck.loadedTrackId === currentVideoId;
  };
  const set = (status: PlayerStatus) => {
    if (!ownsActiveTrack() || holding) return;
    const curStatus = usePlayer.getState().status;
    if (curStatus === 'loading') return;
    if (curStatus === 'error' && status !== 'playing') return;
    usePlayer.setState({ status });
  };
  element.addEventListener('playing', () => set('playing'));
  element.addEventListener('pause', () => {
    if (!element.ended) set('paused');
  });
  element.addEventListener('waiting', () => set('buffering'));
  element.addEventListener('ended', () => {
    if (!ownsActiveTrack() || holding) return;
    endedListeners.forEach((listener) => listener());
    if (fade?.pending) cancelCrossfade();
    if (graph?.dj.forceHandoff()) return;
    void advance(true).then(intent);
  });
  element.addEventListener('timeupdate', () => {
    if (!ownsActiveTrack()) return;
    maybeCrossfade();
    ensureAutoplay();
  });
  for (const event of ['durationchange', 'ratechange', 'seeked'] as const) {
    element.addEventListener(event, () => {
      if (ownsActiveTrack()) updatePositionState();
    });
  }
  element.addEventListener('play', () => {
    if (ownsActiveTrack() && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  element.addEventListener('pause', () => {
    if (ownsActiveTrack() && 'mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
}

// ---- Media Session (prompt §5.2 step 6) ---------------------------------------------

let handlersBound = false;

function updateMediaSession(track: NowPlaying | null) {
  if (!('mediaSession' in navigator)) return;
  const session = navigator.mediaSession;
  if (!track) {
    session.metadata = null;
    return;
  }
  session.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    artwork: track.artworkUrl
      ? [96, 256, 512].map((px) => ({ src: artworkAtPixels(track.artworkUrl!, px), sizes: `${px}x${px}` }))
      : [],
  });

  if (handlersBound) return;
  handlersBound = true;
  const handle = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Not every browser knows every action.
    }
  };
  const player = () => usePlayer.getState();
  // Through the store, so a party hears about them like any other press.
  // A loop mix holds the elements paused while it plays: that's playing, for the keys.
  const sounding = () => graph?.dj.loopMixing || getAudio()?.paused === false;
  handle('play', () => !sounding() && player().togglePlay());
  handle('pause', () => sounding() && player().togglePlay());
  handle('seekto', (details) => {
    if (details.seekTime !== undefined) player().seek(details.seekTime);
  });
  handle('seekbackward', (details) => player().seek((getAudio()?.currentTime ?? 0) - (details.seekOffset ?? 10)));
  handle('seekforward', (details) => player().seek((getAudio()?.currentTime ?? 0) + (details.seekOffset ?? 10)));
  handle('previoustrack', () => player().previous());
  handle('nexttrack', () => player().next());
}

function updatePositionState() {
  const audio = getAudio();
  if (!audio || !('mediaSession' in navigator) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {
    // Position past duration during a seek; the next event corrects it.
  }
}

// ---- The party's door (party/partySync.ts): moves the player, reports nothing ----------

const PARTY_SOURCE: QueueSource = { title: 'Listen Together', type: 'queue' };

export const partyPlayer = {
  /** Puts the party's running order on the player at [index], at [startSec]; starts it only when [play]. */
  load(tracks: Track[], tiers: ('user' | 'autoplay')[], index: number, startSec: number, play: boolean): Promise<void> {
    canonical = null;
    usePlayer.setState({ queue: tracks.map((t, i) => asEntry(t, tiers[i] ?? 'user', PARTY_SOURCE)) });
    return startAt(index, { startSec, autoplay: play });
  },
  play(): void {
    const state = usePlayer.getState();
    if (castHooks?.isConnected()) {
      castHooks.play();
      usePlayer.setState({ status: 'playing' });
      return;
    }
    if (state.nativeActive) {
      const head = getPlayhead();
      const currentSec = head?.sec ?? state.nativePlayhead?.positionSec ?? 0;
      const durSec = state.nativePlayhead?.durationSec ?? state.nowPlaying?.durationSec ?? 0;
      const activeRate = bitPerfectBypassActive() ? 1 : state.playbackRate;
      void desktopApi.audioResume().catch((e: unknown) => trackLog.w(`party native resume failed: ${String(e)}`));
      usePlayer.setState({
        status: 'playing',
        nativePlayhead: {
          trackId: state.nowPlaying?.videoId ?? state.nativePlayhead?.trackId ?? null,
          positionSec: currentSec,
          durationSec: durSec,
          playbackRate: activeRate,
          updatedAtMs: performance.now(),
          paused: false,
        },
      });
      return;
    }
    const audio = getAudio();
    if (audio?.paused) void audio.play().catch((e: unknown) => trackLog.w(`party play() refused: ${String(e)}`));
  },
  pause(): void {
    const state = usePlayer.getState();
    if (castHooks?.isConnected()) {
      castHooks.pause();
      usePlayer.setState({ status: 'paused' });
      return;
    }
    if (state.nativeActive) {
      cancelQualityUpgrade();
      const head = getPlayhead();
      const currentSec = head?.sec ?? state.nativePlayhead?.positionSec ?? 0;
      const durSec = state.nativePlayhead?.durationSec ?? state.nowPlaying?.durationSec ?? 0;
      const activeRate = bitPerfectBypassActive() ? 1 : state.playbackRate;
      void desktopApi.audioPause().catch(() => {});
      usePlayer.setState({
        status: 'paused',
        nativePlayhead: {
          trackId: state.nowPlaying?.videoId ?? state.nativePlayhead?.trackId ?? null,
          positionSec: currentSec,
          durationSec: durSec,
          playbackRate: activeRate,
          updatedAtMs: performance.now(),
          paused: true,
        },
      });
      return;
    }
    const audio = getAudio();
    if (audio && !audio.paused) {
      cancelCrossfade();
      audio.pause();
    }
  },
  seekTo(seconds: number): void {
    const state = usePlayer.getState();
    const clamped = Math.max(0, seconds);
    if (castHooks?.isConnected()) {
      castHooks.seek(clamped);
      return;
    }
    if (state.nativeActive) {
      cancelQualityUpgrade();
      const durSec = state.nativePlayhead?.durationSec ?? state.nowPlaying?.durationSec ?? clamped;
      const bounded = durSec > 0 ? Math.min(clamped, durSec) : clamped;
      void desktopApi.audioSeek(bounded).catch(() => {});
      usePlayer.setState({
        nativePlayhead: {
          trackId: state.nowPlaying?.videoId ?? state.nativePlayhead?.trackId ?? null,
          positionSec: bounded,
          durationSec: durSec,
          playbackRate: bitPerfectBypassActive() ? 1 : state.playbackRate,
          updatedAtMs: performance.now(),
          paused: state.status !== 'playing',
        },
      });
      return;
    }
    const audio = getAudio();
    if (!audio) return;
    cancelCrossfade();
    audio.currentTime = clamped;
    updatePositionState();
  },
  /** Replaces everything after the playing track; the playing track is left alone. */
  setUpcoming(tracks: Track[], tiers: ('user' | 'autoplay')[]): void {
    const { queue, index } = usePlayer.getState();
    if (index < 0) return;
    usePlayer.setState({ queue: [...queue.slice(0, index + 1), ...tracks.map((t, i) => asEntry(t, tiers[i] ?? 'user', PARTY_SOURCE))] });
  },
};

if (typeof window !== 'undefined') {
  usePlayer.subscribe((state, prev) => {
    if (
      state.queue !== prev.queue ||
      state.index !== prev.index ||
      state.nowPlaying?.videoId !== prev.nowPlaying?.videoId ||
      state.nowPlaying?.durationSec !== prev.nowPlaying?.durationSec ||
      state.status !== prev.status
    ) {
      schedulePlaybackSessionSave();
    }
  });
  window.addEventListener('pagehide', flushPlaybackSession);
  window.addEventListener('beforeunload', flushPlaybackSession);
  window.setInterval(() => {
    if (usePlayer.getState().status === 'playing') {
      flushPlaybackSession();
    }
  }, SESSION_PLAYING_TICK_MS);
}

if (initialSession.nowPlaying) {
  updateMediaSession(initialSession.nowPlaying);
}
