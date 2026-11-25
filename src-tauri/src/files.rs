use crate::AppState;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const EDIT_LIMIT: u64 = 4 * 1024 * 1024;

pub fn text<'a>(payload: &'a Value, key: &str) -> Result<&'a str, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && !v.contains('\0'))
        .ok_or_else(|| format!("Missing or invalid {key}"))
}

pub fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn local_display(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(tail) = text.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{tail}");
        }
        if let Some(tail) = text.strip_prefix(r"\\?\") {
            return tail.to_owned();
        }
    }
    text.into_owned()
}

pub fn remote_join(parent: &str, name: &str) -> Result<String, String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0', '\r', '\n'])
    {
        return Err("Invalid file name".into());
    }
    Ok(format!("{}/{}", parent.trim_end_matches('/'), name))
}

pub fn validate_local_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return Err("Remote filename cannot be represented safely on this system".into());
    }
    #[cfg(windows)]
    {
        let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
        let reserved = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
            "CONIN$", "CONOUT$", "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
        ];
        if name.ends_with(['.', ' '])
            || name.chars().any(|c| c < ' ' || "<>\"|?*".contains(c))
            || reserved.contains(&stem.as_str())
        {
            return Err(format!("Filename {name} is not supported on Windows"));
        }
    }
    Ok(())
}

pub fn remote_regular(sftp: &Sftp, path: &Path) -> Result<FileStat, String> {
    let stat = sftp.lstat(path).map_err(|e| e.to_string())?;
    if !stat.is_file() {
        return Err("Choose a regular file. Symbolic links and special files are not supported for this operation".into());
    }
    Ok(stat)
}

fn read_bytes(mut reader: impl Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take(EDIT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > EDIT_LIMIT {
        return Err("Text editor supports files up to 4 MiB".into());
    }
    if bytes.contains(&0) {
        return Err("This file contains binary data".into());
    }
    Ok(bytes)
}

pub fn local_bytes(path: &Path) -> Result<Vec<u8>, String> {
    if !fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_file()
    {
        return Err("Choose a regular file".into());
    }
    read_bytes(fs::File::open(path).map_err(|e| e.to_string())?)
}

pub fn remote_bytes(sftp: &Sftp, path: &Path) -> Result<Vec<u8>, String> {
    let stat = remote_regular(sftp, path)?;
    if stat.size.unwrap_or(0) > EDIT_LIMIT {
        return Err("Text editor supports files up to 4 MiB".into());
    }
    read_bytes(sftp.open(path).map_err(|e| e.to_string())?)
}

pub(crate) fn preview_remote_path(sftp: &Sftp, path: &str) -> Result<Value, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.len() > 16384
        || path.contains('\\') || path.chars().any(char::is_control)
    {
        return Err("Choose an absolute remote path without control characters".into());
    }
    let canonical = sftp.realpath(Path::new(path)).map_err(|e| e.to_string())?;
    let stat = sftp.lstat(&canonical).map_err(|e| e.to_string())?;
    if stat.is_dir() {
        return Ok(json!({"kind":"directory", "path":canonical.to_string_lossy()}));
    }
    if !stat.is_file() {
        return Err("Only folders and regular text files can be opened from the terminal".into());
    }
    if stat.size.unwrap_or(0) > EDIT_LIMIT {
        return Err("File preview supports files up to 4 MiB".into());
    }
    let bytes = read_bytes(sftp.open(&canonical).map_err(|e| e.to_string())?)?;
    let hash = revision(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| "File preview requires UTF-8 text")?;
    Ok(json!({"kind":"file", "path":canonical.to_string_lossy(), "content":content, "revision":hash}))
}

fn editor_result(path: &str, bytes: Vec<u8>) -> Result<Value, String> {
    let hash = revision(&bytes);
    let content =
        String::from_utf8(bytes).map_err(|_| "Text editor requires UTF-8 encoding".to_string())?;
    Ok(json!({"path":path,"content":content,"revision":hash}))
}

