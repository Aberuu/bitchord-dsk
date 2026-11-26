import { useQuery } from '@tanstack/react-query';
import { AudioLines, Maximize2, Music2, Play, X } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { performBackNavigation } from '@/lib/navigationHistory';
import {
  BackwardIcon,
  ForwardIcon,
  PauseIcon,
  PlayIcon,
} from '@/components/icons/Transport';
import { ExplicitBadge } from '@/components/music/ExplicitBadge';
import { FavoriteButton } from '@/components/music/FavoriteButton';
import { TrackMenu } from '@/components/music/TrackMenu';
import type { Track } from '@/data/music/types';
import { statsApi, type RankedSong } from '@/desktop/statsApi';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { sizedArtwork } from '@/lib/artwork';
import { LyricsPanel } from '@/shell/LyricsPanel';
import { MeshBackdrop } from '@/shell/MeshBackdrop';
import { MixWindowHighlight } from '@/shell/NerdStats';
import { useScrubber } from '@/shell/useScrubber';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

function LyricsScrubber() {
  const { bar, elapsed, remaining, dragging, handlers } = useScrubber();
  return (
    <div className="group/scrub mt-1" data-dragging={dragging || undefined}>
      <div className="group/hit flex h-4 cursor-pointer touch-none items-center" {...handlers}>
        <div
          className="relative h-1.5 flex-1 overflow-hidden rounded-pill bg-white/22 transition-[height] duration-120 ease-in group-hover/hit:h-2 group-data-dragging/scrub:h-2"
          aria-hidden="true"
        >
          <MixWindowHighlight />
          <div
            ref={bar}
            className="relative size-full origin-left scale-x-(--progress) bg-white/85 transition-[background-color] duration-120 ease-in [--progress:0] group-hover/hit:bg-white"
          />
        </div>
      </div>
      <div className="mt-0.5 flex justify-between type-[500_11px/14px] tabular-nums text-white/60">
        <span ref={elapsed} />
        <span ref={remaining} />
      </div>
    </div>
  );
}

