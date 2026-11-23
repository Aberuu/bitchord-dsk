import { useMutation, useQuery } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderPlus, Music, Play, RefreshCw, Trash2 } from 'lucide-react';
import { useContextMenu } from '@/components/contextMenu';
import { TrackMenu } from '@/components/music/TrackMenu';
import { PageHeader } from '@/components/PageHeader';
import type { Track } from '@/data/music/types';
import { desktopApi, isTauriDesktop, type LocalTrack } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';
import { settingsUi } from './settingsStyles';

function formatSpec(t: LocalTrack): string {
  const parts = [t.codec];
  if (t.sampleRateHz) parts.push(`${+(t.sampleRateHz / 1000).toFixed(1)} kHz`);
  if (t.bitDepth) parts.push(`${t.bitDepth}-bit`);
  return parts.join(' · ');
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toQueueTrack(t: LocalTrack): Track {
  return {
    videoId: t.id,
    title: t.title,
    artists: [{ name: t.artist, id: null }],
    album: t.album ? { name: t.album, id: null } : null,
    durationSec: t.durationSec,
    explicit: false,
    thumbnail: null,
    index: null,
    plays: null,
  };
}

function LocalTrackRow({ track, onPlay }: { track: LocalTrack; onPlay: () => void }) {
  const menu = useContextMenu();
  const queueTrack = toQueueTrack(track);
  return (
    <div
      className="group/row relative grid grid-cols-[36px_minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-tracklist-hover data-open:bg-tracklist-hover hairline-[56px]"
      data-open={menu.isOpen || undefined}
      onContextMenu={menu.openAtEvent}
    >
      <button
        type="button"
        className="grid size-8 cursor-pointer place-items-center rounded-[6px] bg-quaternary text-primary hover:bg-key-bg hover:text-white"
        aria-label={`Play ${track.title}`}
        onClick={onPlay}
      >
        <Play size={13} fill="currentColor" aria-hidden="true" />
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
      <span className="type-callout tabular-nums text-secondary">
        {formatSpec(track)} · {formatDuration(track.durationSec)}
      </span>
      <TrackMenu
        track={queueTrack}
        menu={menu}
        className="grid size-7 place-items-center rounded-full text-key opacity-0 transition-opacity duration-100 ease-in group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-quinary data-open:opacity-100"
      />
    </div>
  );
}

export default function LocalLibraryPage() {
  const desktop = isTauriDesktop();

  const foldersQuery = useQuery({
    queryKey: ['desktop', 'local', 'folders'],
    queryFn: () => desktopApi.localListFolders(),
    enabled: desktop,
  });

  const tracksQuery = useQuery({
    queryKey: ['desktop', 'local', 'tracks'],
    queryFn: () => desktopApi.localListTracks(),
    enabled: desktop,
  });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['desktop', 'local'] });
  };

  const addFolder = useMutation({
    mutationFn: async () => {
      const picked = await open({ directory: true, multiple: false, title: 'Select a music folder' });
      if (!picked || Array.isArray(picked)) return null;
      return desktopApi.localAddFolder(picked);
    },
    onSuccess: refreshAll,
  });

  const rescan = useMutation({
    mutationFn: () => desktopApi.localScan(),
    onSuccess: refreshAll,
  });

  const removeFolder = useMutation({
    mutationFn: (folder: string) => desktopApi.localRemoveFolder(folder),
    onSuccess: refreshAll,
  });

  const folders = foldersQuery.data ?? [];
  const tracks = tracksQuery.data ?? [];

  const playFromLocal = (startIndex: number) => {
    const selected = tracks[startIndex];
    if (!selected) return;
    usePlayer.getState().registerLocalTracks(tracks);
    const queueTracks = tracks.map(toQueueTrack);
    usePlayer.getState().playTracks(queueTracks, startIndex, { title: 'Local Music', type: 'playlist' });
  };

  return (
    <div className="mx-auto max-w-[1120px] pb-16">
      <PageHeader title="Local Music" />
      <div className="mx-(--body-gutter) mt-4 flex flex-col gap-5">
        {!desktop && (
          <section className={`${settingsUi.group} p-5`}>
            <p className="type-title-3 text-primary">Local folder scanning requires BitChord Desktop.</p>
            <p className="mt-1 type-body text-secondary">Supports FLAC, ALAC/M4A, MP3, Opus, Ogg, WAV, and DSD (DSF/DFF).</p>
          </section>
        )}

        {desktop && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-key-bg px-4 py-2 type-callout-emphasized text-white hover:brightness-[1.06] disabled:opacity-50"
                  disabled={addFolder.isPending}
                  onClick={() => addFolder.mutate()}
                >
                  <FolderPlus size={15} aria-hidden="true" />
                  Add Music Folder
                </button>
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-quaternary px-4 py-2 type-callout-emphasized text-primary hover:bg-tertiary/30 disabled:opacity-50"
                  disabled={rescan.isPending || folders.length === 0}
                  onClick={() => rescan.mutate()}
                >
                  <RefreshCw size={14} className={rescan.isPending ? 'animate-spin' : undefined} aria-hidden="true" />
                  {rescan.isPending ? 'Scanning…' : 'Rescan Folders'}
                </button>
              </div>
              {tracks.length > 0 && (
                <button
                  type="button"
                  className="inline-flex cursor-pointer items-center gap-2 rounded-pill bg-quaternary px-4 py-2 type-callout-emphasized text-primary hover:bg-tertiary/30"
                  onClick={() => void playFromLocal(0)}
                >
                  <Play size={14} fill="currentColor" aria-hidden="true" />
                  Play All ({tracks.length})
                </button>
              )}
            </div>

            {folders.length > 0 && (
              <section className={settingsUi.group} aria-label="Watched folders">
                {folders.map((folder) => (
                  <div key={folder} className={settingsUi.row}>
                    <span className="min-w-0 truncate type-body text-primary">{folder}</span>
                    <button
                      type="button"
                      className="grid size-8 flex-none cursor-pointer place-items-center rounded-[6px] text-secondary hover:bg-quaternary hover:text-red"
                      aria-label={`Remove folder ${folder}`}
                      onClick={() => removeFolder.mutate(folder)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </section>
            )}

            {(tracksQuery.isError || addFolder.isError || rescan.isError) && (
              <section className={`${settingsUi.group} p-4`}>
                <p className="type-callout text-red">
                  {String(tracksQuery.error ?? addFolder.error ?? rescan.error)}
                </p>
              </section>
            )}

            {tracksQuery.isPending ? (
              <section className={`${settingsUi.group} p-5`} aria-busy="true">
                <p className="type-body text-secondary">Loading local library…</p>
              </section>
            ) : tracks.length === 0 ? (
              <section className={`${settingsUi.group} flex flex-col items-start gap-2 p-6`}>
                <span className="grid size-10 place-items-center rounded-[10px] bg-quaternary text-secondary">
                  <Music size={20} aria-hidden="true" />
                </span>
                <h2 className="type-title-2-emphasized text-primary">No local music indexed</h2>
                <p className="max-w-[52ch] type-body-tall text-secondary">
                  Add a folder containing FLAC, WAV, M4A/ALAC, MP3, Opus, Ogg, or DSD files. When WASAPI Exclusive mode is enabled in Audio & EQ, local lossless files route straight to your DAC.
                </p>
              </section>
            ) : (
              <section className={settingsUi.group} aria-label="Local tracks">
                {tracks.map((track, idx) => (
                  <LocalTrackRow key={track.id} track={track} onPlay={() => void playFromLocal(idx)} />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
