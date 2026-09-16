use serde::Serialize;

/// Application-wide error type. Serialized as a plain message string so the
/// frontend can display it directly.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{}", .0.message())]
    Git(#[from] git2::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Http(#[from] reqwest::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Url(#[from] url::ParseError),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
    #[error("LFS: {0}")]
    Lfs(String),
    #[error("{0}")]
    Msg(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Msg(s)
    }
}
impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Msg(s.to_string())
    }
}
impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        AppError::Msg(format!("keyring: {e}"))
    }
}
impl From<ssh2::Error> for AppError {
    fn from(e: ssh2::Error) -> Self {
        AppError::Lfs(format!("ssh: {e}"))
    }
}
impl From<git_lfs_api::ApiError> for AppError {
    fn from(e: git_lfs_api::ApiError) -> Self {
        AppError::Lfs(e.to_string())
    }
}
impl From<git_lfs_transfer::TransferError> for AppError {
    fn from(e: git_lfs_transfer::TransferError) -> Self {
        AppError::Lfs(e.to_string())
    }
}
impl From<git_lfs_store::StoreError> for AppError {
    fn from(e: git_lfs_store::StoreError) -> Self {
        AppError::Lfs(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

pub fn err<T>(msg: impl Into<String>) -> AppResult<T> {
    Err(AppError::Msg(msg.into()))
}

/// Run blocking (libgit2 / filesystem) work off the async runtime threads.
pub async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Msg(format!("background task failed: {e}")))?
}
