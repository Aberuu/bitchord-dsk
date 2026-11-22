import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriDesktop } from './tauriBridge';

export type ReplayPeriod = 'this_week' | 'this_month' | 'this_year' | 'all_time';
export type ReplayFocus = 'minutes' | 'songs' | 'artists' | 'albums';

export interface ListeningSampleInput {
  videoId: string;
  title: string;
  artist: string;
  albumName?: string | null;
  albumId?: string | null;
  artistId?: string | null;
  artworkUrl?: string | null;
  playedMs: number;
  countsAsPlay: boolean;
}

export interface RankedSong {
  videoId: string;
  title: string;
  artist: string;
  albumName: string | null;
  albumId: string | null;
  artistId: string | null;
  artworkUrl: string | null;
  ms: number;
  plays: number;
}

export interface RankedEntry {
  title: string;
  subtitle: string | null;
  artworkUrl: string | null;
  browseId: string | null;
  ms: number;
  plays: number;
}

export interface ReplaySummary {
  period: ReplayPeriod;
  label: string;
  totalMs: number;
  totalPlays: number;
  songs: RankedSong[];
  artists: RankedEntry[];
  albums: RankedEntry[];
  hourOfDay: number[];
  peakHour: number | null;
  busiestDay: string | null;
  busiestDayMs: number;
  distinctSongs: number;
  distinctArtists: number;
  distinctAlbums: number;
  since: string | null;
  memberSince: string | null;
}

export interface BackupSummary {
  months: number;
  tracks: number;
  fromVersion: string;
  exportedAt: string;
}

export interface ReplayHeroCard {
  id: ReplayFocus;
  label: string;
  value: string;
  detail: string | null;
  artworkUrl: string | null;
  focus: ReplayFocus;
}

export const REPLAY_PERIODS: { id: ReplayPeriod; tab: string; chip: string }[] = [
  { id: 'this_week', tab: 'Weekly', chip: 'This week' },
  { id: 'this_month', tab: 'Monthly', chip: 'This month' },
  { id: 'this_year', tab: 'Yearly', chip: 'This year' },
  { id: 'all_time', tab: 'Lifetime', chip: 'All time' },
];

const CREDIT_SPLIT = /\s*,\s*|\s+&\s+|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+/i;

export const MAX_STEP_MS = 8_000;
export const PLAY_FLOOR_MS = 30_000;
export const PLAY_CEILING_MS = 4 * 60 * 1000;

export function playThresholdMs(durationSec: number): number {
  const durationMs = durationSec * 1000;
  if (durationMs > 0) {
    return Math.max(PLAY_FLOOR_MS, Math.min(Math.floor(durationMs / 2), PLAY_CEILING_MS));
  }
  return PLAY_FLOOR_MS;
}

export function primaryArtist(credit: string): string | null {
  const first = credit
    .split(CREDIT_SPLIT)
    .map((p) => p.trim())
    .find((p) => p.length > 0);
  return first ?? null;
}

export function formatGrouped(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString('en-US');
}

export function formatMinutes(ms: number): string {
  return formatGrouped(Math.floor(ms / 60_000));
}

export function formatListening(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1 && ms > 0) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }
  return `${formatGrouped(minutes)} min`;
}

export function formatPlays(count: number): string {
  return count === 1 ? '1 play' : `${formatGrouped(count)} plays`;
}

export function formatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return 'midnight';
  if (h === 12) return 'midday';
  if (h < 12) return `${h} am`;
  return `${h - 12} pm`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatDay(iso: string): string {
  const parts = iso.split('-').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return iso;
  const [, month, day] = parts;
  const name = MONTH_NAMES[(month ?? 1) - 1];
  return name ? `${day} ${name}` : iso;
}

export function formatMemberSince(monthKey: string | null | undefined): string | null {
  if (!monthKey) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey.trim());
  if (!match) return null;
  const year = Number.parseInt(match[1]!, 10) % 100;
  const month = Number.parseInt(match[2]!, 10);
  if (month < 1 || month > 12) return null;
  return `${String(month).padStart(2, '0')}/${String(year).padStart(2, '0')}`;
}

