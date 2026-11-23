import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Clock, Download, FileMusic, ImageDown, Play, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SiSpotify } from 'react-icons/si';
import { useNavigate, useSearchParams } from 'react-router';
import { useContextMenu } from '@/components/contextMenu';
import { PageHeader } from '@/components/PageHeader';
import { PrefetchLink } from '@/components/PrefetchLink';
import { SquareLockup } from '@/components/music/Lockups';
import { TrackMenu } from '@/components/music/TrackMenu';
import { ReplayCardCarousel } from '@/components/replay/ReplayCardCarousel';
import { renderReplayPosterPngBase64 } from '@/components/replay/ReplayPoster';
import { useLibraryPlaylists, useSignedIn } from '@/data/music/queries';
import type { MusicItem, Track } from '@/data/music/types';
import {
  buildReplayCards,
  formatDay,
  formatHour,
  formatListening,
  formatPlays,
  REPLAY_PERIODS,
  statsApi,
  type RankedEntry,
  type RankedSong,
  type ReplayFocus,
  type ReplayPeriod,
} from '@/desktop/statsApi';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { useSpotifySignedIn } from '@/extension/useSpotifyAuth';
import { useYtAuth } from '@/extension/useYtAuth';
import { artworkAtPixels } from '@/lib/artwork';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';
import { seeAllGrid } from './pageStyles';
import { settingsUi } from './settingsStyles';

interface FolderLinkRowProps {
  to: string;
  icon: ReactNode;
  title: string;
  subtitle?: string | null;
}

