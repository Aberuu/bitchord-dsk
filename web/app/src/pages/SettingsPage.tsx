import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Radio, RefreshCw, SlidersHorizontal, Users } from 'lucide-react';
import { lazy, Suspense, useState, type ComponentType, type ReactNode } from 'react';
import { SiApplemusic, SiDiscord, SiSpotify, SiYoutubemusic } from 'react-icons/si';
import { PageHeader } from '@/components/PageHeader';
import { PrefetchLink } from '@/components/PrefetchLink';
import { Select } from '@/components/Select';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { useDiscord } from '@/extension/useDiscord';
import { useExtension } from '@/extension/useExtension';
import { useYtAuth } from '@/extension/useYtAuth';
import { queryClient } from '@/lib/queryClient';
import { useParty } from '@/party/useParty';
import { AUTOMIX_BARS } from '@/playback/automix/choices';
import { useHistorySettings } from '@/playback/historyReporting';
import { CROSSFADE_CHOICES, usePlayer } from '@/state/player';
import { useUi, type ThemePreference } from '@/state/ui';
import {
  AppleMusicIntegration,
  AppleMusicToggles,
  CanvasToggle,
  LyricSourcesAccess,
  SpotifyIntegration,
  Toggle,
} from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const LyricsSettings = lazy(() => import('@/shell/LyricsSettings').then((m) => ({ default: m.LyricsSettings })));

function Glyph({ Icon, color, ink }: { Icon: ComponentType<{ size?: number }>; color: string; ink?: string }) {
  return (
    <span className={settingsUi.integrationIcon} style={{ backgroundColor: color, ...(ink && { color: ink }) }}>
      <Icon size={15} />
    </span>
  );
}

function LinkRow({ to, icon, title, value }: { to: string; icon?: ReactNode; title: string; value?: string | null }) {
  return (
    <PrefetchLink to={to} className={`${icon ? settingsUi.integration : settingsUi.integrationPlain} ${settingsUi.linkRow}`}>
      {icon}
      <span className={settingsUi.integrationName}>{title}</span>
      <span className={settingsUi.value}>
        {value}
        <ChevronRight size={16} aria-hidden="true" />
      </span>
    </PrefetchLink>
  );
}

function youtubeText(auth: ReturnType<typeof useYtAuth>): string {
  if (auth.state === 'checking') return 'Checking…';
  if (auth.state === 'unavailable') return 'Unavailable';
  const { browserSignedIn, connected, active } = auth.auth;
  if (!browserSignedIn) return 'Not signed in';
  if (!connected) return 'Disconnected';
  return active ? active.name : 'Signed in';
}

