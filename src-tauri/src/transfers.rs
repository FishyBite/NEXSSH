use crate::{files, AppState};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
mod conflict;
#[cfg(test)]
mod integration;
mod resume;
use conflict::{Choice, Conflict, Destination};
use resume::Partial;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    id: String,
    session_id: String,
    #[serde(default)]
    tab_id: Option<String>,
    #[serde(default)]
    route_token: Option<String>,
    host_id: String,
    #[serde(default)]
    binding: Option<crate::storage::SessionBinding>,
    source: String,
    destination: String,
    direction: String,
    protocol: String,
    status: String,
    total_bytes: u64,
    transferred_bytes: u64,
    speed_bytes_per_second: f64,
    eta_seconds: Option<f64>,
    error: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
    duration_seconds: Option<f64>,
    #[serde(default)]
    completed_files: HashMap<String, String>,
    #[serde(default)]
    resumable: bool,
    #[serde(default)]
    resumed_bytes: u64,
    #[serde(default)]
    partial: Option<Partial>,
    #[serde(default)]
    restart_requested: bool,
    #[serde(default)]
    conflict: Option<Conflict>,
    #[serde(default)]
    batch_id: Option<String>,
    #[serde(default)]
    skipped_files: usize,
    #[serde(default)]
    skipped_paths: std::collections::HashSet<String>,
    #[serde(default)]
    renamed_paths: HashMap<String, String>,
}

