import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, ChevronsUpDown, User } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Menu, MenuHeader, MenuItem, MenuSeparator } from '@/components/Menu';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { useRefreshYtAuth, useSelectChannel, useSetConnected, useYtAuth, ytAuthQueryKey } from '@/extension/useYtAuth';
import { useUi } from '@/state/ui';

const SIGN_IN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com/';

const pill =
  'self-start rounded-[16px] bg-key px-3.5 py-[5px] type-[600_13px/18px] text-white hover:brightness-[1.08] disabled:opacity-60';
const avatar = 'inline-grid flex-none place-items-center rounded-full bg-quinary object-cover type-[600_11px/1] text-secondary';

function Avatar({ src, name, size }: { src: string | null; name: string; size: number }) {
  return src ? (
    <img className={avatar} src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  ) : (
    <span className={avatar} style={{ width: size, height: size }} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function actionPillClass(compact: boolean): string {
  return compact
    ? `${pill} sm:self-auto sm:grid sm:size-10 sm:place-items-center sm:rounded-nav sm:px-0 sm:py-0`
    : pill;
}

export function AccountButton({ compact = false }: { compact?: boolean }) {
  const status = useYtAuth();
  const select = useSelectChannel();
  const connect = useSetConnected();
  const refresh = useRefreshYtAuth();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const desktop = isTauriDesktop();
  const qc = useQueryClient();
  const openQuickSignIn = useUi((s) => s.setQuickSignInOpen);
  const sessionMeta = useQuery({
    queryKey: ['desktop', 'session-meta'],
    queryFn: () => desktopApi.authGetSessionMeta(),
    enabled: desktop,
    staleTime: 10_000,
  });
  const isTemporary = desktop && sessionMeta.data?.persistence === 'temporary';

  if (status.state !== 'ready') return null;
  const { auth } = status;

  const openSignIn = () => {
    if (desktop) openQuickSignIn(true);
    else window.open(SIGN_IN_URL, '_blank', 'noreferrer');
  };

  if (!auth.browserSignedIn) {
    return (
      <button
        type="button"
        className={actionPillClass(compact)}
        aria-label="Sign In"
        title={compact ? 'Sign In' : undefined}
        onClick={openSignIn}
      >
        <User size={17} strokeWidth={1.9} className={compact ? 'hidden sm:block' : 'hidden'} aria-hidden="true" />
        <span className={compact ? 'sm:sr-only' : undefined}>Sign In</span>
      </button>
    );
  }
  if (!auth.connected) {
    return (
      <button
        type="button"
        className={actionPillClass(compact)}
        aria-label="Connect YouTube Music"
        title={compact ? 'Connect YouTube Music' : undefined}
        onClick={() => connect.mutate(true)}
        disabled={connect.isPending}
      >
        <User size={17} strokeWidth={1.9} className={compact ? 'hidden sm:block' : 'hidden'} aria-hidden="true" />
        <span className={compact ? 'sm:sr-only' : undefined}>Connect YouTube Music</span>
      </button>
    );
  }
  if (!auth.active) {
    const label = refresh.isPending ? 'Reading account…' : 'Sign In Again';
    return (
      <button
        type="button"
        className={actionPillClass(compact)}
        aria-label={label}
        title={auth.problem ?? (compact ? label : undefined)}
        onClick={() => (desktop ? openSignIn() : refresh.mutate())}
        disabled={refresh.isPending}
      >
        <User size={17} strokeWidth={1.9} className={compact ? 'hidden sm:block' : 'hidden'} aria-hidden="true" />
        <span className={compact ? 'sm:sr-only' : undefined}>{label}</span>
      </button>
    );
  }

  const active = auth.active;
  const multiple = auth.accounts.flatMap((a) => a.channels).length > 1;

  return (
    <>
      <button
        type="button"
        className={`flex w-full min-w-0 items-center gap-2 rounded-nav px-1 py-1.5 text-start type-body-reduced text-primary hover:bg-quinary aria-expanded:bg-quinary${compact ? ' sm:mx-auto sm:size-10 sm:justify-center sm:gap-0 sm:px-0 sm:py-0' : ''}`}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={compact ? `${active.name} account` : undefined}
        title={compact ? active.name : undefined}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        <Avatar src={active.avatarUrl} name={active.name} size={24} />
        <span className={compact ? 'min-w-0 flex-1 truncate sm:sr-only' : 'min-w-0 flex-1 truncate'}>{active.name}</span>
        {isTemporary && (
          <span
            className={
              compact
                ? 'hidden rounded-pill border border-(--labelDivider) bg-quinary px-1.5 py-0.5 text-[10px] font-semibold text-secondary sm:inline-flex'
                : 'rounded-pill border border-(--labelDivider) bg-quinary px-1.5 py-0.5 text-[10px] font-semibold text-secondary'
            }
          >
            Temporary
          </span>
        )}
        {multiple && (
          <ChevronsUpDown
            size={14}
            strokeWidth={2}
            className={compact ? 'flex-none text-secondary sm:hidden' : 'flex-none text-secondary'}
            aria-hidden="true"
          />
        )}
      </button>
      {anchor && (
        <Menu anchor={anchor} placement="above-start" onClose={close} label="Account">
          {auth.accounts.map((account) => (
            <div key={account.authUser} role="group" aria-label={account.email ?? account.name}>
              <MenuHeader>{account.email ?? account.name}</MenuHeader>
              {account.channels.map((channel) => (
                <MenuItem
                  key={channel.id}
                  checked={channel.id === active.id}
                  icon={<Avatar src={channel.avatarUrl} name={channel.name} size={20} />}
                  trailing={channel.brand ? 'Brand' : undefined}
                  onSelect={() => {
                    close();
                    if (channel.id !== active.id) select.mutate(channel.id);
                  }}
                >
                  {channel.name}
                </MenuItem>
              ))}
            </div>
          ))}
          <MenuSeparator />
          {isTemporary && (
            <MenuItem
              onSelect={() => {
                close();
                void desktopApi.authPromoteTemporarySession().then(() => {
                  void qc.invalidateQueries({ queryKey: ['desktop', 'session-meta'] });
                  void qc.invalidateQueries({ queryKey: ytAuthQueryKey });
                });
              }}
            >
              Keep me signed in (Save to PC)
            </MenuItem>
          )}
          <MenuItem
            onSelect={() => {
              close();
              openSignIn();
            }}
            trailing={<ArrowUpRight size={13} aria-hidden="true" />}
          >
            Switch or Add Account
          </MenuItem>
          <MenuItem
            destructive
            onSelect={() => {
              close();
              if (desktop) {
                void desktopApi.signOutYt().then(() => {
                  void qc.invalidateQueries({ queryKey: ['desktop', 'session-meta'] });
                });
              } else {
                connect.mutate(false);
              }
            }}
          >
            Sign Out
          </MenuItem>
        </Menu>
      )}
    </>
  );
}