export function buildReplayCards(summary: ReplaySummary | null | undefined): ReplayHeroCard[] {
  if (!summary || summary.songs.length === 0) return [];
  const cards: ReplayHeroCard[] = [
    {
      id: 'minutes',
      label: 'Minutes listened',
      value: formatMinutes(summary.totalMs),
      detail: `${formatPlays(summary.totalPlays)} · ${summary.label}`,
      artworkUrl: summary.songs[0]?.artworkUrl ?? null,
      focus: 'minutes',
    },
  ];

  const topSong = summary.songs[0];
  if (topSong) {
    cards.push({
      id: 'songs',
      label: 'Top song',
      value: topSong.title,
      detail: [topSong.artist, formatPlays(topSong.plays)].filter(Boolean).join(' · '),
      artworkUrl: topSong.artworkUrl,
      focus: 'songs',
    });
  }

  const topArtist = summary.artists[0];
  if (topArtist) {
    cards.push({
      id: 'artists',
      label: 'Top artist',
      value: topArtist.title,
      detail: `${formatListening(topArtist.ms)} · ${formatPlays(topArtist.plays)}`,
      artworkUrl: topArtist.artworkUrl,
      focus: 'artists',
    });
  }

  const topAlbum = summary.albums[0];
  if (topAlbum) {
    cards.push({
      id: 'albums',
      label: 'Top album',
      value: topAlbum.title,
      detail: [topAlbum.subtitle, formatListening(topAlbum.ms)].filter(Boolean).join(' · '),
      artworkUrl: topAlbum.artworkUrl,
      focus: 'albums',
    });
  }

  return cards;
}

// Browser preview fallback storage so UI tests and standalone preview work identically to Tauri.
interface StoredDayStats {
  ms?: number;
  plays?: number;
}

interface StoredTrackEntry {
  id: string;
  title?: string;
  artist?: string;
  album?: string | null;
  albumId?: string | null;
  artistId?: string | null;
  art?: string | null;
  ms?: number;
  plays?: number;
  last?: number;
  days?: Record<string, StoredDayStats>;
}

interface StoredNameEntry {
  name?: string;
  sub?: string | null;
  art?: string | null;
  id?: string | null;
  ms?: number;
  plays?: number;
  days?: Record<string, StoredDayStats>;
}

interface StoredBucket {
  version?: number;
  month: string;
  tracks?: StoredTrackEntry[];
  artists?: StoredNameEntry[];
  albums?: StoredNameEntry[];
  hours?: number[];
  days?: Record<string, number>;
}

const LOCAL_STORAGE_KEY = 'bitchord:listening-buckets:v1';
const localListeners = new Set<() => void>();

function readLocalBuckets(): StoredBucket[] {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredBucket[]) : [];
  } catch {
    return [];
  }
}

function writeLocalBuckets(buckets: StoredBucket[]): void {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(buckets));
  } catch {
    // Quota exceeded or disabled storage in headless mode leaves memory state intact.
  }
  localListeners.forEach((fn) => fn());
}

function currentMonthAndDay(): { monthKey: string; dayKey: string; dayNum: string; hour: number; year: number; month: number } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const dayKey = `${monthKey}-${String(day).padStart(2, '0')}`;
  return { monthKey, dayKey, dayNum: String(day), hour: now.getHours(), year, month };
}

