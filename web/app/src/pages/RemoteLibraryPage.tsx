import { useQuery } from '@tanstack/react-query';
import { Cloud, HardDrive, Play, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useContextMenu } from '@/components/contextMenu';
import { TrackMenu } from '@/components/music/TrackMenu';
import { PageHeader } from '@/components/PageHeader';
import { PrefetchLink } from '@/components/PrefetchLink';
import type { Track } from '@/data/music/types';
import { desktopApi, isTauriDesktop, type RemoteTrackItem } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import { useSources } from '@/state/sources';
import { settingsUi } from './settingsStyles';

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toQueueTrack(t: RemoteTrackItem): Track {
  return {
    videoId: t.id,
    title: t.title,
    artists: [{ name: t.artist, id: null }],
    album: t.album ? { name: t.album, id: null } : null,
    durationSec: null,
    explicit: false,
    thumbnail: t.artworkProxyUrl,
    index: null,
    plays: null,
  };
}

function RemoteTrackRow({
  track,
  onPlay,
}: {
  track: RemoteTrackItem;
  onPlay: () => void;
}) {
  const menu = useContextMenu();
  const queueTrack = toQueueTrack(track);
  const metaParts = [track.codec, formatBytes(track.sizeBytes)].filter(Boolean).join(' · ');

  return (
    <div
      className="group/row relative grid grid-cols-[40px_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-tracklist-hover data-open:bg-tracklist-hover hairline-[56px]"
      data-open={menu.isOpen || undefined}
      onContextMenu={menu.openAtEvent}
    >
      <button
        type="button"
        className="relative grid size-10 cursor-pointer place-items-center overflow-hidden rounded-[6px] bg-quaternary text-primary hover:bg-key-bg hover:text-white"
        aria-label={`Play ${track.title}`}
        onClick={onPlay}
      >
        {track.artworkProxyUrl ? (
          <img
            src={track.artworkProxyUrl}
            alt=""
            className="size-full object-cover"
            loading="lazy"
          />
        ) : (
          <Play size={14} fill="currentColor" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className="flex min-w-0 cursor-pointer flex-col text-start"
        onClick={onPlay}
      >
        <span className="truncate type-body-emphasized text-primary">{track.title}</span>
        <span className="truncate type-callout text-secondary">
          {track.artist}
          {track.album ? ` · ${track.album}` : ''}
        </span>
      </button>
      <span className="type-callout tabular-nums text-secondary">{metaParts}</span>
      <TrackMenu
        track={queueTrack}
        menu={menu}
        className="grid size-7 place-items-center rounded-full text-key opacity-0 transition-opacity duration-100 ease-in group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-quinary data-open:opacity-100"
      />
    </div>
  );
}

export function RemoteLibraryView({ kind }: { kind: 'webdav' | 'smb' }) {
  const desktop = isTauriDesktop();
  const webdav = useSources((s) => s.webdav);
  const smb = useSources((s) => s.smb);
  const configured = kind === 'webdav' ? webdav.configured : smb.configured;
  const title = kind === 'webdav' ? 'WebDAV' : 'SMB';
  const [filter, setFilter] = useState('');

  const tracksQuery = useQuery({
    queryKey: ['desktop', 'remote', kind],
    queryFn: () => (kind === 'webdav' ? desktopApi.webdavListTracks() : desktopApi.smbListTracks()),
    enabled: desktop && configured,
    staleTime: 60_000,
  });

  const allTracks = tracksQuery.data ?? [];
  const filteredTracks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allTracks;
    return allTracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        (t.album?.toLowerCase().includes(q) ?? false) ||
        t.fileName.toLowerCase().includes(q),
    );
  }, [allTracks, filter]);

  const playFromRemote = (startIndex: number) => {
    if (!filteredTracks[startIndex]) return;
    usePlayer.getState().registerRemoteTracks(filteredTracks);
    const queueTracks = filteredTracks.map(toQueueTrack);
    usePlayer.getState().playTracks(queueTracks, startIndex, { title, type: 'playlist' });
  };

  const Icon = kind === 'webdav' ? Cloud : HardDrive;

  return (
    <div className="mx-auto max-w-[1120px] pb-16">
      <PageHeader title={title} />
      <div className="mx-(--body-gutter) mt-4 flex flex-col gap-5">
        {!desktop ? (
          <section className={`${settingsUi.group} p-5`}>
            <p className="type-title-3 text-primary">
              {title} browsing requires BitChord Desktop.
            </p>
          </section>
        ) : !configured ? (
          <section className={`${settingsUi.group} flex flex-col items-start gap-3 p-6`}>
            <span className="grid size-10 place-items-center rounded-[10px] bg-quaternary text-secondary">
              <Icon size={20} aria-hidden="true" />
            </span>
            <h2 className="type-title-2-emphasized text-primary">
              {kind === 'webdav' ? 'No WebDAV server connected' : 'No SMB share connected'}
            </h2>
            <p className="max-w-[52ch] type-body-tall text-secondary">
              {kind === 'webdav'
                ? 'Connect a WebDAV server in Sources to browse and stream your remote library.'
                : 'Connect an SMB share in Sources to browse and stream your shared music folder.'}
            </p>
            <PrefetchLink
              to="/settings/sources"
              className="inline-flex items-center gap-2 rounded-pill bg-key-bg px-4 py-2 type-callout-emphasized text-white hover:brightness-[1.06]"
            >
              Configure under Sources
            </PrefetchLink>
          </section>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={tracksQuery.isFetching}
                  onClick={() => void tracksQuery.refetch()}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-quaternary px-4 py-2 type-callout-emphasized text-primary hover:bg-tertiary/30 disabled:opacity-50"
                >
                  <RefreshCw
                    size={14}
                    className={tracksQuery.isFetching ? 'animate-spin' : undefined}
                    aria-hidden="true"
                  />
                  {tracksQuery.isFetching ? 'Scanning…' : 'Refresh'}
                </button>
                <div className="relative min-w-[220px] flex-1 max-w-[360px]">
                  <Search
                    size={14}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-tertiary"
                    aria-hidden="true"
                  />
                  <input
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.currentTarget.value)}
                    placeholder={`Filter ${title} tracks`}
                    aria-label={`Filter ${title} tracks`}
                    className="h-9 w-full rounded-pill border-0 bg-quinary pr-3.5 pl-8.5 type-body text-primary placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-key"
                  />
                </div>
              </div>
              {filteredTracks.length > 0 && (
                <button
                  type="button"
                  onClick={() => playFromRemote(0)}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-key-bg px-4 py-2 type-callout-emphasized text-white hover:brightness-[1.06]"
                >
                  <Play size={14} fill="currentColor" aria-hidden="true" />
                  Play All ({filteredTracks.length})
                </button>
              )}
            </div>

            {tracksQuery.isError && (
              <section className={`${settingsUi.group} p-4`}>
                <p className="type-callout text-red">{String(tracksQuery.error)}</p>
              </section>
            )}

            {tracksQuery.isPending ? (
              <section className={`${settingsUi.group} p-5`} aria-busy="true">
                <p className="type-body text-secondary">Scanning {title} audio files…</p>
              </section>
            ) : filteredTracks.length === 0 ? (
              <section className={`${settingsUi.group} flex flex-col items-start gap-2 p-6`}>
                <span className="grid size-10 place-items-center rounded-[10px] bg-quaternary text-secondary">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <h2 className="type-title-2-emphasized text-primary">
                  {filter.trim()
                    ? 'No matching tracks'
                    : `No audio files found on ${title}`}
                </h2>
                <p className="max-w-[52ch] type-body-tall text-secondary">
                  {filter.trim()
                    ? 'Try a different title, artist, or folder query.'
                    : `Check the ${title} configuration under Sources.`}
                </p>
              </section>
            ) : (
              <section className={settingsUi.group} aria-label={`${title} tracks`}>
                {filteredTracks.map((track, idx) => (
                  <RemoteTrackRow
                    key={track.id}
                    track={track}
                    onPlay={() => playFromRemote(idx)}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function WebDavLibraryPage() {
  return <RemoteLibraryView kind="webdav" />;
}

export function SmbLibraryPage() {
  return <RemoteLibraryView kind="smb" />;
}
