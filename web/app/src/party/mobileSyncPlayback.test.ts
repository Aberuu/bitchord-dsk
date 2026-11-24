// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '@/config';
import { desktopApi } from '@/desktop/tauriBridge';
import { getPlayhead, partyPlayer, usePlayer } from '@/state/player';

describe('Mobile <-> Desktop unified playhead and party transport', () => {
  afterEach(() => {
    usePlayer.setState({
      nativeActive: false,
      nativePlayhead: null,
      status: 'idle',
      nowPlaying: null,
    });
    vi.restoreAllMocks();
  });

  it('defaults partyServerUrl to BitChord Android cloud server when env override is unset', () => {
    expect(config.partyServerUrl).toBe('https://bitchord-listen-together.onrender.com');
  });

  it('routes partyPlayer play/pause/seekTo through Native Audio Engine when nativeActive is true', () => {
    const pauseSpy = vi.spyOn(desktopApi, 'audioPause').mockResolvedValue(undefined as never);
    const resumeSpy = vi.spyOn(desktopApi, 'audioResume').mockResolvedValue(undefined as never);
    const seekSpy = vi.spyOn(desktopApi, 'audioSeek').mockResolvedValue(undefined as never);

    usePlayer.setState({
      nativeActive: true,
      status: 'playing',
      nowPlaying: {
        videoId: 'vid-sync-1',
        title: 'Hi-Res Track',
        artist: 'Artist',
        artworkUrl: null,
        durationSec: 240,
        streamInfo: null,
        stream: null,
      },
      nativePlayhead: {
        trackId: 'vid-sync-1',
        positionSec: 45,
        durationSec: 240,
        playbackRate: 1,
        updatedAtMs: performance.now(),
        paused: false,
      },
    });

    // Seek updates nativePlayhead and forwards to Rust audio_seek.
    partyPlayer.seekTo(92);
    expect(seekSpy).toHaveBeenCalledWith(92);
    expect(Math.round(getPlayhead()?.sec ?? 0)).toBe(92);

    // Pause pauses native audio and marks status paused.
    partyPlayer.pause();
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().status).toBe('paused');
    expect(usePlayer.getState().nativePlayhead?.paused).toBe(true);

    // Play resumes native audio and marks status playing.
    partyPlayer.play();
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().status).toBe('playing');
    expect(usePlayer.getState().nativePlayhead?.paused).toBe(false);
  });
});