function ScrobblingSection() {
  const [lbToken, setLbToken] = useState('');
  const [lfmKey, setLfmKey] = useState('');
  const [lfmSecret, setLfmSecret] = useState('');
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const stateQuery = useQuery({
    queryKey: ['desktop', 'scrobble'],
    queryFn: () => desktopApi.scrobbleGetState(),
  });

  const save = useMutation({
    mutationFn: desktopApi.scrobbleUpdateConfig,
    onSuccess: (next) => {
      queryClient.setQueryData(['desktop', 'scrobble'], next);
      setFeedback('Scrobbling settings saved.');
    },
    onError: (err) => setFeedback(String(err)),
  });

  const startLfm = useMutation({
    mutationFn: () => desktopApi.scrobbleLastfmStart(),
    onSuccess: (res) => {
      setPendingToken(res.token);
      window.open(res.authUrl, '_blank', 'noreferrer');
      setFeedback('Approve BitChord in the browser tab, then click Complete Last.fm Sign-In.');
    },
    onError: (err) => setFeedback(String(err)),
  });

  const finishLfm = useMutation({
    mutationFn: (tok: string) => desktopApi.scrobbleLastfmFinish(tok),
    onSuccess: (next) => {
      queryClient.setQueryData(['desktop', 'scrobble'], next);
      setPendingToken(null);
      setFeedback(`Connected Last.fm as ${next.lastfmUsername ?? 'your account'}.`);
    },
    onError: (err) => setFeedback(String(err)),
  });

  const disconnectLfm = useMutation({
    mutationFn: () => desktopApi.scrobbleDisconnectLastfm(),
    onSuccess: (next) => {
      queryClient.setQueryData(['desktop', 'scrobble'], next);
      setFeedback('Disconnected from Last.fm.');
    },
  });

  const st = stateQuery.data;

  return (
    <>
      <h2 className={settingsUi.sectionHeader}>Scrobbling</h2>
      <section className={settingsUi.group}>
        <div className={settingsUi.integration}>
          <Glyph Icon={Radio} color="#d51007" />
          <span className={settingsUi.integrationName}>Last.fm / Libre.fm</span>
          <span className={settingsUi.value}>
            <span>{st?.lastfmConnected ? `Signed in as ${st.lastfmUsername}` : st?.lastfmConfigured ? 'API keys saved' : 'Not configured'}</span>
            {st?.lastfmConnected ? (
              <button type="button" className={settingsUi.inlineButton} onClick={() => disconnectLfm.mutate()}>
                Disconnect
              </button>
            ) : pendingToken ? (
              <button type="button" className={settingsUi.inlineButton} onClick={() => finishLfm.mutate(pendingToken)}>
                Complete Sign-In
              </button>
            ) : st?.lastfmConfigured ? (
              <button type="button" className={settingsUi.inlineButton} onClick={() => startLfm.mutate()}>
                Connect
              </button>
            ) : null}
          </span>
        </div>

        <form
          className="flex flex-col gap-2.5 px-4 py-3 hairline-[16px]"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              ...(lfmKey.trim() && { lastfmApiKey: lfmKey.trim() }),
              ...(lfmSecret.trim() && { lastfmApiSecret: lfmSecret.trim() }),
              ...(lbToken.trim() && { listenbrainzToken: lbToken.trim() }),
            });
            setLfmKey('');
            setLfmSecret('');
            setLbToken('');
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="type-callout text-secondary">Last.fm API Key</span>
              <input
                type="text"
                className="rounded-[8px] border-0 bg-quaternary px-2.5 py-1.5 type-body text-primary"
                placeholder={st?.lastfmConfigured ? 'Configured (enter to replace)' : 'Paste API key'}
                value={lfmKey}
                onChange={(e) => setLfmKey(e.currentTarget.value)}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="type-callout text-secondary">Last.fm Shared Secret</span>
              <input
                type="password"
                className="rounded-[8px] border-0 bg-quaternary px-2.5 py-1.5 type-body text-primary"
                placeholder={st?.lastfmConfigured ? 'Configured (enter to replace)' : 'Paste shared secret'}
                value={lfmSecret}
                onChange={(e) => setLfmSecret(e.currentTarget.value)}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="type-callout text-secondary">ListenBrainz User Token</span>
            <input
              type="password"
              className="rounded-[8px] border-0 bg-quaternary px-2.5 py-1.5 type-body text-primary"
              placeholder={st?.listenbrainzConnected ? 'Token saved in Windows vault (enter to replace)' : 'Paste ListenBrainz token'}
              value={lbToken}
              onChange={(e) => setLbToken(e.currentTarget.value)}
            />
          </label>
          <div className="flex items-center justify-between pt-1">
            <span className="type-callout text-secondary">
              {st?.listenbrainzConnected ? 'ListenBrainz connected' : 'ListenBrainz not connected'}
            </span>
            <button
              type="submit"
              disabled={!lfmKey.trim() && !lfmSecret.trim() && !lbToken.trim()}
              className="cursor-pointer rounded-pill bg-key-bg px-3.5 py-1.5 type-callout-emphasized text-white disabled:opacity-45"
            >
              Save Credentials
            </button>
          </div>
        </form>

        <Toggle
          label="Scrobble Primary Artist Only"
          detail="Strips featured artists so scrobbles group under the main artist."
          checked={st?.primaryArtistOnly ?? false}
          onChange={(primaryArtistOnly) => save.mutate({ primaryArtistOnly })}
        />
      </section>
      {feedback && <p className={settingsUi.footer}>{feedback}</p>}
    </>
  );
}

