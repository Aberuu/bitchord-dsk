import { useMutation, useQuery } from '@tanstack/react-query';
import { Clock, Download, ImageDown, Play, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { ReplayCardCarousel } from '@/components/replay/ReplayCardCarousel';
import { renderReplayPosterPngBase64 } from '@/components/replay/ReplayPoster';
import type { Track } from '@/data/music/types';
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
import { useYtAuth } from '@/extension/useYtAuth';
import { artworkAtPixels } from '@/lib/artwork';
import { queryClient } from '@/lib/queryClient';
import { usePlayer } from '@/state/player';

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

export default function ReplayPage() {
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
  const holder =
    ytAuth.state === 'ready' && ytAuth.auth.active?.name
      ? ytAuth.auth.active.name
      : 'BitChord Listener';

  const summaryQuery = useQuery({
    queryKey: ['desktop', 'stats', period],
    queryFn: () => statsApi.getSummary(period),
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
            : null;
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
    playTrack(track, { title: `Replay · ${summary?.label ?? 'Top Songs'}`, type: 'library', id: 'replay' });
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

  return (
    <div className="pb-10">
      <div className="flex flex-wrap items-end justify-between gap-3 pr-(--body-gutter)">
        <div>
          <PageHeader title="Replay" />
          <p className="mx-(--body-gutter) -mt-2 mb-4 type-title-3 text-secondary">
            {summary?.label ?? REPLAY_PERIODS.find((p) => p.id === period)?.chip}
          </p>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 pl-(--body-gutter) sm:pl-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importMutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-pill bg-quaternary px-3.5 py-1.5 type-callout-emphasized text-primary transition-colors hover:bg-quinary disabled:opacity-50"
          >
            <Upload size={13} aria-hidden="true" />
            Import Backup
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

      {/* Period Picker matching Android ReplayScreen PeriodPicker */}
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
        onImportBackup={() => fileInputRef.current?.click()}
      />

      {!summaryQuery.isPending && (!summary || summary.songs.length === 0) && (
        <div className="mx-(--body-gutter) mt-6 flex max-w-[480px] flex-col items-center rounded-[16px] bg-quinary px-6 py-10 text-center">
          <Clock size={38} strokeWidth={1.7} className="text-tertiary" aria-hidden="true" />
          <h2 className="mt-3 type-title-2-emphasized text-primary">Not enough listening yet</h2>
          <p className="mt-1.5 type-body-tall text-secondary">
            {period === 'this_week'
              ? 'Play a song this week to build your weekly chart.'
              : period === 'this_month'
                ? 'Play a song this month to see your monthly top songs, artists, and albums.'
                : 'Your listening minutes, top songs, artists, and albums are tallied privately on this PC as you play music.'}
          </p>
        </div>
      )}

      {summary && summary.songs.length > 0 && (
        <div className="mx-(--body-gutter) mt-6 flex flex-col gap-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            {/* Top Songs */}
            <section ref={songsRef} aria-label="Top songs">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="type-title-1-emphasized text-primary">Top Songs</h2>
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
                  <button
                    key={`${song.videoId}-${idx}`}
                    type="button"
                    onClick={() => handlePlaySong(song)}
                    className="relative flex w-full items-center gap-3 px-4 py-2.5 text-start transition-colors hover:bg-tracklist-hover hairline-[56px]"
                  >
                    <RankBadge rank={idx + 1} />
                    <RankedArtwork url={song.artworkUrl} title={song.title} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate type-body-emphasized text-primary">{song.title}</span>
                      <span className="truncate type-callout text-secondary">
                        {[song.artist, formatListening(song.ms)].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    {song.plays > 0 && (
                      <span className="flex-none type-callout text-tertiary tabular-nums">
                        {formatPlays(song.plays)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>

            {/* Top Artists */}
            {topArtists.length > 0 && (
              <section ref={artistsRef} aria-label="Top artists">
                <h2 className="mb-3 type-title-1-emphasized text-primary">Top Artists</h2>
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
            {/* Top Albums */}
            {topAlbums.length > 0 && (
              <section ref={albumsRef} aria-label="Top albums">
                <h2 className="mb-3 type-title-1-emphasized text-primary">Top Albums</h2>
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

            {/* Your Listening Pattern (Habits) */}
            <section aria-label="Your listening pattern">
              <h2 className="mb-3 type-title-1-emphasized text-primary">Your Listening Pattern</h2>
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
    </div>
  );
}
