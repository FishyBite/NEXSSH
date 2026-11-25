use crate::{files, required, AppState};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const CHUNK: u64 = 32 * 1024;
const ANCHOR: u64 = 96;

pub struct LogReader {
    viewer: String,
    session_id: String,
    path: String,
    sftp: ssh2::Sftp,
}

#[derive(Deserialize)]
struct Cursor {
    offset: u64,
    anchor: String,
}

fn anchor(file: &mut (impl Read + Seek), offset: u64) -> std::io::Result<String> {
    let start = offset.saturating_sub(ANCHOR);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0; (offset - start) as usize];
    file.read_exact(&mut bytes)?;
    Ok(files::revision(&bytes))
}

fn read_chunk(
    file: &mut (impl Read + Seek),
    size: u64,
    cursor: Option<Cursor>,
) -> Result<Value, String> {
    // SFTP v3 has no inode field. Check the previous bytes as well as the size
    // so replacement by an equally large file is detected at the read boundary.
    let continuing = match cursor.as_ref() {
        Some(c) if c.offset <= size => {
            anchor(file, c.offset).map_err(|e| e.to_string())? == c.anchor
        }
        _ => false,
    };
    let start = if continuing {
        cursor.as_ref().unwrap().offset
    } else {
        size.saturating_sub(CHUNK)
    };
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(CHUNK.min(size - start))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Err("Choose a UTF-8 text log.".into());
    }
    let prefix = if !continuing && start > 0 {
        bytes
            .iter()
            .take(3)
            .take_while(|b| **b & 0xc0 == 0x80)
            .count()
    } else {
        0
    };
    let slice = &bytes[prefix..];
    let text = match std::str::from_utf8(slice) {
        Ok(text) => text,
        Err(error) if error.error_len().is_none() => {
            std::str::from_utf8(&slice[..error.valid_up_to()]).map_err(|e| e.to_string())?
        }
        Err(_) => return Err("Choose a UTF-8 text log.".into()),
    };
    let end = start + (prefix + text.len()) as u64;
    let signature = anchor(file, end).map_err(|e| e.to_string())?;
    Ok(
        json!({"text":text,"cursor":{"offset":end,"anchor":signature},
        "reset":cursor.is_some()&&!continuing,"more":start+CHUNK<size}),
    )
}

