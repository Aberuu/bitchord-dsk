import { useQuery } from '@tanstack/react-query';
import { Maximize2, Music2, Play, X } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { Track } from '@/data/music/types';
import { statsApi, type RankedSong } from '@/desktop/statsApi';
import { sizedArtwork } from '@/lib/artwork';
import { LyricsPanel } from '@/shell/LyricsPanel';
import { MeshBackdrop } from '@/shell/MeshBackdrop';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

export default function LyricsPage() {
  const navigate = useNavigate();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const playTrack = usePlayer((s) => s.playTrack);
  const closeSidePanel = useUi((s) => s.closeSidePanel);
  const setFullScreen = useUi((s) => s.setFullScreen);

  useEffect(() => {
    closeSidePanel();
  }, [closeSidePanel]);

  const statsQuery = useQuery({
    queryKey: ['desktop', 'stats', 'all_time'],
    queryFn: () => statsApi.getSummary('all_time'),
    enabled: !nowPlaying,
  });

  const topSongs = statsQuery.data?.songs.slice(0, 4) ?? [];
  const fallbackArt = topSongs[0]?.artworkUrl ?? null;

  const handleSelectSong = (song: RankedSong) => {
    const track: Track = {
      videoId: song.videoId,
      title: song.title,
      artists: song.artist ? [{ name: song.artist, id: song.artistId }] : [],
      album: song.albumName ? { name: song.albumName, id: song.albumId } : null,
      durationSec: Math.max(0, Math.round(song.ms / Math.max(1, song.plays) / 1000)),
      thumbnail: song.artworkUrl,
      explicit: false,
      index: null,
      plays: null,
    };
    playTrack(track, { title: 'Library Top Songs', type: 'library', id: 'lyrics' });
  };

  const handleClose = () => {
    if (window.history.length > 1) {
      void navigate(-1);
    } else {
      void navigate('/home');
    }
  };

  const toolbarActions = (
    <>
      {nowPlaying && (
        <button
          type="button"
          onClick={() => setFullScreen(true)}
          className="grid size-7 place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-primary"
          aria-label="Open full-screen player"
          title="Open full-screen player"
        >
          <Maximize2 size={14} />
        </button>
      )}
      <button
        type="button"
        onClick={handleClose}
        className="grid size-7 place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-primary"
        aria-label="Close lyrics"
        title="Close lyrics"
      >
        <X size={15} />
      </button>
    </>
  );

  return (
    <div className="px-(--body-gutter) pt-3 pb-4">
      <div
        data-full-screen
        className="relative isolate flex h-[calc(100dvh-var(--title-bar-height,0px)-var(--player-pill-height,64px)-var(--player-bottom-offset,16px)-36px)] min-h-[520px] flex-col overflow-hidden rounded-[18px] border border-white/10 text-primary shadow-glass"
      >
        <MeshBackdrop artworkUrl={nowPlaying?.artworkUrl ?? fallbackArt} playing={playing} />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-1 bg-[radial-gradient(ellipse_at_top,rgba(0,0,0,0.16),rgba(0,0,0,0.48))]"
        />

        {nowPlaying && (
          <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-1 max-sm:px-4">
            <div className="flex min-w-0 items-center gap-3 rounded-pill border border-white/12 bg-black/24 py-1.5 pr-4 pl-2 backdrop-blur-md">
              {nowPlaying.artworkUrl ? (
                <img
                  src={sizedArtwork(nowPlaying.artworkUrl, 96)}
                  alt=""
                  width={34}
                  height={34}
                  referrerPolicy="no-referrer"
                  className="size-[34px] flex-none rounded-[8px] object-cover"
                />
              ) : (
                <span className="grid size-[34px] flex-none place-items-center rounded-[8px] bg-white/12 text-secondary">
                  <Music2 size={16} aria-hidden="true" />
                </span>
              )}
              <div className="flex min-w-0 flex-col">
                <span className="truncate type-callout-emphasized text-primary">{nowPlaying.title}</span>
                {nowPlaying.artist && (
                  <span className="truncate type-caption-1 text-secondary">{nowPlaying.artist}</span>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mx-auto flex min-h-0 w-full max-w-[920px] flex-1 flex-col px-8 pt-4 pb-6 max-sm:px-4">
          <LyricsPanel variant="page" toolbarActions={toolbarActions} />

          {!nowPlaying && topSongs.length > 0 && (
            <div className="mx-auto mb-8 flex w-full max-w-[460px] flex-col items-center gap-2.5">
              <span className="type-caption-1 tracking-[0.08em] text-secondary uppercase">
                Quick load from your listening history
              </span>
              <div className="flex flex-wrap justify-center gap-2">
                {topSongs.map((song) => (
                  <button
                    key={song.videoId}
                    type="button"
                    onClick={() => handleSelectSong(song)}
                    className="inline-flex items-center gap-2 rounded-pill border border-white/14 bg-black/30 px-3.5 py-1.5 type-callout-emphasized text-primary backdrop-blur-md transition-colors hover:bg-black/45"
                  >
                    <Play size={12} fill="currentColor" aria-hidden="true" />
                    <span className="max-w-[210px] truncate">
                      {song.title}
                      {song.artist ? ` · ${song.artist}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
