import {
  artistNames,
  queries as buildMatchQueries,
  score as scoreMatch,
  sharesArtist,
  withinSeconds,
  type MatchCandidate,
  type MatchTarget,
} from '@/data/match/trackMatcher';
import type { Track } from '@/data/music/types';
import {
  desktopApi,
  isTauriDesktop,
  type AddonConfig,
  type AudioDeviceInfo,
  type OutputMode,
  type RegisteredSourceStreamPayload,
  type SourceCandidateTrack,
} from '@/desktop/tauriBridge';
import { isExclusiveOutputMode } from '@/desktop/bitPerfectMode';
import type { StreamingQuality } from '@/state/player';
import { addonHasLosslessCapability, useSources } from '@/state/sources';

export interface ReplacementResolveOptions {
  streamingQuality: StreamingQuality;
  outputMode: OutputMode;
  activeDevice: AudioDeviceInfo | null;
  shouldCancel?: () => boolean;
  maxQueriesPerSource?: number;
  timeoutMs?: number;
}

export interface ResolvedPlaybackSource {
  payload: RegisteredSourceStreamPayload;
  candidate: SourceCandidateTrack;
}

/**
 * Determines whether the current desktop output route is capable of carrying
 * lossless audio without lossy Bluetooth re-encoding.
 */
export function hasLosslessOutputCapability(
  outputMode: OutputMode,
  activeDevice: AudioDeviceInfo | null,
): boolean {
  if (isExclusiveOutputMode(outputMode)) return true;
  if (!activeDevice) return true;
  return activeDevice.kind !== 'bluetooth';
}

export function buildMatchTargetFromTrack(track: Track): MatchTarget {
  return {
    title: track.title,
    artist: track.artists.map((a) => a.name).filter(Boolean).join(', '),
    durationSec: track.durationSec ?? null,
    album: track.album?.name ?? null,
    isExplicit: track.explicit,
    isVideo: false,
  };
}

export function toMatchCandidate(candidate: SourceCandidateTrack): MatchCandidate {
  return {
    title: candidate.title,
    artist: candidate.artist,
    durationSec: candidate.durationSec,
    album: candidate.album,
    explicit: candidate.explicit,
  };
}

/**
 * Picks the highest-scoring candidate matching [target] that obeys [toleranceSec],
 * shares an artist credit when known, and rejects short preview clips.
 */
export function pickMatchingCandidate(
  candidates: SourceCandidateTrack[],
  target: MatchTarget,
  toleranceSec: number,
): SourceCandidateTrack | null {
  let winner: SourceCandidateTrack | null = null;
  let winnerScore = -Infinity;
  const wantedArtist = target.artist?.trim() ?? '';
  const mustShareArtist = artistNames(wantedArtist).length > 0;

  for (const cand of candidates) {
    if (
      target.durationSec != null &&
      target.durationSec > 45 &&
      cand.durationSec != null &&
      cand.durationSec > 0 &&
      cand.durationSec <= 35
    ) {
      continue;
    }

    if (
      mustShareArtist &&
      !sharesArtist(wantedArtist, cand.artist) &&
      !sharesArtist(wantedArtist, cand.title)
    ) {
      continue;
    }

    const matchCand = toMatchCandidate(cand);
    const points = scoreMatch(matchCand, target);
    if (points === null) continue;

    if (target.durationSec != null && target.durationSec > 0 && cand.durationSec != null && cand.durationSec > 0) {
      if (!withinSeconds(matchCand, target, toleranceSec)) continue;
    }

    if (points > winnerScore) {
      winnerScore = points;
      winner = cand;
    }
  }
  return winner;
}

function shouldTryAddon(addon: AddonConfig, opts: ReplacementResolveOptions): boolean {
  if (!addon.enabled) return false;
  if (addon.checkValidLossless && !hasLosslessOutputCapability(opts.outputMode, opts.activeDevice)) {
    return false;
  }
  if (opts.streamingQuality === 'normal' && addonHasLosslessCapability(addon)) {
    return false;
  }
  return true;
}

export function listEligibleSourceIds(opts: ReplacementResolveOptions): string[] {
  const { addons, jiosaavnEnabled } = useSources.getState();
  const ids: string[] = [];
  for (const addon of addons) {
    if (shouldTryAddon(addon, opts)) ids.push(addon.id);
  }
  if (jiosaavnEnabled) {
    ids.push('jiosaavn');
  }
  return ids;
}

function withOptionalTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Source lookup timed out')), timeoutMs);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Walks configured sources in priority order (enabled user Addons, then JioSaavn if opted in)
 * and resolves the first recording matching [track] within the configured tolerance.
 * Returns null when no higher-priority source yields a match, allowing fallback to YouTube Music.
 */
export async function resolveReplacementSource(
  track: Track,
  opts: ReplacementResolveOptions,
): Promise<ResolvedPlaybackSource | null> {
  if (!isTauriDesktop()) return null;
  if (opts.shouldCancel?.()) return null;

  const sources = useSources.getState();
  if (!sources.loaded) {
    await sources.loadFromBackend().catch(() => {});
  }
  if (opts.shouldCancel?.()) return null;

  const { trackLengthToleranceSec } = useSources.getState();
  const candidateSourceIds = listEligibleSourceIds(opts);
  if (!candidateSourceIds.length) return null;

  const target = buildMatchTargetFromTrack(track);
  const queryList = buildMatchQueries(target);
  const primaryQuery = queryList[0] ?? `${track.title} ${target.artist ?? ''}`.trim();
  if (!primaryQuery) return null;

  const maxQueries = Math.max(1, opts.maxQueriesPerSource ?? 2);
  const queriesToRun = queryList.length ? queryList.slice(0, maxQueries) : [primaryQuery];

  const runWalk = async (): Promise<ResolvedPlaybackSource | null> => {
    for (const sourceId of candidateSourceIds) {
      for (const q of queriesToRun) {
        if (opts.shouldCancel?.()) return null;
        let candidates: SourceCandidateTrack[] = [];
        try {
          candidates = await desktopApi.sourcesSearchSource(
            sourceId,
            q,
            track.title,
            target.artist ?? null,
          );
        } catch {
          continue;
        }
        if (opts.shouldCancel?.()) return null;

        const best = pickMatchingCandidate(candidates, target, trackLengthToleranceSec);
        if (!best) continue;

        try {
          const payload = await desktopApi.sourcesResolveCandidate(best);
          if (opts.shouldCancel?.()) return null;
          return { payload, candidate: best };
        } catch {
          continue;
        }
      }
    }
    return null;
  };

  return withOptionalTimeout(runWalk(), opts.timeoutMs).catch(() => null);
}

export function extensionForResolvedStream(payload: RegisteredSourceStreamPayload): string | null {
  const stream = payload.stream;
  const fmt = stream.format?.trim().toLowerCase();
  if (fmt) return fmt;
  const mime = stream.mimeType?.toLowerCase() ?? '';
  if (mime.includes('flac')) return 'flac';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('opus') || mime.includes('webm')) return 'webm';
  if (mime.includes('wav')) return 'wav';
  return null;
}
