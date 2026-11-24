import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef } from 'react';
import { artworkAtPixels } from '@/lib/artwork';
import {
  getPlayhead,
  handleCastTrackEnded,
  handleNativeTrackEnded,
  onTrackEnded,
  syncNativePlayheadFromSnapshot,
  usePlayer,
} from '@/state/player';
import { useUi } from '@/state/ui';
import { queryClient } from '@/lib/queryClient';
import { registerCastHooks } from './castController';
import { useCast } from './castStore';
import { desktopApi, initDesktopBootstrap, isTauriDesktop } from './tauriBridge';
import { bindDesktopAudioHotplug, DESKTOP_AUDIO_SNAPSHOT_KEY } from './useDesktopAudioDevices';
import { useListeningRecorder } from './useListeningRecorder';

export function useDesktopIntegrations(): void {
  useListeningRecorder();
  const theme = useUi((s) => s.theme);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const status = usePlayer((s) => s.status);
  const nativeActive = usePlayer((s) => s.nativeActive);
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
    void useCast.getState().refreshSupport();
    const refreshCast = () => {
      void useCast.getState().refreshSupport();
    };
    window.addEventListener('online', refreshCast);
    window.addEventListener('offline', refreshCast);
    window.addEventListener('focus', refreshCast);

    if (!isTauriDesktop()) {
      return () => {
        window.removeEventListener('online', refreshCast);
        window.removeEventListener('offline', refreshCast);
        window.removeEventListener('focus', refreshCast);
      };
    }

    void initDesktopBootstrap().then((info) => {
      if (info) {
        useUi.getState().syncMinimizeToTrayFromDesktop(info.minimizeToTray);
      }
    });
    void desktopApi
      .castGetState()
      .then((castState) => {
        useCast.getState().applySessionEvent(castState);
      })
      .catch(() => {});

    const unbindHotplug = bindDesktopAudioHotplug();
    const unbindCastHooks = registerCastHooks();
    let unlistenMedia: (() => void) | undefined;
    let unlistenNativeEnd: (() => void) | undefined;
    let unlistenCastState: (() => void) | undefined;
    let unlistenCastEnd: (() => void) | undefined;
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
        if (active) unlistenMedia = fn;
        else fn();
      });
    void desktopApi
      .onNativeTrackEnded((trackId) => {
        if (active) handleNativeTrackEnded(trackId);
      })
      .then((fn) => {
        if (active) unlistenNativeEnd = fn;
        else fn();
      });
    void desktopApi
      .onCastState((castState) => {
        if (!active) return;
        useCast.getState().applySessionEvent(castState);
        if (castState.connected) {
          if (castState.status === 'playing') {
            usePlayer.setState({ status: 'playing', error: null });
          } else if (castState.status === 'paused') {
            usePlayer.setState({ status: 'paused' });
          } else if (castState.status === 'buffering' || castState.status === 'loading') {
            usePlayer.setState({ status: 'buffering' });
          }
        }
      })
      .then((fn) => {
        if (active) unlistenCastState = fn;
        else fn();
      });
    void desktopApi
      .onCastTrackEnded((trackId) => {
        if (active) handleCastTrackEnded(trackId);
      })
      .then((fn) => {
        if (active) unlistenCastEnd = fn;
        else fn();
      });
    return () => {
      active = false;
      window.removeEventListener('online', refreshCast);
      window.removeEventListener('offline', refreshCast);
      window.removeEventListener('focus', refreshCast);
      unbindHotplug();
      unbindCastHooks();
      unlistenMedia?.();
      unlistenNativeEnd?.();
      unlistenCastState?.();
      unlistenCastEnd?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriDesktop() || !nativeActive) return;
    const id = window.setInterval(() => {
      void desktopApi
        .audioSnapshot()
        .then((snap) => {
          queryClient.setQueryData(DESKTOP_AUDIO_SNAPSHOT_KEY, snap);
          syncNativePlayheadFromSnapshot(snap);
        })
        .catch(() => {});
    }, 1000);
    return () => window.clearInterval(id);
  }, [nativeActive]);

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

    if (status === 'playing' && scrobbleRef.current?.videoId !== nowPlaying.videoId) {
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
  }, [nowPlaying, queue, index, status]);

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
