pub mod prefs;
pub mod spotify;
pub mod vault;
pub mod watermark;
pub mod youtube;

pub use prefs::DesktopPrefs;
pub use spotify::SpotifyService;
pub use vault::{
    app_data_dir, DiscordUser, SecretVault, StoredAddonConfig, StoredAddonQualityOption,
    StoredSmbConfig, StoredWebDavConfig, VaultData,
};
pub use youtube::{HttpResponsePayload, YouTubeAuthService, YtAuthState, YtFetchParams};
