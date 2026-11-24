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
});
