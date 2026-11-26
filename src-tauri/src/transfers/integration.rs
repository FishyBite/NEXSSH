#![allow(unexpected_cfgs)] // vexssh_queue_fixture opts into the Windows manifest-equipped harness.
use super::*;
use base64::Engine;
use std::net::TcpStream;

fn connection(fixture: &Value) -> (Session, TcpStream) {
    assert_eq!(fixture["hostname"], "127.0.0.1");
    let socket =
        TcpStream::connect(("127.0.0.1", fixture["port"].as_u64().unwrap() as u16)).unwrap();
    let mut session = Session::new().unwrap();
    session.set_tcp_stream(socket.try_clone().unwrap());
    session.set_timeout(3000);
    session.handshake().unwrap();
    let fingerprint = format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD
            .encode(Sha256::digest(session.host_key().unwrap().0))
    );
    assert_eq!(fingerprint, fixture["fingerprint"]);
    session
        .userauth_password(
            fixture["username"].as_str().unwrap(),
            fixture["password"].as_str().unwrap(),
        )
        .unwrap();
    (session, socket)
}

fn record(entry: &Entry, upload: bool) -> Transfer {
    serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"sessionId":"loop","hostId":"loop","source":entry.source,"destination":entry.destination,"direction":if upload {"upload"}else{"download"},"protocol":"sftp","status":"running","totalBytes":entry.size,"transferredBytes":0,"speedBytesPerSecond":0,"etaSeconds":null,"error":null,"startedAt":0,"finishedAt":null,"durationSeconds":null})).unwrap()
}

fn progress<'a>(state: &'a AppState, t: &'a mut Transfer, cancel: &'a AtomicBool) -> Progress<'a> {
    Progress {
        state,
        app: None,
        transfer: t,
        cancelled: cancel,
        started: Instant::now(),
        published: Instant::now(),
        network_bytes: 0,
        interrupt: None,
    }
}

