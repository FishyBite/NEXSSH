use crate::{files, ssh_attempt::Attempt, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::Path,
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex},
};

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Arc<Job>>>);

#[derive(Default)]
struct Job {
    session_id: String,
    transport: Attempt,
    running: AtomicBool,
    bytes: AtomicU64,
}

impl Jobs {
    pub fn shutdown(&self) {
        if let Ok(mut jobs) = self.0.lock() {
            for (_, job) in jobs.drain() {
                job.transport.cancel();
            }
        }
    }
}

fn stream_hash(mut reader: impl Read, job: &Job) -> Result<(String, u64), String> {
    let mut buffer = vec![0; 128 * 1024];
    let mut digest = Sha256::new();
    let mut size = 0;
    loop {
        job.transport.check()?;
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok((format!("{:x}", digest.finalize()), size));
        }
        digest.update(&buffer[..n]);
        size += n as u64;
        job.bytes.fetch_add(n as u64, Ordering::Relaxed);
    }
}

fn checksum_pair(sftp: &ssh2::Sftp, local: &Path, remote: &Path, job: &Job) -> Result<Value, String> {
    let local_stamp = || -> Result<_, String> {
        let info = fs::symlink_metadata(local).map_err(|e| format!("Cannot inspect local file: {e}"))?;
        if !info.file_type().is_file() {
            return Err("Select a regular local file for comparison".into());
        }
        Ok((info.len(), info.modified().ok()))
    };
    let remote_stamp = || -> Result<_, String> {
        let info = files::remote_regular(sftp, remote).map_err(|e| format!("Cannot inspect remote file: {e}"))?;
        Ok((info.size, info.mtime))
    };
    let local_before = local_stamp()?;
    let remote_before = remote_stamp()?;
    let local_file = fs::File::open(local).map_err(|e| format!("Cannot open local file: {e}"))?;
    let (local_digest, local_size) = stream_hash(local_file, job).map_err(|e| format!("Cannot read local file: {e}"))?;
    job.transport.check()?;
    let remote_file = sftp.open(remote).map_err(|e| format!("Cannot open remote file: {e}"))?;
    let (remote_digest, remote_size) = stream_hash(remote_file, job).map_err(|e| format!("Cannot read remote file: {e}"))?;
    if local_before != local_stamp()? || remote_before != remote_stamp()? ||
        local_before.0 != local_size || remote_before.0.is_some_and(|size| size != remote_size) {
        return Err("A file changed during comparison. Verify both files again.".into());
    }
    Ok(json!({"local":local_digest, "remote":remote_digest, "matches":local_digest==remote_digest}))
}