struct JobControl {
    cancelled: Arc<AtomicBool>,
    destination: String,
    host_id: String,
    direction: String,
    batch: String,
    conflict: Option<(String, bool)>,
    decision: Option<Choice>,
}
#[derive(Default)]
struct Queue {
    running: usize,
    jobs: HashMap<String, JobControl>,
}
static QUEUE: OnceLock<(Mutex<Queue>, Condvar)> = OnceLock::new();
static INITIALIZED: OnceLock<Mutex<bool>> = OnceLock::new();
fn queue() -> &'static (Mutex<Queue>, Condvar) {
    QUEUE.get_or_init(|| (Mutex::new(Queue::default()), Condvar::new()))
}
pub fn shutdown() {
    let (lock, condition) = queue();
    if let Ok(queue_state) = lock.lock() {
        for job in queue_state.jobs.values() {
            job.cancelled.store(true, Ordering::Release);
        }
        condition.notify_all();
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn initialize(state: &AppState) -> Result<(), String> {
    let mut initialized = INITIALIZED
        .get_or_init(|| Mutex::new(false))
        .lock()
        .map_err(|e| e.to_string())?;
    if *initialized {
        return Ok(());
    }
    let db = state.db()?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS transfer_conflict_policies(batch TEXT PRIMARY KEY, policy TEXT NOT NULL)").map_err(|e|e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS vexssh_transfers (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated_at INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    let mut query = db
        .prepare("SELECT record FROM vexssh_transfers")
        .map_err(|e| e.to_string())?;
    let records = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for item in records {
        let mut record: Transfer =
            serde_json::from_str(&item.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if matches!(record.status.as_str(), "queued" | "running" | "conflict") {
            record.status = "failed".into();
            record.conflict = None;
            record.resumable = record.partial.is_some();
            record.error = Some("Application closed before the transfer completed.".into());
            record.finished_at = Some(now());
            db.execute(
                "UPDATE vexssh_transfers SET record=?1,updated_at=?2 WHERE id=?3",
                params![
                    serde_json::to_string(&record).map_err(|e| e.to_string())?,
                    now(),
                    record.id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    *initialized = true;
    Ok(())
}

fn persist(state: &AppState, transfer: &Transfer) -> Result<(), String> {
    state.db()?.execute("INSERT INTO vexssh_transfers(id,record,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET record=excluded.record,updated_at=excluded.updated_at",params![transfer.id,serde_json::to_string(transfer).map_err(|e|e.to_string())?,now()]).map_err(|e|e.to_string())?;
    Ok(())
}

fn get_transfer(state: &AppState, id: &str) -> Result<Transfer, String> {
    let record: String = state
        .db()?
        .query_row(
            "SELECT record FROM vexssh_transfers WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&record).map_err(|e| e.to_string())
}

fn publish(state: &AppState, app: &tauri::AppHandle, transfer: &Transfer) -> Result<(), String> {
    persist(state, transfer)?;
    app.emit("transfer-progress", transfer)
        .map_err(|e| e.to_string())
}

#[derive(Clone)]
struct Entry {
    source: String,
    destination: String,
    directory: bool,
    size: u64,
    mode: i32,
    modified: Option<u64>,
}

fn collect_upload(
    source: &Path,
    destination: &str,
    entries: &mut Vec<Entry>,
    depth: usize,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancelled)?;
    if depth > 64 || entries.len() >= 100_000 {
        return Err("Folder exceeds the transfer limit of 64 levels or 100,000 entries".into());
    }
    let metadata = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err(format!(
            "Symbolic links and special files require individual handling: {}",
            source.display()
        ));
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        (metadata.permissions().mode() & 0o777) as i32
    };
    #[cfg(not(unix))]
    let mode = if metadata.is_dir() { 0o755 } else { 0o600 };
    entries.push(Entry {
        source: source.to_string_lossy().into_owned(),
        destination: destination.to_owned(),
        directory: metadata.is_dir(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        mode,
        modified: metadata
            .modified()
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map(|v| v.as_secs()),
    });
    if metadata.is_dir() {
        for child in fs::read_dir(source).map_err(|e| e.to_string())? {
            let child = child.map_err(|e| e.to_string())?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| "Filename is not UTF-8")?;
            collect_upload(
                &child.path(),
                &files::remote_join(destination, &name)?,
                entries,
                depth + 1,
                cancelled,
            )?;
        }
    }
    Ok(())
}

fn collect_download(
    sftp: &Sftp,
    source: &str,
    destination: &Path,
    entries: &mut Vec<Entry>,
    depth: usize,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancelled)?;
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Download destination must include a filename")?;
    files::validate_local_name(destination_name)?;
    if depth > 64 || entries.len() >= 100_000 {
        return Err("Folder exceeds the transfer limit of 64 levels or 100,000 entries".into());
    }
    let stat = sftp.lstat(Path::new(source)).map_err(|e| e.to_string())?;
    if !stat.is_file() && !stat.is_dir() {
        return Err(format!(
            "Symbolic links and special files require individual handling: {source}"
        ));
    }
    entries.push(Entry {
        source: source.to_owned(),
        destination: destination.to_string_lossy().into_owned(),
        directory: stat.is_dir(),
        size: if stat.is_file() {
            stat.size
                .ok_or("Server did not report the remote file size")?
        } else {
            0
        },
        mode: (stat.perm.unwrap_or(0o600) & 0o777) as i32,
        modified: stat.mtime,
    });
    if stat.is_dir() {
        for (child, _) in sftp.readdir(Path::new(source)).map_err(|e| e.to_string())? {
            let name = child
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or("Remote filename is not UTF-8")?;
            files::validate_local_name(name)?;
            collect_download(
                sftp,
                &files::remote_join(source, name)?,
                &destination.join(name),
                entries,
                depth + 1,
                cancelled,
            )?;
        }
    }
    Ok(())
}

fn check_cancel(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("Transfer cancelled".into())
    } else {
        Ok(())
    }
}

struct Progress<'a> {
    state: &'a AppState,
    app: Option<&'a tauri::AppHandle>,
    transfer: &'a mut Transfer,
    cancelled: &'a AtomicBool,
    started: Instant,
    published: Instant,
    network_bytes: u64,
    #[cfg(test)]
    interrupt: Option<(u64, std::net::TcpStream)>,
}
impl Progress<'_> {
    fn advance(&mut self, bytes: u64) -> Result<(), String> {
        #[cfg(test)]
        if self
            .interrupt
            .as_ref()
            .is_some_and(|(limit, _)| self.network_bytes >= *limit)
        {
            if let Some((_, socket)) = self.interrupt.take() {
                socket
                    .shutdown(std::net::Shutdown::Both)
                    .map_err(|e| e.to_string())?;
            }
        }
        check_cancel(self.cancelled)?;
        self.transfer.transferred_bytes += bytes;
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        self.transfer.speed_bytes_per_second = self.network_bytes as f64 / elapsed;
        self.transfer.eta_seconds = if self.transfer.speed_bytes_per_second > 0.0 {
            Some(
                self.transfer
                    .total_bytes
                    .saturating_sub(self.transfer.transferred_bytes) as f64
                    / self.transfer.speed_bytes_per_second,
            )
        } else {
            None
        };
        if self.published.elapsed() >= Duration::from_millis(200) {
            self.publish()?;
            self.published = Instant::now();
        }
        Ok(())
    }
    fn publish(&self) -> Result<(), String> {
        if let Some(app) = self.app {
            publish(self.state, app, self.transfer)
        } else {
            persist(self.state, self.transfer)
        }
    }
}

fn stream_copy(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected: u64,
    progress: &mut Progress<'_>,
) -> Result<String, String> {
    let mut copied = 0;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while copied < expected {
        check_cancel(progress.cancelled)?;
        let length = ((expected - copied) as usize).min(buffer.len());
        let read = reader
            .read(&mut buffer[..length])
            .map_err(|e| e.to_string())?;
        if read == 0 {
            return Err(
                "Source file changed or connection ended before the transfer completed".into(),
            );
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|e| e.to_string())?;
        digest.update(&buffer[..read]);
        copied += read as u64;
        progress.network_bytes += read as u64;
        progress.advance(read as u64)?;
    }
    writer.flush().map_err(|e| e.to_string())?;
    Ok(format!("{:x}", digest.finalize()))
}

fn checksum(mut reader: impl Read, cancelled: &AtomicBool) -> Result<String, String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check_cancel(cancelled)?;
        let count = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn already_completed(
    sftp: &Sftp,
    entry: &Entry,
    direction: &str,
    progress: &Progress<'_>,
) -> Result<bool, String> {
    let Some(expected) = progress.transfer.completed_files.get(&entry.destination) else {
        return Ok(false);
    };
    let destination_hash = if direction == "upload" {
        files::remote_regular(sftp, Path::new(&entry.destination))?;
        checksum(
            sftp.open(Path::new(&entry.destination))
                .map_err(|e| e.to_string())?,
            progress.cancelled,
        )?
    } else {
        let metadata = fs::symlink_metadata(&entry.destination).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() {
            return Err("Completed download was replaced by a special file".into());
        }
        checksum(
            fs::File::open(&entry.destination).map_err(|e| e.to_string())?,
            progress.cancelled,
        )?
    };
    if &destination_hash != expected {
        return Err(format!(
            "Previously completed file changed: {}",
            entry.destination
        ));
    }
    let source_hash = if direction == "upload" {
        if !fs::symlink_metadata(&entry.source)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_file()
        {
            return Err("Source is no longer a regular file".into());
        }
        checksum(
            fs::File::open(&entry.source).map_err(|e| e.to_string())?,
            progress.cancelled,
        )?
    } else {
        files::remote_regular(sftp, Path::new(&entry.source))?;
        checksum(
            sftp.open(Path::new(&entry.source))
                .map_err(|e| e.to_string())?,
            progress.cancelled,
        )?
    };
    if &source_hash != expected {
        return Err(format!(
            "Source changed since the earlier attempt: {}",
            entry.source
        ));
    }
    Ok(true)
}

fn remote_directory(sftp: &Sftp, path: &Path, mode: i32) -> Result<(), String> {
    match sftp.lstat(path) {
        Ok(stat) if stat.is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "Destination exists and is not a directory: {}",
            path.display()
        )),
        Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => {
            sftp.mkdir(path, mode).map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn local_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!(
            "Destination exists and is not a regular directory: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn publish_download(temporary: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileExW(existing: *const u16, destination: *const u16, flags: u32) -> i32;
        }
        let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both terminated buffers stay alive for the call. Omitting REPLACE_EXISTING protects concurrent writes.
        let moved = unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 8) };
        if moved == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(temporary, destination).map_err(|e| e.to_string())?;
        fs::remove_file(temporary).map_err(|e| e.to_string())
    }
}