function recordLocalSample(sample: ListeningSampleInput): void {
  if (!sample.videoId.trim() || (sample.playedMs <= 0 && !sample.countsAsPlay)) return;
  const { monthKey, dayKey, dayNum, hour } = currentMonthAndDay();
  const buckets = readLocalBuckets();
  let bucket = buckets.find((b) => b.month === monthKey);
  if (!bucket) {
    bucket = { version: 1, month: monthKey, tracks: [], artists: [], albums: [], hours: Array.from({ length: 24 }, () => 0), days: {} };
    buckets.push(bucket);
  }
  bucket.tracks ??= [];
  bucket.artists ??= [];
  bucket.albums ??= [];
  bucket.hours ??= Array.from({ length: 24 }, () => 0);
  bucket.days ??= {};

  const playedMs = Math.max(0, sample.playedMs);
  let track = bucket.tracks.find((t) => t.id === sample.videoId);
  if (!track) {
    track = {
      id: sample.videoId,
      title: sample.title,
      artist: sample.artist,
      album: sample.albumName ?? null,
      albumId: sample.albumId ?? null,
      artistId: sample.artistId ?? null,
      art: sample.artworkUrl ?? null,
      ms: 0,
      plays: 0,
      last: Date.now(),
      days: {},
    };
    bucket.tracks.push(track);
  }
  track.ms = (track.ms ?? 0) + playedMs;
  track.last = Date.now();
  track.album ??= sample.albumName ?? null;
  track.albumId ??= sample.albumId ?? null;
  track.artistId ??= sample.artistId ?? null;
  track.art ??= sample.artworkUrl ?? null;
  if (sample.countsAsPlay) track.plays = (track.plays ?? 0) + 1;
  track.days ??= {};
  const td = (track.days[dayKey] ??= { ms: 0, plays: 0 });
  td.ms = (td.ms ?? 0) + playedMs;
  if (sample.countsAsPlay) td.plays = (td.plays ?? 0) + 1;

  const lead = primaryArtist(sample.artist);
  if (lead) {
    let artist = bucket.artists.find((a) => (a.name ?? '').toLowerCase() === lead.toLowerCase());
    if (!artist) {
      artist = { name: lead, art: sample.artworkUrl ?? null, id: sample.artistId ?? null, ms: 0, plays: 0, days: {} };
      bucket.artists.push(artist);
    }
    artist.ms = (artist.ms ?? 0) + playedMs;
    if (sample.countsAsPlay) artist.plays = (artist.plays ?? 0) + 1;
    artist.art ??= sample.artworkUrl ?? null;
    artist.id ??= sample.artistId ?? null;
    artist.days ??= {};
    const ad = (artist.days[dayKey] ??= { ms: 0, plays: 0 });
    ad.ms = (ad.ms ?? 0) + playedMs;
    if (sample.countsAsPlay) ad.plays = (ad.plays ?? 0) + 1;
  }

  const albumName = sample.albumName?.trim();
  if (albumName) {
    let album = bucket.albums.find(
      (al) => (al.name ?? '').toLowerCase() === albumName.toLowerCase() && (al.sub ?? '').toLowerCase() === sample.artist.toLowerCase(),
    );
    if (!album) {
      album = { name: albumName, sub: sample.artist, art: sample.artworkUrl ?? null, id: sample.albumId ?? null, ms: 0, plays: 0, days: {} };
      bucket.albums.push(album);
    }
    album.ms = (album.ms ?? 0) + playedMs;
    if (sample.countsAsPlay) album.plays = (album.plays ?? 0) + 1;
    album.art ??= sample.artworkUrl ?? null;
    album.id ??= sample.albumId ?? null;
    album.days ??= {};
    const ald = (album.days[dayKey] ??= { ms: 0, plays: 0 });
    ald.ms = (ald.ms ?? 0) + playedMs;
    if (sample.countsAsPlay) ald.plays = (ald.plays ?? 0) + 1;
  }

  bucket.hours[hour] = (bucket.hours[hour] ?? 0) + playedMs;
  bucket.days[dayNum] = (bucket.days[dayNum] ?? 0) + playedMs;
  writeLocalBuckets(buckets);
}

