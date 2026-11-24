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
    installerUrl: 'https://example.invalid/BitChord-win-x64.exe',
    installerSha256: null,
    installerFileName: 'BitChord-win-x64.exe',
    downloadedPath: null,
    notes: [
      '![Feature Banner](https://example.invalid/hero.png)',
      '## Top Features',
      '- Seamless in-app self-updates without reinstalling.',
    ].join('\n'),
    ...overrides,
  };
}

describe('UpdateBannerAndGate (Software Update frosted dialog)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useUi.setState({
      mandatoryUpdateLocked: false,
      updateModalOpen: false,
      hasPendingUpdate: false,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useUi.setState({
      mandatoryUpdateLocked: false,
      updateModalOpen: false,
      hasPendingUpdate: false,
    });
    vi.restoreAllMocks();
  });

  it('renders Software Update dialog with What\'s new Markdown, runs in-app download -> silent apply on Download Now, and dismisses on Remind Me Later', async () => {
    const dlSpy = vi
      .spyOn(desktopApi, 'downloadUpdate')
      .mockResolvedValue('C:\\Users\\test\\AppData\\Local\\BitChord\\updates\\BitChord-win-x64.exe');
    const installSpy = vi.spyOn(desktopApi, 'installUpdate').mockResolvedValue();

    act(() => {
      root.render(<UpdateBannerAndGate forceDesktop initialResult={makeUpdate()} />);
    });

    expect(useUi.getState().mandatoryUpdateLocked).toBe(false);
    expect(useUi.getState().hasPendingUpdate).toBe(true);
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Software Update');
    expect(dialog?.textContent).toContain('BitChord 0.10.0 is available to download.');
    expect(dialog?.textContent).toContain("What's new");
    expect(dialog?.textContent).toContain('Top Features');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe('https://example.invalid/hero.png');

    // Remind Me Later closes the modal while keeping pending indicator available.
    const remindBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Remind Me Later'),
    )!;
    act(() => {
      remindBtn.click();
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(useUi.getState().hasPendingUpdate).toBe(true);

    // Reopening (e.g. via TitleBar Update chip) and clicking Download Now downloads and auto-applies in app.
    act(() => {
      useUi.getState().setUpdateModalOpen(true);
    });
    const downloadNowBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Download Now'),
    )!;
    await act(async () => {
      downloadNowBtn.click();
    });
    expect(dlSpy).toHaveBeenCalledTimes(1);
    expect(installSpy).toHaveBeenCalledWith(
      'C:\\Users\\test\\AppData\\Local\\BitChord\\updates\\BitChord-win-x64.exe',
    );
    expect(host.textContent).toContain('Applying BitChord 0.10.0 and restarting');
  });

  it('locks mandatory gate when more than 3 major patches behind, hides Remind Me Later, blocks Escape, and supports Try Again on error', async () => {
    const dlSpy = vi
      .spyOn(desktopApi, 'downloadUpdate')
      .mockRejectedValueOnce(new Error('Network interrupted'))
      .mockResolvedValueOnce('C:\\Users\\test\\AppData\\Local\\BitChord\\updates\\BitChord-win-x64.exe');
    const installSpy = vi.spyOn(desktopApi, 'installUpdate').mockResolvedValue();

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
    expect(dialog?.textContent).not.toContain('Remind Me Later');
    expect(dialog?.textContent).toContain('Exit BitChord');

    // Pressing Escape must NOT dismiss mandatory update dialog.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(host.querySelector('[data-mandatory-update="true"]')).not.toBeNull();

    // First download attempt fails and shows Try Again.
    const downloadBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Download Now'),
    )!;
    await act(async () => {
      downloadBtn.click();
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Network interrupted');

    // Clicking Try Again downloads and silently triggers installUpdate.
    const retryBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Try Again'),
    )!;
    await act(async () => {
      retryBtn.click();
    });
    expect(dlSpy).toHaveBeenCalledTimes(2);
    expect(installSpy).toHaveBeenCalledTimes(1);
  });
});
