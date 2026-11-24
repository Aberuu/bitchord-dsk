import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Crown, LogOut, RefreshCw, Smartphone, Trash2, UserMinus, Wifi } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { useSignedIn } from '@/data/music/queries';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { cleanCode, inviteUrl } from '@/party/invite';
import {
  controlsLocked,
  createParty,
  DEFAULT_SERVER,
  joinParty,
  leaveParty,
  messageOf,
  party,
  partyServer,
  partySettings,
  previewParty,
  savePartySettings,
  useParty,
} from '@/party/listenTogether';
import { usePlayer } from '@/state/player';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

const lede = 'mx-4 mb-4 type-body-tall text-secondary';
const error = 'mx-4 mt-3 type-callout text-red';
const primary = 'flex-none rounded-pill bg-key-bg px-4 py-1.5 type-body-emphasized text-white disabled:opacity-45';
// The code, large, as the phone shows it.
const invite = 'flex flex-col items-center gap-2.5 rounded-[10px] bg-quinary px-4 py-7 text-center';
const inviteCode = 'type-[700_40px/48px] tracking-[0.18em]';

/**
 * Listen Together (ListenTogetherScreen on the phone): start a party or join
 * one by code, then the party itself: its code and invite link, who's in it,
 * and the host's controls. Opened from Settings, and from an invite link
 * (`/invite/:code`), where joining waits for a tap: a browser only lets audio
 * start after the listener has interacted with the page.
 */
export default function ListenTogetherPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const inviteCode = params.code ? cleanCode(params.code) : null;
  const inviteServer = search.get('server');
  const state = useParty();
  const signedIn = useSignedIn();

  return (
    <div className={settingsUi.centered}>
      <PageHeader title="Listen Together" />
      <div className={settingsUi.body}>
        {state.code ? (
          <InParty />
        ) : inviteCode ? (
          <InviteCard code={inviteCode} server={inviteServer} signedIn={signedIn} />
        ) : (
          <StartOrJoin signedIn={signedIn} />
        )}
        {state.error && <p className={error}>{state.error}</p>}
      </div>
    </div>
  );
}

function SignInFirst() {
  return (
    <p className={`${settingsUi.footer} mb-4`}>
      Listen Together uses your YouTube Music account for your name and picture in the party. Sign in on music.youtube.com,
      then come back.
    </p>
  );
}