export default function LyricsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const track = usePlayer((s) => {
    const entry = s.queue[s.index]?.track;
    return entry && entry.videoId === s.nowPlaying?.videoId ? entry : null;
  });
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const hasNext = usePlayer(
    (s) => s.index + 1 < s.queue.length || s.repeat !== 'off' || (s.autoplay && s.index >= 0),
  );
  const { playTrack, togglePlay, next, previous } = usePlayer.getState();
  const closeSidePanel = useUi((s) => s.closeSidePanel);
  const setFullScreen = useUi((s) => s.setFullScreen);
  const setAudioOutputOpen = useUi((s) => s.setAudioOutputOpen);
  const pipeline = useAudioPipeline();

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
    const t: Track = {
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
    playTrack(t, { title: 'Library Top Songs', type: 'library', id: 'lyrics' });
  };

  const handleClose = () => {
    performBackNavigation(navigate, location, 'button');
  };

  return (
    <div className="px-(--body-gutter) pt-3 pb-4 max-sm:px-3">
      <div
        data-full-screen
        className="relative isolate flex h-[calc(100dvh-var(--title-bar-height,0px)-var(--player-pill-height,64px)-var(--player-bottom-offset,16px)-36px)] min-h-[540px] flex-col overflow-hidden rounded-[22px] border border-white/10 text-primary shadow-glass max-sm:h-[calc(100dvh-210px)]"
      >
        <MeshBackdrop artworkUrl={nowPlaying?.artworkUrl ?? fallbackArt} playing={playing} />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-1 bg-[radial-gradient(ellipse_at_top,rgba(0,0,0,0.16),rgba(0,0,0,0.52))]"
        />

        {/* Compact mobile-style top track bar matching Screenshots 6 & 7 */}
        <header className="mx-auto flex w-full max-w-[820px] items-center justify-between gap-3 px-6 pt-5 pb-2 max-sm:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {nowPlaying?.artworkUrl ? (
              <img
                src={sizedArtwork(nowPlaying.artworkUrl, 96)}
                alt=""
                width={44}
                height={44}
                referrerPolicy="no-referrer"
                className="size-11 flex-none rounded-[10px] object-cover shadow-sm"
              />
            ) : (
              <span className="grid size-11 flex-none place-items-center rounded-[10px] bg-white/14 text-white/80">
                <Music2 size={18} aria-hidden="true" />
              </span>
            )}
            <div className="flex min-w-0 flex-col">
              <div className="flex min-w-0 items-center gap-1">
                {track?.explicit && <ExplicitBadge size={12} />}
                <span className="truncate type-title-3-emphasized text-white">
                  {nowPlaying?.title ?? 'Synced Lyrics'}
                </span>
              </div>
              <span className="truncate type-callout text-white/65">
                {nowPlaying?.artist || 'Select a track to follow lyrics in real time'}
              </span>
            </div>
          </div>

          <div className="flex flex-none items-center gap-2">
            {nowPlaying && (
              <FavoriteButton
                videoId={nowPlaying.videoId}
                className="grid size-9 place-items-center rounded-full bg-white/14 text-white transition-colors hover:bg-white/24"
                size={17}
              />
            )}
            {track && (
              <TrackMenu
                track={track}
                className="grid size-9 place-items-center rounded-full bg-white/14 text-white transition-colors hover:bg-white/24"
                placement="below-end"
              />
            )}
            {nowPlaying && (
              <button
                type="button"
                onClick={() => setFullScreen(true)}
                aria-label="Open full-screen player"
                title="Open full-screen player"
                className="grid size-9 place-items-center rounded-full bg-white/14 text-white transition-colors hover:bg-white/24"
              >
                <Maximize2 size={15} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close lyrics"
              title="Close lyrics"
              className="grid size-9 place-items-center rounded-full bg-white/14 text-white transition-colors hover:bg-white/24"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        {/* Main synced lyrics body with floating Globe & Languages buttons + "Lyrics by ..." */}
        <div className="mx-auto flex min-h-0 w-full max-w-[820px] flex-1 flex-col px-6 pb-4 max-sm:px-4">
          <LyricsPanel variant="page" />

          {!nowPlaying && topSongs.length > 0 && (
            <div className="mx-auto mb-5 flex w-full max-w-[480px] flex-col items-center gap-2.5">
              <span className="type-caption-1 tracking-[0.08em] text-white/65 uppercase">
                Quick load from your listening history
              </span>
              <div className="flex flex-wrap justify-center gap-2">
                {topSongs.map((song) => (
                  <button
                    key={song.videoId}
                    type="button"
                    onClick={() => handleSelectSong(song)}
                    className="inline-flex items-center gap-2 rounded-pill border border-white/14 bg-black/30 px-3.5 py-1.5 type-callout-emphasized text-white backdrop-blur-md transition-colors hover:bg-black/45"
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

          {/* Integrated bottom scrubber + transport + output device trigger matching Screenshot 6 */}
          {nowPlaying && (
            <div className="mt-1 border-t border-white/10 pt-2">
              <LyricsScrubber />
              <div className="mt-1 flex items-center justify-between gap-4">
                <button
                  type="button"
                  onClick={() => setAudioOutputOpen(true)}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-pill bg-white/10 px-3 py-1.5 type-callout text-white/75 transition-colors hover:bg-white/18 hover:text-white"
                  aria-label="Audio output and pipeline"
                >
                  <AudioLines size={14} aria-hidden="true" />
                  <span className="max-w-[160px] truncate">{pipeline.activeDeviceName}</span>
                </button>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="Previous"
                    onClick={previous}
                    className="grid size-10 place-items-center rounded-full text-white transition-colors hover:bg-white/14"
                  >
                    <BackwardIcon size={28} />
                  </button>
                  <button
                    type="button"
                    aria-label={playing ? 'Pause' : 'Play'}
                    onClick={togglePlay}
                    className="grid size-11 place-items-center rounded-full text-white transition-colors hover:bg-white/14"
                  >
                    {playing ? <PauseIcon size={34} /> : <PlayIcon size={34} />}
                  </button>
                  <button
                    type="button"
                    aria-label="Next"
                    disabled={!hasNext}
                    onClick={next}
                    className="grid size-10 place-items-center rounded-full text-white transition-colors hover:bg-white/14 disabled:opacity-40"
                  >
                    <ForwardIcon size={28} />
                  </button>
                </div>

                <span className="hidden w-[160px] text-right type-caption-1 tabular-nums text-white/55 sm:inline-block">
                  {pipeline.shortSubtitle}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
