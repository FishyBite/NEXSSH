use super::*;

#[derive(Copy, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Choice {
    Skip,
    KeepBoth,
    Replace,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Conflict {
    token: String,
    source: String,
    destination: String,
    source_size: u64,
    destination_size: Option<u64>,
    source_modified: Option<u64>,
    destination_modified: Option<u64>,
    can_replace: bool,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) regular: bool,
    directory: bool,
    pub(super) size: Option<u64>,
    pub(super) modified: Option<u64>,
}

pub(super) fn inspect(sftp: &Sftp, upload: bool, path: &str) -> Result<Option<Stamp>, String> {
    if upload {
        match sftp.lstat(Path::new(path)) {
            Ok(stat) => Ok(Some(Stamp {
                regular: stat.is_file(),
                directory: stat.is_dir(),
                size: stat.size,
                modified: stat.mtime,
            })),
            Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    } else {
        match fs::symlink_metadata(path) {
            Ok(meta) => Ok(Some(Stamp {
                regular: meta.file_type().is_file(),
                directory: meta.file_type().is_dir(),
                size: Some(meta.len()),
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|time| time.as_secs()),
            })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }
}

pub(super) enum Destination {
    Write(Option<Stamp>),
    Skip,
}

pub(super) fn scope(transfer: &Transfer) -> String {
    json!([
        transfer.batch_id.as_ref().unwrap_or(&transfer.id),
        transfer.direction,
        transfer.binding
    ])
    .to_string()
}

fn key(path: &str, upload: bool) -> String {
    if upload {
        path.into()
    } else {
        path.replace('/', "\\").to_lowercase()
    }
}

fn keep_both(
    sftp: &Sftp,
    upload: bool,
    entry: &Entry,
    reserved: &std::collections::HashSet<String>,
) -> Result<String, String> {
    let path = Path::new(&entry.destination);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid destination file name")?;
    let (stem, ext) = if entry.directory {
        (name, String::new())
    } else {
        (
            path.file_stem().and_then(|s| s.to_str()).unwrap_or(name),
            path.extension()
                .and_then(|s| s.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default(),
        )
    };
    for n in 1..=10000 {
        let leaf = format!("{stem} ({n}){ext}");
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let candidate = if upload {
            files::remote_join(&parent.to_string_lossy(), &leaf)?
        } else {
            parent.join(leaf).to_string_lossy().into_owned()
        };
        if !reserved.contains(&key(&candidate, upload))
            && inspect(sftp, upload, &candidate)?.is_none()
        {
            return Ok(candidate);
        }
    }
    Err("Could not find an available destination name".into())
}

pub(super) fn reserved(entries: &[Entry], upload: bool) -> std::collections::HashSet<String> {
    entries
        .iter()
        .map(|entry| key(&entry.destination, upload))
        .collect()
}

fn policy(state: &AppState, batch: &str) -> Result<Option<Choice>, String> {
    use rusqlite::OptionalExtension;
    let policy: Option<String> = state
        .db()?
        .query_row(
            "SELECT policy FROM transfer_conflict_policies WHERE batch=?1",
            [batch],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    policy
        .map(|s| serde_json::from_value(json!(s)).map_err(|e| e.to_string()))
        .transpose()
}

pub(super) fn resolve(state: &AppState, payload: &Value) -> Result<Value, String> {
    let id = files::text(payload, "id")?;
    let token = files::text(payload, "token")?;
    let choice: Choice = serde_json::from_value(payload["choice"].clone())
        .map_err(|_| "Select a conflict action")?;
    let (lock, condition) = queue();
    let mut queue = lock.lock().map_err(|e| e.to_string())?;
    let job = queue
        .jobs
        .get_mut(id)
        .ok_or("This transfer is no longer waiting for a decision")?;
    let (current, replace_allowed) = job
        .conflict
        .as_ref()
        .ok_or("This conflict is no longer active")?;
    if current != token || job.decision.is_some() {
        return Err("The conflict has changed. Review the current file.".into());
    }
    if matches!(choice, Choice::Replace) && !replace_allowed {
        return Err("Only regular files can be replaced".into());
    }
    if payload["applyToAll"].as_bool().unwrap_or(false) {
        state
            .db()?
            .execute(
                "INSERT OR REPLACE INTO transfer_conflict_policies(batch,policy) VALUES (?1,?2)",
                params![job.batch, payload["choice"].as_str()],
            )
            .map_err(|e| e.to_string())?;
    }
    job.decision = Some(choice);
    condition.notify_all();
    Ok(Value::Null)
}

fn decide(
    entry: &Entry,
    stamp: &Stamp,
    progress: &mut Progress<'_>,
    force_prompt: bool,
) -> Result<Choice, String> {
    let batch = scope(progress.transfer);
    let can_replace = !entry.directory && stamp.regular;
    let applicable = |choice: &Choice| !matches!(choice, Choice::Replace) || can_replace;
    if !force_prompt {
        if let Some(choice) = policy(progress.state, &batch)?.filter(applicable) {
            return Ok(choice);
        }
    }
    let token = uuid::Uuid::new_v4().to_string();
    let (lock, condition) = queue();
    {
        let mut queue = lock.lock().map_err(|e| e.to_string())?;
        let job = queue
            .jobs
            .get_mut(&progress.transfer.id)
            .ok_or("Transfer is no longer active")?;
        job.conflict = Some((token.clone(), can_replace));
        job.decision = None;
    }
    progress.transfer.conflict = Some(Conflict {
        token,
        source: entry.source.clone(),
        destination: entry.destination.clone(),
        source_size: entry.size,
        destination_size: stamp.size,
        source_modified: entry.modified,
        destination_modified: stamp.modified,
        can_replace,
    });
    progress.transfer.status = "conflict".into();
    progress.publish()?;
    let mut queue = lock.lock().map_err(|e| e.to_string())?;
    let choice = loop {
        check_cancel(progress.cancelled)?;
        let job = queue
            .jobs
            .get_mut(&progress.transfer.id)
            .ok_or("Transfer is no longer active")?;
        if let Some(choice) = job.decision.take() {
            break choice;
        }
        if !force_prompt {
            if let Some(choice) = policy(progress.state, &batch)?.filter(applicable) {
                break choice;
            }
        }
        queue = condition.wait(queue).map_err(|e| e.to_string())?;
    };
    if let Some(job) = queue.jobs.get_mut(&progress.transfer.id) {
        job.conflict = None;
    }
    drop(queue);
    progress.transfer.conflict = None;
    progress.transfer.status = "running".into();
    progress.publish()?;
    Ok(choice)
}

pub(super) fn destination(
    sftp: &Sftp,
    entry: &mut Entry,
    progress: &mut Progress<'_>,
    reserved: &std::collections::HashSet<String>,
    original: &str,
) -> Result<Destination, String> {
    let upload = progress.transfer.direction == "upload";
    let mut force_prompt = false;
    while let Some(stamp) = inspect(sftp, upload, &entry.destination)? {
        if entry.directory && stamp.directory {
            break;
        }
        let choice = decide(entry, &stamp, progress, force_prompt)?;
        match choice {
            Choice::Skip => return Ok(Destination::Skip),
            Choice::KeepBoth => {
                let name = keep_both(sftp, upload, entry, reserved)?;
                progress
                    .transfer
                    .renamed_paths
                    .insert(original.to_owned(), name.clone());
                entry.destination = name;
                persist(progress.state, progress.transfer)?;
                break;
            }
            Choice::Replace => {
                if inspect(sftp, upload, &entry.destination)?.as_ref() == Some(&stamp) {
                    return Ok(Destination::Write(Some(stamp)));
                }
                force_prompt = true;
            }
        }
    }
    Ok(Destination::Write(None))
}

pub(super) fn publish_file(
    session: &Session,
    sftp: &Sftp,
    entry: &Entry,
    staged: &Path,
    upload: bool,
    expected: Option<&Stamp>,
) -> Result<(), String> {
    let path = Path::new(&entry.destination);
    if inspect(sftp, upload, &entry.destination)?.as_ref() != expected {
        return Err("Destination changed during the transfer. Review it before retrying.".into());
    }
    match (upload, expected.is_some()) {
        (true, true) => files::atomic_remote_rename(session, staged, path),
        (true, false) => sftp
            .rename(staged, path, Some(RenameFlags::empty()))
            .map_err(|e| e.to_string()),
        (false, true) => fs::rename(staged, path).map_err(|e| e.to_string()),
        (false, false) => publish_download(staged, path),
    }
}
