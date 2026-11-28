import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, QrCode, Send, ShieldCheck, Smartphone } from 'lucide-react';
import { useState } from 'react';
import { extractPairingCodeInput, PairingCodeBoxes } from '@/components/PairingCodeBoxes';
import { QrCodeSvg } from '@/components/QrCodeSvg';
import {
  desktopApi,
  type DesktopSessionMeta,
  type GeneratedOneKey,
} from '@/desktop/tauriBridge';
import { useSpotifySignedIn } from '@/extension/useSpotifyAuth';
import { ytAuthQueryKey } from '@/extension/useYtAuth';
import { settingsUi } from '@/pages/settingsStyles';
import { useUi } from '@/state/ui';

const PREVIEW_META: DesktopSessionMeta = {
  persistence: 'temporary',
  source: 'one_key',
  skipSignInPrompt: false,
};

interface OneKeySessionSectionProps {
  desktop: boolean;
  ytSignedIn: boolean;
  preview?: boolean;
}

function extractPeerCode(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

export function OneKeySessionSection({
  desktop,
  ytSignedIn,
  preview = false,
}: OneKeySessionSectionProps) {
  const qc = useQueryClient();
  const spotifySignedIn = useSpotifySignedIn();
  const setQuickSignInOpen = useUi((s) => s.setQuickSignInOpen);
  const setPairMobileOpen = useUi((s) => s.setPairMobileOpen);

  const [ttlMinutes, setTtlMinutes] = useState<string>('10080');
  const [pin, setPin] = useState('');
  const [includeSpotifyKey, setIncludeSpotifyKey] = useState(false);
  const [generated, setGenerated] = useState<GeneratedOneKey | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [keyActionError, setKeyActionError] = useState<string | null>(null);

  const [peerUrl, setPeerUrl] = useState('');
  const [peerCode, setPeerCode] = useState('');
  const [includeSpotifyPeer, setIncludeSpotifyPeer] = useState(false);
  const [peerResult, setPeerResult] = useState<string | null>(null);
  const [peerError, setPeerError] = useState<string | null>(null);

  const [previewMeta, setPreviewMeta] = useState<DesktopSessionMeta>(PREVIEW_META);

  const sessionMetaQuery = useQuery({
    queryKey: ['desktop', 'session-meta'],
    queryFn: () => desktopApi.authGetSessionMeta(),
    enabled: desktop && !preview,
    staleTime: 10_000,
  });

  const promoteMutation = useMutation({
    mutationFn: async () => {
      if (preview) {
        setPreviewMeta((prev) => ({ ...prev, persistence: 'persistent' }));
        return { ...previewMeta, persistence: 'persistent' as const };
      }
      return desktopApi.authPromoteTemporarySession();
    },
    onSuccess: (next) => {
      qc.setQueryData(['desktop', 'session-meta'], next);
      void qc.invalidateQueries({ queryKey: ytAuthQueryKey });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      setKeyActionError(null);
      const parsedTtl = ttlMinutes === 'never' ? null : Number(ttlMinutes);
      const trimmedPin = pin.trim();
      if (trimmedPin.length > 0 && trimmedPin.length < 4) {
        throw new Error('Optional PIN must be at least 4 characters.');
      }
      if (preview) {
        return {
          key: 'BC1K-PREVIEW-9X4L-BITCHORD-LOCAL-ONLY-DEMO-SESSION-KEY',
          hasPin: trimmedPin.length >= 4,
          expiresAtMs: parsedTtl ? Date.now() + parsedTtl * 60_000 : null,
          includeSpotify: includeSpotifyKey && spotifySignedIn,
        };
      }
      return desktopApi.authGenerateOneKey(
        includeSpotifyKey && spotifySignedIn,
        parsedTtl,
        trimmedPin.length >= 4 ? trimmedPin : null,
      );
    },
    onSuccess: (res) => {
      setGenerated(res);
    },
    onError: (err) => {
      setKeyActionError(err instanceof Error ? err.message : 'Unable to generate 1-Key Session.');
    },
  });

  const approvePeerMutation = useMutation({
    mutationFn: async () => {
      setPeerError(null);
      setPeerResult(null);
      const targetUrl = peerUrl.trim();
      const targetCode = peerCode.trim();
      if (!targetUrl) throw new Error('Paste the other PC quick sign-in URL first.');
      if (!targetCode) throw new Error('Enter the 6-character quick sign-in code.');
      if (preview) {
        return `Preview approved peer at ${targetUrl} with code ${targetCode}.`;
      }
      return desktopApi.authQuickLoginApprovePeer(
        targetUrl,
        targetCode,
        includeSpotifyPeer && spotifySignedIn,
      );
    },
    onSuccess: (msg) => {
      setPeerResult(msg);
      setPeerUrl('');
      setPeerCode('');
    },
    onError: (err) => {
      setPeerError(err instanceof Error ? err.message : 'Unable to send session to peer.');
    },
  });

  if (!desktop) return null;

  const meta = preview ? previewMeta : sessionMetaQuery.data;
  const persistence = meta?.persistence ?? (ytSignedIn ? 'persistent' : 'signed_out');
  const isTemporary = persistence === 'temporary';

  const copyGeneratedKey = async () => {
    if (!generated) return;
    try {
      await navigator.clipboard.writeText(generated.key);
      setCopiedKey(true);
      window.setTimeout(() => setCopiedKey(false), 1800);
    } catch {
      // Clipboard write may fail outside secure contexts.
    }
  };

  return (
    <>
      <h2 className={settingsUi.sectionHeader}>1-Key Session &amp; Quick Sign-In</h2>
      <section className={settingsUi.group}>
        <div className={settingsUi.controlRow}>
          <div className={settingsUi.rowText}>
            <span>Session Persistence</span>
            <span className={settingsUi.rowDetail}>
              {isTemporary
                ? 'Temporary session active in memory only. Cleared when BitChord closes.'
                : persistence === 'persistent'
                  ? 'Saved encrypted on this PC across app restarts.'
                  : 'Signed out. Use Quick Sign-In to pair with QR, a 1-Key Session, or Google.'}
            </span>
          </div>
          <span className={settingsUi.value}>
            {isTemporary && (
              <button
                type="button"
                className={settingsUi.inlineButton}
                disabled={promoteMutation.isPending}
                onClick={() => promoteMutation.mutate()}
              >
                {promoteMutation.isPending ? 'Saving...' : 'Keep me signed in (Save to PC)'}
              </button>
            )}
            <button
              type="button"
              className={settingsUi.inlineButton}
              onClick={() => setQuickSignInOpen(true)}
            >
              {ytSignedIn ? 'Quick Sign-In Options' : 'Open Quick Sign-In'}
            </button>
            {(ytSignedIn || preview) && (
              <button
                type="button"
                className={settingsUi.inlineButton}
                onClick={() => setPairMobileOpen(true)}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Smartphone size={14} aria-hidden="true" />
                  <span>Pair Mobile (QR)</span>
                </span>
              </button>
            )}
          </span>
        </div>

        {(ytSignedIn || preview) && (
          <>
            <div className="flex flex-col gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className={settingsUi.rowText}>
                  <span className="inline-flex items-center gap-1.5">
                    <KeyRound size={15} aria-hidden="true" />
                    <span>Generate 1-Key Session &amp; QR</span>
                  </span>
                  <span className={settingsUi.rowDetail}>
                    Export an encrypted key to unlock another BitChord Desktop without typing Google credentials.
                  </span>
                </div>
                <button
                  type="button"
                  disabled={generateMutation.isPending}
                  onClick={() => generateMutation.mutate()}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-pill bg-key-bg px-4 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  <QrCode size={15} aria-hidden="true" />
                  <span>{generateMutation.isPending ? 'Generating...' : 'Generate 1-Key & QR'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-[12px] text-secondary">
                  <span>Key lifetime</span>
                  <select
                    aria-label="Key lifetime"
                    value={ttlMinutes}
                    onChange={(ev) => setTtlMinutes(ev.target.value)}
                    className={`${settingsUi.input} min-h-[44px] w-full text-[13px] text-primary`}
                  >
                    <option value="1440">24 hours</option>
                    <option value="10080">7 days</option>
                    <option value="43200">30 days</option>
                    <option value="never">Never expires</option>
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-[12px] text-secondary">
                  <span>Optional PIN lock (4+ chars)</span>
                  <input
                    type="password"
                    aria-label="Optional PIN lock"
                    value={pin}
                    onChange={(ev) => setPin(ev.target.value)}
                    placeholder="Leave blank for BC1K-"
                    autoComplete="off"
                    className={`${settingsUi.input} min-h-[44px] w-full text-[13px] text-primary`}
                  />
                </label>
              </div>

              {spotifySignedIn && (
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] text-primary">
                  <input
                    type="checkbox"
                    checked={includeSpotifyKey}
                    onChange={(ev) => setIncludeSpotifyKey(ev.target.checked)}
                    className="size-4 accent-key"
                  />
                  <span>Include Spotify session cookie in generated key</span>
                </label>
              )}

              {keyActionError && (
                <p role="alert" className="type-footnote text-red">
                  {keyActionError}
                </p>
              )}

              {generated && (
                <div className="space-y-3 rounded-[14px] border border-(--labelDivider) bg-quaternary p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-primary">
                        <ShieldCheck size={14} aria-hidden="true" />
                        <span>{generated.hasPin ? 'PIN-protected BC1P- key ready' : 'BC1K- 1-Key Session ready'}</span>
                      </div>
                      <p className="type-caption-1 text-secondary">
                        Keep this token private. Anyone with it can use your active session until it expires.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyGeneratedKey()}
                      className="inline-flex min-h-[44px] flex-none items-center gap-1.5 rounded-[10px] border border-(--labelDivider) bg-page px-3 text-[13px] font-medium text-primary hover:bg-quinary"
                    >
                      {copiedKey ? (
                        <Check size={14} className="text-green" aria-hidden="true" />
                      ) : (
                        <Copy size={14} aria-hidden="true" />
                      )}
                      <span>{copiedKey ? 'Copied' : 'Copy 1-Key'}</span>
                    </button>
                  </div>

                  <textarea
                    readOnly
                    rows={3}
                    value={generated.key}
                    aria-label="Generated 1-Key Session token"
                    className="w-full rounded-[10px] border border-(--labelDivider) bg-page px-3 py-2 font-mono text-[11px] text-primary"
                  />

                  {generated.key.length <= 2200 ? (
                    <div className="flex justify-center pt-1">
                      <QrCodeSvg value={generated.key} size={180} label="Generated 1-Key Session QR code" />
                    </div>
                  ) : (
                    <p className="type-caption-1 text-secondary">
                      This session token ({generated.key.length} chars) exceeds QR code density limits. Use Copy 1-Key instead.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 px-4 py-3.5">
              <div className={settingsUi.rowText}>
                <span>Approve Another PC on Wi-Fi</span>
                <span className={settingsUi.rowDetail}>
                  Push your active session directly to another BitChord Desktop showing a QR link and 6-character code on your local network.
                </span>
              </div>

              <div className="flex flex-col gap-3">
                <input
                  type="url"
                  aria-label="Peer quick sign-in URL"
                  value={peerUrl}
                  onChange={(ev) => {
                    const nextUrl = ev.target.value;
                    setPeerUrl(nextUrl);
                    const detectedCode = extractPeerCode(nextUrl);
                    if (detectedCode && !peerCode.trim()) setPeerCode(detectedCode);
                    setPeerError(null);
                    setPeerResult(null);
                  }}
                  placeholder="http://192.168.1.42:47923/quick-login?code=..."
                  className={`${settingsUi.input} min-h-[44px] w-full font-mono text-[12px] text-primary`}
                />
                <div className="flex flex-wrap items-center justify-between gap-2.5">
                  <span className="type-callout font-medium text-secondary">
                    6-Character Code
                  </span>
                  <PairingCodeBoxes
                    value={peerCode}
                    ariaLabel="Peer 6-character code"
                    disabled={approvePeerMutation.isPending}
                    onChange={(nextCode) => {
                      setPeerCode(nextCode);
                      setPeerError(null);
                      setPeerResult(null);
                    }}
                    onPasteRaw={(rawClipboard) => {
                      const trimmed = rawClipboard.trim();
                      if (/^https?:\/\//i.test(trimmed) && !peerUrl.trim()) {
                        setPeerUrl(trimmed);
                      }
                      const detected = extractPairingCodeInput(rawClipboard);
                      if (detected) {
                        setPeerError(null);
                        setPeerResult(null);
                      }
                    }}
                  />
                </div>
              </div>

              {spotifySignedIn && (
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] text-primary">
                  <input
                    type="checkbox"
                    checked={includeSpotifyPeer}
                    onChange={(ev) => setIncludeSpotifyPeer(ev.target.checked)}
                    className="size-4 accent-key"
                  />
                  <span>Also send Spotify session to this PC</span>
                </label>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {peerError && (
                    <p role="alert" className="type-footnote text-red">
                      {peerError}
                    </p>
                  )}
                  {peerResult && (
                    <p role="status" className="type-footnote text-green">
                      {peerResult}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  disabled={approvePeerMutation.isPending}
                  onClick={() => approvePeerMutation.mutate()}
                  className="inline-flex min-h-[44px] items-center gap-2 rounded-pill border border-(--labelDivider) bg-page px-4 text-[13px] font-semibold text-primary shadow-xs transition-colors hover:bg-quinary disabled:opacity-60"
                >
                  <Send size={14} aria-hidden="true" />
                  <span>{approvePeerMutation.isPending ? 'Sending...' : 'Send Session'}</span>
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      <p className={settingsUi.footer}>
        Wi-Fi quick sign-in transfers stay inside your local network and expire after 5 minutes.
      </p>
    </>
  );
}
