import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import menuTsx from '../components/Menu.tsx?raw';
import audioOutputModalTsx from '../shell/AudioOutputModal.tsx?raw';
import audioPipelineDialogTsx from '../shell/AudioPipelineDialog.tsx?raw';
import sidebarTsx from '../shell/Sidebar.tsx?raw';
import upNextTsx from '../shell/UpNext.tsx?raw';

const globalCss = readFileSync(new URL('./global.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('custom scrollbar theme & Chromium compatibility', () => {
  it('defines neutral scrollbar tokens across light, dark, tint, contrast, and full-screen surfaces', () => {
    const thumbMatches = tokensCss.match(/--scrollbarThumb:/g) ?? [];
    expect(thumbMatches.length).toBeGreaterThanOrEqual(8);
    expect(tokensCss).toContain('--scrollbarThumbHover:');
    expect(tokensCss).toContain('--scrollbarThumbActive:');
  });

  it('defines translucent pill scrollbar rules in base layer and @utility scrollbar-compact', () => {
    expect(globalCss).toContain('@utility scrollbar-compact');
    expect(globalCss).toContain('::-webkit-scrollbar-button');
    expect(globalCss).toContain('border-radius: 9999px;');
    expect(globalCss).toContain('@supports not selector(::-webkit-scrollbar)');
  });

  it('replaces [scrollbar-width:thin] with scrollbar-compact on Chromium scroll containers while preserving hidden carousels/sidebar', () => {
    for (const src of [menuTsx, audioOutputModalTsx, audioPipelineDialogTsx, upNextTsx]) {
      expect(src).toContain('scrollbar-compact');
      expect(src).not.toContain('[scrollbar-width:thin]');
    }
    expect(sidebarTsx).toContain('[scrollbar-width:none]');
  });
});