function StartOrJoin({ signedIn }: { signedIn: boolean }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [settings, setSettings] = useState(partySettings);
  const autoplay = usePlayer((s) => s.autoplay);
  const create = useMutation({ mutationFn: () => createParty({ autoplayEnabled: autoplay }) });
  const update = (change: Partial<typeof settings>) => {
    savePartySettings(change);
    setSettings(partySettings());
  };

  return (
    <>
      <p className={lede}>
        Listen to the same music at the same moment with up to five devices. Anyone in the party can play, pause and skip.
      </p>
      {!signedIn && <SignInFirst />}
      <section className={settingsUi.group}>
        <div className={settingsUi.row}>
          <span className={settingsUi.rowText}>
            <span>Start a Party</span>
            <span className={settingsUi.rowDetail}>Whatever you’re playing comes with you.</span>
          </span>
          <button className={primary} disabled={!signedIn || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Starting…' : 'Start'}
          </button>
        </div>
        <form
          className={settingsUi.controlRow}
          onSubmit={(e) => {
            e.preventDefault();
            const cleaned = cleanCode(code);
            if (cleaned) navigate(`/invite/${cleaned}`);
          }}
        >
          <span>Join with a Code</span>
          <span className="flex gap-2">
            <input
              className="w-[110px] flex-none rounded-[8px] border-0 bg-quaternary px-2.5 py-[5px] text-center type-body tracking-[0.12em] text-primary uppercase"
              value={code}
              maxLength={7}
              placeholder="ABC123"
              aria-label="Party code"
              onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
            />
            <button className={primary} type="submit" disabled={!cleanCode(code)}>
              Join
            </button>
          </span>
        </form>
      </section>

      <h2 className={settingsUi.sectionHeader}>You</h2>
      <section className={settingsUi.group}>
        <label className={settingsUi.controlRow}>
          <span>Name in parties</span>
          <input
            className={settingsUi.input}
            placeholder="Your YouTube name"
            value={settings.nickname}
            maxLength={80}
            onChange={(e) => update({ nickname: e.currentTarget.value })}
          />
        </label>
        <label className={settingsUi.controlRow}>
          <span>Party server</span>
          <input
            className={settingsUi.input}
            placeholder={DEFAULT_SERVER ? new URL(DEFAULT_SERVER).host : 'http://127.0.0.1:8000'}
            value={settings.customServer}
            onChange={(e) => update({ customServer: e.currentTarget.value })}
          />
        </label>
        <div className={settingsUi.row}>
          <span className={settingsUi.rowDetail}>Self-hosted Go server (BitChord-main/backend)</span>
          <button
            type="button"
            className={settingsUi.inlineButton}
            onClick={() => update({ customServer: 'http://127.0.0.1:8000' })}
          >
            Use Localhost
          </button>
        </div>
      </section>
      <p className={settingsUi.footer}>Enter the URL of your own Listen Together Go server. Anyone joining your party uses the server it runs on.</p>

      <MobileLanSyncCard
        currentCustomServer={settings.customServer}
        onUseServerUrl={(url) => update({ customServer: url })}
      />
    </>
  );
}

function MobileLanSyncCard({
  currentCustomServer,
  onUseServerUrl,
}: {
  currentCustomServer: string;
  onUseServerUrl: (url: string) => void;
}) {
  const desktop = isTauriDesktop();
  const queryClient = useQueryClient();
  const [copiedField, setCopiedField] = useState<'party' | 'portal' | 'pin' | null>(null);

  const statusQuery = useQuery({
    queryKey: ['desktop', 'mobile-sync', 'status'],
    queryFn: () => desktopApi.mobileSyncStatus(),
    enabled: desktop,
    refetchInterval: 4000,
  });

  const peersQuery = useQuery({
    queryKey: ['desktop', 'stats', 'peers'],
    queryFn: () => desktopApi.statsListSyncedPeers(),
    enabled: desktop,
  });

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void desktopApi
      .onMobileSyncUpdated(() => {
        if (!active) return;
        void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats'] });
        void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats', 'peers'] });
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, [desktop, queryClient]);

  useEffect(() => {
    if (!copiedField) return;
    const t = window.setTimeout(() => setCopiedField(null), 1500);
    return () => window.clearTimeout(t);
  }, [copiedField]);

  const startMut = useMutation({
    mutationFn: () => desktopApi.mobileSyncStartServer(),
    onSuccess: (next) => queryClient.setQueryData(['desktop', 'mobile-sync', 'status'], next),
  });
  const stopMut = useMutation({
    mutationFn: () => desktopApi.mobileSyncStopServer(),
    onSuccess: (next) => queryClient.setQueryData(['desktop', 'mobile-sync', 'status'], next),
  });
  const rotatePinMut = useMutation({
    mutationFn: () => desktopApi.mobileSyncRotatePin(),
    onSuccess: (next) => queryClient.setQueryData(['desktop', 'mobile-sync', 'status'], next),
  });
  const removePeerMut = useMutation({
    mutationFn: (deviceId: string) => desktopApi.statsRemoveSyncedPeer(deviceId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats'] });
      void queryClient.invalidateQueries({ queryKey: ['desktop', 'stats', 'peers'] });
    },
  });

  const copyValue = (field: 'party' | 'portal' | 'pin', text: string) => {
    void navigator.clipboard.writeText(text).then(() => setCopiedField(field));
  };

  const status = statusQuery.data;
  const peers = peersQuery.data ?? [];
  const serverRunning = Boolean(status?.running);
  const usingThisPc = Boolean(
    status?.partyServerUrl && currentCustomServer.trim() === status.partyServerUrl,
  );

  return (
    <>
      <h2 className={settingsUi.sectionHeader}>This PC Wi-Fi Server (Mobile &amp; LAN Sync)</h2>
      <section className={settingsUi.group} aria-label="Mobile and LAN synchronization">
        {!desktop ? (
          <div className={settingsUi.row}>
            <span className={settingsUi.rowText}>
              <span className="inline-flex items-center gap-2">
                <Smartphone size={16} aria-hidden="true" />
                <span>Direct Wi-Fi Sync with BitChord Android</span>
              </span>
              <span className={settingsUi.rowDetail}>
                Available in BitChord Desktop. Start a local LAN Listen Together room and PIN-protected /sync portal for unmodified Android APKs.
              </span>
            </span>
          </div>
        ) : (
          <>
            <div className={settingsUi.row}>
              <span className={settingsUi.rowText}>
                <span className="inline-flex items-center gap-2">
                  <Wifi size={16} aria-hidden="true" />
                  <span>Built-in LAN Party &amp; Data Sync Server</span>
                  {serverRunning && (
                    <span className="rounded-[6px] bg-green/18 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] text-green uppercase">
                      Live
                    </span>
                  )}
                </span>
                <span className={settingsUi.rowDetail}>
                  {serverRunning
                    ? `${status?.adapterName ?? 'LAN'} · ${status?.activeParties ?? 0} active room(s) · ${status?.connectedClients ?? 0} connected`
                    : 'Run a local Listen Together server and mobile /sync page on your home Wi-Fi with zero cloud delay.'}
                </span>
              </span>
              <button
                type="button"
                className={serverRunning ? settingsUi.inlineButton : primary}
                disabled={startMut.isPending || stopMut.isPending}
                onClick={() => (serverRunning ? stopMut.mutate() : startMut.mutate())}
              >
                {serverRunning
                  ? stopMut.isPending
                    ? 'Stopping...'
                    : 'Stop Server'
                  : startMut.isPending
                    ? 'Starting...'
                    : 'Start Server'}
              </button>
            </div>

            {serverRunning && status?.partyServerUrl && (
              <>
                <div className={settingsUi.row}>
                  <span className={settingsUi.rowText}>
                    <span>Android Listen Together Server</span>
                    <span className="font-mono text-[12px] text-secondary break-all">
                      {status.partyServerUrl}
                    </span>
                  </span>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <button
                      type="button"
                      className={settingsUi.inlineButton}
                      onClick={() =>
                        onUseServerUrl(usingThisPc ? '' : status.partyServerUrl!)
                      }
                    >
                      {usingThisPc ? 'Use Cloud' : 'Use This PC'}
                    </button>
                    <button
                      type="button"
                      className={settingsUi.inlineButton}
                      onClick={() => copyValue('party', status.partyServerUrl!)}
                    >
                      {copiedField === 'party' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>

                {status.syncPortalUrl && (
                  <div className={settingsUi.row}>
                    <span className={settingsUi.rowText}>
                      <span>Mobile Data Sync Portal (Open on Phone Browser)</span>
                      <span className="font-mono text-[12px] text-secondary break-all">
                        {status.syncPortalUrl}
                      </span>
                    </span>
                    <button
                      type="button"
                      className={settingsUi.inlineButton}
                      onClick={() => copyValue('portal', status.syncPortalUrl!)}
                    >
                      {copiedField === 'portal' ? 'Copied' : 'Copy URL'}
                    </button>
                  </div>
                )}

                <div className={settingsUi.row}>
                  <span className={settingsUi.rowText}>
                    <span>6-Digit Pairing PIN</span>
                    <span className="font-mono text-[16px] font-bold tracking-[0.2em] text-primary">
                      {status.syncPin}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className={settingsUi.inlineButton}
                      onClick={() => copyValue('pin', status.syncPin)}
                    >
                      {copiedField === 'pin' ? 'Copied' : 'Copy PIN'}
                    </button>
                    <button
                      type="button"
                      className={settingsUi.inlineButton}
                      disabled={rotatePinMut.isPending}
                      onClick={() => rotatePinMut.mutate()}
                    >
                      <span className="inline-flex items-center gap-1">
                        <RefreshCw size={12} aria-hidden="true" />
                        Rotate
                      </span>
                    </button>
                  </div>
                </div>
              </>
            )}

            {peers.length > 0 && (
              <div className="border-t border-search-border/40 px-4 py-3">
                <p className="mb-2 type-footnote font-semibold tracking-[0.04em] text-secondary uppercase">
                  Synced Mobile Devices ({peers.length})
                </p>
                <div className="space-y-2">
                  {peers.map((peer) => (
                    <div
                      key={peer.deviceId}
                      className="flex items-center justify-between gap-3 rounded-[10px] bg-quaternary/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate type-body-reduced font-medium text-primary">
                          {peer.deviceName}
                        </p>
                        <p className="type-footnote text-secondary">
                          {peer.months} month(s) · {peer.tracks} tracks · Synced{' '}
                          {new Date(peer.updatedAtMs).toLocaleDateString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove synced device ${peer.deviceName}`}
                        className="grid size-7 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-red"
                        onClick={() => removePeerMut.mutate(peer.deviceId)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
      <p className={settingsUi.footer}>
        On BitChord Android: paste the PC URL into Listen Together &gt; Party server for local real-time playback sync, or open /sync in your phone browser to merge Replay backups without erasing PC plays.
      </p>
    </>
  );
}

/** An invite: who's in it, then a tap to join (the tap also lets the browser start audio). */
function InviteCard({ code, server, signedIn }: { code: string; server: string | null; signedIn: boolean }) {
  const preview = useQuery({ queryKey: ['party', 'preview', code, server], queryFn: () => previewParty(code, server), retry: false });
  const join = useMutation({ mutationFn: () => joinParty(code, server) });
  const data = preview.data;
  return (
    <div className={invite}>
      <p className={inviteCode}>{code}</p>
      {preview.isPending && <p className={settingsUi.footer}>Looking up the party…</p>}
      {preview.isError && <p className={error}>{messageOf(preview.error)}</p>}
      {data && (
        <>
          <p className={lede}>
            {data.hostName ? `${data.hostName}’s party` : 'A Listen Together party'}
            {data.memberCount ? ` · ${data.memberCount} of ${data.maxMembers} listening` : ''}
          </p>
          <div className="flex gap-1.5">
            {data.members.map((m, i) => (
              <Avatar key={i} name={m.displayName} url={m.avatarUrl} large />
            ))}
          </div>
        </>
      )}
      {!signedIn && <SignInFirst />}
      <button
        className="mt-1.5 flex-none rounded-pill bg-key-bg px-7 py-2.5 type-title-3-emphasized text-white disabled:opacity-45"
        disabled={!signedIn || join.isPending || data?.isFull || preview.isError}
        onClick={() => join.mutate()}
      >
        {data?.isFull ? 'This party is full' : join.isPending ? 'Joining…' : 'Tap to Join'}
      </button>
    </div>
  );
}

function Avatar({ name, url, large = false }: { name: string; url: string | null; large?: boolean }) {
  const className = `grid place-items-center rounded-full bg-quaternary object-cover type-callout-emphasized ${large ? 'size-9' : 'size-6'}`;
  return url ? (
    <img className={className} src={url} alt="" referrerPolicy="no-referrer" />
  ) : (
    <span className={className}>{name.slice(0, 1).toUpperCase()}</span>
  );
}

function InParty() {
  const state = useParty();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const isHost = state.you?.isHost === true;
  const locked = controlsLocked(state);
  const custom = partyServer() && partyServer() !== DEFAULT_SERVER ? partyServer() : null;
  const link = inviteUrl(state.code!, custom);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const status =
    state.connection === 'live'
      ? state.clockSynced
        ? `In sync · ${state.roundTripMs} ms round trip`
        : 'Measuring the clock…'
      : state.connection === 'connecting'
        ? 'Reconnecting…'
        : 'Offline';

  return (
    <>
      <div className={invite}>
        <p className={inviteCode}>{state.code}</p>
        <p className={settingsUi.footer}>{status}</p>
        <button
          className="inline-flex items-center gap-1.5 rounded-pill bg-quaternary px-3.5 py-1.5 type-callout-emphasized"
          onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}
          title={link}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? 'Copied' : 'Copy Invite Link'}
        </button>
      </div>

      <h2 className={settingsUi.sectionHeader}>
        Listening · {state.members.length} of {state.maxMembers}
      </h2>
      <section className={settingsUi.group}>
        {state.members.map((m) => (
          <div key={m.memberId} className={settingsUi.integrationPlain}>
            <Avatar name={m.displayName} url={m.avatarUrl} />
            <span className={settingsUi.integrationName}>
              {m.displayName}
              {m.memberId === state.you?.memberId && <span className="text-secondary"> (you)</span>}
            </span>
            <span className={settingsUi.value}>
              {m.isHost && <Crown size={14} aria-label="Host" />}
              <span className="size-2 rounded-full bg-quaternary data-on:bg-green" data-on={m.connected || undefined} title={m.connected ? 'Connected' : 'Reconnecting'} />
              {isHost && m.memberId !== state.you?.memberId && (
                <button className={settingsUi.inlineButton} onClick={() => party.kick(m.memberId)} title="Remove from the party">
                  <UserMinus size={13} />
                </button>
              )}
            </span>
          </div>
        ))}
      </section>

      <h2 className={settingsUi.sectionHeader}>Party</h2>
      <section className={settingsUi.group}>
        <Toggle
          label="AutoPlay"
          detail="Keep the party going with similar music when the queue runs out."
          checked={state.playback.autoplayEnabled}
          onChange={(on) => !locked && party.setAutoplay(on)}
        />
        {isHost && (
          <Toggle
            label="Only I control the music"
            detail="Others can listen but not play, pause, skip or change the queue."
            checked={state.hostOnlyControl}
            onChange={party.setHostOnlyControl}
          />
        )}
      </section>
      {locked && <p className={settingsUi.footer}>The host controls the music in this party. You can still pause your own device.</p>}

      {state.activity.length > 0 && (
        <>
          <h2 className={settingsUi.sectionHeader}>Activity</h2>
          <section className={settingsUi.group}>
            {state.activity.slice(0, 8).map((a, i) => (
              <div key={i} className={settingsUi.row}>
                <span className={settingsUi.rowText}>
                  <span>
                    {a.by} · {a.action}
                  </span>
                  {a.detail && <span className={settingsUi.rowDetail}>{a.detail}</span>}
                </span>
                <span className={settingsUi.rowDetail}>{new Date(a.atMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
              </div>
            ))}
          </section>
        </>
      )}

      <button className="mx-4 mt-6 inline-flex items-center gap-1.5 type-body-emphasized text-red" onClick={() => void leaveParty().then(() => navigate('/settings/listen-together'))}>
        <LogOut size={15} />
        Leave Party
      </button>
    </>
  );
}
