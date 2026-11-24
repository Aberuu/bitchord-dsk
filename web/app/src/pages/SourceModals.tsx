import { Check, Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AddonConfig, AddonQualityOption, SmbStatusView, WebDavStatusView } from '@/desktop/tauriBridge';
import { useSources } from '@/state/sources';

interface ModalFrameProps {
  title: string;
  description?: string;
  labelledBy: string;
  onDismiss: () => void;
  busy?: boolean;
  children: ReactNode;
}

function ModalFrame({ title, description, labelledBy, onDismiss, busy = false, children }: ModalFrameProps) {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !busy) {
        ev.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onDismiss, busy]);

  return (
    <div
      className="fixed inset-0 z-(--z-modal) flex items-center justify-center bg-[var(--modalScrimColor)] p-4 backdrop-blur-xs animate-fade"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      onClick={(ev) => {
        if (!busy && ev.target === ev.currentTarget) onDismiss();
      }}
    >
      <div
        className="w-[min(360px,94vw)] overflow-hidden rounded-[24px] border border-[var(--vibrantDivider)] bg-[var(--systemGray6)]/96 text-primary shadow-[0_24px_70px_var(--dialogShadowColor)] backdrop-blur-2xl animate-zoom"
      >
        <div className="px-5 pt-5 pb-4 text-center">
          <h2 id={labelledBy} className="type-title-2-emphasized text-primary">
            {title}
          </h2>
          {description && (
            <p className="mt-1.5 type-body-tall text-secondary">{description}</p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

const stackedBtn =
  'flex min-h-[48px] w-full cursor-pointer items-center justify-center border-t border-divider/70 px-4 py-3 text-center type-title-3 transition-colors hover:bg-tracklist-hover disabled:cursor-not-allowed disabled:opacity-45';
const fieldInput =
  'h-11 w-full rounded-[12px] border border-divider/60 bg-quinary px-3.5 type-body-reduced text-primary placeholder:text-tertiary focus:border-key focus:outline-none';

function StatusBanner({ ok, message }: { ok: boolean; message: string }) {
  return (
    <p
      role="status"
      className={`mt-2.5 rounded-[10px] px-3 py-2 text-center type-callout ${
        ok ? 'bg-green/12 text-green' : 'bg-red/12 text-red'
      }`}
    >
      {message}
    </p>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        autoComplete="current-password"
        className={`${fieldInput} pr-10`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 cursor-pointer place-items-center rounded-full text-secondary hover:bg-quaternary hover:text-primary"
        aria-label={visible ? `Hide ${ariaLabel}` : `Show ${ariaLabel}`}
      >
        {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  );
}

export function AddonEditorModal({
  editing,
  onDismiss,
}: {
  editing: AddonConfig | null;
  onDismiss: () => void;
}) {
  const isNew = editing === null;
  const addons = useSources((s) => s.addons);
  const { identifyAddon, upsertAddon, removeAddon } = useSources.getState();

  const [url, setUrl] = useState(editing?.baseUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const canSubmit = url.trim().length > 0 && !busy;

  const handleRun = async (thenSave: boolean) => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      const probe = await identifyAddon(url.trim(), editing?.id ?? null);
      const duplicate = addons.find(
        (a) =>
          a.baseUrl.toLowerCase() === probe.config.baseUrl.toLowerCase() &&
          a.id !== (editing?.id ?? ''),
      );
      if (duplicate) {
        setStatus({ ok: false, text: `Already added as ${duplicate.name || duplicate.baseUrl}` });
        setBusy(false);
        return;
      }

      if (probe.health.state === 'ok') {
        setStatus({ ok: true, text: `Connected · ${probe.config.name} · ${probe.health.detail}` });
      } else {
        setStatus({ ok: false, text: probe.health.reason });
      }

      if (thenSave) {
        await upsertAddon(probe.config, probe.health);
        onDismiss();
      }
    } catch (err) {
      setStatus({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!editing || busy) return;
    setBusy(true);
    try {
      await removeAddon(editing.id);
      onDismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title={isNew ? 'Add an addon' : editing.name || 'Edit addon'}
      description="Paste the addon's URL, either its root or its manifest.json. BitChord reads what it can search and stream, then asks it for tracks over plain HTTP."
      labelledBy="addon-editor-title"
      onDismiss={onDismiss}
      busy={busy}
    >
      <div className="px-4 pb-4">
        <input
          ref={inputRef}
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setStatus(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSubmit) void handleRun(true);
          }}
          placeholder="https://my-addon.example.com"
          aria-label="Addon URL"
          disabled={busy}
          className={fieldInput}
        />
        {status && <StatusBanner ok={status.ok} message={status.text} />}
      </div>
      <div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleRun(false)}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          {busy ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleRun(true)}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          Save
        </button>
        {!isNew && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRemove()}
            className={`${stackedBtn} text-red`}
          >
            Remove this source
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className={`${stackedBtn} font-semibold text-primary`}
        >
          Cancel
        </button>
      </div>
    </ModalFrame>
  );
}

export function WebDavModal({
  current,
  onDismiss,
}: {
  current: WebDavStatusView;
  onDismiss: () => void;
}) {
  const { testWebDav, saveWebDav } = useSources.getState();
  const [url, setUrl] = useState(current.url);
  const [username, setUsername] = useState(current.username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus({ preventScroll: true });
  }, []);

  const canSubmit = url.trim().length > 0 && !busy;
  const effectivePassword = password.length > 0 ? password : current.hasPassword ? null : '';

  const handleTest = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await testWebDav(url.trim(), username.trim(), effectivePassword);
      setStatus({ ok: true, text: 'Connected' });
    } catch (err) {
      setStatus({
        ok: false,
        text: `Couldn't reach it: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await saveWebDav(url.trim(), username.trim(), effectivePassword);
      onDismiss();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="WebDAV"
      description="Point BitChord at a WebDAV music folder, your Nextcloud Music directory or any server speaking WebDAV."
      labelledBy="webdav-modal-title"
      onDismiss={onDismiss}
      busy={busy}
    >
      <div className="flex flex-col gap-2.5 px-4 pb-4">
        <input
          ref={urlRef}
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="https://cloud.example.com/remote.php/dav/files/user/Music"
          aria-label="Server URL"
          disabled={busy}
          className={fieldInput}
        />
        <input
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="Username"
          aria-label="Username"
          disabled={busy}
          className={fieldInput}
        />
        <PasswordInput
          value={password}
          onChange={(next) => {
            setPassword(next);
            setStatus(null);
          }}
          placeholder={current.hasPassword ? 'Saved password (leave blank to keep)' : 'Password'}
          ariaLabel="Password"
          disabled={busy}
        />
        {status && <StatusBanner ok={status.ok} message={status.text} />}
      </div>
      <div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleTest()}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          {busy ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSave()}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className={`${stackedBtn} font-semibold text-primary`}
        >
          Cancel
        </button>
      </div>
    </ModalFrame>
  );
}

export function SmbModal({
  current,
  onDismiss,
}: {
  current: SmbStatusView;
  onDismiss: () => void;
}) {
  const { testSmb, saveSmb } = useSources.getState();
  const [host, setHost] = useState(current.host);
  const [share, setShare] = useState(current.share);
  const [basePath, setBasePath] = useState(current.basePath);
  const [username, setUsername] = useState(current.username);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    hostRef.current?.focus({ preventScroll: true });
  }, []);

  const canSubmit = host.trim().length > 0 && share.trim().length > 0 && !busy;
  const effectivePassword = password.length > 0 ? password : current.hasPassword ? null : '';

  const handleTest = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await testSmb(host.trim(), share.trim(), basePath.trim(), username.trim(), effectivePassword);
      setStatus({ ok: true, text: 'Connected' });
    } catch (err) {
      setStatus({
        ok: false,
        text: `Couldn't reach it: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setStatus(null);
    try {
      await saveSmb(host.trim(), share.trim(), basePath.trim(), username.trim(), effectivePassword);
      onDismiss();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) });
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="SMB"
      description="Point BitChord at a shared music folder, a NAS or Windows share speaking SMB."
      labelledBy="smb-modal-title"
      onDismiss={onDismiss}
      busy={busy}
    >
      <div className="flex flex-col gap-2.5 px-4 pb-4">
        <input
          ref={hostRef}
          type="text"
          value={host}
          onChange={(e) => {
            setHost(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="nas.local or 192.168.1.10:4445"
          aria-label="Server"
          disabled={busy}
          className={fieldInput}
        />
        <input
          type="text"
          value={share}
          onChange={(e) => {
            setShare(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="Share name, e.g. Music"
          aria-label="Share"
          disabled={busy}
          className={fieldInput}
        />
        <input
          type="text"
          value={basePath}
          onChange={(e) => {
            setBasePath(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="Folder inside the share, e.g. media/music (optional)"
          aria-label="Folder"
          disabled={busy}
          className={fieldInput}
        />
        <input
          type="text"
          value={username}
          onChange={(e) => {
            setUsername(e.currentTarget.value);
            setStatus(null);
          }}
          placeholder="Username"
          aria-label="Username"
          disabled={busy}
          className={fieldInput}
        />
        <PasswordInput
          value={password}
          onChange={(next) => {
            setPassword(next);
            setStatus(null);
          }}
          placeholder={current.hasPassword ? 'Saved password (leave blank to keep)' : 'Password'}
          ariaLabel="Password"
          disabled={busy}
        />
        {status && <StatusBanner ok={status.ok} message={status.text} />}
      </div>
      <div>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleTest()}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          {busy ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void handleSave()}
          className={`${stackedBtn} ${canSubmit ? 'text-primary' : 'text-tertiary'}`}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className={`${stackedBtn} font-semibold text-primary`}
        >
          Cancel
        </button>
      </div>
    </ModalFrame>
  );
}

export function JioSaavnConfirmModal({
  onConfirm,
  onDismiss,
}: {
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <ModalFrame
      title="Enable JioSaavn?"
      description="May match the wrong version of a song. Enable at your own risk."
      labelledBy="jiosaavn-confirm-title"
      onDismiss={onDismiss}
    >
      <div>
        <button
          type="button"
          onClick={onConfirm}
          className={`${stackedBtn} font-semibold text-key`}
        >
          Enable anyway
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className={`${stackedBtn} font-semibold text-primary`}
        >
          Cancel
        </button>
      </div>
    </ModalFrame>
  );
}

export function AddonQualityModal({
  addon,
  onSelect,
  onDismiss,
}: {
  addon: AddonConfig;
  onSelect: (option: AddonQualityOption) => void;
  onDismiss: () => void;
}) {
  const activeValue = addon.pickedQuality ?? addon.qualityOptions[0]?.value ?? null;
  return (
    <ModalFrame
      title="Audio Quality"
      description={addon.name || addon.baseUrl}
      labelledBy="addon-quality-title"
      onDismiss={onDismiss}
    >
      <div>
        {addon.qualityOptions.map((option) => {
          const active = option.value === activeValue;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onSelect(option)}
              className="flex min-h-[48px] w-full cursor-pointer items-center justify-between border-t border-divider/70 px-5 py-3 text-left type-title-3 text-primary transition-colors hover:bg-tracklist-hover"
            >
              <span>{option.label}</span>
              {active && <Check size={17} strokeWidth={2.3} className="text-key" aria-hidden="true" />}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onDismiss}
          className={`${stackedBtn} font-semibold text-primary`}
        >
          Cancel
        </button>
      </div>
    </ModalFrame>
  );
}
