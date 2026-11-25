pub mod cast;
pub mod discord;
pub mod mobile_sync;
pub mod quick_login;
pub mod scrobble;
pub mod smtc;
pub mod updater;

pub use cast::{
    CastDevice, CastLoadRequest, CastProtocol, CastService, CastSessionState, CastSupportStatus,
};
pub use discord::{DiscordNowPlaying, DiscordPresenceOptions, DiscordService, DiscordState};
pub use mobile_sync::{MobileNowPlaying, MobileSyncService, MobileSyncStatus};
pub use quick_login::{push_session_to_peer, QuickLoginPayload, QuickLoginService, QuickLoginStatus};
pub use scrobble::{LastFmTokenAuth, ScrobbleConfigUpdate, ScrobbleService, ScrobbleState, ScrobbleTrack};
pub use smtc::{SmtcController, SmtcEventPayload, SmtcMetadata, SmtcPlayback};
