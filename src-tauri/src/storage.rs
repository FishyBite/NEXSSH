use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc, Mutex,
    },
};

pub enum TerminalCommand {
    Attach,
    Write(Vec<u8>),
    Resize(u32, u32),
    Close,
}
pub struct TerminalSession {
    pub host_id: String,
    pub sender: Sender<TerminalCommand>,
    pub binding: SessionBinding,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub host_id: String,
    pub route: Vec<Value>,
}
impl SessionBinding {
    pub fn route_token(&self) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        let encoded = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        Ok(format!("{:x}", Sha256::digest(encoded)))
    }
}
pub struct Tunnel {
    pub details: Value,
    pub stop: Arc<AtomicBool>,
    pub finished: Arc<AtomicBool>,
}
#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Inner>,
}
pub struct Inner {
    pub checksums: crate::file_checksum::Jobs,
    pub databases: crate::database::Sessions,
    pub log_reader: Mutex<Option<crate::log_tail::LogReader>>,
    pub directory: PathBuf,
    pub config_lock: Mutex<()>,
    pub sessions: Mutex<HashMap<String, TerminalSession>>,
    pub ssh_attempts: Mutex<HashMap<String, Arc<crate::ssh_attempt::Attempt>>>,
    pub credentials: Mutex<HashMap<String, Value>>,
    pub tunnels: Mutex<HashMap<String, Tunnel>>,
}

