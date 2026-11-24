import { Cast, Maximize, Minimize, Search, Volume1, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { LogoMark } from '@/components/icons/LogoMark';
import {
  BackwardIcon,
  ForwardIcon,
  LyricsActiveIcon,
  LyricsIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  UpNextIcon,
} from '@/components/icons/Transport';
import { ExplicitBadge } from '@/components/music/ExplicitBadge';
import { FavoriteButton } from '@/components/music/FavoriteButton';
import { SearchField } from '@/components/music/SearchField';
import { TrackMenu } from '@/components/music/TrackMenu';
import { albumHref } from '@/components/music/links';
import { MotionArtwork } from '@/components/music/MotionArtwork';
import { VideoSurface } from '@/components/music/VideoSurface';
import { useTrackMotion } from '@/data/apple/motionArt';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { useBitPerfectUi } from '@/desktop/useBitPerfectUi';
import { useCastSession, useCastSupport } from '@/desktop/useCastSupport';
import { sizedArtwork } from '@/lib/artwork';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';
import { useHasVideo, useVideo } from '@/state/video';
import { Credits, PageLink, pageLink } from './Lcd';
import { LyricsPanel } from './LyricsPanel';
import { MeshBackdrop } from './MeshBackdrop';
import { MixWindowHighlight, NerdStats } from './NerdStats';
import { albumPageFor } from './nowPlayingLinks';
import { UpNext } from './UpNext';
import { useScrubber } from './useScrubber';
import { VideoQuality } from './VideoQuality';

function useBrowserFullScreen(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('fullscreenchange', onChange);
      return () => document.removeEventListener('fullscreenchange', onChange);
    },
    () => document.fullscreenElement !== null,
  );
}

function Scrubber() {
  const { bar, elapsed, remaining, mixLabel, dragging, handlers } = useScrubber();
  return (
    <div className="group/scrub mt-3" data-dragging={dragging || undefined}>
      <div className="group/hit flex h-4 cursor-pointer touch-none items-center" {...handlers}>
        <div
          className="relative h-1.5 flex-1 overflow-hidden rounded-[999px] bg-white/22 transition-[height] duration-120 ease-in group-hover/hit:h-2 group-data-dragging/scrub:h-2"
          aria-hidden="true"
        >
          <MixWindowHighlight />
          <div
            ref={bar}
            className="relative size-full origin-left scale-x-(--progress) bg-white/85 transition-[background-color] duration-120 ease-in [--progress:0] group-hover/hit:bg-white group-data-dragging/scrub:bg-white"
          />
        </div>
      </div>
      <div className="relative mt-1 flex justify-between type-[500_11px/14px] tabular-nums text-white/60">
        <span ref={elapsed} />
        <span ref={mixLabel} className="pointer-events-none absolute inset-x-0 text-center text-white/80 opacity-0" aria-hidden="true">
          Mixing
        </span>
        <span ref={remaining} />
      </div>
    </div>
  );
}

const transportButton =
  'grid place-items-center rounded-full transition-[background-color,scale] duration-100 ease-in enabled:hover:bg-white/14 enabled:active:scale-90 disabled:opacity-40';
const toggle = `${transportButton} size-9 text-white/55 aria-pressed:text-white`;
const skip = `${transportButton} size-12 text-white`;

