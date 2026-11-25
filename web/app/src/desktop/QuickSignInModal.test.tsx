// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi, type DesktopSessionMeta, type QuickLoginStatus } from '@/desktop/tauriBridge';
import { extensionQueryKey } from '@/extension/useExtension';
import { ytAuthQueryKey } from '@/extension/useYtAuth';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/state/ui';
import { QuickSignInModal } from './QuickSignInModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setControlValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeQuickStatus(keepSignedIn = false): QuickLoginStatus {
  return {
    active: true,
    code: '482-910',
    pairId: 'pair-test-1',
    qrUrl: 'http://192.168.1.42:47923/quick-login?code=482-910',
    lanIp: '192.168.1.42',
    port: 47923,
    expiresAtMs: Date.now() + 300_000,
    keepSignedIn,
  };
}

function seedSignedOutState(): void {
  queryClient.setQueryData(extensionQueryKey, {
    info: { capabilities: ['yt.auth'] },
    bridge: {
      call: vi.fn(),
      subscribe: () => () => {},
    },
  });
  queryClient.setQueryData(ytAuthQueryKey, {
    browserSignedIn: false,
    connected: true,
    signedIn: false,
    accounts: [],
    active: null,
    problem: null,
  });
}

describe('QuickSignInModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient.clear();
    seedSignedOutState();
    useUi.setState({
      quickSignInOpen: false,
      quickSignInRemindedThisRun: false,
      mandatoryUpdateLocked: false,
    });
    vi.spyOn(desktopApi, 'onQuickLoginCompleted').mockResolvedValue(() => {});
    vi.spyOn(desktopApi, 'onSessionMetaChanged').mockResolvedValue(() => {});
    vi.spyOn(desktopApi, 'authQuickLoginStop').mockResolvedValue({
      active: false,
      code: null,
      pairId: null,
      qrUrl: null,
      lanIp: null,
      port: null,
      expiresAtMs: null,
      keepSignedIn: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    queryClient.clear();
    useUi.setState({
      quickSignInOpen: false,
      quickSignInRemindedThisRun: false,
      mandatoryUpdateLocked: false,
    });
    vi.restoreAllMocks();
  });

  it('auto-opens for first-run signed-out user, defaults to Temporary session, toggles to Keep me signed in, and renders QR + code', async () => {
    const startSpy = vi.spyOn(desktopApi, 'authQuickLoginStart').mockResolvedValue(makeQuickStatus(false));
    const setKeepSpy = vi.spyOn(desktopApi, 'authQuickLoginSetKeep').mockResolvedValue(makeQuickStatus(true));

    const meta: DesktopSessionMeta = {
      persistence: 'signed_out',
      source: null,
      skipSignInPrompt: false,
    };

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <QuickSignInModal forceDesktop initialSessionMeta={meta} initialQuickLogin={makeQuickStatus(false)} />
        </QueryClientProvider>,
      );
    });

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Sign in to BitChord');

    const radios = Array.from(host.querySelectorAll('[role="radio"]'));
    expect(radios[0]?.textContent).toContain('Temporary session');
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
    expect(radios[1]?.textContent).toContain('Keep me signed in');
    expect(radios[1]?.getAttribute('aria-checked')).toBe('false');

    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    expect(dialog?.textContent).toContain('482-910');
    expect(startSpy).toHaveBeenCalledTimes(0);

    await act(async () => {
      (radios[1] as HTMLButtonElement).click();
    });

    expect(radios[1]?.getAttribute('aria-checked')).toBe('true');
    expect(setKeepSpy).toHaveBeenCalledWith(true);
  });

  it('reveals PIN field automatically when pasting a BC1P- key and calls authUnlockWithOneKey', async () => {
    const unlockSpy = vi.spyOn(desktopApi, 'authUnlockWithOneKey').mockResolvedValue({
      auth: {
        browserSignedIn: true,
        connected: true,
        signedIn: true,
        accounts: [],
        active: {
          id: 'ch-1',
          name: 'Demo Listener',
          handle: '@demo',
          avatarUrl: null,
          brand: false,
          authUser: '0',
        },
        problem: null,
      },
      persistence: 'temporary',
    });

    useUi.setState({ quickSignInOpen: true });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <QuickSignInModal
            forceDesktop
            initialSessionMeta={{ persistence: 'signed_out', source: null, skipSignInPrompt: true }}
            initialQuickLogin={makeQuickStatus(false)}
          />
        </QueryClientProvider>,
      );
    });

    const keyTab = Array.from(host.querySelectorAll('[role="tab"]')).find((el) =>
      el.textContent?.includes('1-Key Session'),
    ) as HTMLButtonElement;

    await act(async () => {
      keyTab.click();
    });

    expect(host.querySelector('#one-key-pin-input')).toBeNull();

    const textarea = host.querySelector('#one-key-input') as HTMLTextAreaElement;
    await act(async () => {
      setControlValue(textarea, 'BC1P-encrypted-token-example');
    });

    const pinInput = host.querySelector('#one-key-pin-input') as HTMLInputElement;
    expect(pinInput).not.toBeNull();

    await act(async () => {
      setControlValue(pinInput, '4321');
    });

    const submitBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Unlock & Sign In'),
    ) as HTMLButtonElement;

    await act(async () => {
      submitBtn.click();
    });

    expect(unlockSpy).toHaveBeenCalledWith('BC1P-encrypted-token-example', '4321', false);
    expect(useUi.getState().quickSignInOpen).toBe(false);
  });

  it('Remind me later dismisses only for this run while Continue without signing in persists skipSignInPrompt', async () => {
    const skipSpy = vi.spyOn(desktopApi, 'authSetSkipSignInPrompt').mockResolvedValue({
      persistence: 'signed_out',
      source: null,
      skipSignInPrompt: true,
    });

    useUi.setState({ quickSignInOpen: true });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <QuickSignInModal
            forceDesktop
            initialSessionMeta={{ persistence: 'signed_out', source: null, skipSignInPrompt: true }}
            initialQuickLogin={makeQuickStatus(false)}
          />
        </QueryClientProvider>,
      );
    });

    const remindBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Remind me later'),
    ) as HTMLButtonElement;

    await act(async () => {
      remindBtn.click();
    });

    expect(useUi.getState().quickSignInOpen).toBe(false);
    expect(useUi.getState().quickSignInRemindedThisRun).toBe(true);
    expect(skipSpy).not.toHaveBeenCalled();

    // Re-open manually and click Continue without signing in.
    await act(async () => {
      useUi.getState().setQuickSignInOpen(true);
    });

    const continueBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Continue without signing in'),
    ) as HTMLButtonElement;

    await act(async () => {
      continueBtn.click();
    });

    expect(skipSpy).toHaveBeenCalledWith(true);
    expect(useUi.getState().quickSignInOpen).toBe(false);
  });
});
