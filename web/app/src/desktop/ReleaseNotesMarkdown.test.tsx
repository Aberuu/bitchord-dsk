// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ReleaseNotesMarkdown', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders headings, bold bullets, safe https images, and strips unsafe links', () => {
    const markdown = [
      '![BitChord Banner](https://example.invalid/banner.jpg)',
      '## Top Features',
      '- **Replay Year**: your year in music as animated stories.',
      '- Check [release page](javascript:alert(1)) safely.',
    ].join('\n');

    act(() => {
      root.render(<ReleaseNotesMarkdown notes={markdown} />);
    });

    const img = host.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.invalid/banner.jpg');
    expect(host.querySelector('h3')?.textContent).toBe('Top Features');
    expect(host.querySelector('strong')?.textContent).toBe('Replay Year');
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('release page');
  });

  it('cleans legacy backslash tokens, strips installer filename noise, and renders h4 and ordered lists', () => {
    const legacyNotes = [
      '### BitChord Desktop v1.2.0 (Medium Release)',
      '',
      '#### Highlights',
      '1. **Quick Sign-In:** Added \\quick_login.rs\\, \\QuickSignInModal\\, and \\\u000bault.rs\\.',
      '2. Supports *italic emphasis* cleanly.',
      '',
      '#### Windows x64 Installers',
      '- \\BitChord_1.2.0_x64-setup.exe\\ (NSIS Installer)',
      '- \\BitChord_1.2.0_x64_en-US.msi\\ (MSI Installer)',
    ].join('\n');

    act(() => {
      root.render(<ReleaseNotesMarkdown notes={legacyNotes} />);
    });

    expect(host.textContent).not.toContain('BitChord Desktop v1.2.0 (Medium Release)');
    expect(host.textContent).not.toContain('Windows x64 Installers');
    expect(host.textContent).not.toContain('BitChord_1.2.0_x64-setup.exe');
    expect(host.querySelector('h4')?.textContent).toBe('Highlights');
    expect(host.querySelector('ol')).not.toBeNull();
    const codes = Array.from(host.querySelectorAll('code')).map((c) => c.textContent);
    expect(codes).toEqual(['quick_login.rs', 'QuickSignInModal', 'vault.rs']);
    expect(host.querySelector('em')?.textContent).toBe('italic emphasis');
  });
});
