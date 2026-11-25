use crate::{required, security, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) const REQUIRED: &str = "A password is required for this saved database connection.";

fn vault_id(profile: &Value) -> Result<String, String> {
    let workspace = required(profile, "workspaceId")?;
    let profile_id = required(profile, "profileId")?;
    let identity = serde_json::to_vec(&(workspace, profile_id)).map_err(|e| e.to_string())?;
    Ok(format!("db:{:x}", Sha256::digest(identity)))
}

fn target(state: &AppState, p: &Value) -> Result<Value, String> {
    let route = match p["sshSessionId"].as_str().filter(|s| !s.is_empty()) {
        Some(id) => {
            let binding = state.session_binding(id)?;
            if Some(binding.host_id.as_str()) != p["sshHostId"].as_str() {
                return Err("The selected SSH session belongs to a different jump host.".into());
            }
            Some(binding.route_token()?)
        }
        None => {
            if p["sshHostId"].as_str().is_some_and(|s| !s.is_empty()) {
                return Err("Connect to the saved SSH host before storing or using its database password.".into());
            }
            None
        }
    };
    Ok(json!({
        "engine":required(p,"engine")?, "host":required(p,"host")?.trim().to_ascii_lowercase(),
        "port":p["port"], "username":p["username"].as_str().unwrap_or(""), "database":p["database"].as_str().unwrap_or(""),
        "authSource":p["authSource"].as_str().unwrap_or(""), "tls":p["tls"].as_bool().unwrap_or(true),
        "mongoSrv":p["mongoSrv"].as_bool().unwrap_or(false), "route":route
    }))
}

pub(super) fn read(state: &AppState, p: &Value) -> Result<String, String> {
    let target = target(state, p)?;
    let secret = security::load_secret(state, &vault_id(p)?)?.ok_or(REQUIRED)?;
    if secret["target"] != target {
        return Err(REQUIRED.into());
    }
    Ok(required(&secret, "password").map_err(|_| REQUIRED)?.to_owned())
}

pub(super) fn write(state: &AppState, p: &Value) -> Result<(), String> {
    let password = required(p, "password")?;
    security::save_secret(state, &vault_id(p)?, &json!({"password":password, "target":target(state,p)?}))
}

pub(super) fn forget(state: &AppState, p: &Value) -> Result<(), String> {
    state.db()?.execute("DELETE FROM secrets WHERE id=?1", [vault_id(p)?]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_requires_original_profile_workspace_endpoint_and_security_settings() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(directory.path().into()).unwrap();
        let p = json!({"workspaceId":"qa","profileId":"profile","engine":"mariadb","host":"localhost",
            "port":3306,"database":"qa","username":"qa","tls":true,"password":"fixture-only-password"});
        write(&state, &p).unwrap();
        let restored = AppState::new(directory.path().into()).unwrap();
        assert_eq!(read(&restored,&p).unwrap(), "fixture-only-password");
        for (key, value) in [("workspaceId", json!("other")), ("profileId",json!("copy")), ("engine",json!("mysql")),
            ("host",json!("other")), ("port",json!(3307)), ("username",json!("other")), ("tls",json!(false)),
            ("database",json!("other")), ("authSource",json!("new")), ("mongoSrv",json!(true)), ("sshHostId",json!("new"))] {
            let mut updated = p.clone();
            updated[key] = value;
            assert!(read(&restored,&updated).is_err(), "{key}");
        }
        let bytes: Vec<u8> = restored.db().unwrap().query_row("SELECT ciphertext FROM secrets WHERE id=?1",
            [vault_id(&p).unwrap()], |row| row.get(0)).unwrap();
        assert!(!bytes.windows(b"fixture-only-password".len()).any(|part| part == b"fixture-only-password"));
        forget(&restored, &p).unwrap();
        assert_eq!(read(&restored,&p).unwrap_err(), REQUIRED);
    }
}
