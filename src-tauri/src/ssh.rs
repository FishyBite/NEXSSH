use crate::{
    required, security,
    ssh_attempt::Attempt,
    storage::{TerminalCommand, TerminalSession},
    AppState,
};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ssh2::{ExtendedData, Session};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    sync::{atomic::AtomicBool, mpsc, Arc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

#[derive(Debug)]
pub enum ConnectError {
    Message(String),
    Verification(Value),
    Credential(Value),
}
impl ConnectError {
    pub fn message(self) -> String {
        match self {
            Self::Message(message) => message,
            Self::Credential(value) => value["message"]
                .as_str()
                .unwrap_or("SSH credential required")
                .to_owned(),
            Self::Verification(value) => format!(
                "Host key approval required. Connect this host in a terminal first. {}",
                value
            ),
        }
    }
}
impl From<String> for ConnectError {
    fn from(value: String) -> Self {
        Self::Message(value)
    }
}
impl From<&str> for ConnectError {
    fn from(value: &str) -> Self {
        Self::Message(value.into())
    }
}

pub fn open_session(state: &AppState, id: &str) -> Result<Session, ConnectError> {
    open(state, id, None, None, &mut Vec::new())
}

pub fn open_cancellable_session(state: &AppState, id: &str, attempt: &Attempt) -> Result<Session, ConnectError> {
    open_attempt(state, id, None, None, &mut Vec::new(), false, Some(attempt), &Value::Null)
}

// Older releases keyed encrypted passwords by profile ID only. Snapshot the
// existing verified route before a user can change a profile or trust a new key.
pub fn bind_legacy_credentials(state: &AppState) -> Result<(), String> {
    let db = state.db()?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS ssh_legacy_routes (host_id TEXT PRIMARY KEY, route_token TEXT NOT NULL)").map_err(|e| e.to_string())?;
    let mut statement = db.prepare("SELECT substr(id,6) FROM secrets WHERE id LIKE 'host:%' AND substr(id,6) NOT IN (SELECT host_id FROM ssh_legacy_routes)").map_err(|e| e.to_string())?;
    let ids: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for id in ids {
        let token = state
            .capture_binding(&id)
            .and_then(|b| b.route_token())
            .unwrap_or_default();
        db.execute(
            "INSERT OR IGNORE INTO ssh_legacy_routes VALUES (?1,?2)",
            [&id, &token],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn cached_credentials(state: &AppState, id: &str, route: &str) -> Result<Value, String> {
    if let Some(value) = state
        .inner
        .credentials
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
    {
        if value["routeToken"] == route {
            return Ok(value.clone());
        }
    }
    let Some(value) = security::load_secret(state, &format!("host:{id}"))? else {
        return Ok(Value::Null);
    };
    if let Some(token) = value["routeToken"].as_str() {
        return Ok(if token == route { value } else { Value::Null });
    }
    let matches: bool = state
        .db()?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ssh_legacy_routes WHERE host_id=?1 AND route_token=?2)",
            [id, route],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(if matches { value } else { Value::Null })
}

fn open(
    state: &AppState,
    id: &str,
    trust: Option<&str>,
    trust_id: Option<&str>,
    visited: &mut Vec<String>,
) -> Result<Session, ConnectError> {
    open_configured(state, id, trust, trust_id, visited, false)
}

fn open_configured(
    state: &AppState,
    id: &str,
    trust: Option<&str>,
    trust_id: Option<&str>,
    visited: &mut Vec<String>,
    verify_only: bool,
) -> Result<Session, ConnectError> {
    open_attempt(
        state,
        id,
        trust,
        trust_id,
        visited,
        verify_only,
        None,
        &Value::Null,
    )
}

#[allow(clippy::too_many_arguments)]
fn open_attempt(
    state: &AppState,
    id: &str,
    trust: Option<&str>,
    trust_id: Option<&str>,
    visited: &mut Vec<String>,
    verify_only: bool,
    attempt: Option<&Attempt>,
    payload: &Value,
) -> Result<Session, ConnectError> {
    if let Some(attempt) = attempt {
        attempt.check()?;
    }
    if visited.iter().any(|value| value == id) {
        return Err("ProxyJump configuration contains a cycle".into());
    }
    if visited.len() >= 8 {
        return Err("ProxyJump supports up to eight connection stages".into());
    }
    visited.push(id.to_string());
    let host = state.host(id)?;
    let hostname = required(&host, "hostname")?;
    let username = required(&host, "username")?;
    let port = host["port"].as_u64().unwrap_or(22);
    if port == 0 || port > 65535 {
        return Err("Port must be between 1 and 65535".into());
    }
    if host["agentForwarding"].as_bool() == Some(true) {
        return Err("SSH agent forwarding is not available in this build".into());
    }
    let config = state.config()?;
    let timeout = host["timeout"]
        .as_u64()
        .or(config["settings"]["timeout"].as_u64())
        .unwrap_or(15)
        .clamp(1, 120);
    let jump = host["jumpHostId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| host["proxyJump"].as_str().filter(|s| !s.is_empty()));
    let socket = if let Some(jump) = jump {
        let jump_session = open_attempt(
            state, jump, trust, trust_id, visited, false, attempt, payload,
        )
        .map_err(|error| match error {
            ConnectError::Message(message) => {
                ConnectError::Message(format!("Jump host {jump}: {message}"))
            }
            verification => verification,
        })?;
        let channel = jump_session
            .channel_direct_tcpip(hostname, port as u16, None)
            .map_err(|e| format!("Jump host could not reach {hostname}:{port}: {e}"))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let client = TcpStream::connect(listener.local_addr().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let (relay, _) = listener.accept().map_err(|e| e.to_string())?;
        jump_session.set_blocking(false);
        std::thread::spawn(move || {
            let _ = crate::tunnels::bridge(relay, channel, Arc::new(AtomicBool::new(false)));
            drop(jump_session);
        });
        client
    } else if let Some(attempt) = attempt {
        attempt.dial(hostname, port as u16, Duration::from_secs(timeout))?
    } else {
        let addresses = (hostname, port as u16)
            .to_socket_addrs()
            .map_err(|e| format!("Cannot resolve {hostname}: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(timeout);
        let mut last_error = "Host has no resolved addresses".to_string();
        let mut socket = None;
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match TcpStream::connect_timeout(&address, remaining) {
                Ok(stream) => {
                    socket = Some(stream);
                    break;
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        socket.ok_or_else(|| format!("Cannot connect to {hostname}:{port}: {last_error}"))?
    };
    if let Some(attempt) = attempt {
        attempt.track(&socket)?;
    }
    socket.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut session = Session::new().map_err(|e| e.to_string())?;
    session.method_pref(ssh2::MethodType::HostKey, host["hostKeyAlgorithm"].as_str().unwrap_or("ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256")).map_err(|error| format!("Unable to select SSH host key algorithms: {error}"))?;
    session.set_timeout((timeout * 1000) as u32);
    session.set_compress(host["compression"].as_bool().unwrap_or(false));
    session.set_tcp_stream(socket);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {e}"))?;
    let key = session
        .host_key()
        .ok_or("Server did not send a host key")?
        .0;
    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(key)));
    let previous = security::known_fingerprint(state, id, hostname, port as u16)?;
    if let Some(attempt) = attempt {
        attempt.check()?;
    }
    if previous.as_deref() != Some(&fingerprint) {
        if let Some(trust) = trust.filter(|_| trust_id == Some(id)) {
            if trust != fingerprint
                || payload["trustHostname"]
                    .as_str()
                    .is_some_and(|value| value != hostname)
                || payload["trustPort"]
                    .as_u64()
                    .is_some_and(|value| value != port)
            {
                return Err("Server fingerprint changed during approval. Connect again and verify the new fingerprint.".into());
            }
            security::trust_host(state, id, hostname, port as u16, &fingerprint)?;
        } else {
            return Err(ConnectError::Verification(
                json!({"verificationRequired":true,"hostId":id,"hostname":hostname,"port":port,"fingerprint":fingerprint,"previousFingerprint":previous,"changed":previous.is_some()}),
            ));
        }
    }
    if verify_only {
        return Ok(session);
    }
    let route = state.capture_binding(id)?.route_token()?;
    let submitted = payload["credentialHostId"]
        .as_str()
        .or(payload["hostId"].as_str())
        == Some(id)
        && (payload["password"].is_string() || payload["passphrase"].is_string())
        && payload["credentialRouteToken"].as_str() == Some(route.as_str());
    let credentials = if submitted {
        json!({"password":payload["password"],"passphrase":payload["passphrase"],"routeToken":route})
    } else {
        cached_credentials(state, id, &route)?
    };
    let prompt = |kind: &str, message: &str| {
        ConnectError::Credential(json!({
            "credentialRequired":kind,"hostId":id,"routeToken":route,"message":message
        }))
    };
    if let Some(attempt) = attempt {
        attempt.check()?;
    }
    let passphrase = credentials["passphrase"].as_str().filter(|s| !s.is_empty());
    match host["authMethod"].as_str().unwrap_or("password") {
        "password" => session
            .userauth_password(
                username,
                credentials["password"]
                    .as_str()
                    .ok_or_else(|| prompt("password", "Enter the host password"))?,
            )
            .map_err(|e| prompt("password", &format!("Password authentication failed: {e}")))?,
        "key" => {
            let key = if let Some(key_id) = host["keyId"]
                .as_str()
                .filter(|s| !s.is_empty() && host["keySource"] != "file")
            {
                security::load_secret(state, &format!("key:{key_id}"))?
                    .ok_or("The selected SSH key is unavailable")?["privateKey"]
                    .as_str()
                    .ok_or("Stored key is invalid")?
                    .to_string()
            } else {
                let path = required(&host, "identityFile")?;
                String::from_utf8(
                    security::read_limited(path, 1024 * 1024)
                        .map_err(|error| format!("Unable to read private key file: {error}"))?,
                )
                .map_err(|_| {
                    "Unsupported private key format. Select an OpenSSH Ed25519 or RSA private key."
                        .to_string()
                })?
            };
            let parsed = security::parse_identity(key.as_bytes())?;
            let parsed = if parsed.is_encrypted() {
                parsed
                    .decrypt(passphrase.ok_or_else(|| {
                        prompt(
                            "passphrase",
                            "This private key is encrypted. Enter its passphrase.",
                        )
                    })?)
                    .map_err(|_| {
                        prompt(
                            "passphrase",
                            "Passphrase is incorrect or the encrypted private key is damaged",
                        )
                    })?
            } else {
                parsed
            };
            let private = parsed
                .to_openssh(ssh_key::LineEnding::LF)
                .map_err(|_| "Unable to decode private key".to_string())?;
            session
                .userauth_pubkey_memory(username, None, private.as_str(), None)
                .map_err(|e| format!("Server rejected this SSH key for user {username}: {e}"))?;
        }
        "agent" => session
            .userauth_agent(username)
            .map_err(|e| format!("SSH agent authentication failed: {e}"))?,
        _ => return Err("Unsupported authentication method".into()),
    }
    if !session.authenticated() {
        return Err("SSH authentication was rejected".into());
    }
    if let Some(attempt) = attempt {
        attempt.check()?;
    }
    if submitted {
        if payload["saveCredential"] == true && host["authMethod"] == "password" {
            security::save_secret(state, &format!("host:{id}"), &credentials)?;
        }
        state
            .inner
            .credentials
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.to_string(), credentials);
    }
    let keepalive = host["keepalive"]
        .as_u64()
        .or(config["settings"]["keepalive"].as_u64())
        .unwrap_or(30)
        .min(3600) as u32;
    session.set_keepalive(true, keepalive);
    Ok(session)
}

pub fn connect(state: &AppState, app: &tauri::AppHandle, payload: Value) -> Result<Value, String> {
    let attempt_id = payload["attemptId"].as_str();
    let attempt = match attempt_id {
        Some(id) => Some(
            state
                .inner
                .ssh_attempts
                .lock()
                .map_err(|e| e.to_string())?
                .get(id)
                .cloned()
                .ok_or("SSH connection cancelled")?,
        ),
        None => None,
    };
    let result = connect_registered(state, app, &payload, attempt.as_deref());
    if let Some(id) = attempt_id {
        let mut registry = state.inner.ssh_attempts.lock().map_err(|e| e.to_string())?;
        if registry.remove(id).is_none() {
            drop(registry);
            if let Ok(value) = &result {
                if let Some(session_id) = value["sessionId"].as_str() {
                    let _ = control(state, "ssh_disconnect", json!({"sessionId":session_id}));
                }
            }
            return Err("SSH connection cancelled".into());
        }
    }
    result
}

fn connect_registered(
    state: &AppState,
    app: &tauri::AppHandle,
    payload: &Value,
    attempt: Option<&Attempt>,
) -> Result<Value, String> {
    let id = required(payload, "hostId")?;
    let _profile_guard = state.inner.config_lock.lock().map_err(|e| e.to_string())?;
    let started = Instant::now();
    let session = match open_attempt(
        state,
        id,
        payload["trustFingerprint"].as_str(),
        payload["trustHostId"].as_str().or(Some(id)),
        &mut Vec::new(),
        payload["verifyOnly"].as_bool().unwrap_or(false),
        attempt,
        payload,
    ) {
        Ok(session) => session,
        Err(ConnectError::Verification(value) | ConnectError::Credential(value)) => {
            return Ok(value)
        }
        Err(ConnectError::Message(error)) => return Err(error),
    };
    if payload["verifyOnly"] == true {
        return Ok(json!({"verified":true}));
    }
    if let Some(attempt) = attempt {
        attempt.check()?;
    }
    let binding = state.capture_binding(id)?;
    start_terminal(state, app, payload, session, binding, started, None)
}

pub(crate) fn directory_command(path: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.chars().any(char::is_control) {
        return Err(
            "Choose a remote directory with an absolute path and no control characters.".into(),
        );
    }
    let quoted = path.replace('\'', "'\\''");
    Ok(format!("cd '{quoted}' && exec \"${{SHELL:-/bin/sh}}\" -i"))
}

pub fn open_here(
    state: &AppState,
    app: &tauri::AppHandle,
    payload: Value,
) -> Result<Value, String> {
    let path = required(&payload, "path")?;
    let cmd = directory_command(path)?;
    let started = Instant::now();
    let binding = state.session_binding(required(&payload, "sessionId")?)?;
    let session = state.open_bound_session(&binding)?;
    let stat = session
        .sftp()
        .and_then(|sftp| sftp.stat(std::path::Path::new(path)))
        .map_err(|error| format!("Cannot open this remote directory: {error}"))?;
    if !stat.is_dir() {
        return Err("Choose a remote directory.".into());
    }
    start_terminal(state, app, &payload, session, binding, started, Some(&cmd))
}

fn start_terminal(
    state: &AppState,
    app: &tauri::AppHandle,
    payload: &Value,
    session: Session,
    binding: crate::storage::SessionBinding,
    started: Instant,
    command: Option<&str>,
) -> Result<Value, String> {
    let id = binding.host_id.clone();
    let route_token = binding.route_token()?;
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    let cols = payload["cols"].as_u64().unwrap_or(100).clamp(2, 500) as u32;
    let rows = payload["rows"].as_u64().unwrap_or(30).clamp(2, 500) as u32;
    channel
        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
        .map_err(|e| format!("Server rejected a terminal: {e}"))?;
    let host = state.host(&id)?;
    let config = state.config()?;
    let profile = config["terminalProfiles"].as_array().and_then(|profiles| {
        profiles
            .iter()
            .find(|profile| profile["id"] == host["terminalProfileId"])
    });
    let mut environment = profile
        .and_then(|profile| profile["environment"].as_object())
        .cloned()
        .unwrap_or_default();
    if let Some(host_environment) = host["environment"].as_object() {
        environment.extend(host_environment.clone());
    }
    for (key, value) in &environment {
        if key.is_empty() || !key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err(
                "Environment names must contain only letters, digits and underscores".into(),
            );
        }
        channel
            .setenv(
                key,
                value.as_str().ok_or("Environment values must be strings")?,
            )
            .map_err(|e| format!("Server rejected environment variable {key}: {e}"))?;
    }
    channel
        .handle_extended_data(ExtendedData::Merge)
        .map_err(|e| e.to_string())?;
    match command {
        Some(command) => channel.exec(command),
        None => channel.shell(),
    }
    .map_err(|e| format!("Server could not start the terminal: {e}"))?;
    session.set_blocking(false);
    let session_id = payload["attemptId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (sender, receiver) = mpsc::channel();
    state
        .inner
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            session_id.clone(),
            TerminalSession {
                host_id: id.clone(),
                sender,
                binding,
            },
        );
    let app = app.clone();
    let state = state.clone();
    let worker_id = session_id.clone();
    std::thread::spawn(move || {
        let mut pending = VecDeque::<Vec<u8>>::new();
        let mut write_offset = 0;
        let mut pending_resize = None;
        let mut attached = false;
        let mut buffer = [0u8; 32768];
        let mut keepalive = Instant::now();
        let result: Result<(), String> = (|| {
            loop {
                while let Ok(command) = receiver.try_recv() {
                    match command {
                        TerminalCommand::Attach => attached = true,
                        TerminalCommand::Close => {
                            let _ = channel.close();
                            return Ok(());
                        }
                        TerminalCommand::Write(bytes) => {
                            attached = true;
                            if !bytes.is_empty() {
                                pending.push_back(bytes);
                            }
                        }
                        TerminalCommand::Resize(cols, rows) => {
                            pending_resize = Some((cols, rows));
                        }
                    }
                }
                let mut activity = false;
                if let Some((cols, rows)) = pending_resize {
                    match channel.request_pty_size(cols, rows, None, None) {
                        Ok(()) => pending_resize = None,
                        Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {}
                        Err(error) => return Err(format!("Terminal resize failed: {error}")),
                    }
                }
                // libssh2 requires the same slice when retrying a nonblocking write.
                // A full peer receive window can yield zero before more space opens.
                if let Some(bytes) = pending.front() {
                    match channel.write(&bytes[write_offset..]) {
                        Ok(count) => {
                            write_offset += count;
                            if write_offset == bytes.len() {
                                pending.pop_front();
                                write_offset = 0;
                            }
                            activity = count > 0;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(error) => return Err(format!("SSH transport write failed: {error}")),
                    }
                }
                if attached {
                    match channel.read(&mut buffer) {
                        Ok(0) => {
                            if channel.eof() {
                                break;
                            }
                        }
                        Ok(count) => {
                            let _=app.emit("terminal-data",json!({"sessionId":worker_id,"data":STANDARD.encode(&buffer[..count])}));
                            activity = true;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(error) => return Err(format!("SSH transport read failed: {error}")),
                    }
                }
                if keepalive.elapsed() >= Duration::from_secs(10) {
                    match session.keepalive_send() {
                        Ok(_) => {}
                        Err(error) if error.code() == ssh2::ErrorCode::Session(-37) => {}
                        Err(error) => return Err(format!("SSH keepalive failed: {error}")),
                    }
                    keepalive = Instant::now();
                }
                if !activity {
                    std::thread::sleep(Duration::from_millis(8));
                }
            }
            Ok(())
        })();
        if let Ok(mut sessions) = state.inner.sessions.lock() {
            sessions.remove(&worker_id);
        }
        crate::tunnels::stop_for_session(&state, &worker_id);
        let _ = app.emit("terminal-status", json!({
            "sessionId": worker_id,
            "status": if result.is_ok() { "disconnected" } else { "error" },
            "error": result.err()
        }));
    });
    Ok(
        json!({"sessionId":session_id,"hostId":id,"routeToken":route_token,"latencyMs":started.elapsed().as_millis(),"connectedAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()}),
    )
}

pub fn control(state: &AppState, action: &str, payload: Value) -> Result<Value, String> {
    let id = required(&payload, "sessionId")?;
    let sessions = state.inner.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(id).ok_or("SSH session is disconnected")?;
    let command = match action {
        "ssh_attach" => TerminalCommand::Attach,
        "ssh_write" => {
            let data = payload["data"].as_str().ok_or("Missing terminal data")?;
            if data.len() > 1024 * 1024 {
                return Err("Paste exceeds 1 MiB".into());
            }
            TerminalCommand::Write(data.as_bytes().to_vec())
        }
        "ssh_resize" => TerminalCommand::Resize(
            payload["cols"].as_u64().unwrap_or(80).clamp(2, 500) as u32,
            payload["rows"].as_u64().unwrap_or(24).clamp(2, 500) as u32,
        ),
        "ssh_disconnect" => TerminalCommand::Close,
        _ => return Err("Unknown terminal action".into()),
    };
    session
        .sender
        .send(command)
        .map_err(|_| "SSH session has ended".to_string())?;
    Ok(json!({"ok":true}))
}

#[cfg(test)]
pub(crate) fn seed_test_credential(state: &AppState, id: &str, mut credential: Value) {
    credential["routeToken"] = json!(state.capture_binding(id).unwrap().route_token().unwrap());
    state
        .inner
        .credentials
        .lock()
        .unwrap()
        .insert(id.into(), credential);
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::tunnels;

    #[test]
    fn upgraded_password_is_only_available_for_its_verified_route() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().into()).unwrap();
        let config = json!({"hosts":[{"id":"saved","hostname":"127.0.0.1","port":22,"username":"first","authMethod":"password"}]});
        state.save_config(config.clone()).unwrap();
        security::trust_host(&state, "saved", "127.0.0.1", 22, "SHA256:test-key").unwrap();
        security::save_secret(&state, "host:saved", &json!({"password":"migration-test"})).unwrap();
        drop(state);
        let state = AppState::new(directory.path().into()).unwrap();
        let route = || {
            state
                .capture_binding("saved")
                .unwrap()
                .route_token()
                .unwrap()
        };
        assert_eq!(
            cached_credentials(&state, "saved", &route()).unwrap()["password"],
            "migration-test"
        );
        let mut edited = config.clone();
        edited["hosts"][0]["username"] = json!("different");
        state.save_config(edited).unwrap();
        assert!(cached_credentials(&state, "saved", &route())
            .unwrap()
            .is_null());
        state.save_config(config).unwrap();
        security::trust_host(&state, "saved", "127.0.0.1", 22, "SHA256:different").unwrap();
        bind_legacy_credentials(&state).unwrap();
        assert!(cached_credentials(&state, "saved", &route())
            .unwrap()
            .is_null());
    }

    fn challenge(result: Result<Session, ConnectError>) -> Value {
        match result {
            Err(ConnectError::Verification(value)) => value,
            Err(error) => panic!("Expected host verification, got {}", error.message()),
            Ok(_) => panic!("Unapproved host key was accepted"),
        }
    }

    fn echo_through(port: u16) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.write_all(b"nexssh-forwarding-test").unwrap();
        let mut response = [0; 22];
        stream.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"nexssh-forwarding-test");
    }

    #[test]
    #[ignore = "Requires explicitly approved real SSH host configuration"]
    fn approved_real_host_file_key_shell() {
        let path = std::env::var("NEXSSH_REAL_HOST_TEST_CONFIG")
            .expect("Set NEXSSH_REAL_HOST_TEST_CONFIG to the approved host JSON");
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let directory =
            std::env::temp_dir().join(format!("nexssh-approved-host-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(directory.clone()).unwrap();
        let mut host = fixture.clone();
        host["id"] = json!("approved-real-host");
        host["name"] = json!("Approved host test");
        host["authMethod"] = json!("key");
        host["keySource"] = json!("file");
        host["hostKeyAlgorithm"] = json!("ssh-ed25519");
        state.save_config(json!({"hosts":[host]})).unwrap();
        let identity = security::dispatch(
            &state,
            "identity_inspect",
            json!({"path":fixture["identityFile"]}),
        )
        .unwrap();
        assert_eq!(identity["algorithm"], "ssh-ed25519");
        assert_eq!(identity["encrypted"], false);
        let pending = challenge(open_session(&state, "approved-real-host"));
        assert_eq!(
            pending["fingerprint"], fixture["approvedFingerprint"],
            "Server identity differs from the user-approved fingerprint"
        );
        let session = open(
            &state,
            "approved-real-host",
            fixture["approvedFingerprint"].as_str(),
            Some("approved-real-host"),
            &mut Vec::new(),
        )
        .unwrap();
        assert!(session.authenticated());
        let bound = state.capture_binding("approved-real-host").unwrap();
        assert!(state.open_bound_session(&bound).unwrap().authenticated());
        let mut terminal = session.channel_session().unwrap();
        terminal
            .request_pty("xterm-256color", None, Some((100, 30, 0, 0)))
            .unwrap();
        terminal.shell().unwrap();
        let mut output = String::new();
        let mut buffer = [0; 4096];
        let count = terminal.read(&mut buffer).unwrap();
        output.push_str(&String::from_utf8_lossy(&buffer[..count]));
        terminal.write_all(b"whoami\r").unwrap();
        while !output.split(['\r', '\n']).any(|line| line.trim() == "core") {
            let count = terminal.read(&mut buffer).unwrap_or_else(|error| {
                panic!(
                    "Shell read failed: {error}. Terminal output: {}",
                    output.escape_debug()
                )
            });
            assert!(count > 0, "Shell ended before whoami returned core");
            output.push_str(&String::from_utf8_lossy(&buffer[..count]));
            assert!(
                output.len() < 1024 * 1024,
                "Unexpectedly large shell output"
            );
        }
        terminal.write_all(b"exit\r").unwrap();
        terminal.read_to_end(&mut Vec::new()).unwrap();
        terminal.wait_close().unwrap();
        println!(
            "Approved real host: OpenSSH file key authentication, PTY shell and whoami=core passed"
        );
        drop(terminal);
        drop(session);
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "Requires loopback SSH fixture configured by NEXSSH_TEST_CONNECTION"]
    fn live_encrypted_file_identity_and_probe() {
        let path = std::env::var("NEXSSH_TEST_CONNECTION").unwrap();
        let fixture: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(fixture["hostname"], "127.0.0.1");
        let directory =
            std::env::temp_dir().join(format!("nexssh-file-key-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(directory.clone()).unwrap();
        let mut host = fixture.clone();
        host["id"] = json!("file-key");
        host["authMethod"] = json!("key");
        host["keySource"] = json!("file");
        host["keyId"] = json!("stale-stored-key-must-be-ignored");
        state.save_config(json!({"hosts":[host]})).unwrap();
        assert!(!state
            .config()
            .unwrap()
            .to_string()
            .contains(fixture["passphrase"].as_str().unwrap()));
        let inspection = security::dispatch(
            &state,
            "identity_inspect",
            json!({"path":fixture["identityFile"]}),
        )
        .unwrap();
        assert_eq!(
            inspection,
            json!({"encrypted":true,"algorithm":"ssh-ed25519"})
        );
        assert!(challenge(open_configured(
            &state,
            "file-key",
            None,
            None,
            &mut Vec::new(),
            true
        ))["verificationRequired"]
            .as_bool()
            .unwrap());
        let verified = open_configured(
            &state,
            "file-key",
            fixture["fingerprint"].as_str(),
            Some("file-key"),
            &mut Vec::new(),
            true,
        )
        .unwrap();
        assert!(!verified.authenticated());
        drop(verified);
        let missing = match open_session(&state, "file-key") {
            Err(error) => error.message(),
            Ok(_) => panic!("Encrypted key accepted without a passphrase"),
        };
        assert!(missing.contains("passphrase"));
        crate::ssh::seed_test_credential(
            &state,
            "file-key",
            json!({"passphrase":"wrong-passphrase","password":fixture["password"]}),
        );
        let rejected = match open_session(&state, "file-key") {
            Err(error) => error.message(),
            Ok(_) => panic!("Private key authentication silently fell back to a valid password"),
        };
        assert!(rejected.contains("Passphrase is incorrect"));
        crate::ssh::seed_test_credential(
            &state,
            "file-key",
            json!({"passphrase":fixture["passphrase"]}),
        );
        assert!(open_session(&state, "file-key").unwrap().authenticated());
        let missing_path = directory.join("missing-key");
        assert!(
            security::dispatch(&state, "identity_inspect", json!({"path":missing_path}))
                .unwrap_err()
                .contains("Unable to read")
        );
        let unsupported_path = directory.join("unsupported-key");
        std::fs::write(&unsupported_path, b"PuTTY-User-Key-File-2: ssh-rsa\n").unwrap();
        assert!(
            security::dispatch(&state, "identity_inspect", json!({"path":unsupported_path}))
                .unwrap_err()
                .contains("Unsupported private key format")
        );
        let imported=security::dispatch(&state,"keys_import",json!({"name":"Stored inspection test","path":fixture["identityFile"],"passphrase":fixture["passphrase"]})).unwrap();
        assert_eq!(
            security::dispatch(&state, "identity_inspect", json!({"keyId":imported["id"]}))
                .unwrap(),
            json!({"encrypted":true,"algorithm":"ssh-ed25519"})
        );
        let unauthorized =
            ssh_key::PrivateKey::random(&mut rand::rngs::OsRng, ssh_key::Algorithm::Ed25519)
                .unwrap();
        let unauthorized_path = directory.join("unauthorized-key");
        std::fs::write(
            &unauthorized_path,
            unauthorized
                .to_openssh(ssh_key::LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        let mut config = state.config().unwrap();
        config["hosts"][0]["identityFile"] = json!(unauthorized_path);
        state.save_config(config.clone()).unwrap();
        crate::ssh::seed_test_credential(
            &state,
            "file-key",
            json!({"password":fixture["password"]}),
        );
        let rejected = match open_session(&state, "file-key") {
            Err(error) => error.message(),
            Ok(_) => panic!("Unauthorized private key silently fell back to password"),
        };
        assert!(rejected.contains("Server rejected this SSH key"));
        let invalid_utf8 = directory.join("invalid-utf8-key");
        std::fs::write(&invalid_utf8, [0xff, 0xfe, 0xfd]).unwrap();
        config["hosts"][0]["identityFile"] = json!(invalid_utf8);
        state.save_config(config).unwrap();
        let invalid = match open_session(&state, "file-key") {
            Err(error) => error.message(),
            Ok(_) => panic!("Invalid key file was accepted"),
        };
        assert!(invalid.contains("Unsupported private key format"));
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "Requires loopback SSH fixture configured by NEXSSH_TEST_CONNECTION"]
    fn live_auth_tunnels_and_backup() {
        let fixture_path = std::env::var("NEXSSH_TEST_CONNECTION")
            .expect("Set NEXSSH_TEST_CONNECTION to the fixture JSON path");
        let fixture: Value =
            serde_json::from_slice(&std::fs::read(&fixture_path).unwrap()).unwrap();
        assert_eq!(
            fixture["hostname"], "127.0.0.1",
            "Integration tests require an isolated loopback fixture"
        );
        let directory = std::env::temp_dir().join(format!("nexssh-live-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(directory.clone()).unwrap();
        let mut host = fixture.clone();
        host["id"] = json!("password-host");
        host["name"] = json!("Loopback password test");
        host["authMethod"] = json!("password");
        host["timeout"] = json!(5);
        let mut key_host = host.clone();
        key_host["id"] = json!("key-host");
        key_host["authMethod"] = json!("key");
        let mut jump_target = host.clone();
        jump_target["id"] = json!("jump-target");
        jump_target["jumpHostId"] = json!("password-host");
        state
            .save_config(json!({"hosts":[host,key_host,jump_target]}))
            .unwrap();
        let unknown = challenge(open_session(&state, "password-host"));
        assert_eq!(unknown["changed"], false);
        assert_eq!(unknown["fingerprint"], fixture["fingerprint"]);
        assert!(matches!(
            open(
                &state,
                "password-host",
                Some("SHA256:incorrect"),
                Some("password-host"),
                &mut Vec::new()
            ),
            Err(ConnectError::Message(_))
        ));
        let fingerprint = fixture["fingerprint"].as_str().unwrap();
        open_configured(
            &state,
            "password-host",
            Some(fingerprint),
            Some("password-host"),
            &mut Vec::new(),
            true,
        )
        .unwrap();
        crate::ssh::seed_test_credential(
            &state,
            "password-host",
            json!({"password":fixture["password"]}),
        );
        let session = open(
            &state,
            "password-host",
            Some(fingerprint),
            Some("password-host"),
            &mut Vec::new(),
        )
        .unwrap();
        assert!(session.authenticated());
        let mut terminal = session.channel_session().unwrap();
        terminal
            .request_pty("xterm-256color", None, Some((80, 24, 0, 0)))
            .unwrap();
        terminal.shell().unwrap();
        let mut initial = [0; 4096];
        assert!(terminal.read(&mut initial).unwrap() > 0);
        terminal.request_pty_size(100, 40, None, None).unwrap();
        terminal.write_all(b"echo-live-test\n").unwrap();
        let mut output = String::new();
        while !output.contains("received: echo-live-test") {
            let count = terminal.read(&mut initial).unwrap();
            assert!(count > 0);
            output.push_str(&String::from_utf8_lossy(&initial[..count]));
        }
        terminal.write_all(b"exit\n").unwrap();
        terminal.read_to_end(&mut Vec::new()).unwrap();
        terminal.wait_close().unwrap();
        drop(terminal);
        drop(session);
        assert!(open_session(&state, "password-host")
            .unwrap()
            .authenticated());

        let metadata = security::dispatch(&state,"keys_import",json!({"name":"Encrypted fixture identity","path":fixture["identityFile"],"passphrase":fixture["passphrase"]})).unwrap();
        assert_eq!(metadata["passphraseRequired"], true);
        let mut config = state.config().unwrap();
        config["hosts"][1]["keyId"] = metadata["id"].clone();
        state.save_config(config.clone()).unwrap();
        assert!(
            challenge(open_session(&state, "key-host"))["verificationRequired"]
                .as_bool()
                .unwrap()
        );
        open_configured(
            &state,
            "key-host",
            Some(fingerprint),
            Some("key-host"),
            &mut Vec::new(),
            true,
        )
        .unwrap();
        crate::ssh::seed_test_credential(
            &state,
            "key-host",
            json!({"passphrase":fixture["passphrase"]}),
        );
        assert!(open(
            &state,
            "key-host",
            Some(fingerprint),
            Some("key-host"),
            &mut Vec::new()
        )
        .unwrap()
        .authenticated());
        crate::ssh::seed_test_credential(
            &state,
            "key-host",
            json!({"passphrase":"deliberately-wrong-test-passphrase"}),
        );
        assert!(open_session(&state, "key-host").is_err());
        crate::ssh::seed_test_credential(
            &state,
            "key-host",
            json!({"passphrase":fixture["passphrase"]}),
        );

        let authorized_path = std::path::Path::new(&fixture_path)
            .parent()
            .unwrap()
            .join("authorized.pub");
        let previous_authorized = std::fs::read(&authorized_path).ok();
        for algorithm in ["ed25519", "rsa"] {
            let generated = security::dispatch(&state,"keys_generate",json!({"name":format!("Generated {algorithm} test"),"type":algorithm,"passphrase":"generated-key-test-passphrase"})).unwrap();
            assert!(generated["fingerprint"]
                .as_str()
                .unwrap()
                .starts_with("SHA256:"));
            let public_path = directory.join(format!("{algorithm}.pub"));
            security::dispatch(
                &state,
                "keys_export",
                json!({"id":generated["id"],"path":public_path}),
            )
            .unwrap();
            let public = std::fs::read(&public_path).unwrap();
            assert!(!String::from_utf8_lossy(&public).contains("PRIVATE KEY"));
            std::fs::write(&authorized_path, public).unwrap();
            config["hosts"][1]["keyId"] = generated["id"].clone();
            state.save_config(config.clone()).unwrap();
            crate::ssh::seed_test_credential(
                &state,
                "key-host",
                json!({"passphrase":"generated-key-test-passphrase"}),
            );
            assert!(open_session(&state, "key-host").unwrap().authenticated());
            config["hosts"][1]["keyId"] = metadata["id"].clone();
            state.save_config(config.clone()).unwrap();
            security::dispatch(&state, "keys_delete", json!({"id":generated["id"]})).unwrap();
        }
        if let Some(public) = previous_authorized {
            std::fs::write(&authorized_path, public).unwrap();
        } else {
            std::fs::remove_file(&authorized_path).unwrap();
        }
        crate::ssh::seed_test_credential(
            &state,
            "key-host",
            json!({"passphrase":fixture["passphrase"]}),
        );

        let jump_challenge = challenge(open_session(&state, "jump-target"));
        assert_eq!(jump_challenge["hostId"], "jump-target");
        open_configured(
            &state,
            "jump-target",
            Some(fingerprint),
            Some("jump-target"),
            &mut Vec::new(),
            true,
        )
        .unwrap();
        crate::ssh::seed_test_credential(
            &state,
            "jump-target",
            json!({"password":fixture["password"]}),
        );
        assert!(open(
            &state,
            "jump-target",
            Some(fingerprint),
            Some("jump-target"),
            &mut Vec::new()
        )
        .unwrap()
        .authenticated());
        security::trust_host(
            &state,
            "password-host",
            "127.0.0.1",
            fixture["port"].as_u64().unwrap() as u16,
            "SHA256:previous-key",
        )
        .unwrap();
        let changed = challenge(open_session(&state, "password-host"));
        assert_eq!(changed["changed"], true);
        assert_eq!(changed["previousFingerprint"], "SHA256:previous-key");
        assert_eq!(changed["fingerprint"], fingerprint);
        assert!(open(
            &state,
            "password-host",
            Some("SHA256:previous-key"),
            Some("password-host"),
            &mut Vec::new()
        )
        .is_err());
        assert!(open(
            &state,
            "password-host",
            Some(fingerprint),
            Some("password-host"),
            &mut Vec::new()
        )
        .unwrap()
        .authenticated());

        security::save_secret(
            &state,
            "host:password-host",
            &json!({"password":fixture["password"]}),
        )
        .unwrap();
        let backup_path = directory.join("encrypted-backup.json");
        security::dispatch(
            &state,
            "backup_export",
            json!({"path":backup_path,"password":"integration-backup-passphrase"}),
        )
        .unwrap();
        let encrypted = std::fs::read_to_string(&backup_path).unwrap();
        assert!(!encrypted.contains("Loopback password test"));
        assert!(!encrypted.contains(fixture["password"].as_str().unwrap()));
        assert!(security::dispatch(
            &state,
            "backup_import",
            json!({"path":backup_path,"password":"wrong-password"})
        )
        .is_err());
        let restored = security::dispatch(
            &state,
            "backup_import",
            json!({"path":backup_path,"password":"integration-backup-passphrase"}),
        )
        .unwrap();
        assert_eq!(restored, config);

        let (sender, _receiver) = mpsc::channel();
        state.inner.sessions.lock().unwrap().insert(
            "integration-session".into(),
            TerminalSession {
                host_id: "password-host".into(),
                sender,
                binding: state.capture_binding("password-host").unwrap(),
            },
        );
        let local = tunnels::dispatch(&state,"tunnels_start",json!({"sessionId":"integration-session","type":"local","bindHost":"127.0.0.1","bindPort":18993,"targetHost":"127.0.0.1","targetPort":fixture["echoPort"]})).unwrap();
        echo_through(18993);
        assert!(tunnels::dispatch(&state,"tunnels_start",json!({"sessionId":"integration-session","type":"local","bindHost":"127.0.0.1","bindPort":18993,"targetHost":"127.0.0.1","targetPort":fixture["echoPort"]})).is_err());
        let updated = tunnels::dispatch(
            &state,
            "tunnels_update",
            json!({"id":local["id"],"targetPort":fixture["echoPort"]}),
        )
        .unwrap();
        echo_through(18993);
        assert!(tunnels::dispatch(
            &state,
            "tunnels_update",
            json!({"id":updated["id"],"targetPort":0})
        )
        .is_err());
        echo_through(18993);
        let records = tunnels::dispatch(&state, "tunnels_list", json!({})).unwrap();
        for record in records.as_array().unwrap() {
            tunnels::dispatch(&state, "tunnels_stop", json!({"id":record["id"]})).unwrap();
        }
        assert!(TcpStream::connect(("127.0.0.1", 18993)).is_err());

        let remote=tunnels::dispatch(&state,"tunnels_start",json!({"sessionId":"integration-session","type":"remote","bindHost":"127.0.0.1","bindPort":18994,"targetHost":"127.0.0.1","targetPort":fixture["echoPort"]})).unwrap();
        echo_through(18994);
        tunnels::dispatch(&state, "tunnels_stop", json!({"id":remote["id"]})).unwrap();
        let dynamic=tunnels::dispatch(&state,"tunnels_start",json!({"sessionId":"integration-session","type":"dynamic","bindHost":"127.0.0.1","bindPort":18995})).unwrap();
        let mut socks = TcpStream::connect(("127.0.0.1", 18995)).unwrap();
        socks
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        socks.write_all(&[5, 1, 0]).unwrap();
        let mut greeting = [0; 2];
        socks.read_exact(&mut greeting).unwrap();
        assert_eq!(greeting, [5, 0]);
        let echo_port = (fixture["echoPort"].as_u64().unwrap() as u16).to_be_bytes();
        socks
            .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, echo_port[0], echo_port[1]])
            .unwrap();
        let mut accepted = [0; 10];
        socks.read_exact(&mut accepted).unwrap();
        assert_eq!(accepted[1], 0);
        socks.write_all(b"socks-test").unwrap();
        let mut response = [0; 10];
        socks.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"socks-test");
        drop(socks);
        tunnels::dispatch(&state, "tunnels_stop", json!({"id":dynamic["id"]})).unwrap();
        state.shutdown();
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
