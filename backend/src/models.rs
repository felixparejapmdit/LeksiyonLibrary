//! Installing the local AI models from Settings. Ollama does the download itself; this app
//! only asks it to, and only for its own two models, so nothing from the vault is sent.

use crate::api::{ApiError, User, S};
use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

/// A download in progress, or the last one that ended.
#[derive(Clone, Serialize, Default)]
pub struct Pull {
    /// The model being downloaded now.
    pub model: String,
    /// Which of the models still to install this is, counting from 1, and how many there are.
    pub step: usize,
    pub steps: usize,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// Ollama's own names, with ":latest" meaning the same as no tag.
fn same_model(installed: &str, wanted: &str) -> bool {
    let plain = |n: &str| n.strip_suffix(":latest").unwrap_or(n).to_string();
    plain(installed) == plain(wanted)
}

async fn installed(s: &S) -> Option<Vec<String>> {
    let url = format!("{}/api/tags", s.config.ollama_url.trim_end_matches('/'));
    // Ollama can take several seconds to answer its first request after idling.
    let resp = s.http.get(url).timeout(Duration::from_secs(15)).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: Value = resp.json().await.unwrap_or(json!({}));
    Some(body["models"].as_array().map(|m| m.iter().filter_map(|x| x["name"].as_str().map(str::to_string)).collect()).unwrap_or_default())
}

fn pull_state(s: &S) -> Option<Pull> {
    s.pull.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

pub async fn status(State(s): State<S>, _u: User) -> Json<Value> {
    let model = s.config.ollama_model.clone();
    let found = installed(&s).await;
    let names = found.clone().unwrap_or_default();
    let has = |wanted: &str| names.iter().any(|n| same_model(n, wanted));
    Json(json!({
        "available": has(&model),
        "reachable": found.is_some(),
        "model": model,
        "meaning": has(&s.config.embed_model),
        "embed_model": s.config.embed_model,
        "pull": pull_state(&s),
    }))
}

pub async fn progress(State(s): State<S>, _u: User) -> Json<Value> {
    Json(json!({ "pull": pull_state(&s) }))
}

/// Downloads and installs whichever of the app's two models Ollama does not have yet: the one
/// that writes notes, then the one for search by meaning. Progress is read from GET /ai/pull.
pub async fn start_pull(State(s): State<S>, _u: User) -> Result<Json<Value>, ApiError> {
    let names = installed(&s).await.ok_or_else(|| ApiError::bad("Ollama is not running. Start Ollama, then try again."))?;
    let missing: Vec<String> = [s.config.ollama_model.clone(), s.config.embed_model.clone()]
        .into_iter()
        .filter(|m| !names.iter().any(|n| same_model(n, m)))
        .collect();
    if missing.is_empty() {
        return Err(ApiError::bad("Everything is installed already."));
    }
    {
        let mut pull = s.pull.lock().unwrap_or_else(|e| e.into_inner());
        if pull.as_ref().is_some_and(|p| !p.done) {
            return Err(ApiError::new(StatusCode::CONFLICT, "A download is already running."));
        }
        *pull = Some(Pull { model: missing[0].clone(), step: 1, steps: missing.len(), status: "Starting".into(), ..Pull::default() });
    }
    let state = s.clone();
    let task = tokio::spawn(async move {
        let mut result = Ok(());
        for (i, model) in missing.iter().enumerate() {
            if let Some(p) = state.pull.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                *p = Pull { model: model.clone(), step: i + 1, steps: missing.len(), status: "Starting".into(), ..Pull::default() };
            }
            result = download(&state, model).await;
            if result.is_err() {
                break;
            }
            if *model == state.config.embed_model {
                crate::semantic::kick(state.clone());
            }
        }
        if let Some(p) = state.pull.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            p.done = true;
            match result {
                Ok(()) => p.status = "Installed".into(),
                Err(e) => p.error = Some(e),
            }
        }
    });
    *s.pull_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task.abort_handle());
    Ok(Json(json!({ "pull": pull_state(&s) })))
}

/// Stops a download. Ollama keeps what it has, so starting again carries on from there.
pub async fn cancel_pull(State(s): State<S>, _u: User) -> Json<Value> {
    if let Some(task) = s.pull_task.lock().unwrap_or_else(|e| e.into_inner()).take() {
        task.abort();
    }
    let mut pull = s.pull.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = pull.as_mut().filter(|p| !p.done) {
        p.done = true;
        p.error = Some("Download cancelled. Starting again carries on from where it stopped.".into());
    }
    Json(json!({ "pull": pull.clone() }))
}

/// Ollama answers a download with one line of JSON for each step, and an error as a line too.
async fn download(s: &S, model: &str) -> Result<(), String> {
    let mut resp = s
        .http
        .post(format!("{}/api/pull", s.config.ollama_url.trim_end_matches('/')))
        .json(&json!({ "model": model, "stream": true }))
        // A model is gigabytes, which takes a long time on a slow connection.
        .timeout(Duration::from_secs(12 * 60 * 60))
        .send()
        .await
        .map_err(|_| "Ollama is not running. Start Ollama, then try again.".to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Ollama could not download {model} ({}).", resp.status()));
    }
    let mut pending = Vec::new();
    let mut succeeded = false;
    while let Some(chunk) = resp.chunk().await.map_err(|_| "The download stopped. Check your internet connection and try again.".to_string())? {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let Ok(step) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(error) = step["error"].as_str() {
                return Err(format!("Ollama could not download {model}: {error}"));
            }
            let status = step["status"].as_str().unwrap_or_default();
            succeeded |= status == "success";
            if let Some(p) = s.pull.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                p.status = describe(status);
                if let (Some(total), Some(completed)) = (step["total"].as_u64(), step["completed"].as_u64()) {
                    (p.total, p.completed) = (total, completed);
                }
            }
        }
    }
    if succeeded { Ok(()) } else { Err("The download ended before it finished. Try again; it carries on from where it stopped.".into()) }
}

/// Ollama's steps in plain words.
fn describe(status: &str) -> String {
    match status {
        s if s.starts_with("pulling manifest") => "Starting".into(),
        s if s.starts_with("pulling") || s.starts_with("downloading") => "Downloading".into(),
        s if s.starts_with("verifying") => "Checking the download".into(),
        s if s.starts_with("writing") => "Installing".into(),
        "success" => "Installed".into(),
        _ => "Working".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_model_without_a_tag_is_the_latest_one() {
        assert!(same_model("bge-m3:latest", "bge-m3"));
        assert!(same_model("llama3.2:3b", "llama3.2:3b"));
        assert!(!same_model("llama3.2:1b", "llama3.2:3b"));
    }

    #[test]
    fn ollamas_steps_are_said_in_plain_words() {
        assert_eq!(describe("pulling manifest"), "Starting");
        assert_eq!(describe("pulling 6a0746a1ec1a"), "Downloading");
        assert_eq!(describe("verifying sha256 digest"), "Checking the download");
        assert_eq!(describe("writing manifest"), "Installing");
        assert_eq!(describe("success"), "Installed");
    }
}
