// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchField } from '@/components/music/SearchField';
import { TitleBar } from './TitleBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockIsDesktop = true;

vi.mock('@/desktop/tauriBridge', () => ({
  isTauriDesktop: () => mockIsDesktop,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
    close: async () => {},
  }),
}));

vi.mock('@/data/music/queries', () => ({
  useSuggestions: () => ({
    data: {
      queries: [{ text: 'janji palsu', typed: 'janji', rest: ' palsu' }],
      items: [],
    },
  }),
}));

vi.mock('react-router', () => ({
  useNavigate: () => () => {},
}));

describe('TitleBar, SearchField borders, and OLED black dark theme tokens', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockIsDesktop = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders TitleBar without a top divider line and matches sidebar glass + page canvas fills', () => {
    act(() => {
      root.render(<TitleBar />);
    });

    const header = host.querySelector('header')!;
    expect(header.className).not.toContain('border-b');
    expect(header.querySelector('.glass-material')).toBeTruthy();
    expect(header.innerHTML).toContain('bg-(--scrollablePageBG)');
  });

  it('returns null for TitleBar outside Tauri desktop', () => {
    mockIsDesktop = false;
    act(() => {
      root.render(<TitleBar />);
    });
    expect(host.querySelector('header')).toBeNull();
  });

  it('uses refined smoked glass divider styling instead of bright white inset ring on SearchField dropdown', () => {
    act(() => {
      root.render(<SearchField initial="janji" onSearch={() => {}} />);
    });

    const input = host.querySelector<HTMLInputElement>('input[data-music-search="true"]')!;
    act(() => {
      input.focus();
    });

    const listbox = host.querySelector('[role="listbox"]')!;
    expect(listbox.className).toContain('border-vibrant-divider/80');
    expect(listbox.className).not.toContain('#ffffff33');
  });
});