function rankedSongToTrack(song: RankedSong): Track {
  return {
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
}

function TopSongRow({ song, rank, onPlay }: { song: RankedSong; rank: number; onPlay: () => void }) {
  const menu = useContextMenu();
  const track = rankedSongToTrack(song);
  return (
    <div
      className="group/row relative flex w-full items-center gap-3 px-4 py-2.5 transition-colors duration-150 ease-out hover:bg-tracklist-hover data-open:bg-tracklist-hover hairline-[56px]"
      data-open={menu.isOpen || undefined}
      onContextMenu={menu.openAtEvent}
    >
      <button type="button" onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 text-start">
        <RankBadge rank={rank} />
        <RankedArtwork url={song.artworkUrl} title={song.title} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate type-body-emphasized text-primary">{song.title}</span>
          <span className="truncate type-callout text-secondary">
            {[song.artist, formatListening(song.ms)].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {song.plays > 0 && (
        <span className="flex-none type-callout text-tertiary tabular-nums">
          {formatPlays(song.plays)}
        </span>
      )}
      <TrackMenu
        track={track}
        menu={menu}
        className="grid size-7 flex-none place-items-center rounded-full text-key opacity-0 transition-opacity duration-100 ease-in group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-quinary data-open:opacity-100"
      />
    </div>
  );
}

function FolderLinkRow({ to, icon, title, subtitle }: FolderLinkRowProps) {
  return (
    <PrefetchLink
      to={to}
      className="relative flex min-h-[54px] items-center gap-4 px-4 py-2.5 transition-colors hover:bg-tracklist-hover hairline-[56px]"
    >
      <span className="grid size-6 flex-none place-items-center text-key">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate type-body-reduced text-primary">{title}</span>
        {subtitle && <span className="truncate type-callout text-secondary">{subtitle}</span>}
      </span>
      <ChevronRight size={18} strokeWidth={2.2} className="flex-none text-tertiary" aria-hidden="true" />
    </PrefetchLink>
  );
}

function InitialTile({ title, circular }: { title: string; circular?: boolean }) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  const alnum = /[\p{L}\p{N}]/u.exec(title)?.[0];
  const initial = (alnum || title.trim().slice(0, 1) || '?').toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`grid size-12 flex-none place-items-center type-title-3-emphasized text-white ${
        circular ? 'rounded-full' : 'rounded-[6px]'
      }`}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 55% 44%), hsl(${hue} 55% 32%))`,
      }}
    >
      {initial}
    </span>
  );
}

function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      className={`w-7 flex-none text-start tabular-nums ${
        rank === 1
          ? 'type-[800_18px/22px] text-key'
          : 'type-[700_15px/20px] text-secondary'
      }`}
    >
      {rank}
    </span>
  );
}

function RankedArtwork({
  url,
  title,
  circular,
}: {
  url: string | null;
  title: string;
  circular?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <InitialTile title={title} circular={circular} />;
  return (
    <img
      src={artworkAtPixels(url, 120)}
      alt=""
      width={48}
      height={48}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`size-12 flex-none object-cover ${circular ? 'rounded-full' : 'rounded-[6px]'}`}
    />
  );
}

export default function LibraryOverviewPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState<ReplayPeriod>('all_time');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [posterBusy, setPosterBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const songsRef = useRef<HTMLElement>(null);
  const artistsRef = useRef<HTMLElement>(null);
  const albumsRef = useRef<HTMLElement>(null);

  const playTrack = usePlayer((s) => s.playTrack);
  const ytAuth = useYtAuth();
  const signedIn = useSignedIn();
  const spotifySignedIn = useSpotifySignedIn();
  const playlists = useLibraryPlaylists();
  const desktop = isTauriDesktop();

  const holder =
    ytAuth.state === 'ready' && ytAuth.auth.active?.name
      ? ytAuth.auth.active.name
      : 'BitChord Listener';

  const summaryQuery = useQuery({
    queryKey: ['desktop', 'stats', period],
    queryFn: () => statsApi.getSummary(period),
  });

  const downloadsQuery = useQuery({
    queryKey: ['desktop', 'downloads'],
    queryFn: () => desktopApi.downloadsList(),
    enabled: desktop,
  });

  const localTracksQuery = useQuery({
    queryKey: ['desktop', 'local-tracks'],
    queryFn: () => desktopApi.localListTracks(),
    enabled: desktop,
  });

  useEffect(() => {
    return statsApi.onUpdated(() => {
      void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats'] });
    });
  }, []);

  const focusParam = searchParams.get('focus') as ReplayFocus | null;

  const scrollToFocus = (focus: ReplayFocus) => {
    const target =
      focus === 'songs'
        ? songsRef.current
        : focus === 'artists'
          ? artistsRef.current
          : focus === 'albums'
            ? albumsRef.current
            : songsRef.current;
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!focusParam || !summaryQuery.data || summaryQuery.data.songs.length === 0) return;
    const t = window.setTimeout(() => scrollToFocus(focusParam), 80);
    return () => window.clearTimeout(t);
  }, [focusParam, summaryQuery.data]);

  const importMutation = useMutation({
    mutationFn: (rawJson: string) => statsApi.importBackupJson(rawJson),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats'] });
      setFeedback({
        kind: 'ok',
        text: `Imported ${res.months} month${res.months === 1 ? '' : 's'} (${res.tracks} tracked entries) from BitChord backup.`,
      });
    },
    onError: (err) => {
      setFeedback({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const exportBackupMutation = useMutation({
    mutationFn: async () => {
      const jsonStr = await statsApi.exportBackupJson();
      const dateStr = new Date().toISOString().slice(0, 10);
      const b64 = btoa(unescape(encodeURIComponent(jsonStr)));
      return statsApi.saveFile(`bitchord-backup-${dateStr}.json`, b64, 'application/json');
    },
    onSuccess: (savedTo) => {
      setFeedback({ kind: 'ok', text: `Backup exported: ${savedTo}` });
    },
    onError: (err) => {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    },
  });

  const summary = summaryQuery.data;
  const cards = buildReplayCards(summary);
  const topSongs = summary?.songs.slice(0, 5) ?? [];
  const topArtists = summary?.artists.slice(0, 5) ?? [];
  const topAlbums = summary?.albums.slice(0, 5) ?? [];

  const triggerImport = () => {
    fileInputRef.current?.click();
  };

  const handleSavePoster = async () => {
    if (!summary || summary.songs.length === 0 || posterBusy) return;
    setPosterBusy(true);
    try {
      const pngBase64 = await renderReplayPosterPngBase64(summary, holder);
      const dateStr = new Date().toISOString().slice(0, 10);
      const savedPath = await statsApi.saveFile(
        `bitchord-replay-${period}-${dateStr}.png`,
        pngBase64,
        'image/png',
      );
      setFeedback({ kind: 'ok', text: `Replay poster saved: ${savedPath}` });
    } catch (err) {
      setFeedback({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setPosterBusy(false);
    }
  };

  const handlePlaySong = (song: RankedSong) => {
    playTrack(rankedSongToTrack(song), { title: `Library · ${summary?.label ?? 'Top Songs'}`, type: 'library', id: 'replay' });
  };

  const handleOpenArtist = (artist: RankedEntry) => {
    if (artist.browseId) {
      void navigate(`/artist/${encodeURIComponent(artist.browseId)}`);
    } else {
      void navigate(`/search?q=${encodeURIComponent(artist.title)}`);
    }
  };

  const handleOpenAlbum = (album: RankedEntry) => {
    if (album.browseId) {
      void navigate(`/album/${encodeURIComponent(album.browseId)}`);
    } else {
      const q = [album.title, album.subtitle].filter(Boolean).join(' ');
      void navigate(`/search?q=${encodeURIComponent(q)}`);
    }
  };

  const playlistItems: MusicItem[] =
    playlists.data?.map((p) => ({
      kind: 'playlist',
      id: p.id,
      title: p.title,
      subtitle: p.subtitle ?? '',
      artists: [],
      album: null,
      thumbnail: p.thumbnail,
      wide: false,
      durationSec: null,
      explicit: false,
    })) ?? [];

  const downloadsCount = downloadsQuery.data?.length ?? 0;
  const localCount = localTracksQuery.data?.length ?? 0;

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3 pr-(--body-gutter)">
        <div>
          <PageHeader title="Library" />
          <p className="mx-(--body-gutter) -mt-2 mb-3 type-title-3 text-secondary">
            {summary?.label ?? REPLAY_PERIODS.find((p) => p.id === period)?.chip}
          </p>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 pl-(--body-gutter) sm:pl-0">
          <button
            type="button"
            onClick={triggerImport}
            disabled={importMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-pill bg-quaternary px-3.5 py-1.5 type-callout-emphasized text-primary transition-colors hover:bg-quinary disabled:opacity-50"
          >
            <Upload size={13} aria-hidden="true" />
            {importMutation.isPending ? 'Importing…' : 'Import Backup'}
          </button>
          <button
            type="button"
            onClick={() => exportBackupMutation.mutate()}
            disabled={exportBackupMutation.isPending || !summary || summary.songs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-pill bg-quaternary px-3.5 py-1.5 type-callout-emphasized text-primary transition-colors hover:bg-quinary disabled:opacity-45"
          >
            <Download size={13} aria-hidden="true" />
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => void handleSavePoster()}
            disabled={posterBusy || !summary || summary.songs.length === 0}
            className="inline-flex items-center gap-1.5 rounded-pill bg-key-bg px-3.5 py-1.5 type-callout-emphasized text-white transition-opacity hover:opacity-92 disabled:opacity-45"
          >
            <ImageDown size={13} aria-hidden="true" />
            {posterBusy ? 'Rendering Poster…' : 'Save Poster PNG'}
          </button>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-label="Import BitChord backup JSON"
        onChange={(ev) => {
          const file = ev.currentTarget.files?.[0];
          ev.currentTarget.value = '';
          if (!file) return;
          void file.text().then((raw) => importMutation.mutate(raw));
        }}
      />

      <div className="mx-(--body-gutter) mb-4 max-w-[440px]">
        <div
          role="tablist"
          aria-label="Replay period"
          className="grid grid-cols-4 gap-1 rounded-[12px] bg-segmented p-1"
        >
          {REPLAY_PERIODS.map((item) => {
            const active = item.id === period;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setPeriod(item.id)}
                className={`truncate rounded-[9px] px-2 py-1.5 text-center type-callout-emphasized transition-colors ${
                  active
                    ? 'bg-segmented-selected text-primary shadow-xs'
                    : 'text-secondary hover:text-primary'
                }`}
              >
                {item.tab}
              </button>
            );
          })}
        </div>
      </div>

      {feedback && (
        <div
          role="status"
          className={`mx-(--body-gutter) mb-4 flex items-center justify-between gap-3 rounded-[10px] px-4 py-2.5 type-callout ${
            feedback.kind === 'ok' ? 'bg-quinary text-primary' : 'bg-red/12 text-red'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="type-callout-emphasized text-secondary hover:text-primary"
          >
            Dismiss
          </button>
        </div>
      )}

      <ReplayCardCarousel
        cards={cards}
        holder={holder}
        memberSince={summary?.memberSince ?? null}
        loading={summaryQuery.isPending}
        onSelectCard={(focus) => {
          setSearchParams({ focus }, { replace: true });
          scrollToFocus(focus);
        }}
        onImportBackup={triggerImport}
      />

      <div className="mx-(--body-gutter) mt-3 max-w-[780px]">
        <section className={settingsUi.group} aria-label="Library folders">
          <FolderLinkRow
            to="/library/downloads"
            icon={<Download size={20} strokeWidth={1.9} aria-hidden="true" />}
            title="Downloads"
            subtitle={desktop && downloadsCount > 0 ? `${downloadsCount} downloaded songs` : 'Offline saved songs'}
          />
          <FolderLinkRow
            to="/library/local"
            icon={<FileMusic size={20} strokeWidth={1.9} aria-hidden="true" />}
            title="Local Music"
            subtitle={desktop && localCount > 0 ? `${localCount} audio files indexed` : 'Audio files on this PC'}
          />
          {spotifySignedIn && (
            <FolderLinkRow
              to="/spotify"
              icon={<SiSpotify size={19} className="text-[#1ed760]" aria-hidden="true" />}
              title="Spotify"
              subtitle="Playlists from your connected Spotify account"
            />
          )}
        </section>
      </div>

      {!summaryQuery.isPending && (!summary || summary.songs.length === 0) && period !== 'all_time' && (
        <div className="mx-(--body-gutter) mt-6 flex max-w-[540px] items-center gap-3 rounded-[12px] bg-quinary px-5 py-4">
          <Clock size={22} strokeWidth={1.8} className="flex-none text-tertiary" aria-hidden="true" />
          <p className="type-body text-secondary">
            {period === 'this_week'
              ? 'No songs tracked this week yet. Switch to Lifetime or Yearly to view your historical top songs, artists, and albums.'
              : 'No songs tracked this month yet. Switch to Lifetime or Yearly to view your historical top songs, artists, and albums.'}
          </p>
        </div>
      )}

      {summary && summary.songs.length > 0 && (
        <div className="mx-(--body-gutter) mt-8 flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <section ref={songsRef} aria-label="Top songs">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="type-title-2-emphasized text-primary">Top Songs</h2>
                {topSongs[0] && (
                  <button
                    type="button"
                    onClick={() => handlePlaySong(topSongs[0]!)}
                    className="inline-flex items-center gap-1.5 rounded-pill bg-quinary px-3 py-1 type-callout-emphasized text-primary hover:bg-quaternary"
                  >
                    <Play size={12} fill="currentColor" aria-hidden="true" />
                    Play #1
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-[12px] bg-quinary">
                {topSongs.map((song, idx) => (
                  <TopSongRow
                    key={`${song.videoId}-${idx}`}
                    song={song}
                    rank={idx + 1}
                    onPlay={() => handlePlaySong(song)}
                  />
                ))}
              </div>
            </section>

            {topArtists.length > 0 && (
              <section ref={artistsRef} aria-label="Top artists">
                <h2 className="mb-3 type-title-2-emphasized text-primary">Top Artists</h2>
                <div className="overflow-hidden rounded-[12px] bg-quinary">
                  {topArtists.map((artist, idx) => (
                    <button
                      key={`${artist.title}-${idx}`}
                      type="button"
                      onClick={() => handleOpenArtist(artist)}
                      className="relative flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-tracklist-hover hairline-[56px]"
                    >
                      <RankBadge rank={idx + 1} />
                      <RankedArtwork url={artist.artworkUrl} title={artist.title} circular />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate type-body-emphasized text-primary">{artist.title}</span>
                        <span className="truncate type-callout text-secondary">
                          {formatListening(artist.ms)}
                        </span>
                      </span>
                      {artist.plays > 0 && (
                        <span className="flex-none type-callout text-tertiary tabular-nums">
                          {formatPlays(artist.plays)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            {topAlbums.length > 0 && (
              <section ref={albumsRef} aria-label="Top albums">
                <h2 className="mb-3 type-title-2-emphasized text-primary">Top Albums</h2>
                <div className="overflow-hidden rounded-[12px] bg-quinary">
                  {topAlbums.map((album, idx) => (
                    <button
                      key={`${album.title}-${idx}`}
                      type="button"
                      onClick={() => handleOpenAlbum(album)}
                      className="relative flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-tracklist-hover hairline-[56px]"
                    >
                      <RankBadge rank={idx + 1} />
                      <RankedArtwork url={album.artworkUrl} title={album.title} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate type-body-emphasized text-primary">{album.title}</span>
                        <span className="truncate type-callout text-secondary">
                          {[album.subtitle, formatListening(album.ms)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      {album.plays > 0 && (
                        <span className="flex-none type-callout text-tertiary tabular-nums">
                          {formatPlays(album.plays)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section aria-label="Your listening pattern">
              <h2 className="mb-3 type-title-2-emphasized text-primary">Your Listening Pattern</h2>
              <div className="grid grid-cols-3 gap-2.5">
                <div className="flex flex-col items-center rounded-[14px] bg-quinary px-3 py-4 text-center">
                  <span className="type-[800_24px/28px] text-primary tabular-nums">
                    {summary.distinctSongs}
                  </span>
                  <span className="mt-1 type-caption-2 tracking-[0.08em] text-secondary uppercase">
                    Songs
                  </span>
                </div>
                <div className="flex flex-col items-center rounded-[14px] bg-quinary px-3 py-4 text-center">
                  <span className="type-[800_24px/28px] text-primary tabular-nums">
                    {summary.distinctArtists}
                  </span>
                  <span className="mt-1 type-caption-2 tracking-[0.08em] text-secondary uppercase">
                    Artists
                  </span>
                </div>
                <div className="flex flex-col items-center rounded-[14px] bg-quinary px-3 py-4 text-center">
                  <span className="type-[800_24px/28px] text-primary tabular-nums">
                    {summary.distinctAlbums}
                  </span>
                  <span className="mt-1 type-caption-2 tracking-[0.08em] text-secondary uppercase">
                    Albums
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-col gap-1.5 rounded-[12px] bg-quinary px-4 py-3">
                {summary.peakHour !== null && (
                  <p className="type-body text-secondary">
                    You listen the most around{' '}
                    <span className="type-body-emphasized text-primary">{formatHour(summary.peakHour)}</span>.
                  </p>
                )}
                {summary.busiestDay && (
                  <p className="type-body text-secondary">
                    Your biggest day was{' '}
                    <span className="type-body-emphasized text-primary">{formatDay(summary.busiestDay)}</span>{' '}
                    with {formatListening(summary.busiestDayMs)}.
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      <section className="mt-8" aria-label="Playlists">
        <div className="mx-(--body-gutter) mb-3.5 flex items-center justify-between">
          <h2 className="type-title-2-emphasized">
            <PrefetchLink to="/library/playlists" className="group/title inline-flex items-center gap-0.5">
              Playlists
              <ChevronRight size={18} strokeWidth={2.6} className="text-secondary group-hover/title:text-primary" />
            </PrefetchLink>
          </h2>
        </div>

        {!signedIn ? (
          <div className="mx-(--body-gutter) max-w-[540px] rounded-[12px] bg-quinary px-5 py-4">
            <p className="type-body-emphasized text-primary">Sign in to see your YouTube Music playlists</p>
            <p className="mt-1 type-callout text-secondary">
              Your local downloads, local folders, and Replay listening cards work offline. Connect YouTube Music in the sidebar or Settings to sync your cloud playlists.
            </p>
          </div>
        ) : playlistItems.length === 0 ? (
          <div className="mx-(--body-gutter) max-w-[540px] rounded-[12px] bg-quinary px-5 py-4">
            <p className="type-body text-secondary">
              {playlists.isPending ? 'Loading playlists…' : 'No playlists saved in your YouTube Music library yet.'}
            </p>
          </div>
        ) : (
          <ul className={seeAllGrid}>
            {playlistItems.slice(0, 12).map((item) => (
              <li key={item.id}>
                <SquareLockup item={item} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
