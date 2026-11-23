// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeveloperWatermark } from '@/components/DeveloperWatermark';
import {
  decodeWatermarkBytes,
  ENCRYPTED_WATERMARK,
  getEmbeddedWatermark,
  WATERMARK_TAG,
} from './watermark';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openUrlMock = vi.fn(async (_url: string) => {});

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrlMock(url),
}));

describe('Embedded & visible attribution watermark', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    openUrlMock.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('embeds encrypted ciphertext without leaking plaintext markers', () => {
    const rawCipher = new TextDecoder().decode(ENCRYPTED_WATERMARK);
    expect(rawCipher).not.toContain('Aberuu');
    expect(rawCipher).not.toContain('github.com');
  });

  it('decrypts the formatted payload and GitHub links cleanly', () => {
    const wm = getEmbeddedWatermark();
    expect(wm.integrityValid).toBe(true);
    expect(wm.credit).toBe('Developed by Aberuu');
    expect(wm.author).toBe('Aberuu');
    expect(wm.githubProfileUrl).toBe('https://github.com/Aberuu');
    expect(wm.githubRepoUrl).toBe('https://github.com/Aberuu/bitchord-dsk');
    expect(wm.formatted).toContain('BitChord Desktop (bitchord-dsk)');
    expect(wm.formatted).toContain('Credit     : Developed by Aberuu');
    expect(wm.formatted).toContain('Repository : https://github.com/Aberuu/bitchord-dsk');
  });

  it('rejects single-bit tampering on ciphertext or integrity tag', () => {
    const badCipher = new Uint8Array(ENCRYPTED_WATERMARK);
    badCipher[8] = (badCipher[8] ?? 0) ^ 0x01;
    const tampered = decodeWatermarkBytes(badCipher, WATERMARK_TAG);
    expect(tampered.integrityValid).toBe(false);
    expect(tampered.formatted).toBe('');

    const wrongTag = decodeWatermarkBytes(ENCRYPTED_WATERMARK, WATERMARK_TAG ^ 0x01n);
    expect(wrongTag.integrityValid).toBe(false);
    expect(wrongTag.credit).toBe('');
  });

  it('renders visible "Developed by Aberuu" and working GitHub links in sidebar, footer, and rows variants', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await act(async () => {
      root.render(
        <>
          <DeveloperWatermark variant="sidebar" />
          <DeveloperWatermark variant="footer" version="0.1.0-beta.1" />
          <DeveloperWatermark variant="rows" />
        </>,
      );
    });

    expect(host.textContent).toContain('Developed by Aberuu');
    expect(host.textContent).toContain('github.com/Aberuu/bitchord-dsk');

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>('a'));
    expect(links.length).toBeGreaterThanOrEqual(4);
    expect(links.every((a) => a.href.startsWith('https://github.com/Aberuu'))).toBe(true);

    await act(async () => {
      links[0]!.click();
    });
    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/Aberuu/bitchord-dsk',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});
