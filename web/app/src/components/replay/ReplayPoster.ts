import { formatDay, formatHour, formatListening, formatMinutes, formatPlays, type ReplaySummary } from '@/desktop/statsApi';
import { meshPalette, type Rgb } from '@/lib/meshPalette';

const POSTER_W = 1080;
const POSTER_H = 1920;
const MARGIN = 76;

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut).trimEnd()}…`).width > maxWidth) {
    cut--;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

// Renders a 1080x1920 9:16 shareable PNG poster matching Android ReplayPoster.kt.
export async function renderReplayPosterPngBase64(
  summary: ReplaySummary,
  holder: string,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext('2d')!;

  let cells: Rgb[] = [
    [62, 62, 68],
    [46, 46, 52],
    [34, 34, 40],
    [24, 24, 29],
  ];
  const leadArtwork = summary.songs[0]?.artworkUrl ?? null;
  if (leadArtwork) {
    try {
      cells = await meshPalette(leadArtwork);
    } catch {
      // Keep neutral charcoal palette if image fetch is offline.
    }
  }

  ctx.fillStyle = '#141417';
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  const anchors: [number, number, number][] = [
    [0.2, 0.18, 0.75],
    [0.82, 0.24, 0.7],
    [0.25, 0.72, 0.75],
    [0.78, 0.78, 0.72],
  ];
  anchors.forEach(([ax, ay, r], idx) => {
    const [cr, cg, cb] = cells[(idx * 4) % cells.length] ?? [50, 50, 56];
    const gx = ax * POSTER_W;
    const gy = ay * POSTER_H;
    const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * POSTER_W);
    grad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.85)`);
    grad.addColorStop(0.55, `rgba(${cr}, ${cg}, ${cb}, 0.32)`);
    grad.addColorStop(1, 'rgba(20, 20, 23, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, POSTER_W, POSTER_H);
  });

  const scrim = ctx.createLinearGradient(0, 0, 0, POSTER_H);
  scrim.addColorStop(0, 'rgba(0, 0, 0, 0.22)');
  scrim.addColorStop(0.5, 'rgba(0, 0, 0, 0.45)');
  scrim.addColorStop(1, 'rgba(0, 0, 0, 0.74)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  const font = "'DM Sans', 'Segoe UI', sans-serif";
  const mono = "ui-monospace, 'Cascadia Mono', Consolas, monospace";

  ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.font = `700 24px ${font}`;
  ctx.fillText('YOUR LISTENING EXPERIENCE', MARGIN, 118);

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 68px ${font}`;
  ctx.fillText(`Replay · ${summary.label}`, MARGIN, 200);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.font = `600 26px ${mono}`;
  const holderLine = (holder.trim() || 'BITCHORD LISTENER').toUpperCase();
  const memberLine = summary.memberSince ? ` · MEMBER SINCE ${summary.memberSince}` : '';
  ctx.fillText(`${holderLine}${memberLine}`, MARGIN, 252);

  // Minutes Hero Block
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.beginPath();
  ctx.roundRect(MARGIN, 300, POSTER_W - MARGIN * 2, 230, 32);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 96px ${font}`;
  ctx.fillText(formatMinutes(summary.totalMs), MARGIN + 44, 422);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
  ctx.font = `700 24px ${font}`;
  ctx.fillText(
    `MINUTES LISTENED · ${formatPlays(summary.totalPlays).toUpperCase()} · ${summary.distinctSongs} SONGS`,
    MARGIN + 44,
    478,
  );

  // Two columns: Top Songs & Top Artists
  const colW = (POSTER_W - MARGIN * 2 - 48) / 2;
  const col1X = MARGIN;
  const col2X = MARGIN + colW + 48;
  let y = 610;

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 36px ${font}`;
  ctx.fillText('Top Songs', col1X, y);
  ctx.fillText('Top Artists', col2X, y);

  y += 58;
  const topSongs = summary.songs.slice(0, 5);
  const topArtists = summary.artists.slice(0, 5);

  for (let i = 0; i < 5; i++) {
    const rowY = y + i * 116;
    const song = topSongs[i];
    if (song) {
      ctx.fillStyle = i === 0 ? '#fa586a' : 'rgba(255, 255, 255, 0.48)';
      ctx.font = `800 32px ${font}`;
      ctx.fillText(String(i + 1), col1X, rowY);

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 30px ${font}`;
      ctx.fillText(truncateText(ctx, song.title, colW - 56), col1X + 46, rowY);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.font = `500 23px ${font}`;
      ctx.fillText(
        truncateText(ctx, `${song.artist} · ${formatPlays(song.plays)}`, colW - 56),
        col1X + 46,
        rowY + 34,
      );
    }

    const artist = topArtists[i];
    if (artist) {
      ctx.fillStyle = i === 0 ? '#fa586a' : 'rgba(255, 255, 255, 0.48)';
      ctx.font = `800 32px ${font}`;
      ctx.fillText(String(i + 1), col2X, rowY);

      ctx.fillStyle = '#ffffff';
      ctx.font = `700 30px ${font}`;
      ctx.fillText(truncateText(ctx, artist.title, colW - 56), col2X + 46, rowY);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
      ctx.font = `500 23px ${font}`;
      ctx.fillText(
        truncateText(ctx, `${formatListening(artist.ms)} · ${formatPlays(artist.plays)}`, colW - 56),
        col2X + 46,
        rowY + 34,
      );
    }
  }

  let albumY = 1265;
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 36px ${font}`;
  ctx.fillText('Top Albums', MARGIN, albumY);
  albumY += 56;

  summary.albums.slice(0, 3).forEach((album, idx) => {
    const ry = albumY + idx * 96;
    ctx.fillStyle = idx === 0 ? '#fa586a' : 'rgba(255, 255, 255, 0.48)';
    ctx.font = `800 30px ${font}`;
    ctx.fillText(String(idx + 1), MARGIN, ry);

    ctx.fillStyle = '#ffffff';
    ctx.font = `700 28px ${font}`;
    ctx.fillText(
      truncateText(ctx, album.title, POSTER_W - MARGIN * 2 - 240),
      MARGIN + 46,
      ry,
    );

    ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
    ctx.font = `500 23px ${font}`;
    ctx.fillText(
      truncateText(
        ctx,
        [album.subtitle, formatListening(album.ms)].filter(Boolean).join(' · '),
        POSTER_W - MARGIN * 2 - 120,
      ),
      MARGIN + 46,
      ry + 32,
    );
  });

  // Listening Habits Footer Box
  const footerBoxY = 1620;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.roundRect(MARGIN, footerBoxY, POSTER_W - MARGIN * 2, 160, 26);
  ctx.fill();

  const habitParts = [
    `${summary.distinctSongs} songs`,
    `${summary.distinctArtists} artists`,
    `${summary.distinctAlbums} albums`,
  ];
  if (summary.peakHour !== null) {
    habitParts.push(`Peak hour: ${formatHour(summary.peakHour)}`);
  }
  if (summary.busiestDay) {
    habitParts.push(`Biggest day: ${formatDay(summary.busiestDay)} (${formatListening(summary.busiestDayMs)})`);
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
  ctx.font = `700 22px ${font}`;
  ctx.fillText('LISTENING PATTERN', MARGIN + 36, footerBoxY + 56);

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 25px ${font}`;
  ctx.fillText(
    truncateText(ctx, habitParts.join(' · '), POSTER_W - MARGIN * 2 - 72),
    MARGIN + 36,
    footerBoxY + 106,
  );

  ctx.fillStyle = 'rgba(255, 255, 255, 0.50)';
  ctx.font = `700 24px ${font}`;
  ctx.fillText('BitChord Desktop', MARGIN, 1852);

  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.replace(/^data:image\/png;base64,/, '');
}
