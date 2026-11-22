import type { Track } from '@/data/music/types';
import { ytAuthSnapshot } from '@/extension/useYtAuth';
import { botguard } from '@/playback/youtube/botguard';
import { getInnertube, getSignedInnertube } from '@/playback/youtube/innertube';
import { resolvePlayer, UnplayableError, usesWebPo } from '@/playback/youtube/resolver';
import { desktopApi, type DownloadedTrack } from './tauriBridge';

export async function downloadTrackOffline(track: Track): Promise<DownloadedTrack> {
  if (track.videoId.startsWith('local:') || track.videoId.startsWith('spotify:')) {
    throw new Error('Only YouTube Music tracks can be downloaded for offline listening.');
  }
  let resolved;
  try {
    resolved = await resolvePlayer(await getInnertube(), track.videoId);
  } catch (error) {
    if (!(error instanceof UnplayableError && error.ageGated) || !ytAuthSnapshot().signedIn) throw error;
    resolved = await resolvePlayer(await getSignedInnertube(), track.videoId, new Set(), true);
  }

  const formats = (resolved.info.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher) && !f.is_drc,
  );
  const pick = (mime: string) =>
    formats.filter((f) => f.mime_type.startsWith(mime)).sort((a, b) => b.bitrate - a.bitrate)[0];
  // Prefer MP4/AAC for broad tagging & symphonia support, falling back to WebM/Opus.
  const best = pick('audio/mp4') ?? pick('audio/webm') ?? formats[0];
  if (!best) throw new Error('No direct downloadable audio stream was returned for this track.');

  const url = new URL(await best.decipher(resolved.yt.session.player));
  if (usesWebPo(resolved.client)) {
    const pot = await botguard.mint(track.videoId);
    if (pot) url.searchParams.set('pot', pot);
  }

  return desktopApi.downloadsStart({
    videoId: track.videoId,
    title: track.title,
    artist: track.artists.map((a) => a.name).join(', ') || 'Unknown Artist',
    album: track.album?.name ?? null,
    durationSec: track.durationSec ?? resolved.info.basic_info.duration ?? 0,
    artworkUrl: track.thumbnail,
    streamUrl: url.toString(),
    mimeType: best.mime_type,
    contentLength: best.content_length ?? null,
    bitrateKbps: best.bitrate ? Math.round(best.bitrate / 1000) : null,
  });
}
