pub mod prefs;
pub mod session_key;
pub mod spotify;
pub mod vault;
pub mod watermark;
pub mod youtube;

pub use prefs::{DesktopPrefs, PairedDesktopConfig};
pub use session_key::{current_epoch_ms, decode_one_key, encode_one_key, OneKeyPayload};
pub use spotify::SpotifyService;
pub use vault::{
    app_data_dir, set_app_data_dir_override, DesktopSessionPersistence, DiscordUser,
    EphemeralSessionOverlay, SecretVault, StoredAddonConfig, StoredAddonQualityOption,
    StoredSmbConfig, StoredWebDavConfig, VaultData,
};
pub use youtube::{
    extract_signing_secret_present, HttpResponsePayload, YouTubeAuthService, YtAuthState,
    YtFetchParams,
};