fn ensure_revision(bytes: &[u8], expected: &str) -> Result<(), String> {
    if revision(bytes) != expected {
        return Err(
            "File changed since it was opened. Reload before saving to protect the newer contents"
                .into(),
        );
    }
    Ok(())
}

fn sftp_string(packet: &mut Vec<u8>, value: &[u8]) {
    packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
    packet.extend_from_slice(value);
}

fn send_packet(channel: &mut impl Write, packet: &[u8]) -> Result<(), String> {
    channel
        .write_all(&(packet.len() as u32).to_be_bytes())
        .and_then(|_| channel.write_all(packet))
        .map_err(|e| e.to_string())
}

fn receive_packet(channel: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut length = [0; 4];
    channel.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u32::from_be_bytes(length) as usize;
    if !(5..=65536).contains(&length) {
        return Err("Invalid SFTP response length".into());
    }
    let mut packet = vec![0; length];
    channel.read_exact(&mut packet).map_err(|e| e.to_string())?;
    Ok(packet)
}

fn packet_string<'a>(packet: &'a [u8], offset: &mut usize) -> Result<&'a [u8], String> {
    let end = offset
        .checked_add(4)
        .filter(|end| *end <= packet.len())
        .ok_or("Truncated SFTP response")?;
    let length = u32::from_be_bytes(
        packet[*offset..end]
            .try_into()
            .map_err(|_| "Invalid SFTP length")?,
    ) as usize;
    *offset = end;
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= packet.len())
        .ok_or("Truncated SFTP string")?;
    let value = &packet[*offset..end];
    *offset = end;
    Ok(value)
}

pub(crate) fn atomic_remote_rename(
    session: &Session,
    source: &Path,
    destination: &Path,
) -> Result<(), String> {
    // libssh2's generic rename omits overwrite flags on SFTP v3. Use the negotiated atomic extension.
    let mut channel = session.channel_session().map_err(|e| e.to_string())?;
    channel.subsystem("sftp").map_err(|e| e.to_string())?;
    send_packet(&mut channel, &[1, 0, 0, 0, 3])?;
    let version = receive_packet(&mut channel)?;
    if version[0] != 2 {
        return Err("Server sent an invalid SFTP version response".into());
    }
    let mut offset = 5;
    let mut supported = false;
    while offset < version.len() {
        let name = packet_string(&version, &mut offset)?;
        let value = packet_string(&version, &mut offset)?;
        if name == b"posix-rename@openssh.com" && value == b"1" {
            supported = true;
        }
    }
    if !supported {
        return Err(
            "Server does not support atomic file replacement (posix-rename@openssh.com)".into(),
        );
    }
    let mut packet = vec![200, 0, 0, 0, 1];
    sftp_string(&mut packet, b"posix-rename@openssh.com");
    sftp_string(
        &mut packet,
        source
            .to_str()
            .ok_or("Remote path must be UTF-8")?
            .as_bytes(),
    );
    sftp_string(
        &mut packet,
        destination
            .to_str()
            .ok_or("Remote path must be UTF-8")?
            .as_bytes(),
    );
    send_packet(&mut channel, &packet)?;
    let response = receive_packet(&mut channel)?;
    if response.len() < 9 || response[0] != 101 || response[1..5] != [0, 0, 0, 1] {
        return Err("Server sent an invalid rename response".into());
    }
    let status = u32::from_be_bytes(
        response[5..9]
            .try_into()
            .map_err(|_| "Invalid rename status")?,
    );
    if status != 0 {
        let mut offset = 9;
        let detail = packet_string(&response, &mut offset)
            .map(String::from_utf8_lossy)
            .map(|s| s.into_owned())
            .unwrap_or_else(|_| format!("SFTP status {status}"));
        return Err(format!(
            "Server could not atomically replace the file: {detail}"
        ));
    }
    let _ = channel.send_eof();
    let _ = channel.close();
    Ok(())
}