pub fn dispatch(state: &AppState, action: &str, payload: &Value) -> Result<Value, String> {
    let jobs = &state.inner.checksums.0;
    if action == "file_checksum_prepare" {
        let session_id = files::text(payload, "sessionId")?;
        state.session_binding(session_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut jobs = jobs.lock().map_err(|e| e.to_string())?;
        jobs.insert(id.clone(), Arc::new(Job { session_id: session_id.to_owned(), ..Default::default() }));
        return Ok(json!(id));
    }
    let id = files::text(payload, "id")?;
    if action == "file_checksum_cancel" {
        if let Some(job) = jobs.lock().map_err(|e| e.to_string())?.remove(id) {
            job.transport.cancel();
        }
        return Ok(Value::Null);
    }
    let job = jobs.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("Comparison has ended")?;
    match action {
        "file_checksum_progress" => Ok(json!(job.bytes.load(Ordering::Relaxed))),
        "file_checksum_run" => {
            if job.running.swap(true, Ordering::AcqRel) {
                return Err("Comparison is already running".into());
            }
            let result = (|| {
                let local = Path::new(files::text(payload, "localPath")?);
                let remote = Path::new(files::text(payload, "remotePath")?);
                let session = state.open_cancellable_for(&job.session_id, &job.transport)?;
                session.set_timeout(15_000);
                let sftp = session.sftp().map_err(|e| format!("Cannot start SFTP: {e}"))?;
                let hashes = checksum_pair(&sftp, local, remote, &job)?;
                job.transport.check()?;
                state.session_binding(&job.session_id)?;
                Ok(hashes)
            })();
            jobs.lock().map_err(|e| e.to_string())?.remove(id);
            result
        }
        _ => Err("Unknown checksum action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_multiple_chunks_and_counts_bytes() {
        let bytes = vec![0x5a; 500_007];
        let job = Job::default();
        let (digest, total) = stream_hash(&bytes[..], &job).unwrap();
        assert_eq!(digest, format!("{:x}", Sha256::digest(&bytes)));
        assert_eq!(total, bytes.len() as u64);
        assert_eq!(total, job.bytes.load(Ordering::Relaxed));
    }

    #[test]
    fn cancelled_job_never_reads_another_chunk() {
        let job = Job::default();
        job.transport.cancel();
        assert!(stream_hash(&b"abc"[..], &job).is_err());
        assert_eq!(0, job.bytes.load(Ordering::Relaxed));
    }

    #[test]
    #[ignore = "Requires isolated loopback VEXSSH_TEST_CONNECTION fixture"]
    fn verified_ssh_compares_actual_bytes_and_rejects_changed_route() {
        use std::io::Write;
        let fixture: Value = serde_json::from_slice(&fs::read(std::env::var("VEXSSH_TEST_CONNECTION").unwrap()).unwrap()).unwrap();
        assert_eq!(fixture["hostname"], "127.0.0.1");
        let root = std::env::temp_dir().join(format!("vexssh-checksum-{}", uuid::Uuid::new_v4()));
        let state = AppState::new(root.clone()).unwrap();
        let mut config = json!({"hosts":[{"id":"loop","hostname":"127.0.0.1","port":fixture["port"],"username":fixture["username"],"authMethod":"password"}]});
        state.save_config(config.clone()).unwrap();
        crate::security::trust_host(&state, "loop", "127.0.0.1", fixture["port"].as_u64().unwrap() as u16, fixture["fingerprint"].as_str().unwrap()).unwrap();
        crate::ssh::seed_test_credential(&state, "loop", json!({"password":fixture["password"]}));
        let (sender, _) = std::sync::mpsc::channel();
        let binding = state.capture_binding("loop").unwrap();
        state.inner.sessions.lock().unwrap().insert("terminal".into(), crate::storage::TerminalSession {host_id:"loop".into(), sender, binding});
        let local = root.join("local");
        let remote = format!("/checksum-{}", uuid::Uuid::new_v4());
        let session = state.open_session_for("terminal").unwrap();
        let sftp = session.sftp().unwrap();
        let data = vec![39; 334_537];
        sftp.create(Path::new(&remote)).unwrap().write_all(&data).unwrap();
        fs::write(&local, &data).unwrap();
        let prepare = || dispatch(&state, "file_checksum_prepare", &json!({"sessionId":"terminal"}));
        let run = |id| dispatch(&state,"file_checksum_run",&json!({"id":id,"localPath":local,"remotePath":remote}));
        let result = run(prepare().unwrap()).unwrap();
        assert_eq!(result["matches"], true);
        assert_eq!(result["remote"], format!("{:x}", Sha256::digest(&data)));
        fs::write(&local, vec![40; data.len()]).unwrap();
        assert_eq!(run(prepare().unwrap()).unwrap()["matches"], false);
        let cancelled = prepare().unwrap();
        dispatch(&state, "file_checksum_cancel", &json!({"id":cancelled})).unwrap();
        assert!(run(cancelled).is_err());
        fs::remove_file(&local).unwrap();
        assert!(run(prepare().unwrap()).unwrap_err().contains("local file"));
        let pending = prepare().unwrap();
        config["hosts"][0]["username"] = json!("another-user");
        state.save_config(config).unwrap();
        assert!(run(pending).unwrap_err().contains("changed"));
        assert!(prepare().is_err());
        assert!(state.inner.checksums.0.lock().unwrap().is_empty());
        sftp.unlink(Path::new(&remote)).unwrap();
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