fn copy_scp(
    session: &Session,
    sftp: &Sftp,
    entry: &Entry,
    expected: Option<&conflict::Stamp>,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let upload = progress.transfer.direction == "upload";
    let staged = PathBuf::from(format!(
        "{}.vexssh-{}.part",
        entry.destination,
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut channel;
        let digest;
        if upload {
            let meta = fs::symlink_metadata(&entry.source).map_err(|e| e.to_string())?;
            if !meta.file_type().is_file() || meta.len() != entry.size {
                return Err("Source file changed".into());
            }
            let mut source = fs::File::open(&entry.source).map_err(|e| e.to_string())?;
            channel = session
                .scp_send(&staged, entry.mode, entry.size, None)
                .map_err(|e| e.to_string())?;
            digest = stream_copy(&mut source, &mut channel, entry.size, progress)?;
            if source.metadata().map_err(|e| e.to_string())?.len() != entry.size {
                return Err("Source file changed during transfer".into());
            }
        } else {
            files::remote_regular(sftp, Path::new(&entry.source))?;
            let (mut source, stat) = session
                .scp_recv(Path::new(&entry.source))
                .map_err(|e| e.to_string())?;
            if stat.size() != entry.size {
                return Err("Remote source changed".into());
            }
            let mut target = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staged)
                .map_err(|e| e.to_string())?;
            digest = stream_copy(&mut source, &mut target, entry.size, progress)?;
            target.sync_all().map_err(|e| e.to_string())?;
            channel = source;
        }
        channel.send_eof().map_err(|e| e.to_string())?;
        channel.wait_eof().map_err(|e| e.to_string())?;
        channel.close().map_err(|e| e.to_string())?;
        channel.wait_close().map_err(|e| e.to_string())?;
        if channel.exit_status().map_err(|e| e.to_string())? != 0 {
            return Err("Remote SCP process failed".into());
        }
        check_cancel(progress.cancelled)?;
        conflict::publish_file(session, sftp, entry, &staged, upload, expected)?;
        progress
            .transfer
            .completed_files
            .insert(entry.destination.clone(), digest);
        persist(progress.state, progress.transfer)
    })();
    if result.is_err() {
        if upload {
            let _ = sftp.unlink(&staged);
        } else {
            let _ = fs::remove_file(&staged);
        }
    }
    result
}