fn replace_remote_revision(
    session: &Session,
    sftp: &Sftp,
    path: &Path,
    bytes: &[u8],
    mode: i32,
    expected: &str,
) -> Result<(), String> {
    let temp = PathBuf::from(format!(
        "{}.vexssh-{}.part",
        path.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = sftp
            .open_mode(
                &temp,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                mode,
                OpenType::File,
            )
            .map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.close().map_err(|e| e.to_string())?;
        ensure_revision(&remote_bytes(sftp, path)?, expected)?;
        atomic_remote_rename(session, &temp, path)
    })();
    if result.is_err() {
        let _ = sftp.unlink(&temp);
    }
    result
}

pub fn save_remote(
    session: &Session,
    sftp: &Sftp,
    path: &Path,
    content: &[u8],
    expected: &str,
    backup: bool,
) -> Result<Value, String> {
    if content.len() as u64 > EDIT_LIMIT {
        return Err("Text editor supports files up to 4 MiB".into());
    }
    let original = remote_bytes(sftp, path)?;
    ensure_revision(&original, expected)?;
    let mode = (remote_regular(sftp, path)?.perm.unwrap_or(0o600) & 0o777) as i32;
    let backup_path = format!(
        "{}.vexssh-{}.bak",
        path.to_string_lossy(),
        uuid::Uuid::new_v4()
    );
    if backup {
        let mut copy = sftp
            .open_mode(
                Path::new(&backup_path),
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
                mode,
                OpenType::File,
            )
            .map_err(|e| e.to_string())?;
        copy.write_all(&original).map_err(|e| e.to_string())?;
        copy.close().map_err(|e| e.to_string())?;
    }
    replace_remote_revision(session, sftp, path, content, mode, expected)?;
    Ok(json!({"revision":revision(content),"backupPath":if backup{Some(backup_path)}else{None}}))
}