pub fn dispatch(state: &AppState, action: &str, payload: &Value) -> Result<Value, String> {
    let viewer = required(payload, "viewerId")?;
    let mut slot = state.inner.log_reader.lock().map_err(|e| e.to_string())?;
    if action == "file_tail_close" {
        if slot.as_ref().is_some_and(|r| r.viewer == viewer) {
            slot.take();
        }
        return Ok(Value::Null);
    }
    let id = required(payload, "sessionId")?;
    let path = required(payload, "path")?;
    let binding = state.session_binding(id)?;
    if !slot
        .as_ref()
        .is_some_and(|r| r.viewer == viewer && r.session_id == id && r.path == path)
    {
        let session = state.open_bound_session(&binding)?;
        let sftp = session.sftp().map_err(|e| e.to_string())?;
        *slot = Some(LogReader {
            viewer: viewer.into(),
            session_id: id.into(),
            path: path.into(),
            sftp,
        });
    }
    let reader = slot.as_ref().unwrap();
    let path = Path::new(path);
    let result = (|| {
        files::remote_regular(&reader.sftp, path)?;
        let mut file = reader.sftp.open(path).map_err(|e| e.to_string())?;
        let size = file
            .stat()
            .map_err(|e| e.to_string())?
            .size
            .ok_or("Log size unavailable")?;
        let cursor: Option<Cursor> =
            serde_json::from_value(payload["cursor"].clone()).map_err(|_| "Invalid log cursor")?;
        read_chunk(&mut file, size, cursor)
    })();
    if result.is_err() {
        slot.take();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires the local VEXSSH_NINE_FIXTURE SSH service"]
    fn real_pty_directory_and_incremental_sftp_log() {
        use crate::storage::TerminalSession;
        use std::io::Write;
        let fixture: Value = serde_json::from_slice(
            &std::fs::read(std::env::var("VEXSSH_NINE_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let db = std::env::temp_dir().join(format!("vexssh-tail-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(db.clone()).unwrap();
        let port = fixture["port"].as_u64().unwrap() as u16;
        state.save_config(json!({"hosts":[{"id":"a","hostname":"127.0.0.1","port":port,"username":"fixture","authMethod":"password"}]})).unwrap();
        crate::security::trust_host(
            &state,
            "a",
            "127.0.0.1",
            port,
            fixture["fingerprint"].as_str().unwrap(),
        )
        .unwrap();
        crate::ssh::seed_test_credential(&state, "a", json!({"password":fixture["password"]}));
        let binding = state.capture_binding("a").unwrap();
        let (sender, _recv) = std::sync::mpsc::channel();
        state.inner.sessions.lock().unwrap().insert(
            "s".into(),
            TerminalSession {
                host_id: "a".into(),
                sender,
                binding,
            },
        );
        let session = state.open_session_for("s").unwrap();
        let mut channel = session.channel_session().unwrap();
        channel.request_pty("xterm-256color", None, None).unwrap();
        let cwd = fixture["cwd"].as_str().unwrap();
        assert!(crate::ssh::directory_command("/data\nexit").is_err());
        channel
            .exec(&crate::ssh::directory_command(cwd).unwrap())
            .unwrap();
        let mut output = String::new();
        channel.read_to_string(&mut output).unwrap();
        channel.wait_close().unwrap();
        assert_eq!(channel.exit_status().unwrap(), 0);
        assert!(
            output.lines().any(|line| line.trim() == cwd),
            "Remote pwd didn't match the requested directory: {output:?}"
        );
        let sftp = session.sftp().unwrap();
        let file = Path::new("/active.log");
        let write = |content: &[u8]| {
            let mut out = sftp.create(file).unwrap();
            out.write_all(content).unwrap();
            out.close().unwrap();
        };
        write(b"first\n");
        assert_eq!(crate::files::preview_remote_path(&sftp, "/").unwrap()["kind"], "directory");
        let preview = crate::files::preview_remote_path(&sftp, "/active.log").unwrap();
        assert_eq!((preview["kind"].as_str(), preview["content"].as_str()), (Some("file"), Some("first\n")));
        assert_eq!(preview["revision"], crate::files::revision(b"first\n"));
        let editing_path = format!("/preview-edit-{}.txt", uuid::Uuid::new_v4());
        let editing_file = Path::new(&editing_path);
        let remote_write = |bytes: &[u8]| {
            let mut handle = sftp.create(editing_file).unwrap();
            handle.write_all(bytes).unwrap();
            handle.close().unwrap();
        };
        remote_write(b"first\r\n");
        let read_revision = || {
            crate::files::preview_remote_path(&sftp, &editing_path).unwrap()["revision"]
                .as_str().unwrap().to_owned()
        };
        let save = |expected: &str| {
            crate::files::save_remote(&session, &sftp, editing_file, b"draft\r\n", expected, true)
        };
        let original = read_revision();
        remote_write(b"other\r\n");
        assert!(save(&original).unwrap_err().contains("File changed"));
        let reviewed = read_revision();
        remote_write(b"third\r\n");
        assert!(save(&reviewed).unwrap_err().contains("File changed"));
        let result = save(&read_revision()).unwrap();
        assert_eq!(crate::files::remote_bytes(&sftp, editing_file).unwrap(), b"draft\r\n");
        let backup = Path::new(result["backupPath"].as_str().unwrap());
        assert_eq!(crate::files::remote_bytes(&sftp, backup).unwrap(), b"third\r\n");
        sftp.unlink(backup).unwrap();
        sftp.unlink(editing_file).unwrap();
        assert!(crate::files::preview_remote_path(&sftp, "/missing-file").is_err());
        assert!(crate::files::preview_remote_path(&sftp, "relative").is_err());
        let mut req = json!({"viewerId":"view","sessionId":"s","path":"/active.log"});
        let initial = dispatch(&state, "file_tail", &req).unwrap();
        assert_eq!(initial["text"], "first\n");
        req["cursor"] = initial["cursor"].clone();
        write("first\nnext 🙂\n".as_bytes());
        let next = dispatch(&state, "file_tail", &req).unwrap();
        assert_eq!(next["text"], "next 🙂\n");
        req["cursor"] = next["cursor"].clone();
        write(b"NEW\n");
        assert_eq!(dispatch(&state, "file_tail", &req).unwrap()["reset"], true);
        dispatch(&state, "file_tail_close", &req).unwrap();
        assert!(state.inner.log_reader.lock().unwrap().is_none());
        drop(state);
        std::fs::remove_dir_all(db).unwrap();
    }
    fn read(bytes: &[u8], prev: Value) -> Value {
        read_chunk(
            &mut std::io::Cursor::new(bytes),
            bytes.len() as u64,
            serde_json::from_value(prev).unwrap(),
        )
        .unwrap()
    }
    #[test]
    fn append_rotate_truncate_and_split_unicode() {
        let first = read(b"one\n", Value::Null);
        let appended = read("one\ntwo\n".as_bytes(), first["cursor"].clone());
        assert_eq!(appended["text"], "two\n");
        let rotated = read(b"new log\n", appended["cursor"].clone());
        assert_eq!(rotated["reset"], true);
        assert_eq!(rotated["text"], "new log\n");
        let short = read(b"x", rotated["cursor"].clone());
        assert_eq!(short["reset"], true);
        let partial = read(&[b'x', 0xf0, 0x9f], short["cursor"].clone());
        assert_eq!(partial["text"], "");
        assert_eq!(
            read("x🙂".as_bytes(), partial["cursor"].clone())["text"],
            "🙂"
        );
    }
}
