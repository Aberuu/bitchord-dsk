pub mod prefs;
pub mod session_key;
pub mod spotify;
pub mod vault;
pub mod watermark;
pub mod youtube;

pub use prefs::DesktopPrefs;
pub use session_key::{current_epoch_ms, decode_one_key, encode_one_key, OneKeyPayload};
pub use spotify::SpotifyService;
pub use vault::{
    app_data_dir, DesktopSessionPersistence, DiscordUser, EphemeralSessionOverlay, SecretVault,
    StoredAddonConfig, StoredAddonQualityOption, StoredSmbConfig, StoredWebDavConfig, VaultData,
};
pub use youtube::{HttpResponsePayload, YouTubeAuthService, YtAuthState, YtFetchParams};