fn execute(
    state: &AppState,
    app: &tauri::AppHandle,
    transfer: &mut Transfer,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    check_cancel(cancelled)?;
    let session = open_transfer_session(state, transfer)?;
    session.set_timeout(15_000);
    let sftp = session.sftp().map_err(|e| e.to_string())?;
    if transfer.restart_requested {
        resume::discard_verified(&session, &sftp, transfer, cancelled)?;
        transfer.partial = None;
        transfer.restart_requested = false;
        persist(state, transfer)?;
    }
    let mut entries = Vec::new();
    if transfer.direction == "upload" {
        let destination = sftp
            .realpath(
                Path::new(&transfer.destination)
                    .parent()
                    .unwrap_or_else(|| Path::new(".")),
            )
            .map_err(|e| e.to_string())?;
        let name = Path::new(&transfer.destination)
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or("Destination must include a filename")?;
        transfer.destination = files::remote_join(&destination.to_string_lossy(), name)?;
        collect_upload(
            Path::new(&transfer.source),
            &transfer.destination,
            &mut entries,
            0,
            cancelled,
        )?;
    } else {
        let source = sftp
            .realpath(Path::new(&transfer.source))
            .map_err(|e| e.to_string())?;
        let stat = sftp
            .lstat(Path::new(&transfer.source))
            .map_err(|e| e.to_string())?;
        if !stat.is_file() && !stat.is_dir() {
            return Err("Symbolic link transfers are not supported".into());
        }
        transfer.source = source.to_string_lossy().into_owned();
        collect_download(
            &sftp,
            &transfer.source,
            Path::new(&transfer.destination),
            &mut entries,
            0,
            cancelled,
        )?;
    }
    transfer.total_bytes = entries
        .iter()
        .try_fold(0u64, |sum, entry| sum.checked_add(entry.size))
        .ok_or("Transfer size overflow")?;
    publish(state, app, transfer)?;
    let protocol = transfer.protocol.clone();
    let direction = transfer.direction.clone();
    let mut progress = Progress {
        state,
        app: Some(app),
        transfer,
        cancelled,
        started: Instant::now(),
        published: Instant::now(),
        network_bytes: 0,
        #[cfg(test)]
        interrupt: None,
    };
    let upload = direction == "upload";
    let reserved = conflict::reserved(&entries, upload);
    for mut entry in entries {
        check_cancel(cancelled)?;
        let original = entry.destination.clone();
        let mut skip = false;
        let mut mapped = false;
        for ancestor in Path::new(&original).ancestors() {
            let key = ancestor.to_string_lossy();
            if progress.transfer.skipped_paths.contains(key.as_ref()) {
                skip = true;
                break;
            }
            if !mapped {
                if let Some(renamed) = progress.transfer.renamed_paths.get(key.as_ref()) {
                    let suffix = Path::new(&original)
                        .strip_prefix(ancestor)
                        .map_err(|e| e.to_string())?;
                    entry.destination = if suffix.as_os_str().is_empty() {
                        renamed.clone()
                    } else if upload {
                        format!(
                            "{}/{}",
                            renamed.trim_end_matches('/'),
                            suffix.to_string_lossy().replace('\\', "/")
                        )
                    } else {
                        Path::new(renamed)
                            .join(suffix)
                            .to_string_lossy()
                            .into_owned()
                    };
                    mapped = true;
                }
            }
        }
        if skip {
            progress.advance(entry.size)?;
            continue;
        }
        if !entry.directory && already_completed(&sftp, &entry, &direction, &progress)? {
            progress.advance(entry.size)?;
            continue;
        }
        let expected =
            match conflict::destination(&sftp, &mut entry, &mut progress, &reserved, &original)? {
                Destination::Skip => {
                    if progress
                        .transfer
                        .partial
                        .as_ref()
                        .is_some_and(|partial| partial.under(&entry))
                    {
                        resume::discard_verified(
                            &session,
                            &sftp,
                            progress.transfer,
                            progress.cancelled,
                        )?;
                        progress.transfer.partial = None;
                    }
                    progress.transfer.skipped_paths.insert(original);
                    progress.transfer.skipped_files = progress.transfer.skipped_paths.len();
                    persist(progress.state, progress.transfer)?;
                    progress.advance(entry.size)?;
                    continue;
                }
                Destination::Write(expected) => expected,
            };
        if entry.directory {
            if direction == "upload" {
                remote_directory(&sftp, Path::new(&entry.destination), entry.mode)?;
            } else {
                local_directory(Path::new(&entry.destination))?;
            }
        } else if protocol == "sftp" {
            resume::copy(&session, &sftp, &entry, expected.as_ref(), &mut progress)?;
        } else {
            copy_scp(&session, &sftp, &entry, expected.as_ref(), &mut progress)?;
        }
    }
    if progress.transfer.partial.is_some() {
        return Err("The interrupted source is missing from this folder. Restart after checking its contents.".into());
    }
    Ok(())
}

