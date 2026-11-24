// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopApi, type AddonConfig } from '@/desktop/tauriBridge';
import SourcesPage from '@/pages/SourcesPage';
import { useSources } from '@/state/sources';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('SourcesPage & Modals', () => {
  let host: HTMLDivElement;
  let root: Root;
  let qc: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Object.assign(window, { __TAURI_INTERNALS__: {} });

    vi.spyOn(desktopApi, 'sourcesGetState').mockResolvedValue({
      addons: [],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
      webdav: { configured: false, url: '', username: '', hasPassword: false },
      smb: { configured: false, host: '', share: '', basePath: '', username: '', hasPassword: false },
    });
    vi.spyOn(desktopApi, 'sourcesSetAddons').mockImplementation(async (addons) => ({
      addons,
      jiosaavnEnabled: useSources.getState().jiosaavnEnabled,
      trackLengthToleranceSec: useSources.getState().trackLengthToleranceSec,
      webdav: useSources.getState().webdav,
      smb: useSources.getState().smb,
    }));
    vi.spyOn(desktopApi, 'sourcesSetJiosaavn').mockImplementation(async (enabled) => ({
      addons: useSources.getState().addons,
      jiosaavnEnabled: enabled,
      trackLengthToleranceSec: useSources.getState().trackLengthToleranceSec,
      webdav: useSources.getState().webdav,
      smb: useSources.getState().smb,
    }));
    vi.spyOn(desktopApi, 'sourcesSetTolerance').mockImplementation(async (seconds) => ({
      addons: useSources.getState().addons,
      jiosaavnEnabled: useSources.getState().jiosaavnEnabled,
      trackLengthToleranceSec: seconds,
      webdav: useSources.getState().webdav,
      smb: useSources.getState().smb,
    }));

    useSources.setState({
      loaded: true,
      addons: [],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
      webdav: { configured: false, url: '', username: '', hasPassword: false },
      smb: { configured: false, host: '', share: '', basePath: '', username: '', hasPassword: false },
      healthByAddonId: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  const renderPage = async () => {
    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/settings/sources']}>
            <SourcesPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
  };

  it('requires warning confirmation before enabling JioSaavn and keeps YouTube Always on', async () => {
    await renderPage();

    expect(host.textContent).toContain('YouTube Music');
    expect(host.textContent).toContain('Always on');
    expect(host.textContent).toContain('No enabled source can provide lossless audio');
    expect(host.textContent).toContain('5 s');

    const jiosaavnToggle = host.querySelector<HTMLInputElement>('input[aria-label="Enable JioSaavn"]')!;
    expect(jiosaavnToggle.checked).toBe(false);

    act(() => {
      jiosaavnToggle.click();
    });
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Enable JioSaavn?');

    const enableAnyway = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Enable anyway',
    )!;
    await act(async () => {
      enableAnyway.click();
      await Promise.resolve();
    });

    expect(useSources.getState().jiosaavnEnabled).toBe(true);
  });

  it('supports Add an addon Test and Save workflow', async () => {
    const sampleAddon: AddonConfig = {
      id: 'addon:1',
      name: 'Lossless Mirror',
      baseUrl: 'https://mirror.example.com',
      enabled: true,
      pickedQuality: 'lossless',
      qualityOptions: [
        { value: 'lossless', label: 'Lossless' },
        { value: 'high', label: 'High' },
      ],
      allowDownloads: true,
      checkValidLossless: false,
      bitchordAuth: false,
      version: '1.0.0',
      defaultSettings: {},
    };

    const idSpy = vi.spyOn(desktopApi, 'sourcesIdentifyAddon').mockResolvedValue({
      config: sampleAddon,
      health: { state: 'ok', detail: 'Lossless · 42 ms', latencyMs: 42 },
    });

    await renderPage();

    const addBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add an addon'),
    )!;
    act(() => {
      addBtn.click();
    });

    const urlInput = host.querySelector<HTMLInputElement>('input[aria-label="Addon URL"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(urlInput, 'https://mirror.example.com');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const testBtn = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Test',
    )!;
    await act(async () => {
      testBtn.click();
      await Promise.resolve();
    });
    expect(idSpy).toHaveBeenCalledWith('https://mirror.example.com', null);
    expect(host.querySelector('[role="dialog"] [role="status"]')?.textContent).toContain('Connected');

    const saveBtn = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    await act(async () => {
      saveBtn.click();
      await Promise.resolve();
    });

    expect(useSources.getState().addons).toHaveLength(1);
    expect(host.textContent).toContain('Lossless Mirror');
    expect(host.textContent).not.toContain('No enabled source can provide lossless audio');
  });

  it('saves WebDAV and SMB configs, shows Test Connection and Disconnect controls, and updates tolerance slider', async () => {
    vi.spyOn(desktopApi, 'webdavTest').mockResolvedValue(undefined);
    vi.spyOn(desktopApi, 'webdavSave').mockResolvedValue({
      addons: [],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
      webdav: { configured: true, url: 'https://cloud.example.com/dav', username: 'abel', hasPassword: true },
      smb: useSources.getState().smb,
    });
    vi.spyOn(desktopApi, 'webdavDisconnect').mockResolvedValue({
      addons: [],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
      webdav: { configured: false, url: '', username: '', hasPassword: false },
      smb: useSources.getState().smb,
    });

    await renderPage();

    const davBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent?.includes('WebDAV') && b.textContent?.includes('Connect a server under Sources'),
    )!;
    act(() => {
      davBtn.click();
    });

    const urlInput = host.querySelector<HTMLInputElement>('input[aria-label="Server URL"]')!;
    const userInput = host.querySelector<HTMLInputElement>('input[aria-label="Username"]')!;
    const passInput = host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(urlInput, 'https://cloud.example.com/dav');
      urlInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(userInput, 'abel');
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passInput, 'secret');
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveBtn = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.trim() === 'Save',
    )!;
    await act(async () => {
      saveBtn.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Test Connection');
    expect(host.textContent).toContain('Disconnect');

    const slider = host.querySelector<HTMLInputElement>(
      'input[aria-label="Track length tolerance in seconds"]',
    )!;
    await act(async () => {
      setter.call(slider, '8');
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(useSources.getState().trackLengthToleranceSec).toBe(8);
  });
});
