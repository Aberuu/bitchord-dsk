import { describe, expect, it } from 'vitest';
import { isTauriDesktop, proxyUrl, shouldProxyUrl } from './tauriBridge';

describe('desktop tauriBridge helpers', () => {
  it('identifies YouTube and googlevideo endpoints for proxying', () => {
    expect(shouldProxyUrl('https://music.youtube.com/youtubei/v1/browse')).toBe(true);
    expect(shouldProxyUrl('https://www.youtube.com/youtubei/v1/player')).toBe(true);
    expect(shouldProxyUrl('https://rr3---sn-ab5l6nzy.googlevideo.com/videoplayback?itag=251')).toBe(true);
  });

  it('skips BotGuard jnn endpoints and non-YouTube hosts', () => {
    expect(shouldProxyUrl('https://www.youtube.com/api/jnn/v1/GenerateIT')).toBe(false);
    expect(shouldProxyUrl('https://lrclib.net/api/get')).toBe(false);
    expect(shouldProxyUrl('http://127.0.0.1:42000/local/test')).toBe(false);
    expect(shouldProxyUrl('not-a-valid-url')).toBe(false);
  });

  it('returns raw URL unchanged outside Tauri runtime', () => {
    expect(isTauriDesktop()).toBe(false);
    const url = 'https://music.youtube.com/youtubei/v1/browse';
    expect(proxyUrl(url)).toBe(url);
  });
});
