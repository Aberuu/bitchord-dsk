import { useCast, getCastPlayhead } from '@/desktop/castStore';
import { resolveDirectAudioStream } from '@/playback/youtube/directStream';
import {
  getPlayhead,
  resumeLocalAfterCast,
  setCastHooks,
  silenceLocalOutputForCast,
  usePlayer,
} from '@/state/player';
import { desktopApi, isTauriDesktop, type CastDevice } from './tauriBridge';

async function resolveCastMediaForTrack(
  trackId: string,
  durationSecHint: number,
): Promise<{
  streamUrl: string | null;
  mimeType: string;
  durationSec: number;
}> {
  if (trackId.startsWith('local:')) {
    return { streamUrl: null, mimeType: 'audio/mp4', durationSec: durationSecHint };
  }

  const downloadedUrl = await desktopApi.downloadsMediaUrl(trackId).catch(() => null);
  if (downloadedUrl) {
    return { streamUrl: null, mimeType: 'audio/mp4', durationSec: durationSecHint };
  }

  const stream = await resolveDirectAudioStream(trackId);
  return {
    streamUrl: stream.url,
    mimeType: stream.mimeType,
    durationSec: durationSecHint > 0 ? durationSecHint : stream.durationSec,
  };
}

async function loadTrackOnActiveReceiver(
  device: CastDevice,
  opts: {
    trackId: string;
    title: string;
    artist: string;
    album: string | null;
    artworkUrl: string | null;
    durationSec: number;
    startSec: number;
    autoplay: boolean;
  },
) {
  const source = await resolveCastMediaForTrack(opts.trackId, opts.durationSec);
  const nextState = await desktopApi.castLoadMedia({
    device,
    trackId: opts.trackId,
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    artworkUrl: opts.artworkUrl,
    streamUrl: source.streamUrl,
    localFilePath: null,
    mimeType: source.mimeType,
    durationSec: source.durationSec,
    startSec: opts.startSec,
    autoplay: opts.autoplay,
  });
  useCast.getState().applySessionEvent(nextState);
  return nextState;
}

export function registerCastHooks(): () => void {
  setCastHooks({
    isConnected: () => useCast.getState().session.connected,
    getPlayhead: () => getCastPlayhead(),
    async loadTrack(opts) {
      const device = useCast.getState().session.device;
      if (!device) {
        throw new Error('No Cast receiver connected');
      }
      await loadTrackOnActiveReceiver(device, opts);
    },
    play() {
      const cur = useCast.getState().session;
      useCast.getState().applySessionEvent({ ...cur, status: 'playing' });
      void desktopApi.castPlay().catch(() => {});
    },
    pause() {
      const cur = useCast.getState().session;
      useCast.getState().applySessionEvent({ ...cur, status: 'paused' });
      void desktopApi.castPause().catch(() => {});
    },
    seek(seconds) {
      const cur = useCast.getState().session;
      useCast.getState().applySessionEvent({ ...cur, positionSec: seconds });
      void desktopApi.castSeek(seconds).catch(() => {});
    },
    setVolume(volume) {
      const cur = useCast.getState().session;
      useCast.getState().applySessionEvent({ ...cur, volume });
      void desktopApi.castSetVolume(volume).catch(() => {});
    },
  });
  return () => setCastHooks(null);
}

export async function castToDevice(device: CastDevice): Promise<void> {
  if (!isTauriDesktop()) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np) {
    throw new Error('Play a song first to cast it to your TV.');
  }
  const entry = player.queue[player.index]?.track;
  const album = entry?.videoId === np.videoId ? entry.album?.name ?? null : null;
  const head = getCastPlayhead() ?? getPlayhead();
  const startSec = head?.sec ?? 0;
  const wasPlaying = player.status === 'playing' || player.status === 'buffering';

  useCast.getState().setError(null);
  useCast.getState().applySessionEvent({
    ...useCast.getState().session,
    connected: false,
    connecting: true,
    device,
    trackId: np.videoId,
    status: 'loading',
  });

  try {
    await silenceLocalOutputForCast();
    await loadTrackOnActiveReceiver(device, {
      trackId: np.videoId,
      title: np.title,
      artist: np.artist,
      album,
      artworkUrl: np.artworkUrl,
      durationSec: np.durationSec,
      startSec,
      autoplay: wasPlaying,
    });
    usePlayer.setState({ status: wasPlaying ? 'playing' : 'paused', error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useCast.getState().applySessionEvent({
      ...useCast.getState().session,
      connected: false,
      connecting: false,
      status: 'error',
      error: message,
    });
    throw err;
  }
}

export async function stopCastingAndResumeLocal(): Promise<void> {
  const { session } = useCast.getState();
  const resumeSec = getCastPlayhead()?.sec ?? session.positionSec ?? 0;
  const wasPlaying = session.status === 'playing' || session.status === 'buffering';

  await desktopApi.castDisconnect().catch(() => {});
  useCast.getState().resetSession();
  await resumeLocalAfterCast(resumeSec, wasPlaying);
}
