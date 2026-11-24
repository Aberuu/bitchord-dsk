import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronRight,
  CirclePlay,
  Cloud,
  GripVertical,
  HardDrive,
  Loader2,
  Plus,
  Puzzle,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useState, type DragEvent } from 'react';
import { PillRangeSlider } from '@/components/PillRangeSlider';
import { SubpageHeader } from '@/components/SubpageHeader';
import type { AddonConfig } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import {
  addonHasLosslessCapability,
  MAX_TRACK_LENGTH_TOLERANCE_SEC,
  MIN_TRACK_LENGTH_TOLERANCE_SEC,
  useSources,
  type AddonLiveStatus,
} from '@/state/sources';
import {
  AddonEditorModal,
  AddonQualityModal,
  JioSaavnConfirmModal,
  SmbModal,
  WebDavModal,
} from './SourceModals';
import { settingsUi } from './settingsStyles';

function formatAddonSubtitle(addon: AddonConfig, health?: AddonLiveStatus): string {
  const tags: string[] = [];
  if (addonHasLosslessCapability(addon)) tags.push('Lossless');
  else tags.push('HTTP Addon');
  tags.push(addon.allowDownloads ? 'Downloads allowed' : 'Streaming only');

  if (!addon.enabled) {
    return tags.slice(0, 2).join(' · ');
  }
  if (!health || health.state === 'checking') {
    return `Checking · ${tags[0]}`;
  }
  if (health.state === 'ok') {
    return health.detail;
  }
  if (health.state === 'rejected') {
    return health.reason;
  }
  return `Can't reach it right now · ${health.reason}`;
}

