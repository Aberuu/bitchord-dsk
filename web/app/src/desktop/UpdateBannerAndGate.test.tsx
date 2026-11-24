// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi, type UpdateCheckResult } from '@/desktop/tauriBridge';
import { useUi } from '@/state/ui';
import { UpdateBannerAndGate } from './UpdateBannerAndGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeUpdate(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    status: 'available',
    currentVersion: '0.8.0',
    latestVersion: '0.10.0',
    majorPatchLag: 2,
    maxMajorPatchLag: 3,
    mandatory: false,
    releaseUrl: 'https://github.com/Aberuu/bitchord-dsk/releases/tag/v0.10.0',
    installerUrl: 'https://example.invalid/BitChord-0.10.0-x64-setup.exe',
    installerSha256: null,
    installerFileName: 'BitChord-0.10.0-x64-setup.exe',
    downloadedPath: null,
    notes: 'Fixes and improvements.',
    ...overrides,
  };
}

describe('UpdateBannerAndGate', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useUi.setState({ mandatoryUpdateLocked: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUi.setState({ mandatoryUpdateLocked: false });
    vi.restoreAllMocks();
  });

  it('shows dismissible soft update banner when 1 to 3 major patches behind', () => {
    act(() => {
      root.render(<UpdateBannerAndGate forceDesktop initialResult={makeUpdate()} />);
    });

    expect(useUi.getState().mandatoryUpdateLocked).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('BitChord v0.10.0');
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();

    const dismiss = host.querySelector<HTMLButtonElement>('button[aria-label="Dismiss update notification"]')!;
    act(() => {
      dismiss.click();
    });
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it('renders non-dismissible mandatory gate when more than 3 major patches behind and supports retry on error', async () => {
    const dlSpy = vi
      .spyOn(desktopApi, 'downloadUpdate')
      .mockRejectedValueOnce(new Error('Network interrupted'))
      .mockResolvedValueOnce('C:\\Users\\test\\AppData\\Local\\BitChord\\updates\\BitChord-0.12.0-setup.exe');

    act(() => {
      root.render(
        <UpdateBannerAndGate
          forceDesktop
          initialResult={makeUpdate({
            status: 'mandatory',
            latestVersion: '0.12.0',
            majorPatchLag: 4,
            mandatory: true,
          })}
        />,
      );
    });

    expect(useUi.getState().mandatoryUpdateLocked).toBe(true);
    const dialog = host.querySelector('[role="alertdialog"][data-mandatory-update="true"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('4 major patches behind');

    // Pressing Escape must NOT dismiss mandatory update dialog.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-mandatory-update="true"]')).not.toBeNull();

    // First download fails and exposes Retry button.
    const updateBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Update & Install'),
    )!;
    await act(async () => {
      updateBtn.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Network interrupted');

    // Clicking Retry succeeds and transitions button to Install Update.
    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    )!;
    await act(async () => {
      retryBtn.click();
    });
    expect(dlSpy).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Install Update');
  });
});
