use anyhow::{anyhow, bail, Context, Result};
use chrono::{Datelike, Duration, Local, NaiveDate, Timelike};
use core_auth::app_data_dir;
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const KEEP_MONTHS: usize = 36;
const MAX_TRACKS: usize = 600;
const MAX_NAMES: usize = 400;
const FLUSH_EVERY_SAMPLES: u32 = 6;
const UNIT_SEPARATOR: char = '\u{001F}';

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReplayPeriod {
    #[serde(rename = "this_week", alias = "THIS_WEEK")]
    ThisWeek,
    #[serde(rename = "this_month", alias = "THIS_MONTH")]
    ThisMonth,
    #[serde(rename = "this_year", alias = "THIS_YEAR")]
    ThisYear,
    #[serde(rename = "all_time", alias = "ALL_TIME")]
    AllTime,
}

impl ReplayPeriod {
    pub fn range(self, today: NaiveDate) -> Option<(NaiveDate, NaiveDate)> {
        match self {
            ReplayPeriod::ThisWeek => {
                let offset = i64::from(today.weekday().num_days_from_monday());
                let start = today - Duration::days(offset);
                Some((start, today))
            }
            ReplayPeriod::ThisMonth => {
                let start = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)?;
                Some((start, end_of_month(today.year(), today.month())))
            }
            ReplayPeriod::ThisYear => {
                let start = NaiveDate::from_ymd_opt(today.year(), 1, 1)?;
                let end = NaiveDate::from_ymd_opt(today.year(), 12, 31)?;
                Some((start, end))
            }
            ReplayPeriod::AllTime => None,
        }
    }

    pub fn covers_month(self, month_key: &str, today: NaiveDate) -> bool {
        let Some((year, month)) = parse_year_month(month_key) else {
            return false;
        };
        match self {
            ReplayPeriod::ThisWeek => {
                let Some((week_start, week_end)) = self.range(today) else {
                    return false;
                };
                let Some(m_start) = NaiveDate::from_ymd_opt(year, month, 1) else {
                    return false;
                };
                let m_end = end_of_month(year, month);
                !(week_end < m_start || week_start > m_end)
            }
            ReplayPeriod::ThisMonth => year == today.year() && month == today.month(),
            ReplayPeriod::ThisYear => year == today.year(),
            ReplayPeriod::AllTime => true,
        }
    }

    pub fn needs_day_filter(self) -> bool {
        matches!(self, ReplayPeriod::ThisWeek)
    }

    pub fn label(self, today: NaiveDate) -> String {
        match self {
            ReplayPeriod::ThisWeek => "This week".to_string(),
            ReplayPeriod::ThisMonth => format!("{} {}", month_name(today.month()), today.year()),
            ReplayPeriod::ThisYear => today.year().to_string(),
            ReplayPeriod::AllTime => "All time".to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DayStats {
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub plays: i32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackEntry {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub art: Option<String>,
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub plays: i32,
    #[serde(default)]
    pub last: i64,
    #[serde(default)]
    pub days: HashMap<String, DayStats>,
}

impl TrackEntry {
    pub fn absorb(&mut self, other: &TrackEntry) {
        self.ms += other.ms;
        self.plays += other.plays;
        self.last = self.last.max(other.last);
        if self.album.is_none() {
            self.album.clone_from(&other.album);
        }
        if self.album_id.is_none() {
            self.album_id.clone_from(&other.album_id);
        }
        if self.artist_id.is_none() {
            self.artist_id.clone_from(&other.artist_id);
        }
        if self.art.is_none() {
            self.art.clone_from(&other.art);
        }
        for (day_key, stats) in &other.days {
            let entry = self.days.entry(day_key.clone()).or_default();
            entry.ms += stats.ms;
            entry.plays += stats.plays;
        }
    }

    pub fn week_range(&self, start: NaiveDate, end: NaiveDate) -> (i64, i32) {
        if self.days.is_empty() {
            return (self.ms, self.plays);
        }
        let mut total_ms = 0;
        let mut total_plays = 0;
        for (day_str, stats) in &self.days {
            if let Ok(date) = NaiveDate::parse_from_str(day_str, "%Y-%m-%d") {
                if date >= start && date <= end {
                    total_ms += stats.ms;
                    total_plays += stats.plays;
                }
            }
        }
        (total_ms, total_plays)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NameEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sub: Option<String>,
    #[serde(default)]
    pub art: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ms: i64,
    #[serde(default)]
    pub plays: i32,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub days: HashMap<String, DayStats>,
}

impl NameEntry {
    pub fn absorb(&mut self, other: &NameEntry) {
        self.ms += other.ms;
        self.plays += other.plays;
        if self.art.is_none() {
            self.art.clone_from(&other.art);
        }
        if self.id.is_none() {
            self.id.clone_from(&other.id);
        }
        if self.sub.is_none() {
            self.sub.clone_from(&other.sub);
        }
        for (day_key, stats) in &other.days {
            let entry = self.days.entry(day_key.clone()).or_default();
            entry.ms += stats.ms;
            entry.plays += stats.plays;
        }
    }

    pub fn week_range(&self, start: NaiveDate, end: NaiveDate) -> (i64, i32) {
        if self.days.is_empty() {
            return (self.ms, self.plays);
        }
        let mut total_ms = 0;
        let mut total_plays = 0;
        for (day_str, stats) in &self.days {
            if let Ok(date) = NaiveDate::parse_from_str(day_str, "%Y-%m-%d") {
                if date >= start && date <= end {
                    total_ms += stats.ms;
                    total_plays += stats.plays;
                }
            }
        }
        (total_ms, total_plays)
    }
}

fn default_version() -> i32 {
    1
}

fn default_hours() -> Vec<i64> {
    vec![0; 24]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredBucket {
    #[serde(default = "default_version")]
    pub version: i32,
    pub month: String,
    #[serde(default)]
    pub tracks: Vec<TrackEntry>,
    #[serde(default)]
    pub artists: Vec<NameEntry>,
    #[serde(default)]
    pub albums: Vec<NameEntry>,
    #[serde(default = "default_hours")]
    pub hours: Vec<i64>,
    #[serde(default)]
    pub days: HashMap<i32, i64>,
    #[serde(default)]
    pub track_days: Option<HashMap<String, DayStats>>,
    #[serde(default)]
    pub artist_days: Option<HashMap<String, DayStats>>,
    #[serde(default)]
    pub album_days: Option<HashMap<String, DayStats>>,
}

impl StoredBucket {
    pub fn empty(month: impl Into<String>) -> Self {
        Self {
            version: 1,
            month: month.into(),
            tracks: Vec::new(),
            artists: Vec::new(),
            albums: Vec::new(),
            hours: vec![0; 24],
            days: HashMap::new(),
            track_days: Some(HashMap::new()),
            artist_days: Some(HashMap::new()),
            album_days: Some(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningSampleInput {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub album_name: Option<String>,
    #[serde(default)]
    pub album_id: Option<String>,
    #[serde(default)]
    pub artist_id: Option<String>,
    #[serde(default)]
    pub artwork_url: Option<String>,
    pub played_ms: i64,
    #[serde(default)]
    pub counts_as_play: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedSong {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album_name: Option<String>,
    pub album_id: Option<String>,
    pub artist_id: Option<String>,
    pub artwork_url: Option<String>,
    pub ms: i64,
    pub plays: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedEntry {
    pub title: String,
    pub subtitle: Option<String>,
    pub artwork_url: Option<String>,
    pub browse_id: Option<String>,
    pub ms: i64,
    pub plays: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySummary {
    pub period: ReplayPeriod,
    pub label: String,
    pub total_ms: i64,
    pub total_plays: i32,
    pub songs: Vec<RankedSong>,
    pub artists: Vec<RankedEntry>,
    pub albums: Vec<RankedEntry>,
    pub hour_of_day: Vec<i64>,
    pub peak_hour: Option<u32>,
    pub busiest_day: Option<String>,
    pub busiest_day_ms: i64,
    pub distinct_songs: usize,
    pub distinct_artists: usize,
    pub distinct_albums: usize,
    pub since: Option<String>,
    pub member_since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub months: usize,
    pub tracks: usize,
    pub from_version: String,
    pub exported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    #[serde(default = "default_app_tag")]
    app: String,
    #[serde(default = "default_version")]
    version: i32,
    #[serde(default)]
    version_name: String,
    #[serde(default)]
    exported_at: String,
    #[serde(default)]
    settings: Value,
    #[serde(default)]
    listening: Vec<StoredBucket>,
}

fn default_app_tag() -> String {
    "bitchord".to_string()
}

pub fn primary_artist(credit: &str) -> Option<String> {
    static SEP: OnceLock<Regex> = OnceLock::new();
    let re = SEP.get_or_init(|| {
        Regex::new(r"(?i)\s*,\s*|\s+&\s+|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+")
            .expect("valid credit separator regex")
    });
    re.split(credit)
        .map(str::trim)
        .find(|part| !part.is_empty())
        .map(ToOwned::to_owned)
}

fn album_title_key(name: &str, artist: &str) -> String {
    format!(
        "{}{}{}",
        name.trim().to_lowercase(),
        UNIT_SEPARATOR,
        artist.trim().to_lowercase()
    )
}

fn album_key(album_id: Option<&str>, name: &str, artist: &str) -> String {
    if let Some(id) = album_id.map(str::trim).filter(|s| !s.is_empty()) {
        id.to_string()
    } else {
        album_title_key(name, artist)
    }
}

pub fn merge_key(entry: &TrackEntry) -> String {
    if entry.id.starts_with("content://")
        || entry.id.starts_with("file://")
        || entry.id.starts_with("local:")
    {
        format!(
            "local{}{}",
            UNIT_SEPARATOR,
            album_title_key(&entry.title, &entry.artist)
        )
    } else {
        entry.id.clone()
    }
}

pub fn fold_albums_by_title(albums: impl IntoIterator<Item = NameEntry>) -> Vec<NameEntry> {
    let mut list: Vec<NameEntry> = albums.into_iter().collect();
    list.sort_by(|a, b| {
        b.id.is_some()
            .cmp(&a.id.is_some())
            .then_with(|| b.ms.cmp(&a.ms))
    });
    let mut folded: Vec<NameEntry> = Vec::new();
    let mut index_by_key: HashMap<String, usize> = HashMap::new();
    for entry in list {
        let key = album_title_key(&entry.name, entry.sub.as_deref().unwrap_or(""));
        if let Some(&idx) = index_by_key.get(&key) {
            folded[idx].absorb(&entry);
        } else {
            index_by_key.insert(key, folded.len());
            folded.push(entry);
        }
    }
    folded
}

struct OpenBucket {
    key: String,
    tracks: HashMap<String, TrackEntry>,
    artists: HashMap<String, NameEntry>,
    albums: HashMap<String, NameEntry>,
    hours: [i64; 24],
    days: HashMap<i32, i64>,
    track_days: HashMap<String, DayStats>,
    artist_days: HashMap<String, DayStats>,
    album_days: HashMap<String, DayStats>,
    dirty: bool,
    samples_since_flush: u32,
}

impl OpenBucket {
    fn from_stored(stored: StoredBucket) -> Self {
        let mut tracks = HashMap::new();
        for t in stored.tracks {
            let k = merge_key(&t);
            tracks
                .entry(k)
                .and_modify(|existing: &mut TrackEntry| existing.absorb(&t))
                .or_insert(t);
        }
        let mut artists = HashMap::new();
        for mut a in stored.artists {
            if let Some(lead) = primary_artist(&a.name) {
                a.name = lead;
            }
            let k = a.name.to_lowercase();
            artists
                .entry(k)
                .and_modify(|existing: &mut NameEntry| existing.absorb(&a))
                .or_insert(a);
        }
        let mut albums = HashMap::new();
        for al in stored.albums {
            let k = album_key(
                al.id.as_deref(),
                &al.name,
                al.sub.as_deref().unwrap_or(""),
            );
            albums
                .entry(k)
                .and_modify(|existing: &mut NameEntry| existing.absorb(&al))
                .or_insert(al);
        }
        let mut hours = [0i64; 24];
        for (idx, val) in stored.hours.into_iter().take(24).enumerate() {
            hours[idx] = val;
        }
        Self {
            key: stored.month,
            tracks,
            artists,
            albums,
            hours,
            days: stored.days,
            track_days: stored.track_days.unwrap_or_default(),
            artist_days: stored.artist_days.unwrap_or_default(),
            album_days: stored.album_days.unwrap_or_default(),
            dirty: false,
            samples_since_flush: 0,
        }
    }

    fn snapshot(&self) -> StoredBucket {
        let mut tracks: Vec<TrackEntry> = self.tracks.values().cloned().collect();
        tracks.sort_by(|a, b| b.ms.cmp(&a.ms));
        tracks.truncate(MAX_TRACKS);

        let mut artists: Vec<NameEntry> = self
            .artists
            .iter()
            .map(|(k, v)| {
                let mut copy = v.clone();
                copy.key = Some(k.clone());
                copy
            })
            .collect();
        artists.sort_by(|a, b| b.ms.cmp(&a.ms));
        artists.truncate(MAX_NAMES);

        let mut albums: Vec<NameEntry> = self
            .albums
            .iter()
            .map(|(k, v)| {
                let mut copy = v.clone();
                copy.key = Some(k.clone());
                copy
            })
            .collect();
        albums.sort_by(|a, b| b.ms.cmp(&a.ms));
        albums.truncate(MAX_NAMES);

        StoredBucket {
            version: 1,
            month: self.key.clone(),
            tracks,
            artists,
            albums,
            hours: self.hours.to_vec(),
            days: self.days.clone(),
            track_days: Some(self.track_days.clone()),
            artist_days: Some(self.artist_days.clone()),
            album_days: Some(self.album_days.clone()),
        }
    }
}

pub struct ListeningStatsStore {
    dir: PathBuf,
    open: Mutex<Option<OpenBucket>>,
}

impl ListeningStatsStore {
    pub fn open_default() -> Result<Self> {
        let root = app_data_dir()?;
        Self::open_at(root.join("listening"))
    }

    pub fn open_at(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            open: Mutex::new(None),
        })
    }

    pub fn record_sample(&self, sample: ListeningSampleInput) -> Result<()> {
        let now = Local::now();
        let date = now.date_naive();
        let hour = now.hour() as usize;
        let now_ms = now.timestamp_millis();
        self.record_sample_at(sample, date, hour, now_ms)
    }

    pub fn record_sample_at(
        &self,
        sample: ListeningSampleInput,
        date: NaiveDate,
        hour: usize,
        now_ms: i64,
    ) -> Result<()> {
        if sample.video_id.trim().is_empty() {
            return Ok(());
        }
        if sample.played_ms <= 0 && !sample.counts_as_play {
            return Ok(());
        }
        let month_key = format!("{:04}-{:02}", date.year(), date.month());
        let day_key = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
        let day_num = date.day() as i32;
        let played_ms = sample.played_ms.max(0);

        let mut to_write: Option<StoredBucket> = None;
        let mut stale_to_write: Option<StoredBucket> = None;

        {
            let mut guard = self.open.lock();
            let needs_load = guard.as_ref().map(|b| b.key != month_key).unwrap_or(true);
            if needs_load {
                if let Some(prev) = guard.take() {
                    if prev.dirty {
                        stale_to_write = Some(prev.snapshot());
                    }
                }
                let loaded = self
                    .read_bucket(&month_key)
                    .unwrap_or_else(|| StoredBucket::empty(&month_key));
                *guard = Some(OpenBucket::from_stored(loaded));
            }

            let bucket = guard.as_mut().expect("open bucket initialized");
            let temp_entry = TrackEntry {
                id: sample.video_id.clone(),
                title: sample.title.clone(),
                artist: sample.artist.clone(),
                ..Default::default()
            };
            let track_key = merge_key(&temp_entry);
            let track = bucket
                .tracks
                .entry(track_key)
                .or_insert_with(|| TrackEntry {
                    id: sample.video_id.clone(),
                    title: sample.title.clone(),
                    artist: sample.artist.clone(),
                    album: sample.album_name.clone(),
                    album_id: sample.album_id.clone(),
                    artist_id: sample.artist_id.clone(),
                    art: sample.artwork_url.clone(),
                    ms: 0,
                    plays: 0,
                    last: now_ms,
                    days: HashMap::new(),
                });
            track.ms += played_ms;
            track.last = now_ms;
            if track.album.is_none() {
                track.album.clone_from(&sample.album_name);
            }
            if track.album_id.is_none() {
                track.album_id.clone_from(&sample.album_id);
            }
            if track.artist_id.is_none() {
                track.artist_id.clone_from(&sample.artist_id);
            }
            if track.art.is_none() {
                track.art.clone_from(&sample.artwork_url);
            }
            if sample.counts_as_play {
                track.plays += 1;
            }
            let td = track.days.entry(day_key.clone()).or_default();
            td.ms += played_ms;
            if sample.counts_as_play {
                td.plays += 1;
            }
            let b_td = bucket.track_days.entry(day_key.clone()).or_default();
            b_td.ms += played_ms;
            if sample.counts_as_play {
                b_td.plays += 1;
            }

            if let Some(lead) = primary_artist(&sample.artist) {
                let artist_key = lead.to_lowercase();
                let artist = bucket
                    .artists
                    .entry(artist_key)
                    .or_insert_with(|| NameEntry {
                        name: lead,
                        sub: None,
                        art: sample.artwork_url.clone(),
                        id: sample.artist_id.clone(),
                        ms: 0,
                        plays: 0,
                        key: None,
                        days: HashMap::new(),
                    });
                artist.ms += played_ms;
                if sample.counts_as_play {
                    artist.plays += 1;
                }
                if artist.id.is_none() {
                    artist.id.clone_from(&sample.artist_id);
                }
                if artist.art.is_none() {
                    artist.art.clone_from(&sample.artwork_url);
                }
                let ad = artist.days.entry(day_key.clone()).or_default();
                ad.ms += played_ms;
                if sample.counts_as_play {
                    ad.plays += 1;
                }
                let b_ad = bucket.artist_days.entry(day_key.clone()).or_default();
                b_ad.ms += played_ms;
                if sample.counts_as_play {
                    b_ad.plays += 1;
                }
            }

            if let Some(album_name) = sample
                .album_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let alb_key = album_key(sample.album_id.as_deref(), album_name, &sample.artist);
                let album = bucket.albums.entry(alb_key).or_insert_with(|| NameEntry {
                    name: album_name.to_string(),
                    sub: Some(sample.artist.clone()),
                    art: sample.artwork_url.clone(),
                    id: sample.album_id.clone(),
                    ms: 0,
                    plays: 0,
                    key: None,
                    days: HashMap::new(),
                });
                album.ms += played_ms;
                if sample.counts_as_play {
                    album.plays += 1;
                }
                if album.id.is_none() {
                    album.id.clone_from(&sample.album_id);
                }
                if album.art.is_none() {
                    album.art.clone_from(&sample.artwork_url);
                }
                let ald = album.days.entry(day_key.clone()).or_default();
                ald.ms += played_ms;
                if sample.counts_as_play {
                    ald.plays += 1;
                }
                let b_ald = bucket.album_days.entry(day_key).or_default();
                b_ald.ms += played_ms;
                if sample.counts_as_play {
                    b_ald.plays += 1;
                }
            }

            bucket.hours[hour.min(23)] += played_ms;
            *bucket.days.entry(day_num).or_default() += played_ms;
            bucket.dirty = true;
            bucket.samples_since_flush += 1;
            if sample.counts_as_play || bucket.samples_since_flush >= FLUSH_EVERY_SAMPLES {
                bucket.samples_since_flush = 0;
                bucket.dirty = false;
                to_write = Some(bucket.snapshot());
            }
        }

        if let Some(stale) = stale_to_write {
            self.write_bucket(&stale)?;
        }
        if let Some(snap) = to_write {
            self.write_bucket(&snap)?;
            self.prune_old_months();
        }
        Ok(())
    }

    pub fn flush(&self) -> Result<()> {
        let snap = {
            let mut guard = self.open.lock();
            if let Some(bucket) = guard.as_mut() {
                if bucket.dirty {
                    bucket.dirty = false;
                    bucket.samples_since_flush = 0;
                    Some(bucket.snapshot())
                } else {
                    None
                }
            } else {
                None
            }
        };
        if let Some(s) = snap {
            self.write_bucket(&s)?;
        }
        Ok(())
    }

    pub fn summary(&self, period: ReplayPeriod) -> Result<ReplaySummary> {
        let today = Local::now().date_naive();
        self.summary_at(period, today)
    }

    pub fn summary_at(&self, period: ReplayPeriod, today: NaiveDate) -> Result<ReplaySummary> {
        let _ = self.flush();
        let all_months = self.months();
        let earliest_all_time = all_months.first().cloned();
        let member_since = earliest_all_time
            .as_deref()
            .and_then(format_member_since);

        let mut tracks: HashMap<String, TrackEntry> = HashMap::new();
        let mut artists: HashMap<String, NameEntry> = HashMap::new();
        let mut albums: HashMap<String, NameEntry> = HashMap::new();
        let mut hours = [0i64; 24];
        let mut days: HashMap<String, i64> = HashMap::new();
        let mut earliest_period: Option<String> = None;

        let week_range = if period.needs_day_filter() {
            period.range(today)
        } else {
            None
        };

        for month_key in &all_months {
            if !period.covers_month(month_key, today) {
                continue;
            }
            let Some(bucket) = self.read_bucket(month_key) else {
                continue;
            };
            if earliest_period.is_none() {
                earliest_period = Some(bucket.month.clone());
            }
            for entry in bucket.tracks {
                let k = merge_key(&entry);
                tracks
                    .entry(k)
                    .and_modify(|existing| existing.absorb(&entry))
                    .or_insert(entry);
            }
            for mut entry in bucket.artists {
                if let Some(lead) = primary_artist(&entry.name) {
                    entry.name = lead;
                }
                let k = entry.name.to_lowercase();
                artists
                    .entry(k)
                    .and_modify(|existing| existing.absorb(&entry))
                    .or_insert(entry);
            }
            for entry in bucket.albums {
                let k = album_key(
                    entry.id.as_deref(),
                    &entry.name,
                    entry.sub.as_deref().unwrap_or(""),
                );
                albums
                    .entry(k)
                    .and_modify(|existing| existing.absorb(&entry))
                    .or_insert(entry);
            }
            if week_range.is_none() {
                for (i, h) in bucket.hours.iter().take(24).enumerate() {
                    hours[i] += *h;
                }
            }
            for (day_num, ms) in bucket.days {
                let date_str = format!("{}-{:02}", bucket.month, day_num);
                if let Some((w_start, w_end)) = week_range {
                    if let Ok(parsed) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") {
                        if parsed >= w_start && parsed <= w_end {
                            *days.entry(date_str).or_default() += ms;
                        }
                    }
                } else {
                    *days.entry(date_str).or_default() += ms;
                }
            }
        }

        let mut ranked_songs: Vec<RankedSong> = if let Some((w_start, w_end)) = week_range {
            tracks
                .into_values()
                .filter_map(|entry| {
                    let (ms, plays) = entry.week_range(w_start, w_end);
                    (ms > 0).then(|| RankedSong {
                        video_id: entry.id,
                        title: entry.title,
                        artist: entry.artist,
                        album_name: entry.album,
                        album_id: entry.album_id,
                        artist_id: entry.artist_id,
                        artwork_url: entry.art,
                        ms,
                        plays,
                    })
                })
                .collect()
        } else {
            tracks
                .into_values()
                .filter(|entry| entry.ms > 0 || entry.plays > 0)
                .map(|entry| RankedSong {
                    video_id: entry.id,
                    title: entry.title,
                    artist: entry.artist,
                    album_name: entry.album,
                    album_id: entry.album_id,
                    artist_id: entry.artist_id,
                    artwork_url: entry.art,
                    ms: entry.ms,
                    plays: entry.plays,
                })
                .collect()
        };
        ranked_songs.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| b.plays.cmp(&a.plays)));

        let mut ranked_artists: Vec<RankedEntry> = if let Some((w_start, w_end)) = week_range {
            artists
                .into_values()
                .filter_map(|entry| {
                    let (ms, plays) = entry.week_range(w_start, w_end);
                    (ms > 0).then(|| RankedEntry {
                        title: entry.name,
                        subtitle: entry.sub,
                        artwork_url: entry.art,
                        browse_id: entry.id,
                        ms,
                        plays,
                    })
                })
                .collect()
        } else {
            artists
                .into_values()
                .filter(|entry| entry.ms > 0 || entry.plays > 0)
                .map(|entry| RankedEntry {
                    title: entry.name,
                    subtitle: entry.sub,
                    artwork_url: entry.art,
                    browse_id: entry.id,
                    ms: entry.ms,
                    plays: entry.plays,
                })
                .collect()
        };
        ranked_artists.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| b.plays.cmp(&a.plays)));

        let folded_albums = fold_albums_by_title(albums.into_values());
        let mut ranked_albums: Vec<RankedEntry> = if let Some((w_start, w_end)) = week_range {
            folded_albums
                .into_iter()
                .filter_map(|entry| {
                    let (ms, plays) = entry.week_range(w_start, w_end);
                    (ms > 0).then(|| RankedEntry {
                        title: entry.name,
                        subtitle: entry.sub,
                        artwork_url: entry.art,
                        browse_id: entry.id,
                        ms,
                        plays,
                    })
                })
                .collect()
        } else {
            folded_albums
                .into_iter()
                .filter(|entry| entry.ms > 0 || entry.plays > 0)
                .map(|entry| RankedEntry {
                    title: entry.name,
                    subtitle: entry.sub,
                    artwork_url: entry.art,
                    browse_id: entry.id,
                    ms: entry.ms,
                    plays: entry.plays,
                })
                .collect()
        };
        ranked_albums.sort_by(|a, b| b.ms.cmp(&a.ms).then_with(|| b.plays.cmp(&a.plays)));

        let total_ms: i64 = ranked_songs.iter().map(|s| s.ms).sum();
        let total_plays: i32 = ranked_songs.iter().map(|s| s.plays).sum();
        let busiest = days.into_iter().max_by_key(|(_, ms)| *ms);
        let peak_hour = hours
            .iter()
            .enumerate()
            .filter(|(_, &ms)| ms > 0)
            .max_by_key(|(_, &ms)| ms)
            .map(|(idx, _)| idx as u32);

        Ok(ReplaySummary {
            period,
            label: period.label(today),
            total_ms,
            total_plays,
            distinct_songs: ranked_songs.len(),
            distinct_artists: ranked_artists.len(),
            distinct_albums: ranked_albums.len(),
            songs: ranked_songs,
            artists: ranked_artists,
            albums: ranked_albums,
            hour_of_day: hours.to_vec(),
            peak_hour,
            busiest_day: busiest.as_ref().map(|(d, _)| d.clone()),
            busiest_day_ms: busiest.map(|(_, ms)| ms).unwrap_or(0),
            since: earliest_period.or(earliest_all_time),
            member_since,
        })
    }

    pub fn export_backup_json(&self) -> Result<String> {
        let _ = self.flush();
        let listening: Vec<StoredBucket> = self
            .months()
            .into_iter()
            .filter_map(|m| self.read_bucket(&m))
            .collect();
        let payload = BackupFile {
            app: "bitchord".to_string(),
            version: 1,
            version_name: env!("CARGO_PKG_VERSION").to_string(),
            exported_at: Local::now().to_rfc3339(),
            settings: json!({}),
            listening,
        };
        serde_json::to_string_pretty(&payload).context("serialize BitChord backup JSON")
    }

    pub fn import_backup_json(&self, raw: &str) -> Result<BackupSummary> {
        let trimmed = raw.trim();
        let (buckets, from_version, exported_at) = if trimmed.starts_with('[') {
            let list: Vec<StoredBucket> =
                serde_json::from_str(trimmed).context("That file is not a valid listening array")?;
            (list, "buckets".to_string(), String::new())
        } else {
            let parsed: Value =
                serde_json::from_str(trimmed).context("That file does not look like a BitChord backup")?;
            if parsed.get("month").is_some() && parsed.get("tracks").is_some() {
                let single: StoredBucket = serde_json::from_value(parsed)
                    .context("Could not parse single listening month file")?;
                (vec![single], "month-bucket".to_string(), String::new())
            } else {
                let file: BackupFile = serde_json::from_value(parsed)
                    .context("That file does not look like a BitChord backup")?;
                if file.app != "bitchord" {
                    bail!("That backup is from another app ({})", file.app);
                }
                if file.version > 1 {
                    bail!(
                        "That backup was written by a newer schema version ({})",
                        file.version
                    );
                }
                (file.listening, file.version_name, file.exported_at)
            }
        };

        let valid_buckets: Vec<StoredBucket> = buckets
            .into_iter()
            .filter(|b| parse_year_month(&b.month).is_some())
            .collect();
        if valid_buckets.is_empty() {
            bail!("No valid YYYY-MM listening months found in that backup file");
        }

        let mut guard = self.open.lock();
        *guard = None;

        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("json") {
                    let _ = fs::remove_file(path);
                }
            }
        }

        let mut total_tracks = 0usize;
        for bucket in &valid_buckets {
            total_tracks += bucket.tracks.len();
            self.write_bucket(bucket)?;
        }

        Ok(BackupSummary {
            months: valid_buckets.len(),
            tracks: total_tracks,
            from_version,
            exported_at,
        })
    }

    pub fn months(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        if let Ok(entries) = fs::read_dir(&self.dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(stem) = name.strip_suffix(".json") {
                    if parse_year_month(stem).is_some() {
                        set.insert(stem.to_string());
                    }
                }
            }
        }
        if let Some(open) = self.open.lock().as_ref() {
            if parse_year_month(&open.key).is_some() {
                set.insert(open.key.clone());
            }
        }
        set.into_iter().collect()
    }

    fn read_bucket(&self, month_key: &str) -> Option<StoredBucket> {
        let path = self.dir.join(format!("{month_key}.json"));
        let content = fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }

    fn write_bucket(&self, bucket: &StoredBucket) -> Result<()> {
        fs::create_dir_all(&self.dir)?;
        let file = self.dir.join(format!("{}.json", bucket.month));
        let tmp = self.dir.join(format!("{}.json.tmp", bucket.month));
        let serialized = serde_json::to_string(bucket)?;
        fs::write(&tmp, serialized)?;
        if fs::rename(&tmp, &file).is_err() {
            let _ = fs::remove_file(&file);
            fs::rename(&tmp, &file).with_context(|| format!("write bucket {}", bucket.month))?;
        }
        Ok(())
    }

    fn prune_old_months(&self) {
        let months = self.months();
        if months.len() > KEEP_MONTHS {
            for old in months.iter().take(months.len() - KEEP_MONTHS) {
                let _ = fs::remove_file(self.dir.join(format!("{old}.json")));
            }
        }
    }
}

pub fn parse_year_month(raw: &str) -> Option<(i32, u32)> {
    let (y_str, m_str) = raw.split_once('-')?;
    if y_str.len() != 4 || m_str.len() != 2 {
        return None;
    }
    let year: i32 = y_str.parse().ok()?;
    let month: u32 = m_str.parse().ok()?;
    if !(1..=12).contains(&month) {
        return None;
    }
    Some((year, month))
}

pub fn format_member_since(month_key: &str) -> Option<String> {
    let (year, month) = parse_year_month(month_key)?;
    Some(format!("{:02}/{:02}", month, year.rem_euclid(100)))
}

fn end_of_month(year: i32, month: u32) -> NaiveDate {
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .unwrap_or_else(|| NaiveDate::from_ymd_opt(year, month, 28).expect("valid date"))
}

fn month_name(month: u32) -> &'static str {
    match month {
        1 => "January",
        2 => "February",
        3 => "March",
        4 => "April",
        5 => "May",
        6 => "June",
        7 => "July",
        8 => "August",
        9 => "September",
        10 => "October",
        11 => "November",
        12 => "December",
        _ => "",
    }
}

