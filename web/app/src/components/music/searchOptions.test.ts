import { describe, expect, it } from 'vitest';
import type { MusicItem, SearchResults, Suggestions } from '@/data/music/types';
import { buildSearchShelves, buildSuggestionOptions } from './searchOptions';

function item(kind: MusicItem['kind'], id: string, title = id): MusicItem {
  return {
    kind,
    id,
    title,
    subtitle: kind,
    artists: [],
    album: null,
    thumbnail: null,
    wide: false,
    durationSec: kind === 'song' || kind === 'video' ? 200 : null,
    explicit: false,
  };
}

describe('buildSuggestionOptions', () => {
  it('places song suggestions first, then other items, and query completions last', () => {
    const suggestions: Suggestions = {
      queries: [
        { text: 'janji palsu', typed: 'janji palsu', rest: '' },
        { text: 'janji palsu hindia', typed: 'janji palsu', rest: ' hindia' },
      ],
      items: [
        item('artist', 'art-1', 'Hindia'),
        item('video', 'vid-1', 'Janji Palsu Live'),
        item('song', 'song-1', 'Janji Palsu'),
        item('album', 'alb-1', 'Lagipula Hidup Akan Berakhir'),
        item('song', 'song-2', 'Balasan Janji Palsumu'),
      ],
    };

    const options = buildSuggestionOptions(suggestions);
    expect(options.map((o) => (o.kind === 'item' ? `${o.item.kind}:${o.item.id}` : `q:${o.text}`))).toEqual([
      'song:song-1',
      'song:song-2',
      'video:vid-1',
      'album:alb-1',
      'artist:art-1',
      'q:janji palsu',
      'q:janji palsu hindia',
    ]);
  });

  it('returns an empty list when suggestions are missing', () => {
    expect(buildSuggestionOptions(undefined)).toEqual([]);
  });
});

describe('buildSearchShelves', () => {
  it('leads full search results with the Songs shelf before Artists and Albums', () => {
    const results: SearchResults = {
      top: [],
      artists: [item('artist', 'a1')],
      albums: [item('album', 'al1')],
      songs: [item('song', 's1')],
      playlists: [item('playlist', 'p1')],
      videos: [item('video', 'v1')],
    };

    expect(buildSearchShelves(results).map((s) => s.title)).toEqual([
      'Songs',
      'Artists',
      'Albums',
      'Playlists',
      'Videos',
    ]);
  });
});