export default function SourcesPage() {
  const addons = useSources((s) => s.addons);
  const jiosaavnEnabled = useSources((s) => s.jiosaavnEnabled);
  const toleranceSec = useSources((s) => s.trackLengthToleranceSec);
  const webdav = useSources((s) => s.webdav);
  const smb = useSources((s) => s.smb);
  const healthByAddonId = useSources((s) => s.healthByAddonId);
  const streamingQuality = usePlayer((s) => s.streamingQuality);

  const {
    loadFromBackend,
    probeAllAddons,
    toggleAddonEnabled,
    setAddonQuality,
    reorderAddon,
    setJiosaavnEnabled,
    setTrackLengthToleranceSec,
    testWebDav,
    disconnectWebDav,
    testSmb,
    disconnectSmb,
  } = useSources.getState();

  const [addonEditorState, setAddonEditorState] = useState<{ open: boolean; editing: AddonConfig | null }>({
    open: false,
    editing: null,
  });
  const [qualityPickerAddon, setQualityPickerAddon] = useState<AddonConfig | null>(null);
  const [confirmJioSaavn, setConfirmJioSaavn] = useState(false);
  const [webdavModalOpen, setWebdavModalOpen] = useState(false);
  const [smbModalOpen, setSmbModalOpen] = useState(false);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [webdavTest, setWebdavTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  const [smbTest, setSmbTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });

  useEffect(() => {
    void loadFromBackend().then(() => probeAllAddons());
  }, [loadFromBackend, probeAllAddons]);

  const anyLosslessEnabled = addons.some((a) => a.enabled && addonHasLosslessCapability(a));
  const jiosaavnOrdinal = addons.length + 1;
  const youtubeOrdinal = addons.length + 2;

  const webdavSubtitle = !webdav.configured
    ? 'Connect a server under Sources'
    : webdav.username
      ? `${webdav.url} · ${webdav.username}`
      : webdav.url;

  const smbSubtitle = !smb.configured
    ? 'Connect a share under Sources'
    : smb.basePath
      ? `${smb.host}/${smb.share}/${smb.basePath}${smb.username ? ` · ${smb.username}` : ''}`
      : `${smb.host}/${smb.share}${smb.username ? ` · ${smb.username}` : ''}`;

  const handleDropOnAddon = (targetIndex: number) => {
    if (dragIndex !== null && dragIndex !== targetIndex) {
      void reorderAddon(dragIndex, targetIndex);
    }
    setDragIndex(null);
  };

  const handleTestSavedWebDav = async () => {
    setWebdavTest({ busy: true });
    try {
      await testWebDav(webdav.url, webdav.username, webdav.hasPassword ? null : '');
      setWebdavTest({ busy: false, ok: true, text: 'Connected' });
    } catch (err) {
      setWebdavTest({
        busy: false,
        ok: false,
        text: `Couldn't reach it: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleTestSavedSmb = async () => {
    setSmbTest({ busy: true });
    try {
      await testSmb(smb.host, smb.share, smb.basePath, smb.username, smb.hasPassword ? null : '');
      setSmbTest({ busy: false, ok: true, text: 'Connected' });
    } catch (err) {
      setSmbTest({
        busy: false,
        ok: false,
        text: `Couldn't reach it: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  return (
    <div className={settingsUi.centered}>
      <SubpageHeader title="Sources" backTo="/settings" />
      <div className={settingsUi.body}>
        <h2 className={settingsUi.sectionHeader}>Sources, tried in this order</h2>
        <section className={settingsUi.group} aria-label="Sources priority order">
          {addons.map((addon, idx) => {
            const health = healthByAddonId[addon.id];
            const activeQualityLabel =
              addon.qualityOptions.find((o) => o.value === addon.pickedQuality)?.label ??
              addon.qualityOptions[0]?.label ??
              null;
            const healthError = health?.state === 'rejected' || health?.state === 'unreachable';

            return (
              <div
                key={addon.id}
                draggable={addons.length > 1}
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(ev: DragEvent<HTMLDivElement>) => {
                  if (dragIndex !== null) ev.preventDefault();
                }}
                onDrop={() => handleDropOnAddon(idx)}
                onDragEnd={() => setDragIndex(null)}
                className={`relative flex min-h-[60px] items-center gap-3 px-4 py-3 hairline-[48px] ${
                  dragIndex === idx ? 'opacity-55' : ''
                }`}
              >
                <span className="w-4 flex-none text-center type-callout font-semibold text-tertiary tabular-nums">
                  {idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => setAddonEditorState({ open: true, editing: addon })}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                >
                  <span className={settingsUi.iconPlain}>
                    <Puzzle size={19} strokeWidth={1.9} aria-hidden="true" />
                  </span>
                  <span className={settingsUi.rowText}>
                    <span className="truncate type-title-3 text-primary">
                      {addon.name || addon.baseUrl}
                    </span>
                    <span className={`truncate type-callout ${healthError ? 'text-red' : 'text-secondary'}`}>
                      {formatAddonSubtitle(addon, health)}
                    </span>
                  </span>
                </button>

                <div className="flex flex-none items-center gap-2">
                  {addon.qualityOptions.length >= 2 && activeQualityLabel && (
                    <button
                      type="button"
                      onClick={() => setQualityPickerAddon(addon)}
                      className="cursor-pointer rounded-pill bg-quaternary px-2.5 py-1 type-callout-emphasized text-primary transition-colors hover:bg-tracklist-hover"
                      aria-label={`Select quality for ${addon.name || addon.baseUrl}`}
                    >
                      {activeQualityLabel}
                    </button>
                  )}
                  {addons.length > 1 && (
                    <div className="flex items-center gap-0.5 text-tertiary">
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => void reorderAddon(idx, idx - 1)}
                        aria-label={`Move ${addon.name || addon.baseUrl} up`}
                        className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-quaternary hover:text-primary disabled:opacity-30"
                      >
                        <ArrowUp size={13} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === addons.length - 1}
                        onClick={() => void reorderAddon(idx, idx + 1)}
                        aria-label={`Move ${addon.name || addon.baseUrl} down`}
                        className="grid size-7 cursor-pointer place-items-center rounded-full hover:bg-quaternary hover:text-primary disabled:opacity-30"
                      >
                        <ArrowDown size={13} aria-hidden="true" />
                      </button>
                      <span
                        className="hidden cursor-grab pl-0.5 text-tertiary sm:inline-flex"
                        aria-hidden="true"
                        title="Drag to reorder"
                      >
                        <GripVertical size={15} />
                      </span>
                    </div>
                  )}
                  <input
                    type="checkbox"
                    aria-label={`Enable ${addon.name || addon.baseUrl}`}
                    className={settingsUi.switch}
                    checked={addon.enabled}
                    onChange={(e) => void toggleAddonEnabled(addon.id, e.currentTarget.checked)}
                  />
                </div>
              </div>
            );
          })}

          {/* JioSaavn row (opt-in with explicit warning modal) */}
          <label className="relative flex min-h-[60px] cursor-pointer items-center gap-3 px-4 py-3 hairline-[48px]">
            <span className="w-4 flex-none text-center type-callout font-semibold text-tertiary tabular-nums">
              {jiosaavnOrdinal}
            </span>
            <span className={`${settingsUi.iconPlain} ${jiosaavnEnabled ? 'text-primary' : 'text-secondary'}`}>
              <AudioLines size={19} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className={`type-title-3 ${jiosaavnEnabled ? 'text-primary' : 'text-secondary'}`}>
                JioSaavn
              </span>
              <span className={settingsUi.rowDetail}>
                May match the wrong version of a song. Enable at your own risk.
              </span>
            </span>
            <input
              type="checkbox"
              aria-label="Enable JioSaavn"
              className={settingsUi.switch}
              checked={jiosaavnEnabled}
              onChange={(e) => {
                if (e.currentTarget.checked) {
                  setConfirmJioSaavn(true);
                } else {
                  void setJiosaavnEnabled(false);
                }
              }}
            />
          </label>

          {/* YouTube Music row (always enabled fallback) */}
          <div className="relative flex min-h-[60px] items-center gap-3 px-4 py-3 hairline-[48px]">
            <span className="w-4 flex-none text-center type-callout font-semibold text-tertiary tabular-nums">
              {youtubeOrdinal}
            </span>
            <span className={settingsUi.iconPlain}>
              <CirclePlay size={19} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">YouTube Music</span>
              <span className={settingsUi.rowDetail}>Lossy · Full catalogue · Radio</span>
            </span>
            <span className="flex-none type-callout text-secondary">Always on</span>
          </div>

          {/* + Add an addon action row */}
          <button
            type="button"
            onClick={() => setAddonEditorState({ open: true, editing: null })}
            className="relative flex min-h-[60px] w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-tracklist-hover"
          >
            <span className="w-4 flex-none" aria-hidden="true" />
            <span className={settingsUi.iconPlain}>
              <Plus size={19} strokeWidth={2.2} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">Add an addon</span>
              <span className={settingsUi.rowDetail}>
                Point BitChord at an addon server you host or were given a link to
              </span>
            </span>
          </button>
        </section>

        <p className={settingsUi.footer}>
          If a source does not have a track or cannot be reached, BitChord tries the next one. Sources above YouTube can replace its recording when they return a better version.
        </p>
        {streamingQuality === 'normal' && (
          <p className={settingsUi.footer}>
            Streaming quality is set below High, so high-bitrate sources may be skipped or transcoded.
          </p>
        )}
        {!anyLosslessEnabled && (
          <p className={settingsUi.footer}>
            No enabled source can provide lossless audio. Add an addon to play lossless files without transcoding.
          </p>
        )}

        {/* WEBDAV */}
        <h2 className={settingsUi.sectionHeader}>WebDAV</h2>
        <section className={settingsUi.group} aria-label="WebDAV server">
          <button
            type="button"
            onClick={() => {
              setWebdavTest({ busy: false });
              setWebdavModalOpen(true);
            }}
            className={`${settingsUi.integration} ${settingsUi.linkRow}`}
          >
            <span className={settingsUi.iconPlain}>
              <Cloud size={19} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">WebDAV</span>
              <span className={`truncate ${settingsUi.rowDetail}`}>{webdavSubtitle}</span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </button>

          {webdav.configured && (
            <>
              <button
                type="button"
                disabled={webdavTest.busy}
                onClick={() => void handleTestSavedWebDav()}
                className={`${settingsUi.row} ${settingsUi.linkRow} min-h-[48px]`}
              >
                <span className="pl-[40px] type-title-3 text-primary">
                  {webdavTest.busy ? 'Testing connection…' : 'Test Connection'}
                </span>
                <span className="flex items-center gap-2 type-callout">
                  {webdavTest.busy && <Loader2 size={14} className="animate-spin text-secondary" aria-hidden="true" />}
                  {webdavTest.text && (
                    <span className={webdavTest.ok ? 'text-green' : 'text-red'}>{webdavTest.text}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setWebdavTest({ busy: false });
                  void disconnectWebDav();
                }}
                className={`${settingsUi.row} ${settingsUi.linkRow} min-h-[48px]`}
              >
                <span className="pl-[40px] type-title-3 text-red">Disconnect</span>
              </button>
            </>
          )}
        </section>
        <p className={settingsUi.footer}>
          Point BitChord at a WebDAV music folder, your Nextcloud Music directory or any server speaking WebDAV.
        </p>

        {/* SMB */}
        <h2 className={settingsUi.sectionHeader}>SMB</h2>
        <section className={settingsUi.group} aria-label="SMB file share">
          <button
            type="button"
            onClick={() => {
              setSmbTest({ busy: false });
              setSmbModalOpen(true);
            }}
            className={`${settingsUi.integration} ${settingsUi.linkRow}`}
          >
            <span className={settingsUi.iconPlain}>
              <HardDrive size={19} strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span className={settingsUi.rowText}>
              <span className="type-title-3 text-primary">SMB</span>
              <span className={`truncate ${settingsUi.rowDetail}`}>{smbSubtitle}</span>
            </span>
            <ChevronRight size={17} className="text-tertiary" aria-hidden="true" />
          </button>

          {smb.configured && (
            <>
              <button
                type="button"
                disabled={smbTest.busy}
                onClick={() => void handleTestSavedSmb()}
                className={`${settingsUi.row} ${settingsUi.linkRow} min-h-[48px]`}
              >
                <span className="pl-[40px] type-title-3 text-primary">
                  {smbTest.busy ? 'Testing connection…' : 'Test Connection'}
                </span>
                <span className="flex items-center gap-2 type-callout">
                  {smbTest.busy && <Loader2 size={14} className="animate-spin text-secondary" aria-hidden="true" />}
                  {smbTest.text && (
                    <span className={smbTest.ok ? 'text-green' : 'text-red'}>{smbTest.text}</span>
                  )}
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSmbTest({ busy: false });
                  void disconnectSmb();
                }}
                className={`${settingsUi.row} ${settingsUi.linkRow} min-h-[48px]`}
              >
                <span className="pl-[40px] type-title-3 text-red">Disconnect</span>
              </button>
            </>
          )}
        </section>
        <p className={settingsUi.footer}>
          Point BitChord at a shared music folder, a NAS or Windows share speaking SMB.
        </p>

        {/* SOURCE MATCHING */}
        <h2 className={settingsUi.sectionHeader}>Source matching</h2>
        <section className={settingsUi.group} aria-label="Source matching">
          <div className="relative flex flex-col gap-3 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3.5">
                <span className={`${settingsUi.iconPlain} mt-0.5`}>
                  <SlidersHorizontal size={19} strokeWidth={2} aria-hidden="true" />
                </span>
                <div className={settingsUi.rowText}>
                  <span className="type-title-3 text-primary">Track length tolerance</span>
                  <span className={settingsUi.rowDetail}>
                    Maximum duration difference allowed for a replacement stream
                  </span>
                </div>
              </div>
              <span className="flex-none pt-0.5 type-body-reduced text-secondary tabular-nums">
                {toleranceSec} s
              </span>
            </div>
            <div className="pl-10">
              <PillRangeSlider
                value={toleranceSec}
                min={MIN_TRACK_LENGTH_TOLERANCE_SEC}
                max={MAX_TRACK_LENGTH_TOLERANCE_SEC}
                step={1}
                ariaLabel="Track length tolerance in seconds"
                onChange={(sec) => void setTrackLengthToleranceSec(sec)}
              />
            </div>
          </div>
        </section>
        <p className={settingsUi.footer}>
          A larger tolerance accepts more source matches; a smaller tolerance is stricter. The default is 5 seconds.
        </p>
      </div>

      {addonEditorState.open && (
        <AddonEditorModal
          editing={addonEditorState.editing}
          onDismiss={() => setAddonEditorState({ open: false, editing: null })}
        />
      )}

      {qualityPickerAddon && (
        <AddonQualityModal
          addon={qualityPickerAddon}
          onSelect={(opt) => {
            void setAddonQuality(qualityPickerAddon.id, opt.value);
            setQualityPickerAddon(null);
          }}
          onDismiss={() => setQualityPickerAddon(null)}
        />
      )}

      {confirmJioSaavn && (
        <JioSaavnConfirmModal
          onConfirm={() => {
            void setJiosaavnEnabled(true);
            setConfirmJioSaavn(false);
          }}
          onDismiss={() => setConfirmJioSaavn(false)}
        />
      )}

      {webdavModalOpen && (
        <WebDavModal current={webdav} onDismiss={() => setWebdavModalOpen(false)} />
      )}

      {smbModalOpen && (
        <SmbModal current={smb} onDismiss={() => setSmbModalOpen(false)} />
      )}
    </div>
  );
}