export default function SettingsPage() {
  const desktop = isTauriDesktop();
  const extension = useExtension();
  const yt = useYtAuth();
  const discord = useDiscord();
  const party = useParty();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const minimizeToTray = useUi((s) => s.minimizeToTray);
  const setMinimizeToTray = useUi((s) => s.setMinimizeToTray);

  const autoplay = usePlayer((s) => s.autoplay);
  const crossfadeSec = usePlayer((s) => s.crossfadeSec);
  const automix = usePlayer((s) => s.automix);
  const automixBars = usePlayer((s) => s.automixBars);
  const showNerdStats = usePlayer((s) => s.showNerdStats);
  const shareHistory = useHistorySettings((s) => s.share);
  const setShareHistory = useHistorySettings((s) => s.setShare);
  const { setAutoplay, setCrossfade, setAutomix, setAutomixBars, setShowNerdStats } = usePlayer.getState();

  const [lyrics, setLyrics] = useState(false);
  const updateCheck = useMutation({ mutationFn: () => desktopApi.checkForUpdates() });

  const present = extension.state === 'present';
  const discordText =
    discord.state === 'ready' && discord.discord.connected
      ? discord.discord.enabled
        ? 'On'
        : 'Off'
      : discord.state === 'ready' && discord.discord.available
        ? 'Not connected'
        : null;

  return (
    <div className={settingsUi.centered}>
      <PageHeader title="Settings" />
      <div className={settingsUi.body}>
        <h2 className={settingsUi.sectionHeader}>Appearance & Desktop</h2>
        <section className={settingsUi.group}>
          <label className={settingsUi.controlRow}>
            <span>Appearance</span>
            <Select<ThemePreference>
              label="Appearance"
              value={theme}
              options={[
                { value: 'system', label: 'Match Windows' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={setTheme}
            />
          </label>
          {desktop && (
            <>
              <Toggle
                label="Minimize to System Tray on Close"
                detail="Keep music playing in the background when you close the main window."
                checked={minimizeToTray}
                onChange={setMinimizeToTray}
              />
              <div className={settingsUi.row}>
                <span className={settingsUi.rowText}>
                  <span>App Updates</span>
                  <span className={settingsUi.rowDetail}>
                    {updateCheck.data?.notes ?? 'Check for stream-resolver and desktop fixes.'}
                  </span>
                </span>
                <button
                  type="button"
                  className={settingsUi.inlineButton}
                  disabled={updateCheck.isPending}
                  onClick={() => updateCheck.mutate()}
                >
                  <span className="inline-flex items-center gap-1">
                    <RefreshCw size={12} className={updateCheck.isPending ? 'animate-spin' : undefined} aria-hidden="true" />
                    {updateCheck.isPending ? 'Checking…' : 'Check Now'}
                  </span>
                </button>
              </div>
            </>
          )}
        </section>

        <h2 className={settingsUi.sectionHeader}>Account & Integrations</h2>
        <section className={settingsUi.group}>
          <div className={settingsUi.integration}>
            <Glyph Icon={SiYoutubemusic} color="#ffffff" ink="#ff0033" />
            <span className={settingsUi.integrationName}>YouTube Music</span>
            <span className={settingsUi.value}>
              <span>{youtubeText(yt)}</span>
              {desktop && (
                <button
                  type="button"
                  className={settingsUi.inlineButton}
                  onClick={() =>
                    yt.state === 'ready' && yt.auth.signedIn
                      ? void desktopApi.signOutYt()
                      : void desktopApi.openYtSignIn()
                  }
                >
                  {yt.state === 'ready' && yt.auth.signedIn ? 'Sign Out' : 'Sign In'}
                </button>
              )}
            </span>
          </div>
          <div className={settingsUi.integration}>
            <Glyph Icon={SiSpotify} color="#1ed760" />
            <span className={settingsUi.integrationName}>Spotify</span>
            {present ? <SpotifyIntegration /> : <span className={settingsUi.value}>Unavailable</span>}
          </div>
          {present && discord.state === 'ready' && discord.discord.available && (
            <LinkRow to="/settings/discord" icon={<Glyph Icon={SiDiscord} color="#5865f2" />} title="Discord" value={discordText} />
          )}
        </section>

        <section className={`${settingsUi.group} mt-3 empty:hidden`}>
          <Toggle
            label="Share Listening Activity to YouTube"
            detail="Songs you play here go to your YouTube Music history and shape its recommendations."
            checked={shareHistory}
            onChange={setShareHistory}
          />
          <CanvasToggle />
        </section>

        {desktop && <ScrobblingSection />}

        <h2 className={settingsUi.sectionHeader}>Apple Music</h2>
        <section className={settingsUi.group}>
          {!desktop && (
            <div className={settingsUi.integration}>
              <Glyph Icon={SiApplemusic} color="#fa2d48" />
              <span className={settingsUi.integrationName}>Extension Access</span>
              {present ? <AppleMusicIntegration /> : <span className={settingsUi.value}>Needs the extension</span>}
            </div>
          )}
          <AppleMusicToggles />
        </section>
        <p className={settingsUi.footer}>From Apple Music public pages. No Apple Music account or sign-in needed.</p>

        <h2 className={settingsUi.sectionHeader}>Listen Together</h2>
        <section className={settingsUi.group}>
          <LinkRow
            to="/settings/listen-together"
            icon={<Glyph Icon={Users} color="#fa2d48" />}
            title="Listen Together"
            value={party.code ? `In party ${party.code}` : 'Self-hosted party sync'}
          />
        </section>

        <h2 className={settingsUi.sectionHeader}>Playback & Audio</h2>
        <section className={settingsUi.group}>
          <LinkRow
            to="/settings/audio"
            icon={<Glyph Icon={SlidersHorizontal} color="#3a3a3c" />}
            title="Audio Output, Bit-Perfect & Equalizer"
            value="WASAPI, Speed, Sleep Timer, EQ"
          />
          <Toggle
            label="AutoPlay"
            detail="When the queue ends, keep playing similar music."
            checked={autoplay}
            onChange={setAutoplay}
          />
          <label className={settingsUi.controlRow}>
            <span>Crossfade</span>
            <Select<number | 'automix'>
              label="Crossfade"
              value={automix ? 'automix' : crossfadeSec}
              options={[
                ...CROSSFADE_CHOICES.map((seconds) => ({ value: seconds, label: seconds === 0 ? 'Off' : `${seconds} seconds` })),
                { value: 'automix', label: 'Automix' },
              ]}
              onChange={(value) => (value === 'automix' ? setAutomix(true) : setCrossfade(value))}
            />
          </label>
          {automix && (
            <label className={settingsUi.controlRow}>
              <span>Blend Length</span>
              <Select
                label="Blend Length"
                value={automixBars}
                options={AUTOMIX_BARS.map((bars) => ({ value: bars, label: `Up to ${bars} bars` }))}
                onChange={setAutomixBars}
              />
            </label>
          )}
          <Toggle
            label="Show Stats for Nerds"
            detail="Codec, bitrate, sample rate, and bit-perfect status under the artist in the full-screen player."
            checked={showNerdStats}
            onChange={setShowNerdStats}
          />
        </section>
        {automix && (
          <p className={settingsUi.footer}>
            Automix detects tempo, key, and phrases, then blends on the beat with pitch-preserved time stretching. Based on AutoMix by David Finnegan (AGPL-3.0).
          </p>
        )}

        <h2 className={settingsUi.sectionHeader}>Lyrics</h2>
        <section className={settingsUi.group}>
          <button type="button" className={`${settingsUi.integrationPlain} ${settingsUi.linkRow}`} onClick={() => setLyrics(true)}>
            <span className={settingsUi.integrationName}>Lyric Sources</span>
            <span className={settingsUi.value}>
              Order, sources, syllable timing
              <ChevronRight size={16} aria-hidden="true" />
            </span>
          </button>
          {!desktop && (
            <div className={settingsUi.integrationPlain}>
              <span className={settingsUi.integrationName}>Lyric Sources Access</span>
              {present ? <LyricSourcesAccess /> : <span className={settingsUi.value}>Needs the extension</span>}
            </div>
          )}
        </section>
      </div>
      {lyrics && (
        <Suspense fallback={null}>
          <LyricsSettings onClose={() => setLyrics(false)} />
        </Suspense>
      )}
    </div>
  );
}
