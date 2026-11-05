mod ai;
mod api;
mod backup;
mod books;
mod db;
mod export;
mod language;
mod parser;
mod semantic;
mod vault;
mod verse_import;

use axum::http::{header, HeaderValue};
use std::{
    future::IntoFuture,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

pub struct Config {
    pub port: u16,
    pub bind: String,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    pub ollama_url: String,
    pub ollama_model: String,
    pub embed_model: String,
    pub sheets_url: String,
}

pub struct AppState {
    pub conn: Mutex<rusqlite::Connection>,
    pub config: Config,
    pub http: reqwest::Client,
    pub owner_id: String,
    pub vault: vault::Vault,
    pub indexing: AtomicBool,
}

const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; \
object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/// Relative LV_DATA and LV_STATIC paths are anchored to the backend folder found
/// above the executable, not to wherever the process was started. Otherwise a
/// launch from another folder silently opens a new, empty vault.
fn base_dir(exe: Option<&Path>, cwd: &Path) -> PathBuf {
    exe.and_then(|e| e.ancestors().skip(1).find(|d| d.join("Cargo.toml").is_file()))
        .map_or_else(|| cwd.to_path_buf(), Path::to_path_buf)
}

/// Resolves on Ctrl+C, or also when the terminal window is closed on Windows.
async fn shutdown_signal() {
    #[cfg(windows)]
    {
        let mut close = tokio::signal::windows::ctrl_close().expect("cannot watch for terminal close");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = close.recv() => {}
        }
    }
    #[cfg(not(windows))]
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() {
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
    let cwd = std::env::current_dir().expect("cannot read current directory");
    let base = base_dir(std::env::current_exe().ok().as_deref(), &cwd);
    let config = Config {
        // 47319 is this app's dedicated port; it is not a framework default.
        port: env("LV_PORT", "47319").parse().expect("LV_PORT must be a port number"),
        bind: env("LV_BIND", "127.0.0.1"),
        data_dir: base.join(env("LV_DATA", "data")),
        static_dir: base.join(env("LV_STATIC", "../frontend/dist")),
        ollama_url: env("LV_OLLAMA_URL", "http://127.0.0.1:11434"),
        ollama_model: env("LV_OLLAMA_MODEL", "llama3.2:3b"),
        // bge-m3 because it separates related from unrelated questions in Tagalog as well as
        // English. paraphrase-multilingual, tested first, could not do so for Tagalog.
        embed_model: env("LV_OLLAMA_EMBED_MODEL", "bge-m3"),
        sheets_url: env("LV_SHEETS_URL", "https://docs.google.com"),
    };

    // There is no sign-in, so the app must never be reachable from other computers.
    if !["127.0.0.1", "localhost"].contains(&config.bind.as_str()) {
        eprintln!("Cannot bind {}: Lesson Vault has no sign-in, so it only runs on this computer (127.0.0.1).", config.bind);
        std::process::exit(1);
    }
    let addr = format!("{}:{}", config.bind, config.port);

    // Binding is exclusive: if the port is taken we stop instead of drifting to another one.
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Cannot bind {addr}: {e}. Another process is using this port; stop it or set LV_PORT.");
            std::process::exit(1);
        }
    };

    // Opened only after the port is ours, so a second copy never touches the data.
    let opened = vault::Vault::open(&config.data_dir).and_then(|v| v.load_database().map(|c| (v, c)));
    let (vault, conn) = match opened {
        Ok(v) => v,
        Err(e) => {
            eprintln!("Cannot open the vault: {e}");
            std::process::exit(1);
        }
    };
    let owner_id = db::local_owner(&conn).expect("cannot read the vault owner");
    vault.save_db(&conn).expect("cannot save the vault");

    let http = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(300))
        .build()
        .expect("cannot build HTTP client");

    let index = config.static_dir.join("index.html");
    if !index.is_file() {
        eprintln!("Warning: the frontend is not built ({} is missing). Run `npm run build`.", index.display());
    }
    let data_shown = config.data_dir.display().to_string();
    let spa = ServeDir::new(&config.static_dir).fallback(ServeFile::new(index));

    let state = Arc::new(AppState { conn: Mutex::new(conn), config, http, owner_id, vault, indexing: AtomicBool::new(false) });

    semantic::kick(state.clone());

    let app = api::router(state)
        .fallback_service(tower::ServiceBuilder::new()
            .layer(SetResponseHeaderLayer::if_not_present(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-cache"),
            ))
            .service(spa))
        .layer(SetResponseHeaderLayer::overriding(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(axum::middleware::map_response(api::cache_hashed_assets))
        .layer(CompressionLayer::new());

    println!("Lesson Vault running at http://{addr}");
    println!("Data folder (encrypted): {data_shown}");
    println!("Press Ctrl+C to stop.");

    let (stopping, stop_requested) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app).with_graceful_shutdown(async move {
        shutdown_signal().await;
        let _ = stopping.send(());
    });
    // A slow request, such as an AI note, must not hold up shutdown.
    let drain_limit = async move {
        let _ = stop_requested.await;
        tokio::time::sleep(Duration::from_secs(3)).await;
    };
    tokio::select! {
        result = server.into_future() => result.expect("server error"),
        _ = drain_limit => eprintln!("Stopping without waiting for requests still in progress."),
    }

    println!("Lesson Vault stopped.");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_location_does_not_depend_on_where_the_app_was_started() {
        let backend = std::env::temp_dir().join(format!("lv-base-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(backend.join("target/release")).unwrap();
        std::fs::write(backend.join("Cargo.toml"), "").unwrap();
        let exe = backend.join("target/release/lesson-vault.exe");
        assert_eq!(base_dir(Some(&exe), Path::new("/somewhere/else")), backend);
        std::fs::remove_dir_all(&backend).unwrap();
    }

    #[test]
    fn a_copied_executable_falls_back_to_the_current_folder() {
        let lone = std::env::temp_dir().join(format!("lv-lone-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&lone).unwrap();
        let cwd = Path::new("/run/here");
        assert_eq!(base_dir(Some(&lone.join("lesson-vault.exe")), cwd), cwd);
        assert_eq!(base_dir(None, cwd), cwd);
        std::fs::remove_dir_all(&lone).unwrap();
    }
}
