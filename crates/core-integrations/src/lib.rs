pub mod cast;
pub mod discord;
pub mod mobile_pairing;
pub mod mobile_sync;
pub mod quick_login;
pub mod scrobble;
pub mod smtc;
pub mod updater;

pub use cast::{
    CastDevice, CastLoadRequest, CastProtocol, CastService, CastSessionState, CastSupportStatus,
};
pub use discord::{DiscordNowPlaying, DiscordPresenceOptions, DiscordService, DiscordState};
pub use mobile_pairing::{
    check_desktop_health, parse_pairing_qr, redeem_desktop_pairing, DesktopHealthSnapshot,
    DesktopPairingOfferView, DesktopPairingPayload, MobilePairingService, PairedMobileRecord,
    PairingStatusView, ParsedPairingQr,
};
pub use mobile_sync::{MobileNowPlaying, MobileSyncService, MobileSyncStatus};
pub use quick_login::{push_session_to_peer, QuickLoginPayload, QuickLoginService, QuickLoginStatus};
pub use scrobble::{LastFmTokenAuth, ScrobbleConfigUpdate, ScrobbleService, ScrobbleState, ScrobbleTrack};
pub use smtc::{SmtcController, SmtcEventPayload, SmtcMetadata, SmtcPlayback};