pub fn save_file_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, bytes).map_err(|e| anyhow!("Failed to write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_store(label: &str) -> ListeningStatsStore {
        let dir = env::temp_dir().join(format!(
            "bitchord_stats_test_{}_{}",
            label,
            Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        ListeningStatsStore::open_at(dir).expect("open temp store")
    }

    #[test]
    fn splits_collaboration_credits_to_primary_artist() {
        assert_eq!(
            primary_artist(".Feast & Hindia").as_deref(),
            Some(".Feast")
        );
        assert_eq!(
            primary_artist("Cheema Y, Gur Sidhu feat. Naseeb").as_deref(),
            Some("Cheema Y")
        );
        // Preserves bands whose name includes "and".
        assert_eq!(
            primary_artist("Florence and the Machine").as_deref(),
            Some("Florence and the Machine")
        );
    }

    #[test]
    fn folds_duplicate_albums_by_title_and_prefers_entry_with_id() {
        let without_id = NameEntry {
            name: "Membangun & Menghancurkan".into(),
            sub: Some(".Feast".into()),
            art: Some("https://img.test/1.jpg".into()),
            id: None,
            ms: 300_000,
            plays: 2,
            key: None,
            days: HashMap::new(),
        };
        let with_id = NameEntry {
            name: "Membangun & Menghancurkan".into(),
            sub: Some(".Feast".into()),
            art: Some("https://img.test/2.jpg".into()),
            id: Some("MPREb_test123".into()),
            ms: 360_000,
            plays: 3,
            key: None,
            days: HashMap::new(),
        };
        let folded = fold_albums_by_title(vec![without_id, with_id]);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].id.as_deref(), Some("MPREb_test123"));
        assert_eq!(folded[0].ms, 660_000);
        assert_eq!(folded[0].plays, 5);
    }

    #[test]
    fn records_samples_and_computes_summary_with_member_since() {
        let store = temp_store("summary");
        let day = NaiveDate::from_ymd_opt(2026, 11, 22).unwrap();
        store
            .record_sample_at(
                ListeningSampleInput {
                    video_id: "tarot_vid01".into(),
                    title: "Tarot".into(),
                    artist: ".Feast".into(),
                    album_name: Some("Membangun & Menghancurkan".into()),
                    album_id: Some("MPREb_feast".into()),
                    artist_id: Some("UC_feast".into()),
                    artwork_url: Some("https://i.ytimg.com/vi/tarot_vid01/hqdefault.jpg".into()),
                    played_ms: 660_000,
                    counts_as_play: true,
                },
                day,
                18,
                1_795_347_000_000,
            )
            .unwrap();

        let summary = store.summary_at(ReplayPeriod::AllTime, day).unwrap();
        assert_eq!(summary.total_ms, 660_000);
        assert_eq!(summary.total_plays, 1);
        assert_eq!(summary.member_since.as_deref(), Some("11/26"));
        assert_eq!(summary.songs[0].title, "Tarot");
        assert_eq!(summary.artists[0].title, ".Feast");
        assert_eq!(summary.albums[0].title, "Membangun & Menghancurkan");
        assert_eq!(summary.peak_hour, Some(18));
        assert_eq!(summary.busiest_day.as_deref(), Some("2026-11-22"));
    }

    #[test]
    fn imports_and_exports_android_compatible_backup_json() {
        let store = temp_store("backup");
        let android_json = r#"{
            "app": "bitchord",
            "version": 1,
            "versionName": "1.2.4",
            "exportedAt": "2026-11-22T18:25:00Z",
            "settings": {
                "theme": { "type": "string", "value": "dark" }
            },
            "listening": [
                {
                    "version": 1,
                    "month": "2026-11",
                    "tracks": [
                        {
                            "id": "tarot_vid01",
                            "title": "Tarot",
                            "artist": ".Feast",
                            "album": "Membangun & Menghancurkan",
                            "ms": 4020000,
                            "plays": 16,
                            "last": 1795347000000,
                            "days": {
                                "2026-11-22": { "ms": 4020000, "plays": 16 }
                            }
                        }
                    ],
                    "artists": [
                        {
                            "name": ".Feast",
                            "ms": 1500000,
                            "plays": 5,
                            "days": {
                                "2026-11-22": { "ms": 1500000, "plays": 5 }
                            }
                        }
                    ],
                    "albums": [
                        {
                            "name": "Membangun & Menghancurkan",
                            "sub": ".Feast",
                            "ms": 660000,
                            "plays": 3,
                            "days": {
                                "2026-11-22": { "ms": 660000, "plays": 3 }
                            }
                        }
                    ],
                    "hours": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4020000,0,0,0,0,0],
                    "days": { "22": 4020000 }
                }
            ]
        }"#;

        let res = store.import_backup_json(android_json).unwrap();
        assert_eq!(res.months, 1);
        assert_eq!(res.tracks, 1);

        let today = NaiveDate::from_ymd_opt(2026, 11, 22).unwrap();
        let summary = store.summary_at(ReplayPeriod::AllTime, today).unwrap();
        assert_eq!(summary.total_ms / 60_000, 67);
        assert_eq!(summary.total_plays, 16);
        assert_eq!(summary.member_since.as_deref(), Some("11/26"));
        assert_eq!(summary.songs[0].title, "Tarot");
        assert_eq!(summary.artists[0].title, ".Feast");
        assert_eq!(summary.albums[0].title, "Membangun & Menghancurkan");

        let exported = store.export_backup_json().unwrap();
        let store2 = temp_store("backup_roundtrip");
        let res2 = store2.import_backup_json(&exported).unwrap();
        assert_eq!(res2.months, 1);
    }
}