fn concurrency(state: &AppState) -> usize {
    state
        .config()
        .ok()
        .and_then(|config| config["settings"]["transferConcurrency"].as_u64())
        .unwrap_or(3)
        .clamp(1, 8) as usize
}

fn open_transfer_session(state: &AppState, transfer: &Transfer) -> Result<Session, String> {
    let binding = transfer.binding.as_ref().ok_or(
        "This saved transfer has no verified session binding. Reconnect and start a new transfer.",
    )?;
    state.open_bound_session(binding)
}

fn enqueue(
    state: &AppState,
    app: &tauri::AppHandle,
    mut transfer: Transfer,
) -> Result<Value, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let (lock, condition) = queue();
    let mut queue_state = lock.lock().map_err(|e| e.to_string())?;
    if queue_state.jobs.len() >= 256 {
        return Err("Transfer queue is full. Wait for active transfers to finish".into());
    }
    if queue_state.jobs.values().any(|job| {
        job.destination == transfer.destination
            && job.direction == transfer.direction
            && (job.direction == "download" || job.host_id == transfer.host_id)
    }) {
        return Err("A transfer to this destination is already queued".into());
    }
    persist(state, &transfer)?;
    queue_state.jobs.insert(
        transfer.id.clone(),
        JobControl {
            cancelled: cancelled.clone(),
            destination: transfer.destination.clone(),
            direction: transfer.direction.clone(),
            host_id: transfer.host_id.clone(),
            batch: conflict::scope(&transfer),
            conflict: None,
            decision: None,
        },
    );
    drop(queue_state);
    let response = serde_json::to_value(&transfer).map_err(|e| e.to_string())?;
    let worker_state = state.clone();
    let worker_app = app.clone();
    let failed_id = transfer.id.clone();
    let limit = concurrency(state);
    let spawn = std::thread::Builder::new()
        .name(format!("transfer-{}", transfer.id))
        .spawn(move || {
            let (lock, condition) = queue();
            let mut queue_state = lock.lock().unwrap_or_else(|p| p.into_inner());
            while queue_state.running >= limit && !cancelled.load(Ordering::Acquire) {
                queue_state = condition
                    .wait(queue_state)
                    .unwrap_or_else(|p| p.into_inner());
            }
            let active = !cancelled.load(Ordering::Acquire);
            if active {
                queue_state.running += 1;
            }
            drop(queue_state);
            let started = Instant::now();
            transfer.status = if active { "running" } else { "cancelled" }.into();
            transfer.started_at = now();
            let result = publish(&worker_state, &worker_app, &transfer)
                .and_then(|_| execute(&worker_state, &worker_app, &mut transfer, &cancelled));
            transfer.status = match &result {
                Ok(_) if transfer.skipped_paths.contains(&transfer.destination) => "skipped",
                Ok(_) => "completed",
                Err(_) if cancelled.load(Ordering::Acquire) => "cancelled",
                Err(_) => "failed",
            }
            .into();
            transfer.conflict = None;
            transfer.resumable =
                transfer.protocol == "sftp" && transfer.partial.is_some() && result.is_err();
            transfer.error = result.err();
            transfer.finished_at = Some(now());
            transfer.duration_seconds = Some(started.elapsed().as_secs_f64());
            transfer.eta_seconds = None;
            // Serialize the terminal event with admitting a retry for this transfer.
            let mut queue_state = lock.lock().unwrap_or_else(|p| p.into_inner());
            if let Err(error) = publish(&worker_state, &worker_app, &transfer) {
                transfer.error = Some(format!("Transfer state could not be saved: {error}"));
                let _ = worker_app.emit("transfer-progress", &transfer);
            }
            if active {
                queue_state.running = queue_state.running.saturating_sub(1);
            }
            queue_state.jobs.remove(&transfer.id);
            condition.notify_all();
        });
    if let Err(error) = spawn {
        let mut queue_state = lock.lock().map_err(|e| e.to_string())?;
        queue_state.jobs.remove(&failed_id);
        condition.notify_all();
        let mut record = get_transfer(state, &failed_id)?;
        record.status = "failed".into();
        record.error = Some(error.to_string());
        persist(state, &record)?;
        return Err(error.to_string());
    }
    Ok(response)
}

fn downloaded_file(transfer: &Transfer) -> Result<&Path, String> {
    if transfer.direction != "download" || transfer.status != "completed" {
        return Err("Choose a completed download to show in Explorer".into());
    }
    let destination = transfer
        .renamed_paths
        .get(&transfer.destination)
        .unwrap_or(&transfer.destination);
    let path = Path::new(destination);
    if !transfer.completed_files.contains_key(destination)
        || !path.is_absolute()
        || !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
    {
        return Err("The downloaded file is no longer available at its saved location".into());
    }
    Ok(path)
}

