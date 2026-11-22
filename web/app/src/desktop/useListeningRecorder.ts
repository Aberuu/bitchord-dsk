import { useEffect, useRef } from 'react';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';
import { MAX_STEP_MS, playThresholdMs, statsApi } from './statsApi';

const TICK_INTERVAL_MS = 2_000;

export function useListeningRecorder(): void {
  const trackerRef = useRef<{
    videoId: string;
    lastSampleAt: number;
    playedThisTrack: number;
    playCounted: boolean;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = usePlayer.getState();
      const np = state.nowPlaying;
      if (state.status !== 'playing' || !np || !np.videoId) {
        if (trackerRef.current) {
          trackerRef.current = null;
          void statsApi.flush().catch(() => {});
        }
        return;
      }

      const now = Date.now();
      const current = trackerRef.current;
      if (!current || current.videoId !== np.videoId) {
        trackerRef.current = {
          videoId: np.videoId,
          lastSampleAt: now,
          playedThisTrack: 0,
          playCounted: false,
        };
        return;
      }

      const step = Math.max(0, Math.min(MAX_STEP_MS, now - current.lastSampleAt));
      current.lastSampleAt = now;
      if (step <= 0) return;

      current.playedThisTrack += step;
      const threshold = playThresholdMs(np.durationSec);
      const countsAsPlay = !current.playCounted && current.playedThisTrack >= threshold;
      if (countsAsPlay) {
        current.playCounted = true;
      }

      const queueEntry = state.queue[state.index]?.track;
      const matchesQueue = queueEntry?.videoId === np.videoId;
      const albumName = matchesQueue ? queueEntry.album?.name ?? null : null;
      const albumId = matchesQueue ? queueEntry.album?.id ?? null : null;
      const artistId = matchesQueue ? queueEntry.artists[0]?.id ?? null : null;

      void statsApi
        .recordSample({
          videoId: np.videoId,
          title: np.title,
          artist: np.artist,
          albumName,
          albumId,
          artistId,
          artworkUrl: np.artworkUrl,
          playedMs: step,
          countsAsPlay,
        })
        .then(() => {
          if (countsAsPlay) {
            void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats'] });
          }
        })
        .catch(() => {});
    }, TICK_INTERVAL_MS);

    const onBeforeUnload = () => {
      void statsApi.flush().catch(() => {});
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('beforeunload', onBeforeUnload);
      void statsApi.flush().catch(() => {});
    };
  }, []);
}
