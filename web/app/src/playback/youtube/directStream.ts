import { ytAuthSnapshot } from '@/extension/useYtAuth';
import { botguard } from './botguard';
import { getInnertube, getSignedInnertube } from './innertube';
import { resolvePlayer, UnplayableError, usesWebPo } from './resolver';

export interface DirectAudioStream {
  url: string;
  mimeType: string;
  bitrateKbps: number | null;
  contentLength: number | null;
  durationSec: number;
}

export async function resolveDirectAudioStream(videoId: string): Promise<DirectAudioStream> {
  let resolved;
  try {
    resolved = await resolvePlayer(await getInnertube(), videoId);
  } catch (error) {
    if (!(error instanceof UnplayableError && error.ageGated) || !ytAuthSnapshot().signedIn) {
      throw error;
    }
    resolved = await resolvePlayer(await getSignedInnertube(), videoId, new Set(), true);
  }

  const formats = (resolved.info.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video && (f.url || f.signature_cipher || f.cipher) && !f.is_drc,
  );
  const pick = (mime: string) =>
    formats.filter((f) => f.mime_type.startsWith(mime)).sort((a, b) => b.bitrate - a.bitrate)[0];
  // Prefer MP4/AAC for broad hardware decoder, receiver, and tagging compatibility.
  const best = pick('audio/mp4') ?? pick('audio/webm') ?? formats[0];
  if (!best) {
    throw new Error('No direct streamable audio format was returned for this track.');
  }

  const url = new URL(await best.decipher(resolved.yt.session.player));
  if (usesWebPo(resolved.client)) {
    const pot = await botguard.mint(videoId);
    if (pot) url.searchParams.set('pot', pot);
  }

  return {
    url: url.toString(),
    mimeType: best.mime_type,
    bitrateKbps: best.bitrate ? Math.round(best.bitrate / 1000) : null,
    contentLength: best.content_length ?? null,
    durationSec: resolved.info.basic_info.duration ?? 0,
  };
}
