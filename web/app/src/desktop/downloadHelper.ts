import type { Track } from '@/data/music/types';
import { resolveDirectAudioStream } from '@/playback/youtube/directStream';
import { desktopApi, type DownloadedTrack } from './tauriBridge';

export async function downloadTrackOffline(track: Track): Promise<DownloadedTrack> {
  if (track.videoId.startsWith('local:') || track.videoId.startsWith('spotify:')) {
    throw new Error('Only YouTube Music tracks can be downloaded for offline listening.');
  }
  const stream = await resolveDirectAudioStream(track.videoId);

  return desktopApi.downloadsStart({
    videoId: track.videoId,
    title: track.title,
    artist: track.artists.map((a) => a.name).join(', ') || 'Unknown Artist',
    album: track.album?.name ?? null,
    durationSec: track.durationSec ?? stream.durationSec ?? 0,
    artworkUrl: track.thumbnail,
    streamUrl: stream.url,
    mimeType: stream.mimeType,
    contentLength: stream.contentLength,
    bitrateKbps: stream.bitrateKbps,
  });
}