function Transport() {
  const hasTrack = usePlayer((s) => s.nowPlaying !== null);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const hasNext = usePlayer((s) => s.index + 1 < s.queue.length || s.repeat !== 'off' || (s.autoplay && s.index >= 0));
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const { togglePlay, next, previous, toggleShuffle, cycleRepeat } = usePlayer.getState();

  return (
    <div className="mx-auto mt-2.5 flex h-13 w-[min(100%,320px)] items-center justify-between">
      <button className={toggle} aria-label="Shuffle" aria-pressed={shuffle} onClick={toggleShuffle}>
        <ShuffleIcon size={28} />
      </button>
      <button className={skip} disabled={!hasTrack} aria-label="Previous" onClick={previous}>
        <BackwardIcon size={40} />
      </button>
      <button className={`${transportButton} size-14 text-white`} disabled={!hasTrack} aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
        {playing ? <PauseIcon size={48} /> : <PlayIcon size={48} />}
      </button>
      <button className={skip} disabled={!hasTrack || !hasNext} aria-label="Next" onClick={next}>
        <ForwardIcon size={40} />
      </button>
      <button
        className={toggle}
        aria-label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
        aria-pressed={repeat !== 'off'}
        onClick={cycleRepeat}
      >
        {repeat === 'one' ? <RepeatOneIcon size={28} /> : <RepeatIcon size={28} />}
      </button>
    </div>
  );
}

