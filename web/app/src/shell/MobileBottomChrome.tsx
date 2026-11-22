import {
  AlbumsIcon,
  HomeIcon,
  NewIcon,
  SearchIcon,
} from '@/components/icons/NavIcons';
import { ForwardIcon, PauseIcon, PlayIcon } from '@/components/icons/Transport';
import { ExplicitBadge } from '@/components/music/ExplicitBadge';
import { PrefetchNavLink } from '@/components/PrefetchLink';
import { sizedArtwork } from '@/lib/artwork';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

const MOBILE_TABS = [
  { to: '/home', label: 'Home', Icon: HomeIcon, end: false },
  { to: '/new', label: 'New', Icon: NewIcon, end: false },
  { to: '/library', label: 'Library', Icon: AlbumsIcon, end: true },
  { to: '/search', label: 'Search', Icon: SearchIcon, end: false },
] as const;

export function MobileBottomChrome() {
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const track = usePlayer((s) => {
    const entry = s.queue[s.index]?.track;
    return entry && entry.videoId === s.nowPlaying?.videoId ? entry : null;
  });
  const playing = usePlayer((s) => s.status === 'playing' || s.status === 'buffering');
  const hasNext = usePlayer(
    (s) => s.index + 1 < s.queue.length || s.repeat !== 'off' || (s.autoplay && s.index >= 0),
  );
  const { togglePlay, next } = usePlayer.getState();
  const setFullScreen = useUi((s) => s.setFullScreen);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[calc(var(--z-web-chrome)-1)] hidden flex-col gap-2 px-4 pb-3 max-sm:flex">
      {nowPlaying && (
        <div
          className="glass-pill pointer-events-auto relative flex h-[56px] items-center gap-3 rounded-[28px] px-2.5"
          role="region"
          aria-label="Mini player"
        >
          <button
            type="button"
            onClick={() => setFullScreen(true)}
            aria-label={`Open Now Playing for ${nowPlaying.title}`}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
          >
            {nowPlaying.artworkUrl ? (
              <img
                src={sizedArtwork(nowPlaying.artworkUrl, 80)}
                alt=""
                width={40}
                height={40}
                referrerPolicy="no-referrer"
                className="size-10 flex-none rounded-[10px] object-cover"
              />
            ) : (
              <span className="size-10 flex-none rounded-[10px] bg-quaternary" aria-hidden="true" />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-1">
                {track?.explicit && <ExplicitBadge size={11} />}
                <span className="truncate type-body-emphasized text-primary">{nowPlaying.title}</span>
              </span>
              <span className="truncate type-callout text-secondary">{nowPlaying.artist}</span>
            </span>
          </button>

          <div className="flex flex-none items-center gap-1">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? 'Pause' : 'Play'}
              className="grid size-10 place-items-center rounded-full text-primary transition-colors hover:bg-quinary"
            >
              {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
            </button>
            <button
              type="button"
              onClick={next}
              disabled={!hasNext}
              aria-label="Next"
              className="grid size-10 place-items-center rounded-full text-primary transition-colors hover:bg-quinary disabled:opacity-40"
            >
              <ForwardIcon size={22} />
            </button>
          </div>
        </div>
      )}

      <nav
        aria-label="Mobile navigation"
        className="glass-pill pointer-events-auto relative grid grid-cols-4 items-center rounded-pill p-1"
      >
        {MOBILE_TABS.map(({ to, label, Icon, end }) => (
          <PrefetchNavLink
            key={to}
            to={to}
            end={end}
            className="group flex min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-pill px-2 py-1 text-secondary transition-colors hover:text-primary aria-[current=page]:bg-quaternary aria-[current=page]:text-primary"
          >
            <Icon size={22} className="group-aria-[current=page]:text-key" />
            <span className="type-[600_10px/12px] tracking-[0.02em]">{label}</span>
          </PrefetchNavLink>
        ))}
      </nav>
    </div>
  );
}
