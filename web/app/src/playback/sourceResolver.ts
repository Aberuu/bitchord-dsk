import {
  queries as buildMatchQueries,
  score as scoreMatch,
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
 * Picks the highest-scoring candidate matching [target] that obeys [toleranceSec].
 * When both target and candidate durations are positive, replacement streams whose
 * duration delta exceeds [toleranceSec] are rejected.
 */
export function pickMatchingCandidate(
  candidates: SourceCandidateTrack[],
  target: MatchTarget,
  toleranceSec: number,
): SourceCandidateTrack | null {
  let winner: SourceCandidateTrack | null = null;
  let winnerScore = -Infinity;

  for (const cand of candidates) {
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

  const sources = useSources.getState();
  if (!sources.loaded) {
    await sources.loadFromBackend().catch(() => {});
  }
  const { addons, jiosaavnEnabled, trackLengthToleranceSec } = useSources.getState();

  const candidateSourceIds: string[] = [];
  for (const addon of addons) {
    if (shouldTryAddon(addon, opts)) candidateSourceIds.push(addon.id);
  }
  if (jiosaavnEnabled) {
    candidateSourceIds.push('jiosaavn');
  }
  if (!candidateSourceIds.length) return null;

  const target = buildMatchTargetFromTrack(track);
  const queryList = buildMatchQueries(target);
  const primaryQuery = queryList[0] ?? `${track.title} ${target.artist ?? ''}`.trim();
  if (!primaryQuery) return null;

  for (const sourceId of candidateSourceIds) {
    for (const q of queryList.slice(0, 2)) {
      let candidates: SourceCandidateTrack[] = [];
      try {
        candidates = await desktopApi.sourcesSearchSource(
          sourceId,
          q,
          track.title,
          target.artist ?? null,
        );
      } catch {
        // Source unreachable or timed out: try next query or source cleanly.
        continue;
      }

      const best = pickMatchingCandidate(candidates, target, trackLengthToleranceSec);
      if (!best) continue;

      try {
        const payload = await desktopApi.sourcesResolveCandidate(best);
        return { payload, candidate: best };
      } catch {
        continue;
      }
    }
  }

  return null;
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
