import { describe, expect, it } from 'vitest';
import {
  buildReplayCards,
  formatDay,
  formatHour,
  formatListening,
  formatMemberSince,
  formatMinutes,
  parseAndValidateBackupJson,
  playThresholdMs,
  primaryArtist,
  type ReplaySummary,
} from './statsApi';

describe('Replay listening stats & card helpers', () => {
  it('splits collaboration credits to lead artist while keeping band names with "and"', () => {
    expect(primaryArtist('.Feast & Hindia')).toBe('.Feast');
    expect(primaryArtist('Cheema Y, Gur Sidhu feat. Naseeb')).toBe('Cheema Y');
    expect(primaryArtist('Florence and the Machine')).toBe('Florence and the Machine');
  });

  it('formats minutes, listening duration, hours, days, and memberSince', () => {
    expect(formatMinutes(4_020_000)).toBe('67');
    expect(formatListening(1_500_000)).toBe('25 min');
    expect(formatListening(660_000)).toBe('11 min');
    expect(formatHour(0)).toBe('midnight');
    expect(formatHour(18)).toBe('6 pm');
    expect(formatDay('2026-11-22')).toBe('22 November');
    expect(formatMemberSince('2026-11')).toBe('11/26');
  });

  it('builds the four YOUR LISTENING EXPERIENCE cards and omits empty categories', () => {
    const summary: ReplaySummary = {
      period: 'this_year',
      label: '2026',
      totalMs: 4_020_000,
      totalPlays: 16,
      songs: [
        {
          videoId: 'tarot_01',
          title: 'Tarot',
          artist: '.Feast',
          albumName: 'Membangun & Menghancurkan',
          albumId: 'MPREb_1',
          artistId: 'UC_1',
          artworkUrl: 'https://i.ytimg.com/vi/tarot_01/hqdefault.jpg',
          ms: 4_020_000,
          plays: 1,
        },
      ],
      artists: [
        {
          title: '.Feast',
          subtitle: null,
          artworkUrl: 'https://i.ytimg.com/vi/tarot_01/hqdefault.jpg',
          browseId: 'UC_1',
          ms: 1_500_000,
          plays: 5,
        },
      ],
      albums: [
        {
          title: 'Membangun & Menghancurkan',
          subtitle: '.Feast',
          artworkUrl: 'https://i.ytimg.com/vi/tarot_01/hqdefault.jpg',
          browseId: 'MPREb_1',
          ms: 660_000,
          plays: 3,
        },
      ],
      hourOfDay: Array.from({ length: 24 }, () => 0),
      peakHour: 18,
      busiestDay: '2026-11-22',
      busiestDayMs: 4_020_000,
      distinctSongs: 1,
      distinctArtists: 1,
      distinctAlbums: 1,
      since: '2026-11',
      memberSince: '11/26',
    };

    const cards = buildReplayCards(summary);
    expect(cards).toHaveLength(4);
    expect(cards[0]).toMatchObject({
      id: 'minutes',
      label: 'Minutes listened',
      value: '67',
      detail: '16 plays · 2026',
    });
    expect(cards[1]).toMatchObject({
      id: 'songs',
      label: 'Top song',
      value: 'Tarot',
      detail: '.Feast · 1 play',
    });
    expect(cards[2]).toMatchObject({
      id: 'artists',
      label: 'Top artist',
      value: '.Feast',
      detail: '25 min · 5 plays',
    });
    expect(cards[3]).toMatchObject({
      id: 'albums',
      label: 'Top album',
      value: 'Membangun & Menghancurkan',
      detail: '.Feast · 11 min',
    });

    const withoutAlbums = buildReplayCards({ ...summary, albums: [] });
    expect(withoutAlbums).toHaveLength(3);
  });

  it('computes scrobbler-aligned play threshold with 30s floor and 4m ceiling', () => {
    expect(playThresholdMs(20)).toBe(30_000);
    expect(playThresholdMs(200)).toBe(100_000);
    expect(playThresholdMs(900)).toBe(240_000);
  });

  it('validates Android BitChord backup JSON format', () => {
    const valid = JSON.stringify({
      app: 'bitchord',
      version: 1,
      versionName: '1.2.4',
      exportedAt: '2026-11-22T18:25:00Z',
      listening: [{ month: '2026-11', tracks: [{ id: 'v1', title: 'Tarot', artist: '.Feast', ms: 60000, plays: 1 }] }],
    });
    const parsed = parseAndValidateBackupJson(valid);
    expect(parsed.buckets).toHaveLength(1);
    expect(parsed.fromVersion).toBe('1.2.4');

    expect(() => parseAndValidateBackupJson(JSON.stringify({ app: 'other', version: 1, listening: [] }))).toThrow(
      /another app/,
    );
  });
});
