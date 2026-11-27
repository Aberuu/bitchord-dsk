import {
  Archive,
  AudioLines,
  ChevronRight,
  CircleArrowDown,
  CirclePlay,
  FileMusic,
  Keyboard,
  MessageSquareQuote,
  MonitorDown,
  Paintbrush,
  Puzzle,
  Search,
  SlidersHorizontal,
  Smartphone,
  Speaker,
  User,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { DeveloperWatermark } from '@/components/DeveloperWatermark';
import { PageHeader } from '@/components/PageHeader';
import { PrefetchLink } from '@/components/PrefetchLink';
import { getBootstrapSnapshot, isTauriDesktop } from '@/desktop/tauriBridge';
import { useAudioPipeline } from '@/desktop/useAudioPipeline';
import { useYtAuth } from '@/extension/useYtAuth';
import { useParty } from '@/party/useParty';
import { usePlayer, type StreamingQuality } from '@/state/player';
import { useUi } from '@/state/ui';
import { settingsUi } from './settingsStyles';

const LyricsSettings = lazy(() => import('@/shell/LyricsSettings').then((m) => ({ default: m.LyricsSettings })));

interface SearchEntry {
  id: string;
  title: string;
  subtitle: string;
  keywords: string;
  to?: string;
  action?: () => void;
}

function HubRow({
  to,
  onClick,
  icon,
  title,
  subtitle,
  badge,
  value,
}: {
  to?: string;
  onClick?: () => void;
  icon: ReactNode;
  title: string;
  subtitle?: string | null;
  badge?: string | null;
  value?: string | null;
}) {
  const inner = (
    <>
      <span className={settingsUi.iconPlain}>{icon}</span>
      <span className={settingsUi.rowText}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate type-title-3 text-primary">{title}</span>
          {badge && (
            <span className="shrink-0 whitespace-nowrap rounded-[6px] bg-quaternary px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] text-secondary uppercase">
              {badge}
            </span>
          )}
        </span>
        {subtitle && <span className={settingsUi.rowDetail}>{subtitle}</span>}
      </span>
      <span className={settingsUi.value}>
        {value && <span>{value}</span>}
        <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
      </span>
    </>
  );

  if (to) {
    return (
      <PrefetchLink to={to} className={`${settingsUi.integration} ${settingsUi.linkRow}`}>
        {inner}
      </PrefetchLink>
    );
  }
  return (
    <button type="button" onClick={onClick} className={`${settingsUi.integration} ${settingsUi.linkRow}`}>
      {inner}
    </button>
  );
}

function qualityLabel(q: StreamingQuality): string {
  if (q === 'lossless') return 'Lossless';
  if (q === 'high') return 'High';
  return 'Normal';
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [lyricsOpen, setLyricsOpen] = useState(false);

  const yt = useYtAuth();
  const party = useParty();
  const pipeline = useAudioPipeline();
  const desktop = isTauriDesktop();
  const desktopShell = desktop;
  const setPipelineOpen = useUi((s) => s.setAudioPipelineOpen);
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  const setPairMobileOpen = useUi((s) => s.setPairMobileOpen);
  const minimizeToTray = useUi((s) => s.minimizeToTray);
  const setMinimizeToTray = useUi((s) => s.setMinimizeToTray);
  const directSourceStream = usePlayer((s) => s.directSourceStream);
  const streamingQuality = usePlayer((s) => s.streamingQuality);
  const spatialAudio = usePlayer((s) => s.spatialAudio);
  const { setDirectSourceStream, setSpatialAudio } = usePlayer.getState();

  const activeAccount = yt.state === 'ready' ? yt.auth.active : null;
  const accountSubtitle =
    yt.state === 'checking'
      ? 'Checking account…'
      : activeAccount?.handle || activeAccount?.name || 'YouTube Music, Spotify, Discord & Scrobbling';

  const version = getBootstrapSnapshot()?.version ?? '0.1.0';

  const searchIndex = useMemo<SearchEntry[]>(
    () => [
      {
        id: 'account',
        title: 'Account & integrations',
        subtitle: 'YouTube Music, Spotify, Discord, Last.fm, ListenBrainz, Apple Music',
        keywords: 'account sign in youtube spotify discord scrobble lastfm listenbrainz apple music canvas',
        to: '/settings/integrations',
      },
      {
        id: 'party',
        title: 'Listen together',
        subtitle: 'Share a code and play the same music, in time',
        keywords: 'party sync room invite code friends listen together',
        to: '/settings/listen-together',
      },
      ...(desktopShell
        ? [
            {
              id: 'pair-mobile',
              title: 'Pair Mobile Device (QR)',
              subtitle: 'Sign in on Android by scanning a Desktop QR code',
              keywords: 'pair mobile android ios qr phone sync',
              action: () => setPairMobileOpen(true),
            },
          ]
        : []),
      {
        id: 'sources',
        title: 'Sources',
        subtitle: 'Addons, JioSaavn, YouTube Music, WebDAV, SMB, and track length tolerance',
        keywords: 'sources addon jiosaavn youtube webdav smb share nas tolerance matching priority',
        to: '/settings/sources',
      },
      {
        id: 'quality',
        title: 'Audio Quality',
        subtitle: 'Direct source stream and streaming quality preferences',
        keywords: 'audio quality lossless high normal bitrate direct stream',
        to: '/settings/quality',
      },
      {
        id: 'playback',
        title: 'Playback',
        subtitle: 'Output precision, WASAPI bit-perfect, loudness, crossfade, automix, spatial audio',
        keywords: 'playback output precision 16-bit 32-bit float dac usb wasapi exclusive crossfade automix silence spatial speed sleep timer',
        to: '/settings/playback',
      },
      {
        id: 'equalizer',
        title: 'Equalizer',
        subtitle: 'Dynamic 2D Tone Pad, 7-band curve, 16 presets, channel balance',
        keywords: 'eq equalizer tone pad bands presets bass vocal balance curve frequency',
        to: '/settings/audio',
      },
      {
        id: 'pipeline',
        title: 'Audio Pipeline',
        subtitle: `Live signal path (${pipeline.shortSubtitle})`,
        keywords: 'pipeline signal path decoder resampler dsp bit exact output device wasapi',
        action: () => setPipelineOpen(true),
      },
      {
        id: 'appearance',
        title: 'Appearance',
        subtitle: 'Light / Dark theme, Match Windows, tray behavior, Stats for Nerds, updates, About',
        keywords: 'theme dark light appearance system tray minimize close exit nerd stats updates about credits developer github',
        to: '/settings/appearance',
      },
      {
        id: 'downloads',
        title: 'Downloads',
        subtitle: 'Offline saved songs on this PC',
        keywords: 'downloads offline cache saved songs',
        to: '/library/downloads',
      },
      {
        id: 'local',
        title: 'Local Music',
        subtitle: 'Local folders, FLAC/MP3/WAV scanner',
        keywords: 'local music files folders flac mp3 wav scan',
        to: '/library/local',
      },
      {
        id: 'data',
        title: 'Your data & Replay',
        subtitle: 'Listening cards, Top Songs, Import & Export JSON backup, Poster PNG',
        keywords: 'data backup export import json replay stats listening history cards poster',
        to: '/library',
      },
      {
        id: 'lyrics',
        title: 'Lyric Sources',
        subtitle: 'Provider priority order, syllable timing, lyric providers',
        keywords: 'lyrics providers lrc lrclib musixmatch genius betterlyrics syllables',
        action: () => setLyricsOpen(true),
      },
      {
        id: 'shortcuts',
        title: 'Keyboard shortcuts',
        subtitle: 'Fullscreen (F), Mute (M), Lyrics (L), Up Next (Q), Seek & Volume keys',
        keywords: 'keyboard shortcuts hotkeys keybindings fullscreen mute lyrics queue seek volume',
        action: () => setShortcutsOpen(true),
      },
    ],
    [pipeline.shortSubtitle, setPipelineOpen, setShortcutsOpen],
  );

  const trimmed = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!trimmed) return [];
    return searchIndex.filter(
      (entry) =>
        entry.title.toLowerCase().includes(trimmed) ||
        entry.subtitle.toLowerCase().includes(trimmed) ||
        entry.keywords.includes(trimmed),
    );
  }, [searchIndex, trimmed]);

  return (
    <div className={settingsUi.centered}>
      <PageHeader title="Settings" />
      <div className={settingsUi.body}>
        {/* Search settings field matching Screenshot 1 */}
        <div className="relative mb-5">
          <Search
            size={16}
            strokeWidth={2.2}
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-secondary"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                if (query) {
                  setQuery('');
                } else {
                  e.currentTarget.blur();
                }
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-10 w-full rounded-[14px] border border-search-border/60 bg-quinary pr-9 pl-10 type-body-reduced text-primary placeholder:text-tertiary [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear settings search"
              className="absolute top-1/2 right-2.5 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-tertiary text-page"
            >
              <X size={12} strokeWidth={3} aria-hidden="true" />
            </button>
          )}
        </div>

        {trimmed ? (
          <section className={settingsUi.group} aria-label="Settings search results">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="type-body-emphasized text-primary">No matching settings</p>
                <p className="mt-1 type-callout text-secondary">
                  Try searching for Playback, Equalizer, Audio Pipeline, Theme, or Backup.
                </p>
              </div>
            ) : (
              filtered.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.action) item.action();
                    else if (item.to) void navigate(item.to);
                  }}
                  className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`}
                >
                  <span className={settingsUi.rowText}>
                    <span className="type-title-3 text-primary">{item.title}</span>
                    <span className={settingsUi.rowDetail}>{item.subtitle}</span>
                  </span>
                  <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
                </button>
              ))
            )}
          </section>
        ) : (
          <>
            {/* Top profile & Listen Together card matching Screenshot 1 */}
            <section className={settingsUi.group} aria-label="Account and social">
              <HubRow
                to="/settings/integrations"
                icon={
                  activeAccount?.avatarUrl ? (
                    <img
                      src={activeAccount.avatarUrl}
                      alt=""
                      width={26}
                      height={26}
                      referrerPolicy="no-referrer"
                      className="size-[26px] rounded-full object-cover"
                    />
                  ) : (
                    <span className="grid size-[26px] place-items-center rounded-full bg-quaternary text-primary">
                      <User size={15} aria-hidden="true" />
                    </span>
                  )
                }
                title="Account & integrations"
                subtitle={accountSubtitle}
              />
              <HubRow
                to="/settings/listen-together"
                icon={<Users size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Listen together"
                subtitle={party.code ? `Connected to party ${party.code}` : 'Share a code and play the same music, in time'}
              />
              {desktopShell && (
                <HubRow
                  onClick={() => setPairMobileOpen(true)}
                  icon={<Smartphone size={20} strokeWidth={1.9} aria-hidden="true" />}
                  title="Pair Mobile Device"
                  subtitle="Scan a QR code from BitChord Android to sign in instantly"
                />
              )}
            </section>

            {/* AUDIO QUALITY section matching Screenshot 1 */}
            <h2 className={settingsUi.sectionHeader}>Audio Quality</h2>
            <section className={settingsUi.group} aria-label="Audio quality">
              <HubRow
                to="/settings/sources"
                icon={<Puzzle size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Sources"
                subtitle="Where audio comes from and the order used"
              />
              <label className={settingsUi.controlRow}>
                <span className={`${settingsUi.rowText} pl-[40px]`}>
                  <span>Direct Source Stream</span>
                  <span className={settingsUi.rowDetail}>
                    Wait for addon streams from 0:00 instead of starting immediately and upgrading in the background.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className={settingsUi.switch}
                  checked={directSourceStream}
                  onChange={(e) => setDirectSourceStream(e.currentTarget.checked)}
                />
              </label>
              <HubRow
                to="/settings/quality"
                icon={<Wifi size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="On Desktop"
                badge="IN USE"
                value={qualityLabel(streamingQuality)}
              />
              <label className={settingsUi.controlRow}>
                <span className="flex min-w-0 flex-1 items-start gap-3.5">
                  <span className={`${settingsUi.iconPlain} mt-0.5`}>
                    <Speaker size={20} strokeWidth={1.9} aria-hidden="true" />
                  </span>
                  <span className={settingsUi.rowText}>
                    <span>Spatial Audio</span>
                    <span className={settingsUi.rowDetail}>
                      Play the wider, immersive stereo mix when enabled.
                    </span>
                  </span>
                </span>
                <input
                  type="checkbox"
                  className={settingsUi.switch}
                  checked={spatialAudio}
                  onChange={(e) => setSpatialAudio(e.currentTarget.checked)}
                />
              </label>
            </section>

            {desktop && (
              <>
                <h2 className={settingsUi.sectionHeader}>Desktop Window</h2>
                <section className={settingsUi.group} aria-label="Desktop window behavior">
                  <label className={settingsUi.controlRow}>
                    <span className="flex min-w-0 flex-1 items-start gap-3.5">
                      <span className={`${settingsUi.iconPlain} mt-0.5`}>
                        <MonitorDown size={20} strokeWidth={1.9} aria-hidden="true" />
                      </span>
                      <span className={settingsUi.rowText}>
                        <span>Minimize to System Tray on Close</span>
                        <span className={settingsUi.rowDetail}>
                          Keep music playing in the background instead of exiting when closing the window.
                        </span>
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      className={settingsUi.switch}
                      checked={minimizeToTray}
                      onChange={(e) => setMinimizeToTray(e.currentTarget.checked)}
                    />
                  </label>
                </section>
              </>
            )}

            {/* Grouped Category List matching Screenshot 1 & 2 */}
            <section className={`${settingsUi.group} mt-6`} aria-label="General settings">
              <HubRow
                to="/library/downloads"
                icon={<CircleArrowDown size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Downloads"
              />
              <HubRow
                to="/settings/playback"
                icon={<CirclePlay size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Playback"
              />
              <HubRow
                to="/settings/audio"
                icon={<SlidersHorizontal size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Equalizer"
              />
              <HubRow
                to="/settings/appearance"
                icon={<Paintbrush size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Appearance"
              />
              <HubRow
                to="/library/local"
                icon={<FileMusic size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Local Music"
              />
              <HubRow
                onClick={() => setPipelineOpen(true)}
                icon={<AudioLines size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Audio Pipeline"
                value={pipeline.shortSubtitle}
              />
              <HubRow
                to="/library"
                icon={<Archive size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Your data"
              />
              <HubRow
                onClick={() => setLyricsOpen(true)}
                icon={<MessageSquareQuote size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Lyric Sources"
              />
              <HubRow
                onClick={() => setShortcutsOpen(true)}
                icon={<Keyboard size={20} strokeWidth={1.9} aria-hidden="true" />}
                title="Keyboard shortcuts"
                value="?"
              />
            </section>

            <DeveloperWatermark variant="footer" version={version} />
          </>
        )}
      </div>

      {lyricsOpen && (
        <Suspense fallback={null}>
          <LyricsSettings onClose={() => setLyricsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
