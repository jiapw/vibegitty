//! Provider REST calls: profile validation and repository listing.

use super::ProviderMeta;
use crate::config::{Account, Provider};
use crate::error::{AppError, AppResult};
use crate::git::types::RemoteRepo;
use reqwest::{Client, RequestBuilder};
use serde_json::Value;

pub struct Profile {
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

fn with_auth(req: RequestBuilder, provider: Provider, username: &str, token: &str, auth_kind: &str) -> RequestBuilder {
    match provider {
        Provider::Github => req
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28"),
        Provider::Gitlab => req.bearer_auth(token),
        Provider::Gitea => {
            if auth_kind == "oauth" {
                req.bearer_auth(token)
            } else {
                req.header("Authorization", format!("token {token}"))
            }
        }
        Provider::Bitbucket | Provider::Generic => req.basic_auth(username, Some(token)),
    }
}

async fn get_json(req: RequestBuilder) -> AppResult<Value> {
    let resp = req.send().await?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Msg(
            "The saved token was rejected (HTTP 401). It has probably expired or been revoked; open Accounts and sign in again.".into(),
        ));
    }
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(AppError::Msg(format!("HTTP {status}: {snippet}")));
    }
    Ok(serde_json::from_str(&text)?)
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(String::from)
}

pub async fn fetch_profile(
    http: &Client,
    provider: Provider,
    meta: &ProviderMeta,
    username_hint: &str,
    token: &str,
) -> AppResult<Profile> {
    let hint = username_hint.trim();
    if provider == Provider::Generic {
        if hint.is_empty() {
            return Err(AppError::Msg("Username is required for a generic git server".into()));
        }
        return Ok(Profile {
            username: hint.to_string(),
            display_name: hint.to_string(),
            avatar_url: None,
        });
    }
    if provider == Provider::Bitbucket && hint.is_empty() {
        return Err(AppError::Msg("Bitbucket needs your username together with an app password".into()));
    }
    let url = format!("{}/user", meta.api_base);
    let v = get_json(with_auth(http.get(&url), provider, hint, token, "token"))
        .await
        .map_err(|e| AppError::Msg(format!("Could not verify the token with {}: {e}", meta.host)))?;
    let (username, display_name, avatar) = match provider {
        Provider::Github => (s(&v, "login"), s(&v, "name"), s(&v, "avatar_url")),
        Provider::Gitlab => (s(&v, "username"), s(&v, "name"), s(&v, "avatar_url")),
        Provider::Gitea => (s(&v, "login"), s(&v, "full_name"), s(&v, "avatar_url")),
        Provider::Bitbucket => (
            s(&v, "username").or_else(|| Some(hint.to_string())),
            s(&v, "display_name"),
            v.pointer("/links/avatar/href").and_then(|x| x.as_str()).map(String::from),
        ),
        Provider::Generic => unreachable!(),
    };
    let username = username.unwrap_or_else(|| hint.to_string());
    let display_name = display_name.filter(|d| !d.is_empty()).unwrap_or_else(|| username.clone());
    Ok(Profile {
        username,
        display_name,
        avatar_url: avatar,
    })
}

pub async fn list_repos(http: &Client, account: &Account, token: &str) -> AppResult<Vec<RemoteRepo>> {
    let auth = |req: RequestBuilder| with_auth(req, account.provider, &account.username, token, &account.auth_kind);
    let mut out = Vec::new();
    match account.provider {
        Provider::Github => {
            for page in 1..=3 {
                let url = format!(
                    "{}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page={page}",
                    account.api_base
                );
                let v = get_json(auth(http.get(&url))).await?;
                let items = v.as_array().cloned().unwrap_or_default();
                let n = items.len();
                for r in items {
                    out.push(RemoteRepo {
                        full_name: s(&r, "full_name").unwrap_or_default(),
                        clone_url: s(&r, "clone_url").unwrap_or_default(),
                        ssh_url: s(&r, "ssh_url"),
                        private: r["private"].as_bool().unwrap_or(false),
                        description: s(&r, "description"),
                        updated_at: s(&r, "updated_at"),
                        default_branch: s(&r, "default_branch"),
                    });
                }
                if n < 100 {
                    break;
                }
            }
        }
        Provider::Gitlab => {
            for page in 1..=3 {
                let url = format!(
                    "{}/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true&page={page}",
                    account.api_base
                );
                let v = get_json(auth(http.get(&url))).await?;
                let items = v.as_array().cloned().unwrap_or_default();
                let n = items.len();
                for r in items {
                    out.push(RemoteRepo {
                        full_name: s(&r, "path_with_namespace").unwrap_or_default(),
                        clone_url: s(&r, "http_url_to_repo").unwrap_or_default(),
                        ssh_url: s(&r, "ssh_url_to_repo"),
                        private: s(&r, "visibility").map(|v| v != "public").unwrap_or(false),
                        description: s(&r, "description"),
                        updated_at: s(&r, "last_activity_at"),
                        default_branch: s(&r, "default_branch"),
                    });
                }
                if n < 100 {
                    break;
                }
            }
        }
        Provider::Gitea => {
            for page in 1..=3 {
                let url = format!("{}/user/repos?limit=50&page={page}", account.api_base);
                let v = get_json(auth(http.get(&url))).await?;
                let items = v.as_array().cloned().unwrap_or_default();
                let n = items.len();
                for r in items {
                    out.push(RemoteRepo {
                        full_name: s(&r, "full_name").unwrap_or_default(),
                        clone_url: s(&r, "clone_url").unwrap_or_default(),
                        ssh_url: s(&r, "ssh_url"),
                        private: r["private"].as_bool().unwrap_or(false),
                        description: s(&r, "description"),
                        updated_at: s(&r, "updated_at"),
                        default_branch: s(&r, "default_branch"),
                    });
                }
                if n < 50 {
                    break;
                }
            }
        }
        Provider::Bitbucket => {
            let mut url = format!("{}/repositories?role=member&pagelen=100&sort=-updated_on", account.api_base);
            for _ in 0..3 {
                let v = get_json(auth(http.get(&url))).await?;
                for r in v["values"].as_array().cloned().unwrap_or_default() {
                    let mut https = String::new();
                    let mut ssh = None;
                    for l in r.pointer("/links/clone").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                        match (s(&l, "name").as_deref(), s(&l, "href")) {
                            (Some("https"), Some(h)) => https = h,
                            (Some("ssh"), Some(h)) => ssh = Some(h),
                            _ => {}
                        }
                    }
                    out.push(RemoteRepo {
                        full_name: s(&r, "full_name").unwrap_or_default(),
                        clone_url: https,
                        ssh_url: ssh,
                        private: r["is_private"].as_bool().unwrap_or(false),
                        description: s(&r, "description"),
                        updated_at: s(&r, "updated_on"),
                        default_branch: r.pointer("/mainbranch/name").and_then(|x| x.as_str()).map(String::from),
                    });
                }
                match s(&v, "next") {
                    Some(n) => url = n,
                    None => break,
                }
            }
        }
        Provider::Generic => {}
    }
    Ok(out)
}
