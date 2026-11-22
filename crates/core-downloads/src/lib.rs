use anyhow::{anyhow, Context, Result};
use core_auth::app_data_dir;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, Tag, TagExt};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;
use walkdir::WalkDir;

const CHUNK_BYTES: u64 = 1024 * 1024;
const SUPPORTED_EXTS: &[&str] = &["flac", "m4a", "mp3", "opus", "ogg", "wav", "webm", "dsf", "dff"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedTrack {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: i64,
    pub artwork_url: Option<String>,
    pub file_path: String,
    pub format: String,
    pub bitrate_kbps: Option<i64>,
    pub file_size_bytes: i64,
    pub downloaded_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: i64,
    pub artwork_url: Option<String>,
    pub stream_url: String,
    pub mime_type: String,
    pub content_length: Option<u64>,
    pub bitrate_kbps: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub video_id: String,
    pub status: String,
    pub progress: f32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrack {
    pub id: String,
    pub file_path: String,
    pub folder_path: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: i64,
    pub sample_rate_hz: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub codec: String,
    pub file_size_bytes: i64,
    pub cover_path: Option<String>,
}

pub struct LibraryStore {
    conn: Mutex<Connection>,
    downloads_dir: PathBuf,
    covers_dir: PathBuf,
    http: reqwest::Client,
}

impl LibraryStore {
    pub fn open_default(http: reqwest::Client) -> Result<Self> {
        let root = app_data_dir()?;
        Self::open_at(root, http)
    }

    pub fn open_at(root: PathBuf, http: reqwest::Client) -> Result<Self> {
        let downloads_dir = root.join("downloads");
        let covers_dir = root.join("covers");
        fs::create_dir_all(&downloads_dir)?;
        fs::create_dir_all(&covers_dir)?;
        let conn = Connection::open(root.join("library.db"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS downloads (
                video_id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT,
                duration_sec INTEGER NOT NULL,
                artwork_url TEXT,
                file_path TEXT NOT NULL,
                format TEXT NOT NULL,
                bitrate_kbps INTEGER,
                file_size_bytes INTEGER NOT NULL,
                downloaded_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_folders (
                path TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_tracks (
                id TEXT PRIMARY KEY,
                file_path TEXT UNIQUE NOT NULL,
                folder_path TEXT NOT NULL,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                album TEXT,
                duration_sec INTEGER NOT NULL,
                sample_rate_hz INTEGER,
                bit_depth INTEGER,
                channels INTEGER,
                codec TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                modified_secs INTEGER NOT NULL,
                cover_path TEXT
            );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            downloads_dir,
            covers_dir,
            http,
        })
    }

    pub fn list_downloads(&self) -> Result<Vec<DownloadedTrack>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT video_id, title, artist, album, duration_sec, artwork_url, file_path, format, bitrate_kbps, file_size_bytes, downloaded_at
             FROM downloads ORDER BY downloaded_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok(DownloadedTrack {
                    video_id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    duration_sec: row.get(4)?,
                    artwork_url: row.get(5)?,
                    file_path: row.get(6)?,
                    format: row.get(7)?,
                    bitrate_kbps: row.get(8)?,
                    file_size_bytes: row.get(9)?,
                    downloaded_at: row.get(10)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_download_path(&self, video_id: &str) -> Option<PathBuf> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT file_path FROM downloads WHERE video_id = ?1",
            params![video_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.exists())
    }

    pub fn delete_download(&self, video_id: &str) -> Result<()> {
        if let Some(path) = self.get_download_path(video_id) {
            let _ = fs::remove_file(path);
        }
        self.conn
            .lock()
            .execute("DELETE FROM downloads WHERE video_id = ?1", params![video_id])?;
        Ok(())
    }

    pub async fn download_track<F>(
        &self,
        req: DownloadRequest,
        on_progress: F,
    ) -> Result<DownloadedTrack>
    where
        F: Fn(DownloadProgress) + Send + Sync,
    {
        on_progress(DownloadProgress {
            video_id: req.video_id.clone(),
            status: "downloading".into(),
            progress: 0.0,
            error: None,
        });

        let ext = ext_for_mime(&req.mime_type);
        let safe_id: String = req
            .video_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        if safe_id.is_empty() {
            return Err(anyhow!("Invalid video id for download"));
        }
        let target_path = self.downloads_dir.join(format!("{safe_id}.{ext}"));
        let tmp_path = target_path.with_extension(format!("{ext}.part"));

        let parsed = Url::parse(&req.stream_url)?;
        let is_visionos = parsed
            .query_pairs()
            .any(|(k, v)| k == "c" && v.eq_ignore_ascii_case("VISIONOS"));

        let mut bytes = Vec::new();
        let mut at: u64 = 0;
        let total = req.content_length.unwrap_or(0);
        loop {
            let mut chunk_url = parsed.clone();
            let end = if total > 0 {
                (at + CHUNK_BYTES).min(total).saturating_sub(1)
            } else {
                at + CHUNK_BYTES - 1
            };
            chunk_url
                .query_pairs_mut()
                .append_pair("range", &format!("{at}-{end}"));

            let mut http_req = self.http.get(chunk_url);
            if !is_visionos {
                http_req = http_req
                    .header("Origin", "https://www.youtube.com")
                    .header("Referer", "https://www.youtube.com/");
            }
            let resp = http_req.send().await.context("download chunk request")?;
            if !resp.status().is_success() {
                let err_msg = format!("Download HTTP {}", resp.status().as_u16());
                on_progress(DownloadProgress {
                    video_id: req.video_id.clone(),
                    status: "error".into(),
                    progress: 0.0,
                    error: Some(err_msg.clone()),
                });
                return Err(anyhow!(err_msg));
            }
            let part = resp.bytes().await?;
            let n = part.len() as u64;
            bytes.extend_from_slice(&part);
            at += n;
            let pct = if total > 0 {
                (at as f32 / total as f32).clamp(0.0, 0.95)
            } else {
                0.5
            };
            on_progress(DownloadProgress {
                video_id: req.video_id.clone(),
                status: "downloading".into(),
                progress: pct,
                error: None,
            });
            if n == 0 || (total > 0 && at >= total) || (total == 0 && n < CHUNK_BYTES) {
                break;
            }
        }

        fs::write(&tmp_path, &bytes)?;
        let _ = fs::remove_file(&target_path);
        fs::rename(&tmp_path, &target_path)?;

        let cover_bytes = match req.artwork_url.as_deref() {
            Some(url) if url.starts_with("http") => self
                .http
                .get(url)
                .send()
                .await
                .ok()
                .filter(|r| r.status().is_success())
                .and_then(|r| Some(r))
                .map(|r| async move { r.bytes().await.ok().map(|b| b.to_vec()) }),
            _ => None,
        };
        let cover = match cover_bytes {
            Some(fut) => fut.await,
            None => None,
        };
        if let Err(err) = embed_metadata(
            &target_path,
            &req.title,
            &req.artist,
            req.album.as_deref(),
            cover.as_deref(),
        ) {
            tracing::debug!("Skipping tag embedding for {}: {err}", target_path.display());
        }

        let size = fs::metadata(&target_path)?.len() as i64;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let item = DownloadedTrack {
            video_id: req.video_id.clone(),
            title: req.title,
            artist: req.artist,
            album: req.album,
            duration_sec: req.duration_sec,
            artwork_url: req.artwork_url,
            file_path: target_path.to_string_lossy().into_owned(),
            format: ext.to_uppercase(),
            bitrate_kbps: req.bitrate_kbps,
            file_size_bytes: size,
            downloaded_at: now,
        };

        self.conn.lock().execute(
            "INSERT OR REPLACE INTO downloads
             (video_id, title, artist, album, duration_sec, artwork_url, file_path, format, bitrate_kbps, file_size_bytes, downloaded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                item.video_id,
                item.title,
                item.artist,
                item.album,
                item.duration_sec,
                item.artwork_url,
                item.file_path,
                item.format,
                item.bitrate_kbps,
                item.file_size_bytes,
                item.downloaded_at
            ],
        )?;

        on_progress(DownloadProgress {
            video_id: item.video_id.clone(),
            status: "done".into(),
            progress: 1.0,
            error: None,
        });
        Ok(item)
    }

    pub fn list_local_folders(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT path FROM local_folders ORDER BY added_at ASC")?;
        let folders = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(folders)
    }

    pub fn add_local_folder(&self, folder: String) -> Result<Vec<LocalTrack>> {
        let path = PathBuf::from(&folder);
        if !path.is_dir() {
            return Err(anyhow!("Folder does not exist: {folder}"));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        self.conn.lock().execute(
            "INSERT OR IGNORE INTO local_folders (path, added_at) VALUES (?1, ?2)",
            params![folder, now],
        )?;
        self.scan_local_folders()
    }

    pub fn remove_local_folder(&self, folder: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM local_folders WHERE path = ?1", params![folder])?;
        conn.execute(
            "DELETE FROM local_tracks WHERE folder_path = ?1",
            params![folder],
        )?;
        Ok(())
    }

    pub fn list_local_tracks(&self) -> Result<Vec<LocalTrack>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, file_path, folder_path, title, artist, album, duration_sec, sample_rate_hz, bit_depth, channels, codec, file_size_bytes, cover_path
             FROM local_tracks ORDER BY artist COLLATE NOCASE ASC, album COLLATE NOCASE ASC, title COLLATE NOCASE ASC",
        )?;
        let tracks = stmt
            .query_map([], |r| {
                Ok(LocalTrack {
                    id: r.get(0)?,
                    file_path: r.get(1)?,
                    folder_path: r.get(2)?,
                    title: r.get(3)?,
                    artist: r.get(4)?,
                    album: r.get(5)?,
                    duration_sec: r.get(6)?,
                    sample_rate_hz: r.get(7)?,
                    bit_depth: r.get(8)?,
                    channels: r.get(9)?,
                    codec: r.get(10)?,
                    file_size_bytes: r.get(11)?,
                    cover_path: r.get(12)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tracks)
    }

    pub fn get_local_track_path(&self, id: &str) -> Option<PathBuf> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT file_path FROM local_tracks WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .map(PathBuf::from)
        .filter(|p| p.exists())
    }

    pub fn scan_local_folders(&self) -> Result<Vec<LocalTrack>> {
        let folders = self.list_local_folders()?;
        let mut scanned = Vec::new();
        for folder in folders {
            let root = PathBuf::from(&folder);
            if !root.is_dir() {
                continue;
            }
            for entry in WalkDir::new(&root).follow_links(false).into_iter().flatten() {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = entry.path();
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|s| s.to_lowercase())
                    .unwrap_or_default();
                if !SUPPORTED_EXTS.contains(&ext.as_str()) {
                    continue;
                }
                if let Some(track) = read_local_track(path, &folder, &ext, &self.covers_dir) {
                    scanned.push(track);
                }
            }
        }

        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM local_tracks", [])?;
        for t in &scanned {
            let modified = fs::metadata(&t.file_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|s| s.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            tx.execute(
                "INSERT OR REPLACE INTO local_tracks
                 (id, file_path, folder_path, title, artist, album, duration_sec, sample_rate_hz, bit_depth, channels, codec, file_size_bytes, modified_secs, cover_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    t.id,
                    t.file_path,
                    t.folder_path,
                    t.title,
                    t.artist,
                    t.album,
                    t.duration_sec,
                    t.sample_rate_hz,
                    t.bit_depth,
                    t.channels,
                    t.codec,
                    t.file_size_bytes,
                    modified,
                    t.cover_path
                ],
            )?;
        }
        tx.commit()?;
        Ok(scanned)
    }
}

fn read_local_track(
    path: &Path,
    folder: &str,
    ext: &str,
    covers_dir: &Path,
) -> Option<LocalTrack> {
    let path_str = path.to_string_lossy().into_owned();
    let mut hasher = Sha1::new();
    hasher.update(path_str.as_bytes());
    let id = format!("local:{}", &hex::encode(hasher.finalize())[..16]);

    let file_size_bytes = fs::metadata(path).ok()?.len() as i64;
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown Track")
        .to_string();

    let (mut title, mut artist, mut album, mut duration_sec, mut sr, mut bits, mut ch, mut cover) = (
        fallback_title,
        "Unknown Artist".to_string(),
        None,
        0i64,
        None,
        None,
        None,
        None,
    );

    if let Ok(tagged) = Probe::open(path).and_then(|p| p.read()) {
        let props = tagged.properties();
        duration_sec = props.duration().as_secs() as i64;
        sr = props.sample_rate().map(i64::from);
        bits = props.bit_depth().map(i64::from);
        ch = props.channels().map(i64::from);

        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(t) = tag.title() {
                if !t.trim().is_empty() {
                    title = t.into_owned();
                }
            }
            if let Some(a) = tag.artist() {
                if !a.trim().is_empty() {
                    artist = a.into_owned();
                }
            }
            if let Some(al) = tag.album() {
                if !al.trim().is_empty() {
                    album = Some(al.into_owned());
                }
            }
            if let Some(pic) = tag.pictures().first() {
                let mut h = Sha1::new();
                h.update(pic.data());
                let cover_name = format!("{}.jpg", &hex::encode(h.finalize())[..16]);
                let cover_file = covers_dir.join(cover_name);
                if cover_file.exists() || fs::write(&cover_file, pic.data()).is_ok() {
                    cover = Some(cover_file.to_string_lossy().into_owned());
                }
            }
        }
    }

    Some(LocalTrack {
        id,
        file_path: path_str,
        folder_path: folder.to_string(),
        title,
        artist,
        album,
        duration_sec,
        sample_rate_hz: sr,
        bit_depth: bits,
        channels: ch,
        codec: ext.to_uppercase(),
        file_size_bytes,
        cover_path: cover,
    })
}

fn embed_metadata(
    path: &Path,
    title: &str,
    artist: &str,
    album: Option<&str>,
    cover: Option<&[u8]>,
) -> Result<()> {
    let mut tagged = Probe::open(path)?.read()?;
    let tag_type = tagged.primary_tag_type();
    if tagged.tag(tag_type).is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    if let Some(tag) = tagged.tag_mut(tag_type) {
        tag.set_title(title.to_string());
        tag.set_artist(artist.to_string());
        if let Some(al) = album.filter(|a| !a.trim().is_empty()) {
            tag.set_album(al.to_string());
        }
        if let Some(img) = cover {
            let mime = if img.starts_with(b"\x89PNG") {
                MimeType::Png
            } else {
                MimeType::Jpeg
            };
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(mime),
                None,
                img.to_vec(),
            ));
        }
        tag.save_to_path(path, WriteOptions::default())?;
    }
    Ok(())
}

fn ext_for_mime(mime: &str) -> &'static str {
    let lower = mime.to_lowercase();
    if lower.contains("flac") {
        "flac"
    } else if lower.contains("mp4") || lower.contains("aac") {
        "m4a"
    } else if lower.contains("ogg") {
        "ogg"
    } else if lower.contains("mpeg") || lower.contains("mp3") {
        "mp3"
    } else {
        "webm"
    }
}