function computeLocalSummary(period: ReplayPeriod): ReplaySummary {
  const { monthKey, year, month } = currentMonthAndDay();
  const buckets = readLocalBuckets().sort((a, b) => a.month.localeCompare(b.month));
  const earliestAllTime = buckets[0]?.month ?? null;
  const memberSince = formatMemberSince(earliestAllTime);

  const filtered = buckets.filter((b) => {
    if (period === 'all_time') return true;
    if (period === 'this_month' || period === 'this_week') return b.month === monthKey;
    if (period === 'this_year') return b.month.startsWith(`${year}-`);
    return true;
  });

  const songsMap = new Map<string, RankedSong>();
  const artistsMap = new Map<string, RankedEntry>();
  const albumsMap = new Map<string, RankedEntry>();
  const hours = Array.from({ length: 24 }, () => 0);
  const daysMap = new Map<string, number>();

  for (const b of filtered) {
    for (const t of b.tracks ?? []) {
      const existing = songsMap.get(t.id);
      if (existing) {
        existing.ms += t.ms ?? 0;
        existing.plays += t.plays ?? 0;
        existing.albumName ??= t.album ?? null;
        existing.albumId ??= t.albumId ?? null;
        existing.artistId ??= t.artistId ?? null;
        existing.artworkUrl ??= t.art ?? null;
      } else {
        songsMap.set(t.id, {
          videoId: t.id,
          title: t.title ?? '',
          artist: t.artist ?? '',
          albumName: t.album ?? null,
          albumId: t.albumId ?? null,
          artistId: t.artistId ?? null,
          artworkUrl: t.art ?? null,
          ms: t.ms ?? 0,
          plays: t.plays ?? 0,
        });
      }
    }
    for (const a of b.artists ?? []) {
      const lead = primaryArtist(a.name ?? '') ?? a.name ?? '';
      if (!lead) continue;
      const k = lead.toLowerCase();
      const existing = artistsMap.get(k);
      if (existing) {
        existing.ms += a.ms ?? 0;
        existing.plays += a.plays ?? 0;
        existing.artworkUrl ??= a.art ?? null;
        existing.browseId ??= a.id ?? null;
      } else {
        artistsMap.set(k, {
          title: lead,
          subtitle: a.sub ?? null,
          artworkUrl: a.art ?? null,
          browseId: a.id ?? null,
          ms: a.ms ?? 0,
          plays: a.plays ?? 0,
        });
      }
    }
    for (const al of b.albums ?? []) {
      const name = (al.name ?? '').trim();
      if (!name) continue;
      const k = `${name.toLowerCase()}\u001f${(al.sub ?? '').trim().toLowerCase()}`;
      const existing = albumsMap.get(k);
      if (existing) {
        existing.ms += al.ms ?? 0;
        existing.plays += al.plays ?? 0;
        existing.artworkUrl ??= al.art ?? null;
        existing.browseId ??= al.id ?? null;
      } else {
        albumsMap.set(k, {
          title: name,
          subtitle: al.sub ?? null,
          artworkUrl: al.art ?? null,
          browseId: al.id ?? null,
          ms: al.ms ?? 0,
          plays: al.plays ?? 0,
        });
      }
    }
    (b.hours ?? []).slice(0, 24).forEach((val, idx) => {
      hours[idx] = (hours[idx] ?? 0) + val;
    });
    for (const [d, ms] of Object.entries(b.days ?? {})) {
      const dayIso = `${b.month}-${String(d).padStart(2, '0')}`;
      daysMap.set(dayIso, (daysMap.get(dayIso) ?? 0) + ms);
    }
  }

  const songs = [...songsMap.values()].filter((s) => s.ms > 0 || s.plays > 0).sort((a, b) => b.ms - a.ms || b.plays - a.plays);
  const artists = [...artistsMap.values()].filter((a) => a.ms > 0 || a.plays > 0).sort((a, b) => b.ms - a.ms || b.plays - a.plays);
  const albums = [...albumsMap.values()].filter((a) => a.ms > 0 || a.plays > 0).sort((a, b) => b.ms - a.ms || b.plays - a.plays);

  const totalMs = songs.reduce((acc, s) => acc + s.ms, 0);
  const totalPlays = songs.reduce((acc, s) => acc + s.plays, 0);

  let busiestDay: string | null = null;
  let busiestDayMs = 0;
  for (const [d, ms] of daysMap.entries()) {
    if (ms > busiestDayMs) {
      busiestDay = d;
      busiestDayMs = ms;
    }
  }

  let peakHour: number | null = null;
  let peakHourMs = 0;
  hours.forEach((ms, idx) => {
    if (ms > peakHourMs) {
      peakHour = idx;
      peakHourMs = ms;
    }
  });

  const label =
    period === 'this_week'
      ? 'This week'
      : period === 'this_month'
        ? `${MONTH_NAMES[month - 1]} ${year}`
        : period === 'this_year'
          ? String(year)
          : 'All time';

  return {
    period,
    label,
    totalMs,
    totalPlays,
    songs,
    artists,
    albums,
    hourOfDay: hours,
    peakHour,
    busiestDay,
    busiestDayMs,
    distinctSongs: songs.length,
    distinctArtists: artists.length,
    distinctAlbums: albums.length,
    since: filtered[0]?.month ?? earliestAllTime,
    memberSince,
  };
}

