import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef } from 'react';
import { artworkAtPixels } from '@/lib/artwork';
import { getPlayhead, onTrackEnded, usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { desktopApi, initDesktopBootstrap, isTauriDesktop } from './tauriBridge';
import { useListeningRecorder } from './useListeningRecorder';

export function useDesktopIntegrations(): void {
  useListeningRecorder();
  const theme = useUi((s) => s.theme);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const status = usePlayer((s) => s.status);
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);

  const scrobbleRef = useRef<{
    videoId: string;
    startedAtMs: number;
    playedMs: number;
    lastTickMs: number;
    submitted: boolean;
  } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }
    if (isTauriDesktop()) {
      void getCurrentWindow()
        .setTheme(theme === 'system' ? null : theme)
        .catch(() => {});
    }
  }, [theme]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    void initDesktopBootstrap();
    let unlisten: (() => void) | undefined;
    let active = true;
    void desktopApi
      .onMediaAction((ev) => {
        const p = usePlayer.getState();
        switch (ev.action) {
          case 'play':
            if (p.status !== 'playing') p.togglePlay();
            break;
          case 'pause':
          case 'stop':
            if (p.status === 'playing' || p.status === 'buffering') p.togglePlay();
            break;
          case 'toggle':
            p.togglePlay();
            break;
          case 'next':
            p.next();
            break;
          case 'previous':
            p.previous();
            break;
          case 'seek':
            if (typeof ev.positionMs === 'number') p.seek(ev.positionMs / 1000);
            break;
        }
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !nowPlaying) return;
    const entry = queue[index]?.track;
    const album = entry?.videoId === nowPlaying.videoId ? entry.album?.name ?? null : null;
    const coverUrl = nowPlaying.artworkUrl ? artworkAtPixels(nowPlaying.artworkUrl, 512) : null;

    void desktopApi
      .smtcUpdateMetadata({
        title: nowPlaying.title,
        artist: nowPlaying.artist,
        album,
        coverUrl,
        durationMs: nowPlaying.durationSec > 0 ? Math.round(nowPlaying.durationSec * 1000) : null,
      })
      .catch(() => {});

    if (scrobbleRef.current?.videoId !== nowPlaying.videoId) {
      const startedAtMs = Date.now();
      scrobbleRef.current = {
        videoId: nowPlaying.videoId,
        startedAtMs,
        playedMs: 0,
        lastTickMs: startedAtMs,
        submitted: false,
      };
      void desktopApi
        .scrobbleNowPlaying({
          title: nowPlaying.title,
          artist: nowPlaying.artist,
          album,
          durationMs: nowPlaying.durationSec > 0 ? Math.round(nowPlaying.durationSec * 1000) : null,
          positionMs: 0,
          startedAtMs,
        })
        .catch(() => {});
    }
  }, [nowPlaying, queue, index]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    const head = getPlayhead();
    void desktopApi
      .smtcUpdatePlayback({
        status,
        positionMs: head ? Math.round(head.sec * 1000) : null,
      })
      .catch(() => {});
  }, [status, nowPlaying?.videoId]);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    const timer = window.setInterval(() => {
      const state = usePlayer.getState();
      if (state.sleepTimerEndMs && Date.now() >= state.sleepTimerEndMs) {
        if (state.status === 'playing' || state.status === 'buffering') state.togglePlay();
        state.setSleepTimer(null);
      }

      const head = getPlayhead();
      if (state.status === 'playing' && head) {
        void desktopApi
          .smtcUpdatePlayback({ status: 'playing', positionMs: Math.round(head.sec * 1000) })
          .catch(() => {});
      }

      const tracker = scrobbleRef.current;
      const np = state.nowPlaying;
      if (!tracker || !np || tracker.videoId !== np.videoId || tracker.submitted) return;
      const now = Date.now();
      if (state.status === 'playing') {
        tracker.playedMs += Math.min(2000, now - tracker.lastTickMs);
      }
      tracker.lastTickMs = now;
      const durMs = np.durationSec * 1000;
      const thresholdMs = durMs > 30_000 ? Math.min(durMs / 2, 240_000) : 30_000;
      if (tracker.playedMs >= thresholdMs) {
        tracker.submitted = true;
        const entry = state.queue[state.index]?.track;
        const album = entry?.videoId === np.videoId ? entry.album?.name ?? null : null;
        void desktopApi
          .scrobbleSubmit({
            title: np.title,
            artist: np.artist,
            album,
            durationMs: durMs > 0 ? Math.round(durMs) : null,
            positionMs: head ? Math.round(head.sec * 1000) : null,
            startedAtMs: tracker.startedAtMs,
          })
          .catch(() => {});
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return onTrackEnded(() => {
      const state = usePlayer.getState();
      if (state.sleepAfterTrack) {
        state.setSleepTimer(null);
        window.setTimeout(() => {
          const cur = usePlayer.getState();
          if (cur.status === 'playing' || cur.status === 'buffering') cur.togglePlay();
        }, 50);
      }
    });
  }, []);
}
