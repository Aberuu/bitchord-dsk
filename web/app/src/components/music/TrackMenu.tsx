import { ChevronLeft, ChevronRight, Download, ListEnd, ListPlus, ListStart, MoreHorizontal, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useContextMenu, type ContextMenuController } from '@/components/contextMenu';
import { Menu, MenuHeader, MenuItem, MenuSeparator, type MenuPlacement } from '@/components/Menu';
import {
  useAddToPlaylist,
  useLikeStatus,
  usePlaylistOptions,
  useSetLiked,
  useSignedIn,
} from '@/data/music/queries';
import type { Track } from '@/data/music/types';
import { downloadTrackOffline } from '@/desktop/downloadHelper';
import { isTauriDesktop } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';

function PlaylistChoices({ videoId, onDone, onBack }: { videoId: string; onDone: () => void; onBack: () => void }) {
  const options = usePlaylistOptions(videoId, true);
  const add = useAddToPlaylist();
  return (
    <>
      <MenuItem icon={<ChevronLeft size={14} />} onSelect={onBack}>
        Back
      </MenuItem>
      <MenuSeparator />
      <MenuHeader>Add to Playlist</MenuHeader>
      {options.isPending && (
        <MenuItem disabled onSelect={() => {}}>
          Loading…
        </MenuItem>
      )}
      {options.isError && (
        <MenuItem disabled onSelect={() => {}}>
          Couldn’t load your playlists
        </MenuItem>
      )}
      {options.data?.length === 0 && (
        <MenuItem disabled onSelect={() => {}}>
          No playlists yet
        </MenuItem>
      )}
      {options.data?.map((option) => (
        <MenuItem
          key={option.playlistId}
          onSelect={() => {
            add.mutate({ playlistId: option.playlistId, videoId });
            onDone();
          }}
        >
          {option.title}
        </MenuItem>
      ))}
    </>
  );
}

/** Favorite and Add to Playlist: the account's actions, signed in only. */
function AccountItems({ track, onClose, onPlaylists }: { track: Track; onClose: () => void; onPlaylists: () => void }) {
  const status = useLikeStatus(track.videoId);
  const setLiked = useSetLiked();
  const liked = status.data === 'LIKE';
  return (
    <>
      <MenuSeparator />
      <MenuItem
        icon={<Star size={15} fill={liked ? 'currentColor' : 'none'} />}
        disabled={status.isPending}
        onSelect={() => {
          setLiked.mutate({ videoId: track.videoId, liked: !liked });
          onClose();
        }}
      >
        {liked ? 'Unfavorite' : 'Favorite'}
      </MenuItem>
      <MenuItem icon={<ListPlus size={15} />} trailing={<ChevronRight size={14} />} onSelect={onPlaylists}>
        Add to Playlist
      </MenuItem>
    </>
  );
}

function TrackMenuItems({ track, onClose }: { track: Track; onClose: () => void }) {
  const [view, setView] = useState<'main' | 'playlists'>('main');
  const signedIn = useSignedIn();
  if (view === 'playlists') {
    return <PlaylistChoices videoId={track.videoId} onDone={onClose} onBack={() => setView('main')} />;
  }
  const { playNext, addToQueue } = usePlayer.getState();
  const canDownload = isTauriDesktop() && !track.videoId.startsWith('local:') && !track.videoId.startsWith('spotify:');
  return (
    <>
      <MenuItem icon={<ListStart size={15} />} onSelect={() => (onClose(), playNext([track]))}>
        Play Next
      </MenuItem>
      <MenuItem icon={<ListEnd size={15} />} onSelect={() => (onClose(), addToQueue([track]))}>
        Add to Queue
      </MenuItem>
      {canDownload && (
        <MenuItem
          icon={<Download size={15} />}
          onSelect={() => {
            onClose();
            void downloadTrackOffline(track)
              .then(() => queryClient.invalidateQueries({ queryKey: ['desktop', 'downloads'] }))
              .catch(() => {});
          }}
        >
          Download Offline
        </MenuItem>
      )}
      {signedIn && <AccountItems track={track} onClose={onClose} onPlaylists={() => setView('playlists')} />}
    </>
  );
}

/**
 * The ⋯ button at the end of a track row (report §14): Play Next and Add to
 * Queue for everyone; Favorite and Add to Playlist signed in.
 */
export function TrackMenu({
  track,
  className,
  placement,
  onOpenChange,
  menu: externalMenu,
}: {
  track: Track;
  className?: string;
  /** Where the menu opens from the button; the player's sit at the bottom of the window. */
  placement?: MenuPlacement;
  /** Told when the menu opens and closes; most mounts don't need to know. */
  onOpenChange?: (open: boolean) => void;
  /** Shared controller when a parent row also triggers this menu on right-click. */
  menu?: ContextMenuController;
}) {
  const internalMenu = useContextMenu();
  const menu = externalMenu ?? internalMenu;
  useEffect(() => {
    onOpenChange?.(menu.isOpen);
  }, [menu.isOpen, onOpenChange]);
  return (
    <>
      <button
        type="button"
        data-no-drag="true"
        className={className}
        aria-label={`More options for ${track.title}`}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        data-open={menu.isOpen || undefined}
        onClick={(event) => {
          event.stopPropagation();
          menu.toggleFromAnchor(event.currentTarget);
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        <MoreHorizontal size={18} strokeWidth={2} />
      </button>
      {menu.isOpen && (
        <Menu
          anchor={menu.anchor}
          point={menu.point}
          returnFocusTo={menu.returnFocusTo}
          placement={placement}
          onClose={menu.close}
          label={track.title}
        >
          <TrackMenuItems track={track} onClose={menu.close} />
        </Menu>
      )}
    </>
  );
}