export function parseAndValidateBackupJson(rawJson: string): { buckets: StoredBucket[]; fromVersion: string; exportedAt: string } {
  const trimmed = rawJson.trim();
  if (!trimmed) throw new Error('Backup file is empty');
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) {
    const valid = (parsed as StoredBucket[]).filter((b) => typeof b?.month === 'string' && /^\d{4}-\d{2}$/.test(b.month));
    if (!valid.length) throw new Error('No valid YYYY-MM listening months found');
    return { buckets: valid, fromVersion: 'buckets', exportedAt: '' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.month === 'string' && Array.isArray(obj.tracks)) {
    return { buckets: [obj as unknown as StoredBucket], fromVersion: 'month-bucket', exportedAt: '' };
  }
  if (obj.app && obj.app !== 'bitchord') {
    throw new Error(`That backup is from another app (${String(obj.app)})`);
  }
  if (typeof obj.version === 'number' && obj.version > 1) {
    throw new Error(`That backup was written by a newer schema version (${obj.version})`);
  }
  const list = Array.isArray(obj.listening) ? (obj.listening as StoredBucket[]) : [];
  const valid = list.filter((b) => typeof b?.month === 'string' && /^\d{4}-\d{2}$/.test(b.month));
  if (!valid.length) throw new Error('No valid YYYY-MM listening months found in that backup file');
  return {
    buckets: valid,
    fromVersion: typeof obj.versionName === 'string' ? obj.versionName : '',
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
  };
}

export const statsApi = {
  recordSample: async (sample: ListeningSampleInput): Promise<void> => {
    if (isTauriDesktop()) {
      await invoke<void>('stats_record_sample', { sample });
      return;
    }
    recordLocalSample(sample);
  },

  flush: async (): Promise<void> => {
    if (isTauriDesktop()) {
      await invoke<void>('stats_flush');
    }
  },

  getSummary: async (period: ReplayPeriod): Promise<ReplaySummary> => {
    if (isTauriDesktop()) {
      return invoke<ReplaySummary>('stats_get_summary', { period });
    }
    return computeLocalSummary(period);
  },

  exportBackupJson: async (): Promise<string> => {
    if (isTauriDesktop()) {
      return invoke<string>('stats_export_backup');
    }
    const buckets = readLocalBuckets();
    return JSON.stringify(
      {
        app: 'bitchord',
        version: 1,
        versionName: '0.1.0-desktop',
        exportedAt: new Date().toISOString(),
        settings: {},
        listening: buckets,
      },
      null,
      2,
    );
  },

  importBackupJson: async (rawJson: string): Promise<BackupSummary> => {
    if (isTauriDesktop()) {
      return invoke<BackupSummary>('stats_import_backup', { rawJson });
    }
    const { buckets, fromVersion, exportedAt } = parseAndValidateBackupJson(rawJson);
    writeLocalBuckets(buckets);
    const tracks = buckets.reduce((acc, b) => acc + (b.tracks?.length ?? 0), 0);
    return {
      months: buckets.length,
      tracks,
      fromVersion,
      exportedAt,
    };
  },

  saveFile: async (fileName: string, base64Bytes: string, mimeType: string): Promise<string> => {
    if (isTauriDesktop()) {
      return invoke<string>('replay_save_file', { fileName, base64Bytes });
    }
    const binary = atob(base64Bytes);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return `Downloaded ${fileName}`;
  },

  onUpdated: (listener: () => void): (() => void) => {
    if (isTauriDesktop()) {
      let active = true;
      let unlisten: (() => void) | null = null;
      void listen('stats://updated', () => {
        if (active) listener();
      }).then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
      return () => {
        active = false;
        unlisten?.();
      };
    }
    localListeners.add(listener);
    return () => {
      localListeners.delete(listener);
    };
  },
};