#[test]
#[ignore = "Requires VEXSSH_TEST_CONNECTION pointing at an isolated loopback SSH fixture"]
fn transport_disconnect_resume_and_conflict_policies() {
    let fixture: Value = serde_json::from_slice(
        &fs::read(std::env::var("VEXSSH_TEST_CONNECTION").unwrap()).unwrap(),
    )
    .unwrap();
    let root = std::env::temp_dir().join(format!("vexssh-resume-test-{}", uuid::Uuid::new_v4()));
    let state = AppState::new(root.join("state")).unwrap();
    state.db().unwrap().execute_batch("CREATE TABLE nexssh_transfers(id TEXT PRIMARY KEY,record TEXT,updated_at INTEGER);CREATE TABLE transfer_conflict_policies(batch TEXT PRIMARY KEY,policy TEXT);").unwrap();
    let (control, _) = connection(&fixture);
    let control_sftp = control.sftp().unwrap();
    let remote_root = format!("/resume-{}", uuid::Uuid::new_v4());
    control_sftp.mkdir(Path::new(&remote_root), 0o700).unwrap();
    let bytes = (0..1_536_000)
        .map(|n| ((n * 37) % 251) as u8)
        .collect::<Vec<_>>();
    let cancel = AtomicBool::new(false);
    for upload in [true, false] {
        let local = root.join(if upload { "source.dat" } else { "target.dat" });
        let remote = format!(
            "{}/{}",
            remote_root,
            if upload { "target.dat" } else { "source.dat" }
        );
        if upload {
            fs::write(&local, &bytes).unwrap();
        } else {
            control_sftp
                .create(Path::new(&remote))
                .unwrap()
                .write_all(&bytes)
                .unwrap();
        }
        let local = local.to_string_lossy().into_owned();
        let entry = Entry {
            source: if upload {
                local.clone()
            } else {
                remote.clone()
            },
            destination: if upload {
                remote.clone()
            } else {
                local.clone()
            },
            directory: false,
            size: bytes.len() as u64,
            mode: 0o600,
            modified: None,
        };
        let mut transfer = record(&entry, upload);
        {
            let (broken, socket) = connection(&fixture);
            let sftp = broken.sftp().unwrap();
            let mut p = progress(&state, &mut transfer, &cancel);
            p.interrupt = Some((256 * 1024, socket));
            assert!(resume::copy(&broken, &sftp, &entry, None, &mut p).is_err());
            assert!(p.network_bytes >= 256 * 1024 && p.network_bytes < entry.size);
            persist(&state, &transfer).unwrap();
        }
        let mut transfer = get_transfer(&state, &transfer.id).unwrap();
        assert!(conflict::inspect(&control_sftp, upload, &entry.destination)
            .unwrap()
            .is_none());
        let (reconnected, _) = connection(&fixture);
        let sftp = reconnected.sftp().unwrap();
        let mut changed = bytes.clone();
        *changed.last_mut().unwrap() ^= 0xff;
        if upload {
            fs::write(&local, changed).unwrap();
        } else {
            sftp.create(Path::new(&remote))
                .unwrap()
                .write_all(&changed)
                .unwrap();
        }
        let err = resume::copy(
            &reconnected,
            &sftp,
            &entry,
            None,
            &mut progress(&state, &mut transfer, &cancel),
        )
        .unwrap_err();
        assert!(err.contains("changed since interruption"), "{err}");
        if upload {
            fs::write(&local, &bytes).unwrap();
        } else {
            sftp.create(Path::new(&remote))
                .unwrap()
                .write_all(&bytes)
                .unwrap();
        }
        let staged = if upload {
            sftp.readdir(Path::new(&remote_root))
                .unwrap()
                .into_iter()
                .find(|(path, _)| path.to_string_lossy().ends_with(".part"))
                .unwrap()
                .0
        } else {
            fs::read_dir(&root)
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .find(|p| p.to_string_lossy().ends_with(".part"))
                .unwrap()
        };
        for first in [0xff, bytes[0]] {
            if upload {
                sftp.open_mode(&staged, OpenFlags::WRITE, 0o600, OpenType::File)
                    .unwrap()
                    .write_all(&[first])
                    .unwrap();
            } else {
                fs::OpenOptions::new()
                    .write(true)
                    .open(&staged)
                    .unwrap()
                    .write_all(&[first])
                    .unwrap();
            }
            if first == 0xff {
                let err = resume::copy(
                    &reconnected,
                    &sftp,
                    &entry,
                    None,
                    &mut progress(&state, &mut transfer, &cancel),
                )
                .unwrap_err();
                assert!(err.contains("Partial file contents changed"), "{err}");
            }
        }
        transfer.transferred_bytes = 0;
        state.save_config(json!({"hosts":[],"settings":{
            "sftpUploadLimitKiB": if upload { 512 } else { 0 },
            "sftpDownloadLimitKiB": if upload { 0 } else { 512 }
        }})).unwrap();
        let mut p = progress(&state, &mut transfer, &cancel);
        let resumed_at = Instant::now();
        resume::copy(&reconnected, &sftp, &entry, None, &mut p).unwrap();
        assert!(p.transfer.resumed_bytes > 0);
        assert_eq!(p.network_bytes + p.transfer.resumed_bytes, entry.size);
        let minimum = Duration::from_secs_f64(p.network_bytes as f64 / (512.0 * 1024.0));
        assert!(resumed_at.elapsed() + Duration::from_millis(51) >= minimum);
        println!(
            "{}: {} bytes, resumed at {}, sent {} remaining bytes",
            if upload { "upload" } else { "download" },
            entry.size,
            p.transfer.resumed_bytes,
            p.network_bytes
        );
        let mut result = vec![];
        if upload {
            sftp.open(Path::new(&remote))
                .unwrap()
                .read_to_end(&mut result)
                .unwrap();
        } else {
            result = fs::read(&local).unwrap();
        }
        assert_eq!(Sha256::digest(&bytes), Sha256::digest(&result));

        let mut conflict_entry = entry.clone();
        let mut conflict_transfer = record(&entry, upload);
        let id = conflict_transfer.id.clone();
        let batch = conflict::scope(&conflict_transfer);
        queue().0.lock().unwrap().jobs.insert(
            id.clone(),
            JobControl {
                cancelled: Arc::new(AtomicBool::new(false)),
                destination: entry.destination.clone(),
                host_id: "loop".into(),
                direction: conflict_transfer.direction.clone(),
                batch: batch.clone(),
                conflict: None,
                decision: None,
            },
        );
        let original = entry.destination.clone();
        std::thread::scope(|threads| {
            let id = id.clone();
            let worker_state = state.clone();
            threads.spawn(move||{
                for _ in 0..500 {
                    let conflict=get_transfer(&worker_state,&id).ok().and_then(|t|t.conflict);
                    if let Some(conflict)=conflict {
                        let value=serde_json::to_value(conflict).unwrap();
                        assert_eq!(value["canReplace"],true);
                        assert!(conflict::resolve(&worker_state,&json!({"id":id,"token":"old","choice":"replace"})).is_err());
                        conflict::resolve(&worker_state,&json!({"id":id,"token":value["token"],"choice":"skip","applyToAll":true})).unwrap();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                panic!("Conflict did not appear");
            });
            assert!(matches!(
                conflict::destination(
                    &sftp,
                    &mut conflict_entry,
                    &mut progress(&state, &mut conflict_transfer, &cancel),
                    &Default::default(),
                    &original
                )
                .unwrap(),
                Destination::Skip
            ));
        });
        let mut progress = progress(&state, &mut conflict_transfer, &cancel);
        assert!(matches!(
            conflict::destination(
                &sftp,
                &mut conflict_entry,
                &mut progress,
                &Default::default(),
                &original
            )
            .unwrap(),
            Destination::Skip
        ));
        for choice in ["keepBoth", "replace"] {
            state
                .db()
                .unwrap()
                .execute(
                    "UPDATE transfer_conflict_policies SET policy=?1 WHERE batch=?2",
                    params![choice, batch],
                )
                .unwrap();
            let mut e = entry.clone();
            let Destination::Write(expected) =
                conflict::destination(&sftp, &mut e, &mut progress, &Default::default(), &original)
                    .unwrap()
            else {
                panic!("Unexpected skip")
            };
            if choice == "keepBoth" {
                assert!(e.destination.contains(" (1).dat"));
            } else {
                assert!(expected.is_some());
            }
            resume::copy(&reconnected, &sftp, &e, expected.as_ref(), &mut progress).unwrap();
            if choice == "keepBoth" && upload {
                sftp.unlink(Path::new(&e.destination)).unwrap();
            }
        }
        queue().0.lock().unwrap().jobs.remove(&id);
        sftp.unlink(Path::new(&remote)).unwrap();
    }
    #[cfg(vexssh_queue_fixture)]
    exercise_queue(&fixture, &state, &root, &remote_root, &control_sftp);
    control_sftp.rmdir(Path::new(&remote_root)).unwrap();
    drop(state);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(vexssh_queue_fixture)]
fn await_status(state: &AppState, id: &str, status: &str) -> Transfer {
    for _ in 0..600 {
        let t = get_transfer(state, id).unwrap();
        if t.status == status {
            return t;
        }
        assert_ne!(t.status, "failed", "transfer error: {:?}", t.error);
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("Transfer did not reach {status}");
}

#[cfg(vexssh_queue_fixture)]
fn exercise_queue(fixture: &Value, state: &AppState, root: &Path, remote: &str, sftp: &Sftp) {
    // Build a windowless event target so the production start/resolve/retry dispatchers
    // can run on a real loopback connection without opening a desktop session.
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default()
        .any_thread()
        .build(context)
        .unwrap();
    let app = app.handle();
    state.save_config(json!({"hosts":[{"id":"fixture","hostname":"127.0.0.1","port":fixture["port"],"username":fixture["username"],"authMethod":"password"}]})).unwrap();
    crate::security::trust_host(
        state,
        "fixture",
        "127.0.0.1",
        fixture["port"].as_u64().unwrap() as u16,
        fixture["fingerprint"].as_str().unwrap(),
    )
    .unwrap();
    crate::ssh::seed_test_credential(&state, "fixture", json!({"password":fixture["password"]}));
    let binding = state.capture_binding("fixture").unwrap();
    for id in ["fixture-live", "fixture-new"] {
        let (sender, _) = std::sync::mpsc::channel();
        state.inner.sessions.lock().unwrap().insert(
            id.into(),
            crate::storage::TerminalSession {
                host_id: "fixture".into(),
                sender,
                binding: binding.clone(),
            },
        );
    }
    let tree = root.join("folder");
    fs::create_dir_all(tree.join("nested")).unwrap();
    fs::write(tree.join("nested/file.txt"), b"original").unwrap();
    let destination = format!("{remote}/folder");
    let copy = format!("{remote}/folder (1)");
    sftp.create(Path::new(&destination))
        .unwrap()
        .write_all(b"existing")
        .unwrap();
    let start = |dest: &str, batch: &str| {
        dispatch(state,app,"transfer_start",json!({"direction":"upload","protocol":"sftp","source":tree,"destination":dest,"sessionId":"fixture-live","batchId":batch})).unwrap()["id"].as_str().unwrap().to_owned()
    };
    let id = start(&destination, &uuid::Uuid::new_v4().to_string());
    let conflict =
        serde_json::to_value(await_status(state, &id, "conflict").conflict.unwrap()).unwrap();
    assert_eq!(conflict["canReplace"], false);
    dispatch(
        state,
        app,
        "transfer_resolve",
        json!({"id":id,"token":conflict["token"],"choice":"keepBoth"}),
    )
    .unwrap();
    await_status(state, &id, "completed");
    let child = format!("{copy}/nested/file.txt");
    assert_eq!(
        files::remote_bytes(sftp, Path::new(&child)).unwrap(),
        b"original"
    );
    assert_eq!(
        files::remote_bytes(sftp, Path::new(&destination)).unwrap(),
        b"existing"
    );

    let batch = uuid::Uuid::new_v4().to_string();
    let id = start(&copy, &batch);
    let conflict =
        serde_json::to_value(await_status(state, &id, "conflict").conflict.unwrap()).unwrap();
    assert_eq!(conflict["destination"], child);
    dispatch(
        state,
        app,
        "transfer_resolve",
        json!({"id":id,"token":conflict["token"],"choice":"skip","applyToAll":true}),
    )
    .unwrap();
    assert_eq!(await_status(state, &id, "completed").skipped_files, 1);
    let next = start(&destination, &batch);
    assert_eq!(await_status(state, &next, "skipped").skipped_files, 1);

    // Both live tabs share credentials. Each queued download must retain the
    // originating connection ID and its own chosen Windows directory.
    for (tab, source, expected) in [
        ("fixture-live", &child, b"original".as_slice()),
        ("fixture-new", &destination, b"existing".as_slice()),
    ] {
        let folder = root.join(tab);
        fs::create_dir(&folder).unwrap();
        let target = folder.join("report.txt");
        fs::write(&target, b"local copy").unwrap();
        let started = dispatch(
            state, app, "transfer_start",
            json!({
                "direction": "download", "protocol": "sftp", "sessionId": tab,
                "source": source, "destination": target, "batchId": uuid::Uuid::new_v4().to_string()
            }),
        ).unwrap();
        let id = started["id"].as_str().unwrap();
        let pending = await_status(state, id, "conflict");
        let conflict = serde_json::to_value(pending.conflict.unwrap()).unwrap();
        dispatch(
            state, app, "transfer_resolve",
            json!({"id": id, "token": conflict["token"], "choice": "keepBoth"}),
        ).unwrap();
        let completed = await_status(state, id, "completed");
        assert_eq!(completed.session_id, tab);
        let actual_path = downloaded_file(&completed).unwrap();
        assert_eq!(actual_path.parent().unwrap(), folder);
        assert_eq!(fs::read(actual_path).unwrap(), expected);
        assert_eq!(fs::read(target).unwrap(), b"local copy");
    }

    let restart_source = root.join("restart-source.bin");
    let bytes = vec![7; 768 * 1024];
    fs::write(&restart_source, &bytes).unwrap();
    let target = format!("{remote}/restarted");
    let entry = Entry {
        source: restart_source.to_string_lossy().into_owned(),
        destination: target.clone(),
        size: bytes.len() as u64,
        modified: None,
        directory: false,
        mode: 0o600,
    };
    let mut transfer = record(&entry, true);
    transfer.host_id = "fixture".into();
    transfer.binding = Some(binding);
    transfer.session_id = "fixture-live".into();
    let (broken, socket) = connection(fixture);
    let interrupted = broken.sftp().unwrap();
    let cancel = AtomicBool::new(false);
    let mut p = progress(state, &mut transfer, &cancel);
    p.interrupt = Some((128 * 1024, socket));
    assert!(resume::copy(&broken, &interrupted, &entry, None, &mut p).is_err());
    transfer.status = "failed".into();
    transfer.resumable = true;
    persist(state, &transfer).unwrap();
    fs::write(&restart_source, vec![8; bytes.len()]).unwrap();
    dispatch(
        state,
        app,
        "transfer_retry",
        json!({"id":transfer.id,"preferredSessionId":"fixture-new"}),
    )
    .unwrap();
    let restarted = await_status(state, &transfer.id, "completed");
    assert_eq!(restarted.session_id, "fixture-new");
    assert_eq!(restarted.resumed_bytes, 0);
    assert_eq!(
        files::remote_bytes(sftp, Path::new(&target)).unwrap(),
        vec![8; bytes.len()]
    );
    for (path, stat) in sftp.readdir(Path::new(remote)).unwrap() {
        if stat.is_file() {
            sftp.unlink(&path).unwrap();
        }
    }
    sftp.unlink(Path::new(&child)).unwrap();
    sftp.rmdir(Path::new(&format!("{copy}/nested"))).unwrap();
    sftp.rmdir(Path::new(&copy)).unwrap();
}
