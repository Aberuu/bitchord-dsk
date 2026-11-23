import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useContextMenu } from '@/components/contextMenu';
import { TrackMenu } from '@/components/music/TrackMenu';
import { PageHeader } from '@/components/PageHeader';
import type { Track } from '@/data/music/types';
import { desktopApi, isTauriDesktop, type DownloadedTrack, type DownloadProgress } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';
import { settingsUi } from './settingsStyles';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toQueueTrack(item: DownloadedTrack): Track {
  return {
    videoId: item.videoId,
    title: item.title,
    artists: item.artist ? item.artist.split(', ').map((name) => ({ name, id: null })) : [],
    album: item.album ? { name: item.album, id: null } : null,
    durationSec: item.durationSec,
    explicit: false,
    thumbnail: item.artworkUrl,
    index: null,
    plays: null,
  };
}

function DownloadedTrackRow({
  item,
  removing,
  onPlay,
  onDelete,
}: {
  item: DownloadedTrack;
  removing: boolean;
  onPlay: () => void;
  onDelete: () => void;
}) {
  const menu = useContextMenu();
  return (
    <div
      className="group/row relative grid grid-cols-[44px_minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-tracklist-hover data-open:bg-tracklist-hover hairline-[68px]"
      data-open={menu.isOpen || undefined}
      onContextMenu={menu.openAtEvent}
    >
      <button
        type="button"
        className="relative size-10 cursor-pointer overflow-hidden rounded-[6px] bg-quaternary"
        aria-label={`Play ${item.title}`}
        onClick={onPlay}
      >
        {item.artworkUrl ? (
          <img src={item.artworkUrl} alt="" width={40} height={40} className="size-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid size-full place-items-center text-secondary">
            <Play size={14} aria-hidden="true" />
          </span>
        )}
      </button>
      <button
        type="button"
        className="flex min-w-0 cursor-pointer flex-col text-start"
        onClick={onPlay}
      >
        <span className="truncate type-body-emphasized text-primary">{item.title}</span>
        <span className="truncate type-callout text-secondary">
          {item.artist}
          {item.album ? ` · ${item.album}` : ''}
        </span>
      </button>
      <span className="type-callout tabular-nums text-secondary">
        {item.format}
        {item.bitrateKbps ? ` · ${item.bitrateKbps} kbps` : ''} · {formatDuration(item.durationSec)}
      </span>
      <TrackMenu
        track={toQueueTrack(item)}
        menu={menu}
        className="grid size-7 place-items-center rounded-full text-key opacity-0 transition-opacity duration-100 ease-in group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-quinary data-open:opacity-100"
      />
      <button
        type="button"
        className="grid size-8 cursor-pointer place-items-center rounded-[6px] text-secondary hover:bg-quaternary hover:text-red disabled:opacity-40"
        aria-label={`Delete ${item.title}`}
        disabled={removing}
        onClick={onDelete}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function DownloadsPage() {
  const desktop = isTauriDesktop();
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    void desktopApi
      .onDownloadProgress((ev) => {
        if (!active) return;
        setProgress((prev) => ({ ...prev, [ev.videoId]: ev }));
        if (ev.status === 'done') {
          void queryClient.invalidateQueries({ queryKey: ['desktop', 'downloads'] });
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
  }, [desktop]);

  const query = useQuery({
    queryKey: ['desktop', 'downloads'],
    queryFn: () => desktopApi.downloadsList(),
    enabled: desktop,
  });

  const remove = useMutation({
    mutationFn: (videoId: string) => desktopApi.downloadsDelete(videoId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['desktop', 'downloads'] }),
  });

  const items = query.data ?? [];
  const totalBytes = items.reduce((sum, t) => sum + t.fileSizeBytes, 0);
  const activeJobs = Object.values(progress).filter((p) => p.status === 'downloading');

  const playAll = (startIndex: number) => {
    if (!items.length) return;
    const tracks = items.map(toQueueTrack);
    usePlayer.getState().playTracks(tracks, startIndex, { title: 'Downloads', type: 'playlist' });
  };

  return (
    <div className="mx-auto max-w-[1120px] pb-16">
      <PageHeader title="Downloads" />
      <div className="mx-(--body-gutter) mt-4 flex flex-col gap-5">
        {!desktop && (
          <section className={`${settingsUi.group} p-5`}>
            <p className="type-title-3 text-primary">Offline downloads are available in the BitChord Desktop app.</p>
            <p className="mt-1 type-body text-secondary">Launch BitChord through Tauri to save audio with embedded tags locally.</p>
          </section>
        )}

        {desktop && activeJobs.length > 0 && (
          <section className={settingsUi.group} aria-label="Active downloads">
            {activeJobs.map((job) => (
              <div key={job.videoId} className={settingsUi.row}>
                <span className="type-body text-primary">Downloading {job.videoId}</span>
                <span className="type-callout tabular-nums text-secondary">{Math.round(job.progress * 100)}%</span>
              </div>
            ))}
          </section>
        )}

        {desktop && query.isPending && (
          <section className={`${settingsUi.group} p-5`} aria-busy="true">
            <p className="type-body text-secondary">Loading downloaded tracks…</p>
          </section>
        )}

        {desktop && query.isError && (
          <section className={`${settingsUi.group} flex items-center justify-between gap-4 p-5`}>
            <div>
              <p className="type-title-3 text-primary">Could not read the downloads database.</p>
              <p className="mt-1 type-callout text-red">{String(query.error)}</p>
            </div>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-pill bg-quaternary px-4 py-2 type-callout-emphasized text-primary hover:bg-tertiary/30"
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Retry
            </button>
          </section>
        )}

        {desktop && !query.isPending && !query.isError && items.length === 0 && (
          <section className={`${settingsUi.group} flex flex-col items-start gap-2 p-6`}>
            <span className="grid size-10 place-items-center rounded-[10px] bg-quaternary text-secondary">
              <Download size={20} aria-hidden="true" />
            </span>
            <h2 className="type-title-2-emphasized text-primary">No offline tracks yet</h2>
            <p className="max-w-[52ch] type-body-tall text-secondary">
              Open the menu on any YouTube Music track and choose Download Offline. Saved files keep their title, artist, album, and cover artwork so you can play them without an internet connection.
            </p>
          </section>
        )}

        {desktop && items.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="type-callout tabular-nums text-secondary">
                {items.length} {items.length === 1 ? 'track' : 'tracks'} · {formatBytes(totalBytes)} on disk
              </p>
              <button
                type="button"
                className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-key-bg px-4 py-2 type-callout-emphasized text-white hover:brightness-[1.06]"
                onClick={() => playAll(0)}
              >
                <Play size={14} fill="currentColor" aria-hidden="true" />
                Play All
              </button>
            </div>

            <section className={settingsUi.group} aria-label="Downloaded tracks">
              {items.map((item, idx) => (
                <DownloadedTrackRow
                  key={item.videoId}
                  item={item}
                  removing={remove.isPending}
                  onPlay={() => playAll(idx)}
                  onDelete={() => remove.mutate(item.videoId)}
                />
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
