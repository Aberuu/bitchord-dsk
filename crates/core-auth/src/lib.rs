pub mod spotify;
pub mod vault;
pub mod watermark;
pub mod youtube;

pub use spotify::SpotifyService;
pub use vault::{app_data_dir, DiscordUser, SecretVault, VaultData};
pub use youtube::{HttpResponsePayload, YouTubeAuthService, YtAuthState, YtFetchParams};
