use super::*;
use std::io::{Seek, SeekFrom};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Partial {
    source: String,
    destination: String,
    nonce: String,
    size: u64,
    modified: Option<u64>,
    source_sha256: String,
    verified_bytes: u64,
    prefix_sha256: String,
}
impl Partial {
    pub(super) fn under(&self, entry: &Entry) -> bool {
        Path::new(&self.source) == Path::new(&entry.source)
            || (entry.directory && Path::new(&self.source).starts_with(&entry.source))
    }
}

fn hash_prefix(reader: &mut impl Read, size: u64, cancel: &AtomicBool) -> Result<Sha256, String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    let mut remaining = size;
    while remaining != 0 {
        check_cancel(cancel)?;
        let n = remaining.min(buffer.len() as u64) as usize;
        reader
            .read_exact(&mut buffer[..n])
            .map_err(|e| e.to_string())?;
        digest.update(&buffer[..n]);
        remaining -= n as u64;
    }
    Ok(digest)
}

fn hex(digest: &Sha256) -> String {
    format!("{:x}", digest.clone().finalize())
}

// Most Linux hosts can hash on the server. SFTP-only accounts use the protocol stream.
fn remote_hash(
    session: &Session,
    sftp: &Sftp,
    path: &str,
    cancel: &AtomicBool,
    download_limit: &bandwidth::RateLimit,
) -> Result<String, String> {
    files::remote_regular(sftp, Path::new(path))?;
    let shell_hash = || -> Result<String, String> {
        let mut channel = session.channel_session().map_err(|e| e.to_string())?;
        let quoted = path.replace('\'', "'\\''");
        channel
            .exec(&format!("sha256sum < '{quoted}'"))
            .map_err(|e| e.to_string())?;
        let mut bytes = vec![];
        (&mut channel)
            .take(200)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() == 200 {
            return Err("Unexpected hash response".into());
        }
        channel.wait_close().map_err(|e| e.to_string())?;
        let output = std::str::from_utf8(&bytes).unwrap_or("");
        let hash = output.split_whitespace().next().unwrap_or("");
        if channel.exit_status().ok() != Some(0)
            || hash.len() != 64
            || !hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("No server-side SHA-256 support".into());
        }
        Ok(hash.to_ascii_lowercase())
    };
    check_cancel(cancel)?;
    shell_hash().or_else(|_| {
        checksum(
            sftp.open(Path::new(path)).map_err(|e| e.to_string())?,
            cancel,
            Some(download_limit),
        )
    })
}

fn stage_name(destination: &str, nonce: &str) -> Result<PathBuf, String> {
    let nonce = uuid::Uuid::parse_str(nonce).map_err(|_| "Invalid partial-file identity")?;
    Ok(PathBuf::from(format!("{destination}.nexssh-{nonce}.part")))
}