fn save_local(path: &Path, content: &[u8], expected: &str, backup: bool) -> Result<Value, String> {
    let original = local_bytes(path)?;
    ensure_revision(&original, expected)?;
    let id = uuid::Uuid::new_v4();
    let temporary = PathBuf::from(format!("{}.vexssh-{id}.part", path.display()));
    let backup_path = PathBuf::from(format!("{}.vexssh-{id}.bak", path.display()));
    let result = (|| {
        if backup {
            let mut copy = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&backup_path)
                .map_err(|e| e.to_string())?;
            fs::set_permissions(
                &backup_path,
                fs::metadata(path).map_err(|e| e.to_string())?.permissions(),
            )
            .map_err(|e| e.to_string())?;
            copy.write_all(&original).map_err(|e| e.to_string())?;
            copy.sync_all().map_err(|e| e.to_string())?;
        }
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        fs::set_permissions(
            &temporary,
            fs::metadata(path).map_err(|e| e.to_string())?.permissions(),
        )
        .map_err(|e| e.to_string())?;
        file.write_all(content).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        ensure_revision(&local_bytes(path)?, expected)?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(
            json!({"revision":revision(content),"backupPath":if backup {Some(backup_path.to_string_lossy().into_owned())} else {None}}),
        )
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn list_local(path: &Path) -> Result<Value, String> {
    let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        let is_directory = meta.is_dir()
            || (meta.file_type().is_symlink()
                && fs::metadata(entry.path()).is_ok_and(|target| target.is_dir()));
        entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":local_display(&entry.path()),"isDir":is_directory,"isSymlink":meta.file_type().is_symlink(),"size":meta.len(),"modified":meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map(|duration|duration.as_secs()),"permissions":if meta.permissions().readonly(){"read-only"}else{"read/write"}}));
    }
    sort_entries(&mut entries);
    Ok(json!({"path":local_display(&path),"entries":entries}))
}

fn sort_entries(entries: &mut [Value]) {
    entries.sort_by(|left, right| {
        right["isDir"]
            .as_bool()
            .cmp(&left["isDir"].as_bool())
            .then_with(|| {
                left["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .cmp(&right["name"].as_str().unwrap_or("").to_lowercase())
            })
    });
}

fn local_action(action: &str, payload: &Value, path: &Path) -> Result<Value, String> {
    match action {
        "file_list" => list_local(path),
        "file_read" => editor_result(&path.to_string_lossy(), local_bytes(path)?),
        "file_save" => {
            let content = payload["content"]
                .as_str()
                .ok_or("Missing content")?
                .as_bytes();
            if content.len() as u64 > EDIT_LIMIT {
                return Err("Text editor supports files up to 4 MiB".into());
            }
            save_local(
                path,
                content,
                text(payload, "revision")?,
                payload["backup"].as_bool().unwrap_or(true),
            )
        }
        "file_mkdir" => {
            fs::create_dir(path).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_rename" => {
            let destination = Path::new(text(payload, "destination")?);
            if fs::symlink_metadata(destination).is_ok() {
                return Err("Destination already exists".into());
            }
            fs::rename(path, destination).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_delete" => {
            let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                fs::remove_dir(path)
            } else {
                fs::remove_file(path)
            }
            .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_chmod" => Err("POSIX permissions can be changed on the remote server".into()),
        _ => Err("Unknown file action".into()),
    }
}

pub fn dispatch(
    state: &AppState,
    _app: &tauri::AppHandle,
    action: &str,
    payload: Value,
) -> Result<Value, String> {
    let side = payload["side"].as_str().unwrap_or("local");
    let default_local = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let default = if side == "local" {
        default_local.as_str()
    } else {
        "."
    };
    let path_text = payload["path"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(default);
    if path_text.contains('\0') {
        return Err("Invalid path".into());
    }
    let path = Path::new(path_text);
    if side == "local" {
        return local_action(action, &payload, path);
    }
    if side != "remote" {
        return Err("Invalid filesystem side".into());
    }
    let session = state.open_session_for(text(&payload, "sessionId")?)?;
    let sftp = session.sftp().map_err(|e| e.to_string())?;
    match action {
        "file_preview_path" => preview_remote_path(&sftp, path_text),
        "file_list" => {
            let canonical = sftp.realpath(path).map_err(|e| e.to_string())?;
            let mut entries = Vec::new();
            for (entry, stat) in sftp.readdir(&canonical).map_err(|e| e.to_string())? {
                let name = entry
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or("Server returned a filename that is not UTF-8")?;
                let is_directory = stat.is_dir()
                    || (stat.file_type().is_symlink()
                        && sftp.stat(&entry).is_ok_and(|target| target.is_dir()));
                entries.push(json!({"name":name,"path":remote_join(&canonical.to_string_lossy(),name)?,"isDir":is_directory,"isSymlink":stat.file_type().is_symlink(),"size":stat.size.unwrap_or(0),"modified":stat.mtime,"permissions":stat.perm.map(|p|format!("{:03o}",p&0o7777))}));
            }
            sort_entries(&mut entries);
            Ok(json!({"path":canonical.to_string_lossy(),"entries":entries}))
        }
        "file_read" => editor_result(path_text, remote_bytes(&sftp, path)?),
        "file_save" => {
            let content = payload["content"]
                .as_str()
                .ok_or("Missing content")?
                .as_bytes();
            if content.len() as u64 > EDIT_LIMIT {
                return Err("Text editor supports files up to 4 MiB".into());
            }
            save_remote(
                &session,
                &sftp,
                path,
                content,
                text(&payload, "revision")?,
                payload["backup"].as_bool().unwrap_or(true),
            )
        }
        "file_mkdir" => {
            sftp.mkdir(path, 0o755).map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_rename" => {
            sftp.rename(
                path,
                Path::new(text(&payload, "destination")?),
                Some(RenameFlags::empty()),
            )
            .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_delete" => {
            let stat = sftp.lstat(path).map_err(|e| e.to_string())?;
            if stat.is_dir() {
                sftp.rmdir(path)
            } else {
                sftp.unlink(path)
            }
            .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        "file_chmod" => {
            let value = text(&payload, "permissions")?;
            let permissions = u32::from_str_radix(value, 8)
                .map_err(|_| "Use octal permissions such as 644 or 755")?;
            if permissions > 0o7777 {
                return Err("Permissions must be between 0000 and 7777".into());
            }
            sftp.setstat(
                path,
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(permissions),
                    atime: None,
                    mtime: None,
                },
            )
            .map_err(|e| e.to_string())?;
            Ok(json!(true))
        }
        _ => Err("Unknown file action".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sftp_extension_parser_bounds_untrusted_lengths() {
        assert!(receive_packet(&mut &0u32.to_be_bytes()[..]).is_err());
        assert!(receive_packet(&mut &70000u32.to_be_bytes()[..]).is_err());
        assert!(receive_packet(&mut &[0, 0, 0, 5, 2][..]).is_err());
        assert!(packet_string(&[0, 0, 0, 8, b'a'], &mut 0).is_err());
        let mut packet = Vec::new();
        sftp_string(&mut packet, b"example");
        let mut offset = 0;
        assert_eq!(packet_string(&packet, &mut offset).unwrap(), b"example");
        assert_eq!(offset, packet.len());
    }
    #[test]
    fn refuses_changed_file_and_preserves_backup() {
        let folder = std::env::temp_dir().join(format!("vexssh-editor-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let file = folder.join("sample.conf");
        fs::write(&file, b"original").unwrap();
        let old_revision = revision(b"original");
        fs::write(&file, b"external edit").unwrap();
        assert!(save_local(&file, b"overwrite", &old_revision, true).is_err());
        assert_eq!(fs::read(&file).unwrap(), b"external edit");
        let result = save_local(&file, b"saved", &revision(b"external edit"), true).unwrap();
        assert_eq!(
            fs::read(result["backupPath"].as_str().unwrap()).unwrap(),
            b"external edit"
        );
        assert_eq!(fs::read(&file).unwrap(), b"saved");
        fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn rejects_remote_path_traversal_names() {
        for name in ["..", "../file", "a/b", "a\\b", ""] {
            assert!(remote_join("/tmp", name).is_err());
        }
        assert_eq!(remote_join("/", "test.txt").unwrap(), "/test.txt");
    }
    #[test]
    fn payload_rejects_missing_empty_and_null_strings() {
        for value in [
            json!({}),
            json!({"path":""}),
            json!({"path":"a\u{0}b"}),
            json!({"path":44}),
        ] {
            assert!(text(&value, "path").is_err());
        }
        assert_eq!(
            text(&json!({"path":"file with spaces.conf"}), "path").unwrap(),
            "file with spaces.conf"
        );
    }
    #[test]
    fn editor_rejects_binary_and_oversized_input() {
        assert!(read_bytes(&b"binary\0data"[..]).is_err());
        assert!(read_bytes(std::io::repeat(b'a').take(EDIT_LIMIT + 1)).is_err());
        assert!(editor_result("invalid", vec![0xff]).is_err());
    }
    #[test]
    fn local_rename_never_overwrites_an_existing_file() {
        let folder = std::env::temp_dir().join(format!("vexssh-rename-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&folder).unwrap();
        let source = folder.join("source");
        let destination = folder.join("destination");
        fs::write(&source, b"source").unwrap();
        fs::write(&destination, b"destination").unwrap();
        assert!(local_action("file_rename", &json!({"destination":destination}), &source).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source");
        assert_eq!(fs::read(&destination).unwrap(), b"destination");
        fs::remove_dir_all(folder).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn remote_names_cannot_create_windows_devices_or_alternate_streams() {
        for name in [
            "NUL",
            "aux.txt",
            "COM1",
            "com¹.log",
            "LPT³",
            "CONIN$",
            "conout$.txt",
            "aux .txt",
            "file:secret",
            "trailing.",
            "trailing ",
            "a/b",
            "a\\b",
        ] {
            assert!(validate_local_name(name).is_err(), "{name}");
        }
        assert!(validate_local_name("normal file.txt").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn displayed_windows_paths_preserve_drive_and_network_roots() {
        assert_eq!(local_display(Path::new(r"\\?\C:\Users")), r"C:\Users");
        assert_eq!(local_display(Path::new(r"\\?\C:\")), r"C:\");
        assert_eq!(
            local_display(Path::new(r"\\?\UNC\server\share")),
            r"\\server\share"
        );
    }
}
