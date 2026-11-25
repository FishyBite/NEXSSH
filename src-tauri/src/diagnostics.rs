use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_LOG_BYTES: u64 = 64 * 1024;
const MAX_LOCATION: u32 = 10_000_000;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Category {
    React,
    Window,
    Rejection,
}

#[derive(Deserialize, Serialize)]
enum ErrorClass {
    Error,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    EvalError,
    AggregateError,
    DOMException,
    Unknown,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    asset: String,
    line: u32,
    column: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    category: Category,
    error_class: ErrorClass,
    #[serde(skip_serializing_if = "Option::is_none")]
    react_code: Option<u32>,
    frames: Vec<Frame>,
}

fn valid_asset_name(name: &str) -> bool {
    name.len() <= 128
        && name.strip_suffix(".js").is_some_and(|stem| {
            !stem.is_empty()
                && stem
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
}

fn validate(payload: Value, known_assets: &HashSet<String>) -> Result<Report, ()> {
    let report: Report = serde_json::from_value(payload).map_err(|_| ())?;
    if report.frames.len() > 12
        || report
            .react_code
            .is_some_and(|code| !(1..=9999).contains(&code))
        || report.frames.iter().any(|frame| {
            !valid_asset_name(&frame.asset)
                || !known_assets.contains(&frame.asset)
                || !(1..=MAX_LOCATION).contains(&frame.line)
                || !(1..=MAX_LOCATION).contains(&frame.column)
        })
    {
        return Err(());
    }
    Ok(report)
}

fn save_report(directory: &Path, report: Report) -> Result<(), ()> {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis();
    let mut record = serde_json::to_vec(&json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "timestampMs": timestamp_ms,
        "report": report
    }))
    .map_err(|_| ())?;
    record.push(b'\n');
    if record.len() as u64 > MAX_LOG_BYTES {
        return Err(());
    }
    let _guard = LOG_LOCK.lock().map_err(|_| ())?;
    fs::create_dir_all(directory).map_err(|_| ())?;
    let path = directory.join("diagnostic.jsonl");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|_| ())?;
    // Keep one bounded file; a full log starts again with the newest report.
    if file.metadata().map_err(|_| ())?.len() + record.len() as u64 > MAX_LOG_BYTES {
        file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&path)
            .map_err(|_| ())?;
    }
    file.write_all(&record).map_err(|_| ())
}

fn accept(directory: &Path, payload: Value, known_assets: &HashSet<String>) -> bool {
    validate(payload, known_assets)
        .and_then(|report| save_report(directory, report))
        .is_ok()
}

pub fn report(state: &AppState, app: &tauri::AppHandle, payload: Value) -> Value {
    let resolver = app.asset_resolver();
    let known_assets = resolver
        .iter()
        .filter_map(|(path, _)| {
            let asset = path.rsplit('/').next()?;
            valid_asset_name(asset).then(|| asset.to_string())
        })
        .collect();
    json!({"ok": accept(&state.data_dir().join("logs"), payload, &known_assets)})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (std::path::PathBuf, HashSet<String>, Value) {
        (
            std::env::temp_dir().join(format!("nexssh-diagnostics-{}", uuid::Uuid::new_v4())),
            HashSet::from(["index-Test123.js".into()]),
            json!({"category":"react", "errorClass":"TypeError", "reactCode":185,
                "frames":[{"asset":"index-Test123.js","line":1,"column":320}]}),
        )
    }

    #[test]
    fn accepts_only_structured_report_with_server_generated_metadata() {
        let (directory, assets, payload) = fixture();
        assert!(accept(&directory, payload.clone(), &assets));
        let data = fs::read_to_string(directory.join("diagnostic.jsonl")).unwrap();
        let record: Value = serde_json::from_str(data.trim()).unwrap();
        assert_eq!(record["report"], payload);
        assert_eq!(record["appVersion"], env!("CARGO_PKG_VERSION"));
        assert!(record["timestampMs"].as_u64().unwrap() > 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn credentials_and_raw_messages_are_rejected_without_persistence() {
        let (directory, assets, valid) = fixture();
        let mut invalid = Vec::new();
        for field in [
            "message",
            "stack",
            "password",
            "passphrase",
            "privateKey",
            "hostId",
            "sessionId",
        ] {
            let mut payload = valid.clone();
            payload[field] = json!("FAKE-CREDENTIAL-DO-NOT-PERSIST");
            invalid.push(payload);
        }
        for field in ["category", "errorClass", "reactCode"] {
            let mut payload = valid.clone();
            payload[field] = json!("FAKE-CREDENTIAL-DO-NOT-PERSIST");
            invalid.push(payload);
        }
        for field in ["asset", "line", "column", "message"] {
            let mut payload = valid.clone();
            payload["frames"][0][field] = json!("FAKE-CREDENTIAL-DO-NOT-PERSIST.js");
            invalid.push(payload);
        }
        for payload in invalid {
            assert!(!accept(&directory, payload, &assets));
        }
        assert!(!directory.exists());
        assert!(accept(&directory, valid.clone(), &assets));
        let before = fs::read(directory.join("diagnostic.jsonl")).unwrap();
        let mut unsafe_payload = valid;
        unsafe_payload["message"] = json!("FAKE-CREDENTIAL-DO-NOT-PERSIST");
        assert!(!accept(&directory, unsafe_payload, &assets));
        assert_eq!(
            before,
            fs::read(directory.join("diagnostic.jsonl")).unwrap()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unbounded_locations_paths_and_unknown_assets() {
        let (_, assets, valid) = fixture();
        for asset in [
            "../index-Test123.js",
            "C:\\secret.js",
            "https://host/index-Test123.js",
            "credential.js",
            "index-Test123.js?password=secret",
            "index-秘密.js",
        ] {
            let mut payload = valid.clone();
            payload["frames"][0]["asset"] = json!(asset);
            assert!(validate(payload, &assets).is_err());
        }
        for field in ["line", "column"] {
            for value in [json!(0), json!(-1), json!(MAX_LOCATION + 1), json!(1.5)] {
                let mut payload = valid.clone();
                payload["frames"][0][field] = value;
                assert!(validate(payload, &assets).is_err());
            }
        }
        let mut payload = valid.clone();
        payload["frames"] = json!(vec![valid["frames"][0].clone(); 13]);
        assert!(validate(payload, &assets).is_err());
        for code in [0, 10000] {
            let mut payload = valid.clone();
            payload["reactCode"] = json!(code);
            assert!(validate(payload, &assets).is_err());
        }
    }

    #[test]
    fn log_stays_bounded_and_io_failure_is_nonfatal() {
        let (directory, assets, payload) = fixture();
        for _ in 0..400 {
            assert!(accept(&directory, payload.clone(), &assets));
        }
        let path = directory.join("diagnostic.jsonl");
        assert!(fs::metadata(&path).unwrap().len() <= MAX_LOG_BYTES);
        let data = fs::read_to_string(&path).unwrap();
        assert!(!data.is_empty());
        assert!(data.lines().count() < 400);
        for line in data.lines() {
            serde_json::from_str::<Value>(line).unwrap();
        }
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert!(!accept(&path, payload, &assets));
        fs::remove_dir_all(directory).unwrap();
    }
}