#[cfg(windows)]
fn show_in_explorer(path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let windows = std::env::var_os("SystemRoot").ok_or("Windows folder is unavailable")?;
    // Explorer takes /select and its quoted filename as one comma-delimited argument.
    // Pass it directly to Explorer, with no command interpreter or file association.
    std::process::Command::new(Path::new(&windows).join("explorer.exe"))
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open File Explorer: {error}"))
}

#[cfg(not(windows))]
fn show_in_explorer(_: &Path) -> Result<(), String> {
    Err("Show in Explorer requires Windows".into())
}

pub fn dispatch(
    state: &AppState,
    app: &tauri::AppHandle,
    action: &str,
    payload: Value,
) -> Result<Value, String> {
    initialize(state)?;
    match action {
        "transfer_list" => {
            let db = state.db()?;
            let mut statement=db.prepare("SELECT record FROM vexssh_transfers ORDER BY updated_at DESC, rowid DESC LIMIT 1000").map_err(|e|e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            let records: Result<Vec<Value>, String> = rows
                .map(|row| {
                    let mut transfer: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    if transfer["resumable"] == true && transfer["routeToken"].is_null() {
                        if let Ok(binding) = serde_json::from_value::<crate::storage::SessionBinding>(transfer["binding"].clone()) {
                            transfer["routeToken"] = json!(binding.route_token()?);
                        }
                    }
                    Ok(transfer)
                })
                .collect();
            Ok(json!(records?))
        }
        "transfer_reveal" => {
            let transfer = get_transfer(state, files::text(&payload, "id")?)?;
            show_in_explorer(downloaded_file(&transfer)?)?;
            Ok(json!(true))
        }
        "transfer_start" => {
            let direction = files::text(&payload, "direction")?;
            let protocol = files::text(&payload, "protocol")?;
            if !["upload", "download"].contains(&direction) || !["sftp", "scp"].contains(&protocol)
            {
                return Err("Choose upload/download and sftp/scp".into());
            }
            let session_id = files::text(&payload, "sessionId")?;
            let binding = state.session_binding(session_id)?;
            let source = files::text(&payload, "source")?;
            let destination = files::text(&payload, "destination")?;
            if source.contains(['\r', '\n']) || destination.contains(['\r', '\n']) {
                return Err("Paths containing line breaks cannot be transferred".into());
            }
            enqueue(
                state,
                app,
                Transfer {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: session_id.into(),
                    tab_id: payload["tabId"].as_str().map(str::to_owned),
                    route_token: Some(binding.route_token()?),
                    host_id: binding.host_id.clone(),
                    binding: Some(binding),
                    source: source.into(),
                    destination: destination.into(),
                    direction: direction.into(),
                    protocol: protocol.into(),
                    status: "queued".into(),
                    total_bytes: 0,
                    transferred_bytes: 0,
                    speed_bytes_per_second: 0.0,
                    eta_seconds: None,
                    error: None,
                    started_at: now(),
                    finished_at: None,
                    duration_seconds: None,
                    completed_files: HashMap::new(),
                    partial: None,
                    restart_requested: false,
                    resumable: false,
                    resumed_bytes: 0,
                    conflict: None,
                    batch_id: payload["batchId"]
                        .as_str()
                        .map(|s| {
                            uuid::Uuid::parse_str(s)
                                .map(|u| u.to_string())
                                .map_err(|_| "Invalid transfer batch")
                        })
                        .transpose()?,
                    skipped_files: 0,
                    skipped_paths: Default::default(),
                    renamed_paths: HashMap::new(),
                },
            )
        }
        "transfer_cancel" => {
            let id = files::text(&payload, "id")?;
            let (lock, condition) = queue();
            let queue_state = lock.lock().map_err(|e| e.to_string())?;
            let job = queue_state
                .jobs
                .get(id)
                .ok_or("Transfer is no longer active")?;
            job.cancelled.store(true, Ordering::Release);
            condition.notify_all();
            Ok(json!(true))
        }
        "transfer_resolve" => conflict::resolve(state, &payload),
        "transfer_retry" | "transfer_resume" => {
            let mut transfer = get_transfer(state, files::text(&payload, "id")?)?;
            if transfer.status != "failed" && transfer.status != "cancelled" {
                return Err("Only failed or cancelled transfers can be retried".into());
            }
            if action == "transfer_resume"
                && (!transfer.resumable
                    || transfer.protocol != "sftp"
                    || transfer.partial.is_none())
            {
                return Err("This transfer has no resumable SFTP partial".into());
            }
            transfer.restart_requested = action == "transfer_retry" && transfer.partial.is_some();
            if let Some(required) = payload["requiredSessionId"].as_str() {
                let binding = state.session_binding(required)?;
                if Some(&binding) != transfer.binding.as_ref() ||
                    transfer.tab_id.as_deref().is_some_and(|tab| Some(tab) != payload["tabId"].as_str()) {
                    return Err("Reconnect the originating tab to the same verified server before resuming".into());
                }
                transfer.route_token = Some(binding.route_token()?);
                transfer.session_id = required.to_owned();
            } else if let Some(preferred) = payload["preferredSessionId"].as_str() {
                if state
                    .session_binding(preferred)
                    .ok()
                    .as_ref()
                    .is_some_and(|binding| Some(binding) == transfer.binding.as_ref())
                {
                    transfer.session_id = preferred.into();
                }
            }
            transfer.resumable = false;
            transfer.resumed_bytes = 0;
            transfer.status = "queued".into();
            transfer.total_bytes = 0;
            transfer.transferred_bytes = 0;
            transfer.speed_bytes_per_second = 0.0;
            transfer.eta_seconds = None;
            transfer.error = None;
            transfer.started_at = now();
            transfer.finished_at = None;
            transfer.duration_seconds = None;
            enqueue(state, app, transfer)
        }
        _ => Err("Unknown transfer action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explorer_only_reveals_a_published_download_at_its_actual_path() {
        let folder = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&folder).unwrap();
        let requested = folder.join("logs.txt");
        let saved = folder.join("logs (1).txt");
        fs::write(&saved, b"saved").unwrap();
        let mut transfer: Transfer = serde_json::from_value(json!({
            "id":"test","sessionId":"one","hostId":"host","source":"/logs.txt",
            "destination":requested,"direction":"download","protocol":"sftp","status":"completed",
            "totalBytes":5,"transferredBytes":5,"speedBytesPerSecond":0,"startedAt":0,
            "completedFiles":{},"renamedPaths":{}
        })).unwrap();
        let actual = saved.to_str().unwrap().to_owned();
        transfer.renamed_paths.insert(transfer.destination.clone(), actual.clone());
        assert!(downloaded_file(&transfer).is_err());
        transfer.completed_files.insert(actual, "file stamp".into());
        assert_eq!(downloaded_file(&transfer).unwrap(), saved);
        transfer.status = "conflict".into();
        assert!(downloaded_file(&transfer).is_err());
        transfer.status = "completed".into();
        transfer.direction = "upload".into();
        assert!(downloaded_file(&transfer).is_err());
        transfer.direction = "download".into();
        fs::remove_file(saved).unwrap();
        assert!(downloaded_file(&transfer).is_err());
        fs::remove_dir(folder).unwrap();
    }
    #[test]
    fn restored_transfer_keeps_original_binding_and_rejects_profile_redirection() {
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let state = AppState::new(directory.clone()).unwrap();
        state.save_config(json!({"hosts":[{"id":"target","hostname":"127.0.0.1","port":22001,"username":"core"}]})).unwrap();
        crate::security::trust_host(&state, "target", "127.0.0.1", 22001, "SHA256:original")
            .unwrap();
        let original = state.capture_binding("target").unwrap();
        let record = json!({"id":"queued-before-edit","sessionId":"old-session","hostId":"target","binding":original,"source":"local-file","destination":"/remote-file","direction":"upload","protocol":"sftp","status":"failed","totalBytes":0,"transferredBytes":0,"speedBytesPerSecond":0.0,"etaSeconds":null,"error":null,"startedAt":0,"finishedAt":null,"durationSeconds":null});
        let stored: Transfer = serde_json::from_value(record.clone()).unwrap();
        state.db().unwrap().execute_batch("CREATE TABLE vexssh_transfers (id TEXT PRIMARY KEY, record TEXT NOT NULL, updated_at INTEGER NOT NULL)").unwrap();
        persist(&state, &stored).unwrap();
        drop(state);
        let state = AppState::new(directory.clone()).unwrap();
        let mut retry = get_transfer(&state, "queued-before-edit").unwrap();
        assert_eq!(retry.binding.as_ref(), Some(&original));
        retry.id = "retry-after-edit".into();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        state.save_config(json!({"hosts":[{"id":"target","hostname":"127.0.0.1","port":port,"username":"core"}]})).unwrap();
        crate::security::trust_host(&state, "target", "127.0.0.1", port, "SHA256:new").unwrap();
        assert!(open_transfer_session(&state, &retry)
            .err()
            .unwrap()
            .contains("Reconnect"));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let mut legacy = record;
        legacy.as_object_mut().unwrap().remove("binding");
        let legacy: Transfer = serde_json::from_value(legacy).unwrap();
        assert!(open_transfer_session(&state, &legacy)
            .err()
            .unwrap()
            .contains("no verified session binding"));
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn collects_nested_folders_and_empty_files() {
        let folder = std::env::temp_dir().join(format!("vexssh-transfer-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/data.txt"), b"contents").unwrap();
        fs::write(folder.join("empty"), b"").unwrap();
        let mut entries = Vec::new();
        collect_upload(
            &folder,
            "/destination",
            &mut entries,
            0,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(entries.iter().map(|entry| entry.size).sum::<u64>(), 8);
        assert!(entries
            .iter()
            .any(|entry| entry.destination == "/destination/nested/data.txt"));
        assert!(entries
            .iter()
            .any(|entry| entry.destination == "/destination/empty" && entry.size == 0));
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn cancellation_stops_folder_scan() {
        assert!(collect_upload(
            Path::new("."),
            "/destination",
            &mut Vec::new(),
            0,
            &AtomicBool::new(true)
        )
        .is_err());
    }
    #[test]
    fn directory_creation_refuses_existing_files() {
        let file = std::env::temp_dir().join(format!("vexssh-existing-{}", uuid::Uuid::new_v4()));
        fs::write(&file, b"keep").unwrap();
        assert!(local_directory(&file).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"keep");
        fs::remove_file(file).unwrap();
    }
    #[test]
    fn publishing_download_never_overwrites_a_concurrent_destination() {
        let directory =
            std::env::temp_dir().join(format!("vexssh-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let temporary = directory.join("download.part");
        let destination = directory.join("download.txt");
        fs::write(&temporary, b"new download").unwrap();
        fs::write(&destination, b"existing content").unwrap();
        assert!(publish_download(&temporary, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing content");
        assert_eq!(fs::read(&temporary).unwrap(), b"new download");
        fs::remove_file(&destination).unwrap();
        publish_download(&temporary, &destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new download");
        assert!(!temporary.exists());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    #[ignore = "Requires VEXSSH_TEST_CONNECTION pointing to an isolated loopback SSH fixture"]
    fn live_sftp_scp_round_trip_and_editor_atomic_write() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let fixture_path =
            std::env::var("VEXSSH_TEST_CONNECTION").expect("VEXSSH_TEST_CONNECTION is required");
        let fixture: Value = serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
        let hostname = fixture["hostname"].as_str().unwrap();
        assert_eq!(
            hostname, "127.0.0.1",
            "Integration tests only connect to loopback"
        );
        let socket =
            std::net::TcpStream::connect((hostname, fixture["port"].as_u64().unwrap() as u16))
                .unwrap();
        let mut session = Session::new().unwrap();
        session.set_tcp_stream(socket);
        session.set_timeout(10_000);
        session.handshake().unwrap();
        let (key, _) = session.host_key().unwrap();
        let fingerprint = format!(
            "SHA256:{}",
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key))
        );
        assert_eq!(fingerprint, fixture["fingerprint"].as_str().unwrap());
        session
            .userauth_password(
                fixture["username"].as_str().unwrap(),
                fixture["password"].as_str().unwrap(),
            )
            .unwrap();
        let sftp = session.sftp().unwrap();
        assert!(files::remote_bytes(&sftp, Path::new("/hello.txt"))
            .unwrap()
            .starts_with(b"VEXSSH"));
        let directory = format!("/vexssh-files-test-{}", uuid::Uuid::new_v4());
        remote_directory(&sftp, Path::new(&directory), 0o700).unwrap();
        let path = files::remote_join(&directory, "quoted ' name $value;sample.txt").unwrap();
        let content = b"actual SCP and SFTP transfer\n";
        {
            let mut upload = session
                .scp_send(Path::new(&path), 0o600, content.len() as u64, None)
                .unwrap();
            upload.write_all(content).unwrap();
            upload.send_eof().unwrap();
            upload.wait_eof().unwrap();
            upload.close().unwrap();
            upload.wait_close().unwrap();
            assert_eq!(upload.exit_status().unwrap(), 0);
        }
        assert_eq!(
            files::remote_bytes(&sftp, Path::new(&path)).unwrap(),
            content
        );
        {
            let (mut download, stat) = session.scp_recv(Path::new(&path)).unwrap();
            assert_eq!(stat.size(), content.len() as u64);
            let mut received = vec![0; stat.size() as usize];
            download.read_exact(&mut received).unwrap();
            download.send_eof().unwrap();
            download.wait_eof().unwrap();
            download.close().unwrap();
            download.wait_close().unwrap();
            assert_eq!(received, content);
        }
        let saved = files::save_remote(
            &session,
            &sftp,
            Path::new(&path),
            b"edited via SFTP",
            &files::revision(content),
            true,
        )
        .unwrap();
        let backup = Path::new(saved["backupPath"].as_str().unwrap());
        assert_eq!(files::remote_bytes(&sftp, backup).unwrap(), content);
        assert!(files::save_remote(
            &session,
            &sftp,
            Path::new(&path),
            b"stale overwrite",
            &files::revision(content),
            true
        )
        .is_err());
        sftp.unlink(backup).unwrap();
        assert_eq!(
            files::remote_bytes(&sftp, Path::new(&path)).unwrap(),
            b"edited via SFTP"
        );
        assert!(remote_directory(&sftp, Path::new(&path), 0o700).is_err());
        let mut entries = Vec::new();
        collect_download(
            &sftp,
            &directory,
            Path::new("test-download"),
            &mut entries,
            0,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].size, 15);
        sftp.unlink(Path::new(&path)).unwrap();
        sftp.rmdir(Path::new(&directory)).unwrap();
    }
}
