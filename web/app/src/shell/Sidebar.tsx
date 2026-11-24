import { Cloud, Download, FileMusic, HardDrive, ListMusic, Settings, SlidersHorizontal } from 'lucide-react';
import { useEffect } from 'react';
import { PrefetchLink, PrefetchNavLink } from '@/components/PrefetchLink';
import { DeveloperWatermark } from '@/components/DeveloperWatermark';
import { LogoMark } from '@/components/icons/LogoMark';
import { isTauriDesktop } from '@/desktop/tauriBridge';
import {
  AlbumsIcon,
  AllPlaylistsIcon,
  ArtistsIcon,
  HomeIcon,
  MadeForYouIcon,
  NewIcon,
  RecentlyAddedIcon,
  SearchIcon,
  SongsIcon,
  type NavIconProps,
} from '@/components/icons/NavIcons';
import { hrefFor } from '@/components/music/links';
import { LIBRARY_SECTIONS, type LibrarySection } from '@/data/music/library';
import { useLibraryPlaylists, useSignedIn } from '@/data/music/queries';
import { useSpotifyPlaylists } from '@/data/spotify/queries';
import { useSpotifySignedIn } from '@/extension/useSpotifyAuth';
import { useSources } from '@/state/sources';
import { useUi } from '@/state/ui';
import { AccountButton } from './AccountButton';

interface NavItem {
  to: string;
  label: string;
  Icon: (props: NavIconProps) => React.ReactNode;
  end?: boolean;
}

const PRIMARY: NavItem[] = [
  { to: '/home', label: 'Home', Icon: HomeIcon },
  { to: '/search', label: 'Search', Icon: SearchIcon },
  { to: '/new', label: 'New', Icon: NewIcon },
  { to: '/library', label: 'Library', Icon: AlbumsIcon, end: true },
];

const LIBRARY_ICONS: Record<Exclude<LibrarySection, 'playlists'>, NavItem['Icon']> = {
  recent: RecentlyAddedIcon,
  artists: ArtistsIcon,
  albums: AlbumsIcon,
  songs: SongsIcon,
  'made-for-you': MadeForYouIcon,
};

const LIBRARY: NavItem[] = (Object.keys(LIBRARY_ICONS) as (keyof typeof LIBRARY_ICONS)[]).map((section) => ({
  to: `/library/${section}`,
  label: LIBRARY_SECTIONS[section].title,
  Icon: LIBRARY_ICONS[section],
}));

const item =
  'group flex h-9 items-center gap-2 mb-0.5 p-1 rounded-nav type-body-reduced text-primary hover:bg-quinary aria-[current=page]:bg-nav-selected sm:group-data-[compact=true]/nav:mx-auto sm:group-data-[compact=true]/nav:h-10 sm:group-data-[compact=true]/nav:w-11 sm:group-data-[compact=true]/nav:justify-center sm:group-data-[compact=true]/nav:gap-0 sm:group-data-[compact=true]/nav:p-0';
const icon = 'inline-grid size-6 flex-none place-items-center text-primary group-aria-[current=page]:text-key';
const navLabel = 'min-w-0 truncate sm:group-data-[compact=true]/nav:sr-only';
const sectionHeader =
  'mt-4 px-2 py-1 type-callout-emphasized text-secondary sm:group-data-[compact=true]/nav:my-2.5 sm:group-data-[compact=true]/nav:p-0';
const list = 'flex flex-col';

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 className={sectionHeader}>
      <span className="sm:group-data-[compact=true]/nav:sr-only">{children}</span>
      <span
        className="hidden sm:group-data-[compact=true]/nav:mx-auto sm:group-data-[compact=true]/nav:block sm:group-data-[compact=true]/nav:h-px sm:group-data-[compact=true]/nav:w-6 sm:group-data-[compact=true]/nav:bg-divider"
        aria-hidden="true"
      />
    </h2>
  );
}

function NavList({
  items,
  compact,
  onNavigate,
}: {
  items: NavItem[];
  compact: boolean;
  onNavigate: () => void;
}) {
  return (
    <ul className={list}>
      {items.map(({ to, label, Icon, end }) => (
        <li key={to}>
          <PrefetchNavLink to={to} end={end} className={item} title={compact ? label : undefined} onClick={onNavigate}>
            <Icon size={24} className={icon} />
            <span className={navLabel}>{label}</span>
          </PrefetchNavLink>
        </li>
      ))}
    </ul>
  );
}