impl AppState {
    pub fn new(directory: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let state = Self {
            inner: Arc::new(Inner {
                checksums: Default::default(),
                databases: crate::database::Sessions::default(),
                log_reader: Mutex::new(None),
                directory,
                config_lock: Mutex::new(()),
                sessions: Mutex::new(HashMap::new()),
                ssh_attempts: Mutex::new(HashMap::new()),
                credentials: Mutex::new(HashMap::new()),
                tunnels: Mutex::new(HashMap::new()),
            }),
        };
        state.db()?.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS known_hosts (host_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, port INTEGER NOT NULL, fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS keys (id TEXT PRIMARY KEY, metadata TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL);")
            .map_err(|e| e.to_string())?;
        crate::ssh::bind_legacy_credentials(&state)?;
        Ok(state)
    }
    pub fn data_dir(&self) -> PathBuf {
        self.inner.directory.clone()
    }
    pub fn db(&self) -> Result<Connection, String> {
        let db = Connection::open(self.inner.directory.join("nexssh.sqlite3"))
            .map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?;
        Ok(db)
    }
    pub fn config(&self) -> Result<Value, String> {
        let db = self.db()?;
        let value = db.query_row("SELECT data FROM configuration WHERE id=1", [], |row| {
            row.get::<_, String>(0)
        });
        match value {
            Ok(value) => serde_json::from_str(&value).map_err(|e| e.to_string()),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(default_config()),
            Err(error) => Err(error.to_string()),
        }
    }
    pub fn save_config(&self, mut value: Value) -> Result<(), String> {
        if !value.is_object() || !value["hosts"].is_array() {
            return Err("Configuration must contain a hosts array".into());
        }
        validate_config(&mut value)?;
        strip_secrets(&mut value);
        let _guard = self.inner.config_lock.lock().map_err(|e| e.to_string())?;
        self.db()?.execute("INSERT INTO configuration(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [value.to_string()]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn host(&self, id: &str) -> Result<Value, String> {
        self.config()?["hosts"]
            .as_array()
            .and_then(|hosts| hosts.iter().find(|host| host["id"].as_str() == Some(id)))
            .cloned()
            .ok_or_else(|| "Host profile no longer exists".into())
    }
    pub fn session_host(&self, id: &str) -> Result<String, String> {
        Ok(self.session_binding(id)?.host_id)
    }
    pub fn session_binding(&self, id: &str) -> Result<SessionBinding, String> {
        let binding = self
            .inner
            .sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .map(|session| session.binding.clone())
            .ok_or_else(|| "SSH session is disconnected".to_string())?;
        let _guard = self.inner.config_lock.lock().map_err(|e| e.to_string())?;
        self.check_binding(&binding)?;
        Ok(binding)
    }
    pub fn capture_binding(&self, host_id: &str) -> Result<SessionBinding, String> {
        let config = self.config()?;
        let hosts = config["hosts"]
            .as_array()
            .ok_or("Host configuration is unavailable")?;
        let mut route = Vec::new();
        let mut current = host_id.to_string();
        let mut visited = std::collections::HashSet::new();
        loop {
            if route.len() >= 8 || !visited.insert(current.clone()) {
                return Err(
                    "Invalid or circular jump-host route. Reconnect after correcting the profile."
                        .into(),
                );
            }
            let host = hosts
                .iter()
                .find(|host| host["id"].as_str() == Some(&current))
                .ok_or("The session host profile changed. Reconnect before using remote files.")?;
            let hostname = host["hostname"].as_str().ok_or("Host address is missing")?;
            let port = host["port"].as_u64().unwrap_or(22);
            if port == 0 || port > 65535 {
                return Err("Invalid host port".into());
            }
            let fingerprint = crate::security::known_fingerprint(self, &current, hostname, port as u16)?.ok_or("The session host identity changed or was forgotten. Reconnect and verify the server.")?;
            let jump = host["jumpHostId"]
                .as_str()
                .filter(|value| !value.is_empty())
                .or_else(|| host["proxyJump"].as_str().filter(|value| !value.is_empty()));
            route.push(json!({"id":current,"hostname":hostname,"port":port,"username":host["username"],"jumpHostId":jump,"authMethod":host["authMethod"],"keySource":host["keySource"],"keyId":host["keyId"],"identityFile":host["identityFile"],"hostKeyAlgorithm":host["hostKeyAlgorithm"],"fingerprint":fingerprint}));
            match jump {
                Some(id) => current = id.to_string(),
                None => break,
            }
        }
        Ok(SessionBinding {
            host_id: host_id.to_string(),
            route,
        })
    }
    fn check_binding(&self, binding: &SessionBinding) -> Result<(), String> {
        if self.capture_binding(&binding.host_id)? != *binding {
            return Err("This session's host profile, jump route, or fingerprint has changed. Reconnect before using remote files or starting a new transfer.".into());
        }
        Ok(())
    }
    pub fn open_bound_session(&self, binding: &SessionBinding) -> Result<ssh2::Session, String> {
        // Profile and trust changes share this lock until SSH authenticates, so the validated route cannot change during a new connection.
        let _guard = self.inner.config_lock.lock().map_err(|e| e.to_string())?;
        self.check_binding(binding)?;
        self.open_session(&binding.host_id)
    }
    pub fn open_session_for(&self, session_id: &str) -> Result<ssh2::Session, String> {
        let binding = self.session_binding(session_id)?;
        self.open_bound_session(&binding)
    }
    pub fn open_session(&self, id: &str) -> Result<ssh2::Session, String> {
        crate::ssh::open_session(self, id).map_err(|e| e.message())
    }
    pub fn open_cancellable_for(&self, session_id: &str, attempt: &crate::ssh_attempt::Attempt) -> Result<ssh2::Session, String> {
        let binding = self.session_binding(session_id)?;
        let _guard = self.inner.config_lock.lock().map_err(|e| e.to_string())?;
        self.check_binding(&binding)?;
        crate::ssh::open_cancellable_session(self, &binding.host_id, attempt).map_err(|e| e.message())
    }
    pub fn sessions_list(&self) -> Result<Value, String> {
        Ok(Value::Array(
            self.inner
                .sessions
                .lock()
                .map_err(|e| e.to_string())?
                .iter()
                .map(|(id, s)| json!({"sessionId":id,"hostId":s.host_id}))
                .collect(),
        ))
    }
    pub fn shutdown(&self) {
        self.inner.checksums.shutdown();
        if let Ok(mut attempts) = self.inner.ssh_attempts.lock() {
            for (_, attempt) in attempts.drain() {
                attempt.cancel();
            }
        }
        self.inner.databases.shutdown();
        crate::transfers::shutdown();
        if let Ok(sessions) = self.inner.sessions.lock() {
            for s in sessions.values() {
                let _ = s.sender.send(TerminalCommand::Close);
            }
        }
        if let Ok(tunnels) = self.inner.tunnels.lock() {
            for t in tunnels.values() {
                t.stop.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn validate_config(value: &mut Value) -> Result<(), String> {
    let defaults = default_config();
    for name in ["workspaces", "groups", "snippets", "terminalProfiles"] {
        if value.get(name).is_none() {
            value[name] = defaults[name].clone();
        }
        if !value[name].is_array() {
            return Err(format!("Configuration {name} must be an array"));
        }
    }
    for name in [
        "hosts",
        "workspaces",
        "groups",
        "snippets",
        "terminalProfiles",
    ] {
        let mut ids = std::collections::HashSet::new();
        for item in value[name].as_array().ok_or("Invalid configuration list")? {
            let id = item["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("Every {name} entry needs an id"))?;
            if !ids.insert(id) {
                return Err(format!("Duplicate id in {name}"));
            }
            for field in [
                "name",
                "hostname",
                "username",
                "command",
                "category",
                "workspaceId",
                "groupId",
                "keyId",
                "notes",
                "color",
                "lastConnected",
            ] {
                if item
                    .get(field)
                    .is_some_and(|v| !v.is_string() && !v.is_null())
                {
                    return Err(format!("{name}.{field} must be text"));
                }
            }
            if item.get("tags").is_some_and(|v| {
                !v.as_array()
                    .is_some_and(|tags| tags.iter().all(Value::is_string))
            }) {
                return Err("Host tags must be text values".into());
            }
            if item.get("environment").is_some_and(|v| {
                !v.as_object()
                    .is_some_and(|env| env.values().all(Value::is_string))
            }) {
                return Err("Environment must map names to text values".into());
            }
        }
    }
    if value.get("settings").is_none() {
        value["settings"] = defaults["settings"].clone();
    }
    let settings = value["settings"]
        .as_object_mut()
        .ok_or("Settings must be an object")?;
    for (key, default) in defaults["settings"].as_object().ok_or("Invalid defaults")? {
        match settings.get(key) {
            None => {
                settings.insert(key.clone(), default.clone());
            }
            Some(value)
                if (default.is_string() && !value.is_string())
                    || (default.is_boolean() && !value.is_boolean())
                    || (default.is_number() && !value.is_number()) =>
            {
                return Err(format!("Invalid setting {key}"))
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn strip_secrets(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.retain(|key, _| {
                !matches!(
                    key.to_ascii_lowercase().as_str(),
                    "password"
                        | "passphrase"
                        | "privatekey"
                        | "private_key"
                        | "secret"
                        | "credentials"
                )
            });
            for value in object.values_mut() {
                strip_secrets(value);
            }
        }
        Value::Array(array) => {
            for value in array {
                strip_secrets(value);
            }
        }
        _ => {}
    }
}
fn default_config() -> Value {
    json!({"hosts":[],"workspaces":[{"id":"personal","name":"Personal"}],"groups":[],"snippets":[],"terminalProfiles":[],"settings":{"theme":"dark","fontFamily":"Cascadia Code, Consolas, monospace","fontSize":14,"cursorStyle":"block","copyOnSelect":true,"timeout":15,"keepalive":30,"defaultPort":22,"downloadDirectory":"","transferConcurrency":2,"sidebarCollapsed":false,"reconnectAttempts":0,"reconnectDelay":5}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_removed_recursively() {
        let mut config = json!({"hosts":[{"id":"1","password":"do-not-persist","nested":{"privateKey":"secret","keyId":"safe"}}],"passphrase":"secret"});
        strip_secrets(&mut config);
        assert_eq!(
            config,
            json!({"hosts":[{"id":"1","nested":{"keyId":"safe"}}]})
        );
    }
    #[test]
    fn configuration_survives_reopening_database() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = AppState::new(directory.clone()).unwrap();
        state
            .save_config(json!({"hosts":[{"id":"h1","hostname":"localhost","password":"secret"}]}))
            .unwrap();
        let reloaded = AppState::new(directory.clone()).unwrap().config().unwrap();
        assert_eq!(reloaded["hosts"][0]["hostname"], "localhost");
        assert!(reloaded["hosts"][0].get("password").is_none());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn malformed_import_does_not_replace_saved_configuration() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = AppState::new(directory.clone()).unwrap();
        state
            .save_config(json!({"hosts": [{"id":"server", "hostname":"localhost"}]}))
            .unwrap();
        assert!(state
            .save_config(json!({"hosts": [], "settings": "invalid"}))
            .is_err());
        assert_eq!(state.config().unwrap()["hosts"][0]["id"], "server");
        assert!(state
            .save_config(json!({"hosts": [{"id":"duplicate"},{"id":"duplicate"}]}))
            .is_err());
        assert!(state
            .save_config(json!({"hosts": [{"id":"server", "tags":"invalid"}]}))
            .is_err());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn persisted_session_binding_rejects_profile_and_jump_redirection_before_connecting() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = AppState::new(directory.clone()).unwrap();
        let mut config = json!({"hosts":[{"id":"target","hostname":"127.0.0.1","port":22001,"username":"core","jumpHostId":"jump"},{"id":"jump","hostname":"127.0.0.1","port":22002,"username":"bastion"}]});
        state.save_config(config.clone()).unwrap();
        crate::security::trust_host(
            &state,
            "target",
            "127.0.0.1",
            22001,
            "SHA256:target-original",
        )
        .unwrap();
        crate::security::trust_host(&state, "jump", "127.0.0.1", 22002, "SHA256:jump-original")
            .unwrap();
        let original = state.capture_binding("target").unwrap();
        let serialized = serde_json::to_string(&original).unwrap();
        let restored: SessionBinding = serde_json::from_str(&serialized).unwrap();
        let token = original.route_token().unwrap();
        assert_eq!(token.len(), 64);
        assert_eq!(token, restored.route_token().unwrap());
        crate::security::trust_host(&state, "jump", "127.0.0.1", 22002, "SHA256:jump-rotated")
            .unwrap();
        assert_ne!(token, state.capture_binding("target").unwrap().route_token().unwrap());
        crate::security::trust_host(&state, "jump", "127.0.0.1", 22002, "SHA256:jump-original")
            .unwrap();
        config["hosts"][0]["name"] = json!("Renamed display label");
        state.save_config(config.clone()).unwrap();
        assert_eq!(original, state.capture_binding("target").unwrap());
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let redirected_port = listener.local_addr().unwrap().port();
        config["hosts"][0]["port"] = json!(redirected_port);
        state.save_config(config.clone()).unwrap();
        crate::security::trust_host(
            &state,
            "target",
            "127.0.0.1",
            redirected_port,
            "SHA256:target-new",
        )
        .unwrap();
        assert!(state
            .open_bound_session(&restored)
            .err()
            .unwrap()
            .contains("Reconnect"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        config["hosts"][0]["port"] = json!(22001);
        config["hosts"][1]["username"] = json!("different-bastion-user");
        state.save_config(config).unwrap();
        crate::security::trust_host(
            &state,
            "target",
            "127.0.0.1",
            22001,
            "SHA256:target-original",
        )
        .unwrap();
        assert!(state
            .open_bound_session(&restored)
            .err()
            .unwrap()
            .contains("Reconnect"));
        drop(state);
        let reopened = AppState::new(directory.clone()).unwrap();
        assert!(reopened.open_bound_session(&restored).is_err());
        drop(reopened);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn profile_writes_wait_until_bound_connection_setup_finishes() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = AppState::new(directory.clone()).unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut config = json!({"hosts":[{"id":"target","hostname":"127.0.0.1","port":port,"username":"core","timeout":2}]});
        state.save_config(config.clone()).unwrap();
        crate::security::trust_host(&state, "target", "127.0.0.1", port, "SHA256:original")
            .unwrap();
        let binding = state.capture_binding("target").unwrap();
        let connection_state = state.clone();
        let connection =
            std::thread::spawn(move || connection_state.open_bound_session(&binding).is_err());
        let started = std::time::Instant::now();
        let accepted = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(started.elapsed() < std::time::Duration::from_secs(3));
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => panic!("{error}"),
            }
        };
        config["hosts"][0]["username"] = json!("changed-user");
        let saved = Arc::new(AtomicBool::new(false));
        let saved_worker = saved.clone();
        let writer_state = state.clone();
        let writer = std::thread::spawn(move || {
            writer_state.save_config(config).unwrap();
            saved_worker.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(std::time::Duration::from_millis(40));
        assert!(!saved.load(Ordering::SeqCst));
        drop(accepted);
        assert!(connection.join().unwrap());
        writer.join().unwrap();
        assert!(saved.load(Ordering::SeqCst));
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
