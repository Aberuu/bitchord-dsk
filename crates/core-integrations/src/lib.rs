pub mod discord;
pub mod scrobble;
pub mod smtc;

pub use discord::{DiscordNowPlaying, DiscordPresenceOptions, DiscordService, DiscordState};
pub use scrobble::{LastFmTokenAuth, ScrobbleConfigUpdate, ScrobbleService, ScrobbleState, ScrobbleTrack};
pub use smtc::{SmtcController, SmtcEventPayload, SmtcMetadata, SmtcPlayback};