function LibraryNav({ compact, onNavigate }: { compact: boolean; onNavigate: () => void }) {
  const playlists = useLibraryPlaylists();
  return (
    <>
      <SectionHeading>YouTube Music</SectionHeading>
      <NavList items={LIBRARY} compact={compact} onNavigate={onNavigate} />
      <SectionHeading>Playlists</SectionHeading>
      <ul className={list}>
        <li>
          <PrefetchNavLink
            to="/library/playlists"
            className={item}
            title={compact ? LIBRARY_SECTIONS.playlists.title : undefined}
            onClick={onNavigate}
          >
            <AllPlaylistsIcon size={24} className={icon} />
            <span className={navLabel}>{LIBRARY_SECTIONS.playlists.title}</span>
          </PrefetchNavLink>
        </li>
        {playlists.data?.map((playlist) => (
          <li key={playlist.id} className="sm:group-data-[compact=true]/nav:hidden">
            <PrefetchNavLink to={hrefFor(playlist) ?? '/library/playlists'} className={item} onClick={onNavigate}>
              <span className={icon}>
                <ListMusic size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={navLabel}>{playlist.title}</span>
            </PrefetchNavLink>
          </li>
        ))}
      </ul>
    </>
  );
}

function SpotifyNav({ compact, onNavigate }: { compact: boolean; onNavigate: () => void }) {
  const playlists = useSpotifyPlaylists();
  return (
    <>
      <SectionHeading>Spotify</SectionHeading>
      <ul className={list}>
        <li>
          <PrefetchNavLink
            to="/spotify"
            end
            className={item}
            title={compact ? 'All Spotify Playlists' : undefined}
            onClick={onNavigate}
          >
            <AllPlaylistsIcon size={24} className={icon} />
            <span className={navLabel}>All Spotify Playlists</span>
          </PrefetchNavLink>
        </li>
        {playlists.data?.map((playlist) => (
          <li key={playlist.id} className="sm:group-data-[compact=true]/nav:hidden">
            <PrefetchNavLink to={`/spotify/playlist/${encodeURIComponent(playlist.id)}`} className={item} onClick={onNavigate}>
              <span className={icon}>
                <ListMusic size={17} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span className={navLabel}>{playlist.name}</span>
            </PrefetchNavLink>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Sidebar() {
  const drawerOpen = useUi((s) => s.drawerOpen);
  const setDrawerOpen = useUi((s) => s.setDrawerOpen);
  const sidebarCompact = useUi((s) => s.sidebarCompact);
  const signedIn = useSignedIn();
  const spotifySignedIn = useSpotifySignedIn();
  const webdavConfigured = useSources((s) => s.webdav.configured);
  const smbConfigured = useSources((s) => s.smb.configured);
  const desktop = isTauriDesktop();
  const close = () => setDrawerOpen(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen, setDrawerOpen]);

  return (
    <>
      <nav
        id="main-sidebar"
        className="group/nav absolute inset-y-0 left-0 z-(--z-web-chrome) flex w-(--web-navigation-width) flex-col glass-material sm:transition-[width] sm:duration-(--duration-panel) sm:ease-panel max-sm:w-[min(300px,82vw)] max-sm:-translate-x-full max-sm:shadow-glass max-sm:transition-transform max-sm:duration-(--duration-panel) max-sm:ease-panel max-sm:data-[open=true]:translate-none"
        data-open={drawerOpen}
        data-compact={sidebarCompact || undefined}
        aria-label="Main"
      >
        <div
          className={`${desktop ? 'mt-11' : 'mt-2 sm:mt-11'} ml-2 flex h-16 items-center px-5 sm:group-data-[compact=true]/nav:ml-0 sm:group-data-[compact=true]/nav:justify-center sm:group-data-[compact=true]/nav:px-0`}
        >
          <PrefetchLink
            to="/home"
            className="inline-flex items-center gap-2 rounded-[6px] sm:group-data-[compact=true]/nav:grid sm:group-data-[compact=true]/nav:size-10 sm:group-data-[compact=true]/nav:place-items-center sm:group-data-[compact=true]/nav:gap-0 sm:group-data-[compact=true]/nav:rounded-nav sm:group-data-[compact=true]/nav:hover:bg-quinary"
            aria-label="BitChord, Home"
            title={sidebarCompact ? 'BitChord Home' : undefined}
            onClick={close}
          >
            <LogoMark size={22} className="text-primary" />
            <span className="type-[700_19px/24px] tracking-[-0.01em] sm:group-data-[compact=true]/nav:sr-only">
              BitChord
            </span>
          </PrefetchLink>
        </div>
        <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-3 pl-5 [scrollbar-width:none] sm:group-data-[compact=true]/nav:px-2">
          <NavList items={PRIMARY} compact={sidebarCompact} onNavigate={close} />
          <SectionHeading>On This PC</SectionHeading>
          <ul className={list}>
            <li>
              <PrefetchNavLink
                to="/library/downloads"
                className={item}
                title={sidebarCompact ? 'Downloads' : undefined}
                onClick={close}
              >
                <span className={icon}>
                  <Download size={18} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={navLabel}>Downloads</span>
              </PrefetchNavLink>
            </li>
            <li>
              <PrefetchNavLink
                to="/library/local"
                className={item}
                title={sidebarCompact ? 'Local Music' : undefined}
                onClick={close}
              >
                <span className={icon}>
                  <FileMusic size={18} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={navLabel}>Local Music</span>
              </PrefetchNavLink>
            </li>
            {desktop && webdavConfigured && (
              <li>
                <PrefetchNavLink
                  to="/library/webdav"
                  className={item}
                  title={sidebarCompact ? 'WebDAV' : undefined}
                  onClick={close}
                >
                  <span className={icon}>
                    <Cloud size={18} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <span className={navLabel}>WebDAV</span>
                </PrefetchNavLink>
              </li>
            )}
            {desktop && smbConfigured && (
              <li>
                <PrefetchNavLink
                  to="/library/smb"
                  className={item}
                  title={sidebarCompact ? 'SMB' : undefined}
                  onClick={close}
                >
                  <span className={icon}>
                    <HardDrive size={18} strokeWidth={1.8} aria-hidden="true" />
                  </span>
                  <span className={navLabel}>SMB</span>
                </PrefetchNavLink>
              </li>
            )}
            <li>
              <PrefetchNavLink
                to="/settings/audio"
                className={item}
                title={sidebarCompact ? 'Audio & EQ' : undefined}
                onClick={close}
              >
                <span className={icon}>
                  <SlidersHorizontal size={18} strokeWidth={1.8} aria-hidden="true" />
                </span>
                <span className={navLabel}>Audio & EQ</span>
              </PrefetchNavLink>
            </li>
          </ul>
          {signedIn && <LibraryNav compact={sidebarCompact} onNavigate={close} />}
          {spotifySignedIn && <SpotifyNav compact={sidebarCompact} onNavigate={close} />}
        </div>
        <div className="flex flex-col gap-2 border-t border-divider/60 pt-3 pr-3 pb-3 pl-5 sm:group-data-[compact=true]/nav:items-center sm:group-data-[compact=true]/nav:px-2">
          <div className="flex items-center justify-between gap-2 sm:group-data-[compact=true]/nav:flex-col sm:group-data-[compact=true]/nav:gap-1.5">
            <div className="min-w-0 flex-1 sm:group-data-[compact=true]/nav:flex-none">
              <AccountButton compact={sidebarCompact} />
            </div>
            <PrefetchNavLink
              to="/settings"
              className="grid size-8 flex-none place-items-center rounded-nav text-secondary hover:bg-quinary hover:text-primary aria-[current=page]:bg-quinary aria-[current=page]:text-primary sm:group-data-[compact=true]/nav:size-10"
              aria-label="Settings"
              title="Settings"
              onClick={close}
            >
              <Settings size={17} strokeWidth={1.9} aria-hidden="true" />
            </PrefetchNavLink>
          </div>
          <DeveloperWatermark variant="sidebar" compact={sidebarCompact} />
        </div>
      </nav>
      {drawerOpen && (
        <div
          className="absolute inset-0 z-[calc(var(--z-web-chrome)-1)] hidden bg-scrim max-sm:block"
          onClick={close}
          aria-hidden="true"
        />
      )}
    </>
  );
}
