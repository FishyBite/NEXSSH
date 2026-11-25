use crate::{required, AppState};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde_json::{json, Value};
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
use std::time::{SystemTime, UNIX_EPOCH};

fn master_key() -> Result<Vec<u8>, String> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let entry = keyring::Entry::new("NEXSSH", "vault-master-key-v1").map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(encoded) => STANDARD.decode(encoded).map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => {
            let mut key = vec![0; 32];
            rand::rngs::OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(&key))
                .map_err(|e| format!("Windows credential vault is unavailable: {e}"))?;
            Ok(key)
        }
        Err(error) => Err(format!("Windows credential vault is unavailable: {error}")),
    }
}

fn encrypt(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce = [0; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "Encryption failed")?;
    Ok([nonce.to_vec(), ciphertext].concat())
}
fn decrypt(key: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted.len() < 28 {
        return Err("Encrypted data is damaged".into());
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|e| e.to_string())?
        .decrypt(Nonce::from_slice(&encrypted[..12]), &encrypted[12..])
        .map_err(|_| "Unable to decrypt data. Check the password and backup file.".into())
}
pub fn save_secret(state: &AppState, id: &str, value: &Value) -> Result<(), String> {
    let encrypted = encrypt(&master_key()?, value.to_string().as_bytes())?;
    let db = state.db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)",
    )
    .map_err(|e| e.to_string())?;
    db.execute("INSERT INTO secrets(id,ciphertext) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext", rusqlite::params![id,encrypted]).map_err(|e| e.to_string())?;
    Ok(())
}
pub fn load_secret(state: &AppState, id: &str) -> Result<Option<Value>, String> {
    let db = state.db()?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL)",
    )
    .map_err(|e| e.to_string())?;
    let encrypted = db.query_row("SELECT ciphertext FROM secrets WHERE id=?1", [id], |row| {
        row.get::<_, Vec<u8>>(0)
    });
    match encrypted {
        Ok(data) => serde_json::from_slice(&decrypt(&master_key()?, &data)?)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
pub fn known_fingerprint(
    state: &AppState,
    host_id: &str,
    hostname: &str,
    port: u16,
) -> Result<Option<String>, String> {
    use rusqlite::OptionalExtension;
    state
        .db()?
        .query_row(
            "SELECT fingerprint FROM known_hosts WHERE host_id=?1 AND hostname=?2 AND port=?3",
            rusqlite::params![host_id, hostname, port],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}
pub fn trust_host(
    state: &AppState,
    host_id: &str,
    hostname: &str,
    port: u16,
    fingerprint: &str,
) -> Result<(), String> {
    state.db()?.execute("INSERT INTO known_hosts(host_id,hostname,port,fingerprint) VALUES(?1,?2,?3,?4) ON CONFLICT(host_id) DO UPDATE SET hostname=excluded.hostname,port=excluded.port,fingerprint=excluded.fingerprint", rusqlite::params![host_id,hostname,port,fingerprint]).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn dispatch(state: &AppState, action: &str, payload: Value) -> Result<Value, String> {
    match action {
        "identity_inspect" => {
            let bytes = if let Some(id) = payload["keyId"].as_str().filter(|id| !id.is_empty()) {
                load_secret(state, &format!("key:{id}"))?
                    .ok_or("The selected SSH key is unavailable")?["privateKey"]
                    .as_str()
                    .ok_or("Stored key is invalid")?
                    .as_bytes()
                    .to_vec()
            } else {
                read_limited(required(&payload, "path")?, 1024 * 1024)
                    .map_err(|error| format!("Unable to read private key file: {error}"))?
            };
            let key = parse_identity(&bytes)?;
            Ok(json!({"encrypted":key.is_encrypted(),"algorithm":key.algorithm().to_string()}))
        }
        "keys_list" => {
            let db = state.db()?;
            let mut query = db
                .prepare("SELECT metadata FROM keys ORDER BY rowid DESC")
                .map_err(|e| e.to_string())?;
            let values = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let mut keys = Vec::new();
            for value in values {
                keys.push(
                    serde_json::from_str::<Value>(&value.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?,
                );
            }
            Ok(Value::Array(keys))
        }
        "keys_generate" | "keys_import" => {
            let name = required(&payload, "name")?;
            let passphrase = payload["passphrase"].as_str().filter(|s| !s.is_empty());
            let mut key = if action == "keys_import" {
                let bytes = read_limited(required(&payload, "path")?, 1024 * 1024)
                    .map_err(|error| format!("Unable to read private key file: {error}"))?;
                let key = parse_identity(&bytes)?;
                if key.is_encrypted() {
                    key.decrypt(passphrase.ok_or("This private key requires a passphrase")?)
                        .map_err(|_| {
                            "Passphrase is incorrect or the encrypted private key is damaged"
                                .to_string()
                        })?
                } else {
                    key
                }
            } else {
                let algorithm = match payload["type"].as_str().unwrap_or("ed25519") {
                    "rsa" => Algorithm::Rsa { hash: None },
                    "ed25519" => Algorithm::Ed25519,
                    _ => return Err("Choose Ed25519 or RSA".into()),
                };
                PrivateKey::random(&mut rand::rngs::OsRng, algorithm).map_err(|e| e.to_string())?
            };
            key.set_comment(name);
            let public_key = key.public_key().to_openssh().map_err(|e| e.to_string())?;
            let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
            let algorithm = key.algorithm().to_string();
            if let Some(passphrase) = passphrase {
                key = key
                    .encrypt(&mut rand::rngs::OsRng, passphrase)
                    .map_err(|e| e.to_string())?;
            }
            let private_key = key.to_openssh(LineEnding::LF).map_err(|e| e.to_string())?;
            let id = uuid::Uuid::new_v4().to_string();
            let encrypted = encrypt(
                &master_key()?,
                json!({"privateKey":private_key.as_str()})
                    .to_string()
                    .as_bytes(),
            )?;
            let metadata = json!({"id":id,"name":name,"type":algorithm,"fingerprint":fingerprint,"publicKey":public_key,"passphraseRequired":passphrase.is_some(),"createdAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()});
            let mut db = state.db()?;
            let transaction = db.transaction().map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "INSERT INTO secrets(id,ciphertext) VALUES(?1,?2)",
                    rusqlite::params![format!("key:{id}"), encrypted],
                )
                .map_err(|e| e.to_string())?;
            transaction
                .execute(
                    "INSERT INTO keys(id,metadata) VALUES(?1,?2)",
                    rusqlite::params![id, metadata.to_string()],
                )
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(metadata)
        }
        "keys_export" => {
            let id = required(&payload, "id")?;
            let metadata: String = state
                .db()?
                .query_row("SELECT metadata FROM keys WHERE id=?1", [id], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            let metadata: Value = serde_json::from_str(&metadata).map_err(|e| e.to_string())?;
            write_new(
                required(&payload, "path")?,
                metadata["publicKey"]
                    .as_str()
                    .ok_or("Missing public key")?
                    .as_bytes(),
            )?;
            Ok(json!({"ok":true}))
        }
        "keys_delete" => {
            let id = required(&payload, "id")?;
            let _guard = state.inner.config_lock.lock().map_err(|e| e.to_string())?;
            if state.config()?["hosts"]
                .as_array()
                .is_some_and(|hosts| hosts.iter().any(|h| h["keyId"].as_str() == Some(id)))
            {
                return Err("Remove this key from its host profiles before deleting it".into());
            }
            let mut db = state.db()?;
            let transaction = db.transaction().map_err(|e| e.to_string())?;
            transaction
                .execute("DELETE FROM keys WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            transaction
                .execute("DELETE FROM secrets WHERE id=?1", [format!("key:{id}")])
                .map_err(|e| e.to_string())?;
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(json!({"ok":true}))
        }
        "known_hosts_list" => {
            let db = state.db()?;
            let mut query = db
                .prepare("SELECT host_id,hostname,port,fingerprint FROM known_hosts")
                .map_err(|e| e.to_string())?;
            let hosts=query.query_map([],|row|Ok(json!({"hostId":row.get::<_,String>(0)?,"hostname":row.get::<_,String>(1)?,"port":row.get::<_,u16>(2)?,"fingerprint":row.get::<_,String>(3)?}))).map_err(|e| e.to_string())?;
            Ok(Value::Array(
                hosts
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?,
            ))
        }
        "known_hosts_delete" => {
            let _guard = state.inner.config_lock.lock().map_err(|e| e.to_string())?;
            state
                .db()?
                .execute(
                    "DELETE FROM known_hosts WHERE host_id=?1",
                    [required(&payload, "hostId")?],
                )
                .map_err(|e| e.to_string())?;
            Ok(json!({"ok":true}))
        }
        "credential_delete" => {
            let id = required(&payload, "hostId")?;
            state
                .inner
                .credentials
                .lock()
                .map_err(|e| e.to_string())?
                .remove(id);
            state
                .db()?
                .execute("DELETE FROM secrets WHERE id=?1", [format!("host:{id}")])
                .map_err(|e| e.to_string())?;
            Ok(json!({"ok":true}))
        }
        "backup_export" => {
            let mut config = state.config()?;
            crate::storage::strip_secrets(&mut config);
            let envelope = json!({"format":"nexssh-config","version":1,"config":config});
            let bytes = serde_json::to_vec_pretty(&envelope).map_err(|e| e.to_string())?;
            let bytes = if let Some(password) =
                payload["password"].as_str().filter(|s| !s.is_empty())
            {
                let mut salt = [0; 16];
                rand::rngs::OsRng.fill_bytes(&mut salt);
                let mut key = [0; 32];
                argon2::Argon2::default()
                    .hash_password_into(password.as_bytes(), &salt, &mut key)
                    .map_err(|e| e.to_string())?;
                serde_json::to_vec_pretty(&json!({"format":"nexssh-encrypted","version":1,"salt":STANDARD.encode(salt),"data":STANDARD.encode(encrypt(&key,&bytes)?)})).map_err(|e|e.to_string())?
            } else {
                bytes
            };
            write_new(required(&payload, "path")?, &bytes)?;
            Ok(json!({"ok":true}))
        }
        "backup_import" => {
            let path = required(&payload, "path")?;
            let mut envelope: Value =
                serde_json::from_slice(&read_limited(path, 16 * 1024 * 1024)?)
                    .map_err(|e| e.to_string())?;
            if envelope["format"] == "nexssh-encrypted" {
                let password = required(&payload, "password")?;
                let salt = STANDARD
                    .decode(required(&envelope, "salt")?)
                    .map_err(|e| e.to_string())?;
                if salt.len() != 16 {
                    return Err("Invalid backup salt".into());
                }
                let mut key = [0; 32];
                argon2::Argon2::default()
                    .hash_password_into(password.as_bytes(), &salt, &mut key)
                    .map_err(|e| e.to_string())?;
                let data = STANDARD
                    .decode(required(&envelope, "data")?)
                    .map_err(|e| e.to_string())?;
                envelope =
                    serde_json::from_slice(&decrypt(&key, &data)?).map_err(|e| e.to_string())?;
            }
            if envelope["format"] != "nexssh-config" || envelope["version"] != 1 {
                return Err("Unsupported NEXSSH backup format".into());
            }
            state.save_config(envelope["config"].clone())?;
            state.config()
        }
        "snippets_export" => {
            let config = state.config()?;
            let bytes = serde_json::to_vec_pretty(
                &json!({"format":"nexssh-snippets","version":1,"snippets":config["snippets"]}),
            )
            .map_err(|e| e.to_string())?;
            write_new(required(&payload, "path")?, &bytes)?;
            Ok(json!({"ok":true}))
        }
        "snippets_import" => {
            let path = required(&payload, "path")?;
            let file: Value = serde_json::from_slice(&read_limited(path, 16 * 1024 * 1024)?)
                .map_err(|e| e.to_string())?;
            if file["format"] != "nexssh-snippets" || file["version"] != 1 {
                return Err("Unsupported snippet file format".into());
            }
            let imported = file["snippets"].as_array().ok_or("Missing snippets")?;
            let mut config = state.config()?;
            let snippets = config["snippets"]
                .as_array_mut()
                .ok_or("Invalid snippet configuration")?;
            for snippet in imported {
                if !snippet.is_object() || snippet["command"].as_str().is_none() {
                    return Err("Every snippet must have a command".into());
                }
                let mut snippet = snippet.clone();
                snippet["id"] = json!(uuid::Uuid::new_v4().to_string());
                snippets.push(snippet);
            }
            state.save_config(config.clone())?;
            Ok(config)
        }
        _ => Err(format!("Unknown security action: {action}")),
    }
}
pub(crate) fn read_limited(path: &str, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("File exceeds the maximum size of {limit} bytes"));
    }
    Ok(bytes)
}
pub(crate) fn parse_identity(bytes: &[u8]) -> Result<PrivateKey, String> {
    if bytes.starts_with(&[0xff, 0xfe])
        || bytes.starts_with(&[0xfe, 0xff])
        || bytes.starts_with(&[0, 0, 0xfe, 0xff])
    {
        return Err("Unsupported private key format: this file is encoded as UTF-16 or UTF-32. Select the original UTF-8 OpenSSH private key or export it again in OpenSSH format.".into());
    }
    if bytes.contains(&0) {
        return Err("Unsupported private key format: this file contains NUL bytes. Select the original UTF-8 OpenSSH private key. A UTF-16 or binary copy cannot be used.".into());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Unsupported private key format: this file is not UTF-8 text. Select an OpenSSH Ed25519 or RSA private key.".to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    if text.starts_with("PuTTY-User-Key-File-") {
        return Err("Unsupported private key format: this is a PuTTY PPK key. In PuTTYgen, export an OpenSSH private key and select the exported file.".into());
    }
    if text.starts_with("ssh-ed25519 ")
        || text.starts_with("ssh-rsa ")
        || text.starts_with("ecdsa-sha2-")
        || text.starts_with("-----BEGIN PUBLIC KEY-----")
        || text.starts_with("---- BEGIN SSH2 PUBLIC KEY ----")
    {
        return Err("Unsupported private key format: this is a public key. Select its matching OpenSSH private key.".into());
    }
    if text.starts_with("-----BEGIN ") && !text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Err("Unsupported private key format: this PEM key must be exported or converted to OpenSSH private key format before importing.".into());
    }
    if !text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return Err("Unsupported private key format. Select a UTF-8 OpenSSH Ed25519 or RSA private key containing BEGIN OPENSSH PRIVATE KEY.".into());
    }
    let key = PrivateKey::from_openssh(text.as_bytes()).map_err(|_| "The OpenSSH private key is incomplete or damaged. Select the original file or export it again.".to_string())?;
    if !matches!(key.algorithm(), Algorithm::Ed25519 | Algorithm::Rsa { .. }) {
        return Err(
            "Unsupported key algorithm. Select an OpenSSH Ed25519 or RSA private key.".into(),
        );
    }
    Ok(key)
}
fn write_new(path: &str, data: &[u8]) -> Result<(), String> {
    use std::{io::Write, path::Path};
    let target = Path::new(path);
    let parent = target.parent().filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    staged.write_all(data).and_then(|_| staged.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    staged.persist_noclobber(target)
        .map_err(|e| format!("Choose a new output filename: {}", e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_export_preserves_existing_file_and_removes_staging_files() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("identity.pub");
        let path = target.to_str().unwrap();
        write_new(path, b"first key").unwrap();
        assert!(write_new(path, b"second key").is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"first key");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
    #[test]
    fn authenticated_encryption_rejects_tampering() {
        let key = [7; 32];
        let encrypted = encrypt(&key, b"private material").unwrap();
        assert_eq!(decrypt(&key, &encrypted).unwrap(), b"private material");
        let mut modified = encrypted.clone();
        modified[15] ^= 1;
        assert!(decrypt(&key, &modified).is_err());
        assert!(decrypt(&[8; 32], &encrypted).is_err());
    }
    #[test]
    fn private_key_encoding_errors_are_actionable_and_do_not_echo_content() {
        let utf16: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain(
                "-----BEGIN OPENSSH PRIVATE KEY-----"
                    .encode_utf16()
                    .flat_map(u16::to_le_bytes),
            )
            .collect();
        let cases: Vec<(&[u8], &str)> = vec![
            (&utf16, "UTF-16"),
            (
                b"-----BEGIN OPENSSH PRIVATE KEY-----\0never-echo-this",
                "NUL bytes",
            ),
            (&[0x80, 0x81, 0x82], "not UTF-8"),
            (
                b"PuTTY-User-Key-File-3: ssh-ed25519\nnever-echo-this",
                "PuTTY PPK",
            ),
            (b"ssh-ed25519 AAAAnever-echo-this", "public key"),
            (
                b"-----BEGIN RSA PRIVATE KEY-----\nnever-echo-this",
                "PEM key",
            ),
            (
                b"-----BEGIN OPENSSH PRIVATE KEY-----\nnever-echo-this",
                "incomplete or damaged",
            ),
        ];
        for (bytes, expected) in cases {
            let error = parse_identity(bytes).unwrap_err();
            assert!(error.contains(expected), "Unexpected diagnostic category");
            assert!(!error.contains("never-echo-this"));
        }
    }
    #[test]
    fn valid_openssh_and_utf8_bom_preserve_the_key() {
        let key = PrivateKey::random(&mut rand::rngs::OsRng, Algorithm::Ed25519).unwrap();
        let encoded = key.to_openssh(LineEnding::LF).unwrap();
        let original = parse_identity(encoded.as_bytes()).unwrap();
        let with_bom = [&[0xef, 0xbb, 0xbf][..], encoded.as_bytes()].concat();
        let parsed = parse_identity(&with_bom).unwrap();
        assert_eq!(
            original.fingerprint(HashAlg::Sha256),
            key.fingerprint(HashAlg::Sha256)
        );
        assert_eq!(
            parsed.fingerprint(HashAlg::Sha256),
            key.fingerprint(HashAlg::Sha256)
        );
    }
    #[test]
    fn import_and_inspection_share_format_diagnostics() {
        let directory =
            std::env::temp_dir().join(format!("nexssh-import-errors-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(directory.clone()).unwrap();
        let path = directory.join("selected-key");
        for bytes in [
            b"invalid\0key".as_slice(),
            b"PuTTY-User-Key-File-2: ssh-rsa",
            b"ssh-ed25519 AAAApublic",
        ] {
            std::fs::write(&path, bytes).unwrap();
            let inspected = dispatch(&state, "identity_inspect", json!({"path":path})).unwrap_err();
            let imported = dispatch(
                &state,
                "keys_import",
                json!({"path":path,"name":"Import test"}),
            )
            .unwrap_err();
            assert_eq!(inspected, imported);
        }
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