pub(super) fn discard_verified(
    session: &Session,
    sftp: &Sftp,
    transfer: &Transfer,
    cancel: &AtomicBool,
    download_limit: &bandwidth::RateLimit,
) -> Result<(), String> {
    let Some(partial) = &transfer.partial else {
        return Ok(());
    };
    let path = stage_name(&partial.destination, &partial.nonce)?;
    let staged = path.to_str().ok_or("Invalid staging path")?;
    let upload = transfer.direction == "upload";
    let Some(stamp) = conflict::inspect(sftp, upload, staged)? else {
        return Ok(());
    };
    if !stamp.regular || stamp.size != Some(partial.verified_bytes) {
        return Ok(());
    }
    let digest = if upload {
        remote_hash(session, sftp, staged, cancel, download_limit)?
    } else {
        checksum(fs::File::open(&path).map_err(|e| e.to_string())?, cancel, None)?
    };
    if digest == partial.prefix_sha256 {
        if upload {
            sftp.unlink(&path).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn copy_tail(
    reader: &mut impl Read,
    writer: &mut impl Write,
    offset: u64,
    mut digest: Sha256,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let mut offset = offset;
    let size = progress.transfer.partial.as_ref().unwrap().size;
    let limits = &progress.state.inner.sftp_bandwidth;
    let limit = if progress.transfer.direction == "upload" {
        &limits.upload
    } else {
        &limits.download
    };
    let mut buffer = [0u8; 65536];
    while offset < size {
        let remaining = (size - offset).min(buffer.len() as u64) as usize;
        let n = limit.grant(remaining, progress.cancelled)?;
        reader
            .read_exact(&mut buffer[..n])
            .map_err(|e| format!("Could not read source: {e}"))?;
        writer
            .write_all(&buffer[..n])
            .map_err(|e| format!("Could not write partial file: {e}"))?;
        digest.update(&buffer[..n]);
        offset += n as u64;
        let partial = progress.transfer.partial.as_mut().unwrap();
        partial.verified_bytes = offset;
        partial.prefix_sha256 = hex(&digest);
        progress.network_bytes += n as u64;
        progress.advance(n as u64)?;
    }
    writer.flush().map_err(|e| e.to_string())?;
    if hex(&digest) != progress.transfer.partial.as_ref().unwrap().source_sha256 {
        return Err("Source contents changed. Start a new transfer.".into());
    }
    Ok(())
}

pub(super) fn copy(
    session: &Session,
    sftp: &Sftp,
    entry: &Entry,
    expected: Option<&conflict::Stamp>,
    progress: &mut Progress<'_>,
) -> Result<(), String> {
    let upload = progress.transfer.direction == "upload";
    let download_limit = &progress.state.inner.sftp_bandwidth.download;
    let verify_source = || -> Result<(), String> {
        let source =
            conflict::inspect(sftp, !upload, &entry.source)?.ok_or("Source no longer exists")?;
        if !source.regular
            || source.size != Some(entry.size)
            || (entry.modified.is_some() && source.modified != entry.modified)
        {
            return Err(
                "Source changed during transfer. Restart after checking the source file.".into(),
            );
        }
        Ok(())
    };
    verify_source()?;
    let source_hash = if upload {
        checksum(
            fs::File::open(&entry.source).map_err(|e| e.to_string())?,
            progress.cancelled,
            None,
        )?
    } else {
        remote_hash(session, sftp, &entry.source, progress.cancelled, download_limit)?
    };
    let existing = progress.transfer.partial.clone();
    let partial = if let Some(partial) = &existing {
        if partial.source != entry.source
            || (partial.destination != entry.destination
                && !progress
                    .transfer
                    .renamed_paths
                    .get(&partial.destination)
                    .is_some_and(|name| name == &entry.destination))
            || partial.size != entry.size
            || partial.modified != entry.modified
            || partial.source_sha256 != source_hash
        {
            return Err(
                "Source or destination changed since interruption. Start a new transfer.".into(),
            );
        }
        partial.clone()
    } else {
        Partial {
            source: entry.source.clone(),
            destination: entry.destination.clone(),
            nonce: uuid::Uuid::new_v4().to_string(),
            size: entry.size,
            modified: entry.modified,
            source_sha256: source_hash.clone(),
            verified_bytes: 0,
            prefix_sha256: hex(&Sha256::new()),
        }
    };
    let stage = stage_name(&partial.destination, &partial.nonce)?;
    let staged = stage.to_str().ok_or("Invalid partial-file path")?;
    let has_stage = conflict::inspect(sftp, upload, staged)?.is_some();
    if has_stage && existing.is_none() {
        return Err("Partial-file name is already in use".into());
    }
    if !has_stage && partial.verified_bytes != 0 {
        return Err("Partial file is missing. Start a new transfer.".into());
    }
    progress.transfer.partial = Some(partial.clone());
    persist(progress.state, progress.transfer)?;
    if upload {
        let mut source = fs::File::open(&entry.source).map_err(|e| e.to_string())?;
        let offset = if has_stage {
            files::remote_regular(sftp, &stage)?
                .size
                .ok_or("Missing partial-file size")?
        } else {
            0
        };
        if offset > entry.size {
            return Err("Partial file exceeds source size. Start a new transfer.".into());
        }
        let digest = hash_prefix(&mut source, offset, progress.cancelled)?;
        if has_stage
            && remote_hash(session, sftp, staged, progress.cancelled, download_limit)? != hex(&digest)
        {
            return Err("Partial file contents changed. Start a new transfer.".into());
        }
        let flags = if has_stage {
            OpenFlags::WRITE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE
        };
        let mut target = sftp
            .open_mode(&stage, flags, entry.mode, OpenType::File)
            .map_err(|e| e.to_string())?;
        if target.stat().map_err(|e| e.to_string())?.size != Some(offset) {
            return Err("Partial file changed during verification".into());
        }
        target
            .seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        progress.transfer.resumed_bytes += offset;
        progress.advance(offset)?;
        copy_tail(&mut source, &mut target, offset, digest, progress)?;
        target.close().map_err(|e| e.to_string())?;
        if remote_hash(session, sftp, staged, progress.cancelled, download_limit)? != source_hash {
            return Err("Uploaded file failed SHA-256 verification".into());
        }
    } else {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create_new(!has_stage);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
        }
        let mut target = options.open(&stage).map_err(|e| e.to_string())?;
        let metadata = target.metadata().map_err(|e| e.to_string())?;
        let offset = metadata.len();
        if !metadata.is_file() || offset > entry.size || offset < partial.verified_bytes {
            return Err("Partial file was replaced or truncated. Start a new transfer.".into());
        }
        let mut digest = hash_prefix(&mut target, partial.verified_bytes, progress.cancelled)?;
        if hex(&digest) != partial.prefix_sha256 {
            return Err("Partial file contents changed. Start a new transfer.".into());
        }
        let mut source = sftp
            .open(Path::new(&entry.source))
            .map_err(|e| e.to_string())?;
        source
            .seek(SeekFrom::Start(partial.verified_bytes))
            .map_err(|e| e.to_string())?;
        // A crash can leave a few bytes on disk beyond the last durable database checkpoint.
        let mut a = [0u8; 65536];
        let mut b = [0u8; 65536];
        let mut extra = offset - partial.verified_bytes;
        while extra > 0 {
            let n = download_limit.grant(extra.min(a.len() as u64) as usize, progress.cancelled)?;
            source.read_exact(&mut a[..n]).map_err(|e| e.to_string())?;
            target.read_exact(&mut b[..n]).map_err(|e| e.to_string())?;
            if a[..n] != b[..n] {
                return Err("Partial file contents changed. Start a new transfer.".into());
            }
            digest.update(&a[..n]);
            extra -= n as u64;
        }
        progress.transfer.resumed_bytes += offset;
        progress.advance(offset)?;
        copy_tail(&mut source, &mut target, offset, digest, progress)?;
        target.sync_all().map_err(|e| e.to_string())?;
    }
    check_cancel(progress.cancelled)?;
    verify_source()?;
    conflict::publish_file(session, sftp, entry, &stage, upload, expected)?;
    progress
        .transfer
        .completed_files
        .insert(entry.destination.clone(), source_hash);
    progress.transfer.partial = None;
    progress.transfer.resumable = false;
    persist(progress.state, progress.transfer)?;
    Ok(())
}