function HorizontalVolumeBar() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const { setVolume, toggleMute } = usePlayer.getState();
  const { lockVolume } = useBitPerfectUi();
  const level = muted ? 0 : volume;
  const displayLevel = lockVolume ? 1 : level;

  return (
    <div
      className={`mt-3 flex items-center gap-2.5 ${lockVolume ? 'opacity-40' : ''}`}
      aria-disabled={lockVolume || undefined}
      title={lockVolume ? 'Volume is bypassed in Bit-Perfect (WASAPI Exclusive) mode' : undefined}
    >
      <button
        type="button"
        disabled={lockVolume}
        onClick={() => {
          if (!lockVolume) toggleMute();
        }}
        aria-label={lockVolume ? 'Volume bypassed in Bit-Perfect mode' : muted ? 'Unmute' : 'Mute'}
        className="grid size-6 flex-none place-items-center text-white/60 transition-colors hover:text-white disabled:cursor-not-allowed disabled:hover:text-white/60"
      >
        <Volume1 size={16} aria-hidden="true" />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={displayLevel}
        disabled={lockVolume}
        aria-label={lockVolume ? 'Volume bypassed in Bit-Perfect mode' : 'Volume'}
        onChange={(e) => {
          if (!lockVolume) setVolume(Number(e.currentTarget.value));
        }}
        className={`h-1.5 flex-1 appearance-none rounded-full bg-white/22 accent-white ${
          lockVolume ? 'cursor-not-allowed' : 'cursor-pointer'
        }`}
      />
      <button
        type="button"
        disabled={lockVolume}
        onClick={() => {
          if (!lockVolume) setVolume(1);
        }}
        aria-label="Max volume"
        className="grid size-6 flex-none place-items-center text-white/60 transition-colors hover:text-white disabled:cursor-not-allowed disabled:hover:text-white/60"
      >
        <Volume2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

const chromeButton =
  'grid size-9 place-items-center rounded-full text-white/75 transition-[background-color,color] duration-100 ease-in hover:bg-white/14 hover:text-white';
const chrome = `absolute z-1 ${chromeButton}`;
const artworkLayer = 'absolute inset-0 size-full rounded-[inherit] object-cover opacity-0 transition-opacity duration-300 ease-in';
const IDLE_MS = 3000;

export function FullScreenPlayer({
  exiting = false,
  onExited,
}: {
  exiting?: boolean;
  onExited?: () => void;
} = {}) {
  const navigate = useNavigate();
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const entry = usePlayer((s) => {
    const row = s.queue[s.index];
    return row && row.track.videoId === s.nowPlaying?.videoId ? row : null;
  });
  const track = entry?.track ?? null;
  const playingFrom = entry?.source?.title ?? null;

  const motion = useTrackMotion(nowPlaying?.title, nowPlaying?.artist, track?.album?.name);
  const { pathname } = useLocation();
  const openedAt = useRef(pathname);
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const setFullScreen = useUi((s) => s.setFullScreen);
  const fullScreenSearchOpen = useUi((s) => s.fullScreenSearchOpen);
  const setFullScreenSearchOpen = useUi((s) => s.setFullScreenSearchOpen);
  const setAudioOutputOpen = useUi((s) => s.setAudioOutputOpen);
  const setCastModalOpen = useUi((s) => s.setCastModalOpen);
  const pipeline = useAudioPipeline();
  const castSupport = useCastSupport();
  const castSession = useCastSession();
  const video = useHasVideo(nowPlaying?.videoId);

  const [panel, setPanel] = useState<'lyrics' | 'queue' | null>(() =>
    nowPlaying && useVideo.getState().videoId === nowPlaying.videoId ? null : 'lyrics',
  );
  const picked = useRef(false);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const browserFullScreen = useBrowserFullScreen();
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const enteredBrowserFullScreen = useRef(false);
  const exitNotified = useRef(false);

  const notifyExited = useCallback(() => {
    if (exitNotified.current) return;
    exitNotified.current = true;
    onExited?.();
  }, [onExited]);

  const showLyrics = panel === 'lyrics';
  const showQueue = panel === 'queue';
  const togglePanel = (p: 'lyrics' | 'queue') => {
    picked.current = true;
    setPanel((on) => (on === p ? null : p));
  };

  useEffect(() => {
    if (video && !picked.current) setPanel(null);
  }, [video]);

  const wake = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  };
  useEffect(() => {
    wake();
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    return () => {
      if (enteredBrowserFullScreen.current && document.fullscreenElement) void document.exitFullscreen();
      opener?.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (pathname !== openedAt.current) setFullScreen(false);
  }, [pathname, setFullScreen]);

  useEffect(() => {
    if (!nowPlaying) {
      setFullScreen(false);
      notifyExited();
    }
  }, [nowPlaying, setFullScreen, notifyExited]);

  useEffect(() => {
    if (!exiting) {
      exitNotified.current = false;
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    if (active && rootRef.current?.contains(active)) active.blur();
    const timer = setTimeout(notifyExited, 260);
    return () => clearTimeout(timer);
  }, [exiting, notifyExited]);

  const toggleBrowserFullScreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen().then(
        () => (enteredBrowserFullScreen.current = true),
        () => undefined,
      );
    }
  };

  if (!nowPlaying) return null;
  const { videoId, title, artist } = nowPlaying;
  const album = track?.album ?? null;
  const column = showLyrics || showQueue;
  const theater = video && !column;
  const hidden = theater && playing && idle && !fullScreenSearchOpen ? ' pointer-events-none opacity-0' : '';
  const corner = `${chrome} transition-[background-color,color,opacity] duration-300${hidden}`;

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 z-[calc(var(--z-contextual-menus)-2)] isolate flex flex-col overflow-hidden text-primary [--art:min(32vw,calc(100dvh-390px),520px)] max-md:[--art:min(82vw,calc(100dvh-410px),360px)] ${
        exiting
          ? 'pointer-events-none animate-exit motion-reduce:[animation-name:fade-out]'
          : 'animate-enter motion-reduce:[animation-name:fade-in]'
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Now Playing"
      data-full-screen
      data-exiting={exiting || undefined}
      data-paused={!playing || undefined}
      onAnimationEnd={(e) => {
        if (exiting && e.target === e.currentTarget) notifyExited();
      }}
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
      style={theater && playing && idle ? { cursor: 'none' } : undefined}
    >
      <MeshBackdrop artworkUrl={nowPlaying.artworkUrl} playing={playing} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-1 bg-[linear-gradient(180deg,rgba(0,0,0,0.18)_0%,rgba(0,0,0,0.28)_60%,rgba(0,0,0,0.52)_100%)]"
      />
      {theater && (
        <div className="absolute inset-0 animate-fade-in bg-black">
          <VideoSurface fit="contain" className="size-full" />
        </div>
      )}
      {theater && (
        <div
          aria-hidden="true"
          data-theater-scrim="true"
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[min(48vh,380px)] bg-[linear-gradient(to_top,rgb(0_0_0/0.82)_0%,rgb(0_0_0/0.46)_48%,rgb(0_0_0/0.14)_78%,transparent_100%)] transition-opacity duration-300${hidden}`}
        />
      )}

      {/* Top handle + Playing from caption matching Screenshot 5 */}
      <div className={`relative z-1 flex flex-none flex-col items-center pt-3.5 pb-1 transition-opacity duration-300${hidden}`}>
        <div className="h-1 w-9 rounded-full bg-white/30" aria-hidden="true" />
        {playingFrom && (
          <p className="mt-1.5 max-w-[min(60vw,calc(100vw-220px))] truncate type-caption-1 text-white/75">
            Playing from {playingFrom}
          </p>
        )}
      </div>

      <button ref={close} className={`${corner} top-3.5 left-5`} aria-label="Close" onClick={() => setFullScreen(false)}>
        <X size={20} />
      </button>
      <button
        type="button"
        className={`${corner} top-3.5 left-16`}
        aria-label="Search music"
        title="Search (Ctrl+K)"
        onClick={() => setFullScreenSearchOpen(true)}
      >
        <Search size={18} />
      </button>
      {video && (
        <VideoQuality className={`absolute top-[18px] z-1${hidden}${document.fullscreenEnabled ? ' right-16' : ' right-5'}`} />
      )}
      {document.fullscreenEnabled && (
        <button
          className={`${corner} top-3.5 right-5`}
          aria-label={browserFullScreen ? 'Exit full screen' : 'Enter full screen'}
          onClick={toggleBrowserFullScreen}
        >
          {browserFullScreen ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      )}
      {fullScreenSearchOpen && !exiting && (
        <div
          className="fixed inset-0 z-20 flex items-start justify-center bg-black/50 px-4 pt-[min(14vh,96px)] [backdrop-filter:blur(8px)]"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            setFullScreenSearchOpen(false);
            close.current?.focus({ preventScroll: true });
          }}
        >
          <div className="glass-menu w-[min(520px,100%)] rounded-[18px] p-3">
            <SearchField
              initial=""
              autoFocus
              fullScreen
              dropdownClassName="w-full"
              onSearch={(q) => {
                const trimmed = q.trim();
                if (!trimmed) return;
                setFullScreenSearchOpen(false);
                setFullScreen(false);
                void navigate(`/search?q=${encodeURIComponent(trimmed)}`);
              }}
              onPickOption={(kind) => {
                setFullScreenSearchOpen(false);
                if (kind === 'track') close.current?.focus({ preventScroll: true });
                else setFullScreen(false);
              }}
              onEscape={() => {
                setFullScreenSearchOpen(false);
                close.current?.focus({ preventScroll: true });
              }}
            />
          </div>
        </div>
      )}

      {/* Main layout: Sleeve + Controls on left, Synced Lyrics or Up Next on right */}
      <div
        className={
          theater
            ? `relative z-1 flex min-h-0 flex-1 items-end justify-center px-6 pb-3 transition-opacity duration-300${hidden}`
            : `grid min-h-0 flex-1 items-center justify-center gap-x-[clamp(44px,6vw,120px)] px-[clamp(24px,8vw,120px)] py-4 max-md:px-6 ${
                column
                  ? 'grid-cols-[var(--art)_minmax(0,40vw)] max-md:grid-cols-[minmax(0,1fr)] max-md:grid-rows-[auto_minmax(0,1fr)_auto] max-md:items-stretch max-md:gap-y-2'
                  : 'grid-cols-[var(--art)]'
              }`
        }
        data-lyrics={column || undefined}
      >
        {/* Compact mobile track header shown at top when Lyrics/Queue is open on narrow screens (Screenshot 6) */}
        {column && (
          <div className="hidden items-center gap-3 pb-1 max-md:flex">
            {nowPlaying.artworkUrl && (
              <img
                src={sizedArtwork(nowPlaying.artworkUrl, 96)}
                alt=""
                width={44}
                height={44}
                referrerPolicy="no-referrer"
                className="size-11 flex-none rounded-[9px] object-cover"
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1">
                {track?.explicit && <ExplicitBadge size={12} />}
                <span className="truncate type-title-3-emphasized text-white">{title}</span>
              </div>
              <span className="truncate type-callout text-white/65">{artist}</span>
            </div>
            <FavoriteButton
              videoId={nowPlaying.videoId}
              className="grid size-9 flex-none place-items-center rounded-full bg-white/14 text-white hover:bg-white/22"
              size={17}
            />
            {track && (
              <TrackMenu
                track={track}
                className="grid size-9 flex-none place-items-center rounded-full bg-white/14 text-white hover:bg-white/22"
                placement="below-end"
              />
            )}
          </div>
        )}

        <section
          className={
            theater
              ? 'flex w-[min(720px,100%)] min-w-0 flex-col'
              : `flex w-(--art) min-w-0 flex-col${column ? ' max-md:order-3 max-md:w-full' : ''}`
          }
          aria-label="Player"
        >
          <div
            className={`relative w-(--art) rounded-[16px] transition-[scale] duration-450 ease-[cubic-bezier(0.34,1.3,0.64,1)] motion-reduce:transition-none${
              video ? ' aspect-video overflow-hidden bg-black' : ' aspect-square'
            }${playing ? '' : ' scale-94'}${column ? ' max-md:hidden' : ''}${theater ? ' hidden' : ''}`}
          >
            {nowPlaying.artworkUrl ? (
              <>
                <img
                  key={`glow-${nowPlaying.artworkUrl}`}
                  className={`${artworkLayer} -z-1 translate-y-3 scale-98 blur-[24px] saturate-180 data-loaded:opacity-45`}
                  src={sizedArtwork(nowPlaying.artworkUrl, 60)}
                  alt=""
                  referrerPolicy="no-referrer"
                  decoding="async"
                  onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
                />
                <img
                  key={nowPlaying.artworkUrl}
                  className={`${artworkLayer} bg-white/10 shadow-[0_14px_40px_rgba(0,0,0,0.42)] data-loaded:opacity-100`}
                  src={sizedArtwork(nowPlaying.artworkUrl, 600)}
                  alt=""
                  referrerPolicy="no-referrer"
                  decoding="async"
                  onLoad={(e) => e.currentTarget.setAttribute('data-loaded', '')}
                />
              </>
            ) : (
              <div
                aria-hidden="true"
                className="grid size-full place-items-center rounded-[inherit] border border-white/12 bg-[linear-gradient(145deg,rgba(255,255,255,0.12),rgba(255,255,255,0.04))] text-white/45 shadow-[0_14px_40px_rgba(0,0,0,0.36)]"
              >
                <LogoMark size={72} />
              </div>
            )}
            {motion && (
              <MotionArtwork
                key={motion.url}
                motion={motion}
                className="absolute inset-0 size-full rounded-[inherit] object-cover opacity-0 transition-opacity duration-600 ease-in data-ready:opacity-100"
                playing={playing}
              />
            )}
            {video && !theater && <VideoSurface className="absolute inset-0" />}
          </div>

          <div className={`flex items-center gap-3${theater ? '' : ' mt-5'}${column ? ' max-md:hidden' : ''}`}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-1.5">
                {track?.explicit && <ExplicitBadge size={14} />}
                <PageLink
                  className={`min-w-0 max-w-full self-start truncate type-[700_19px/24px] text-white ${pageLink}`}
                  href={albumHref(album?.id ?? null)}
                  resolve={() => albumPageFor(videoId, album, [title, artist].filter(Boolean).join(' '))}
                >
                  {title}
                </PageLink>
              </div>
              <span className="truncate type-title-3 text-white/70">
                {artist && <Credits videoId={videoId} line={artist} artists={track?.artists ?? []} className={pageLink} />}
                {artist && album?.name && ' · '}
                {album?.name && (
                  <PageLink
                    className={pageLink}
                    href={albumHref(album.id ?? null)}
                    resolve={() => albumPageFor(videoId, album, [title, artist].filter(Boolean).join(' '))}
                  >
                    {album.name}
                  </PageLink>
                )}
              </span>
              <NerdStats />
            </div>
            <FavoriteButton
              videoId={nowPlaying.videoId}
              className="grid size-9 flex-none place-items-center rounded-full bg-white/14 text-white hover:bg-white/24"
              size={18}
            />
            {track && (
              <TrackMenu
                track={track}
                className="grid size-9 flex-none place-items-center rounded-full bg-white/14 text-white hover:bg-white/24"
                placement="above-end"
              />
            )}
          </div>

          <Scrubber />
          <Transport />
          <HorizontalVolumeBar />
        </section>

        {showLyrics && (
          <section className="flex min-h-0 animate-fade-in self-stretch max-md:order-2" aria-label="Lyrics">
            <LyricsPanel variant="full" />
          </section>
        )}
        {showQueue && (
          <section
            className="flex min-h-0 animate-fade-in flex-col self-stretch [mask-image:linear-gradient(180deg,#000_calc(100%-80px),transparent)] max-md:order-2"
            aria-label="Up Next"
          >
            <UpNext />
          </section>
        )}
      </div>

      {/* Bottom toolbar: Lyrics, hardware-gated Cast to TV (Image 1), Up Next + active audio output pill */}
      <footer className={`relative z-1 flex flex-none flex-col items-center gap-1 pt-1 pb-4 transition-opacity duration-300${hidden}`}>
        <div
          className={`flex w-[min(320px,82vw)] items-center px-4 ${
            castSupport.supported ? 'justify-between' : 'justify-around'
          }`}
        >
          <button
            type="button"
            className={`grid size-10 place-items-center rounded-[11px] transition-colors ${
              showLyrics ? 'bg-white/22 text-white' : 'text-white/70 hover:bg-white/12 hover:text-white'
            }`}
            aria-label="Lyrics"
            aria-pressed={showLyrics}
            onClick={() => togglePanel('lyrics')}
          >
            {showLyrics ? <LyricsActiveIcon size={19} /> : <LyricsIcon size={19} />}
          </button>

          {castSupport.supported && (
            <button
              type="button"
              className={`grid size-10 place-items-center rounded-[11px] transition-colors ${
                castSession.connected
                  ? 'bg-white/22 text-white'
                  : 'text-white/70 hover:bg-white/12 hover:text-white'
              }`}
              aria-label={
                castSession.connected && castSession.device
                  ? `Cast to TV (${castSession.device.name})`
                  : 'Cast to TV'
              }
              aria-pressed={castSession.connected}
              title={
                castSession.connected && castSession.device
                  ? `Casting to ${castSession.device.name}`
                  : 'Cast to TV'
              }
              onClick={() => setCastModalOpen(true)}
            >
              <Cast size={19} strokeWidth={2} aria-hidden="true" />
            </button>
          )}

          <button
            type="button"
            className={`grid size-10 place-items-center rounded-[11px] transition-colors ${
              showQueue ? 'bg-white/22 text-white' : 'text-white/70 hover:bg-white/12 hover:text-white'
            }`}
            aria-label="Up Next"
            aria-pressed={showQueue}
            onClick={() => togglePanel('queue')}
          >
            <UpNextIcon size={19} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => setAudioOutputOpen(true)}
          aria-label="Audio output"
          title="Audio output & Signal Path"
          className="rounded-pill px-3 py-0.5 type-caption-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          {castSession.connected && castSession.device
            ? `Casting to ${castSession.device.name}`
            : pipeline.activeDeviceName}
        </button>
      </footer>
    </div>
  );
}
