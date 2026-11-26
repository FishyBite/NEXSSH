use chrono::{DateTime, SecondsFormat, Utc};
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::SystemTime;
use uuid::Uuid;

struct LineLog<W> {
    output: W,
    at_start: bool,
    after_cr: bool,
    utf8_tail: Vec<u8>,
}

impl<W: Write> LineLog<W> {
    fn new(output: W) -> Self {
        Self {
            output,
            at_start: true,
            after_cr: false,
            utf8_tail: Vec::new(),
        }
    }

    fn prefix(&mut self, at: SystemTime) -> io::Result<()> {
        if self.at_start {
            let at = DateTime::<Utc>::from(at).to_rfc3339_opts(SecondsFormat::Millis, true);
            write!(self.output, "[{at}] ")?;
            self.at_start = false;
        }
        Ok(())
    }

    fn text(&mut self, bytes: &[u8]) -> io::Result<()> {
        let mut joined;
        let mut rest = if self.utf8_tail.is_empty() {
            bytes
        } else {
            joined = std::mem::take(&mut self.utf8_tail);
            joined.extend_from_slice(bytes);
            &joined
        };
        while let Err(error) = std::str::from_utf8(rest) {
            let (good, bad) = rest.split_at(error.valid_up_to());
            self.output.write_all(good)?;
            if let Some(invalid) = error.error_len() {
                self.output.write_all("�".as_bytes())?;
                rest = &bad[invalid..];
            } else {
                self.utf8_tail.extend_from_slice(bad);
                return Ok(());
            }
        }
        self.output.write_all(rest)
    }

    fn newline(&mut self) -> io::Result<()> {
        if !self.utf8_tail.is_empty() {
            self.output.write_all("�".as_bytes())?;
            self.utf8_tail.clear();
        }
        self.at_start = true;
        self.output.write_all(b"\n")
    }

    fn received(&mut self, at: SystemTime, bytes: &[u8]) -> io::Result<()> {
        for part in bytes.split_inclusive(|byte| matches!(byte, b'\r' | b'\n')) {
            if self.after_cr && part == b"\n" {
                self.after_cr = false;
                continue;
            }
            self.prefix(at)?;
            let last = part[part.len() - 1];
            self.after_cr = last == b'\r';
            if matches!(last, b'\r' | b'\n') {
                self.text(&part[..part.len() - 1])?;
                self.newline()?;
            } else {
                self.text(part)?;
            }
        }
        self.output.flush()
    }

    fn finish(&mut self) -> io::Result<()> {
        if !self.at_start {
            self.newline()?;
        }
        self.output.flush()
    }
}

struct Chunk {
    at: SystemTime,
    data: Vec<u8>,
}

struct Writer {
    id: Uuid,
    sender: Option<mpsc::SyncSender<Chunk>>,
    overflow: Arc<AtomicBool>,
    thread: JoinHandle<Result<(), String>>,
}

impl Writer {
    fn finish(mut self) -> Result<(), String> {
        self.sender.take();
        self.thread
            .join()
            .map_err(|_| "The recording writer stopped unexpectedly.")?
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    writer: Option<Writer>,
}

#[derive(Default)]
pub(super) struct Recording(Mutex<State>);

impl Recording {
    pub(super) fn start(
        &self,
        id: Uuid,
        path: &Path,
        report: impl FnOnce(String) + Send + 'static,
    ) -> Result<(), String> {
        if !path.is_absolute() || path.file_name().is_none() {
            return Err("Choose an absolute path for the log file.".into());
        }
        let (ready, opened) = mpsc::sync_channel(1);
        {
            let mut state = self.0.lock().map_err(|_| "Recording state unavailable.")?;
            if state.closed {
                return Err("The serial session has ended.".into());
            }
            if state
                .writer
                .as_ref()
                .is_some_and(|w| !w.thread.is_finished())
            {
                return Err("This serial session is already recording.".into());
            }
            // An 8 KiB device read fits in one slot. Never block serial input on disk I/O.
            let (sender, chunks) = mpsc::sync_channel::<Chunk>(128);
            let overflow = Arc::new(AtomicBool::new(false));
            let overflowed = Arc::clone(&overflow);
            let path = PathBuf::from(path);
            let thread = thread::Builder::new().name("serial-log".into()).spawn(move || {
                let file = match File::create_new(path) {
                    Ok(file) => file,
                    Err(e) => {
                        let reason = if e.kind() == io::ErrorKind::AlreadyExists {
                            "This file already exists. Choose a new log file.".into()
                        } else { format!("Could not create the serial log: {e}") };
                        let _ = ready.send(Err(reason));
                        return Ok(());
                    }
                };
                let _ = ready.send(Ok(()));
                let mut log = LineLog::new(BufWriter::new(file));
                let result = (|| {
                    for chunk in chunks { log.received(chunk.at, &chunk.data)?; }
                    log.finish()?;
                    log.output.get_ref().sync_data()
                })().map_err(|e: io::Error| format!("Serial recording stopped. The log may be incomplete: {e}"));
                let result = result.and_then(|()| if overflowed.load(Ordering::Acquire) {
                    Err("Serial recording stopped because storage could not keep up. The log is incomplete.".into())
                } else { Ok(()) });
                if let Err(error) = &result { report(error.clone()); }
                result
            }).map_err(|e| format!("Could not start serial recording: {e}"))?;
            state.writer = Some(Writer {
                id,
                sender: Some(sender),
                overflow,
                thread,
            });
        }
        let result = opened
            .recv()
            .map_err(|_| "The recording writer stopped unexpectedly.")?;
        if result.is_err() {
            let _ = self.stop(id);
        }
        result
    }

    pub(super) fn received(&self, bytes: &[u8]) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(writer) = &mut state.writer else {
            return;
        };
        let Some(sender) = &writer.sender else {
            return;
        };
        if let Err(error) = sender.try_send(Chunk {
            at: SystemTime::now(),
            data: bytes.to_owned(),
        }) {
            if matches!(error, mpsc::TrySendError::Full(_)) {
                writer.overflow.store(true, Ordering::Release);
            }
            writer.sender.take();
        }
    }

    pub(super) fn stop(&self, id: Uuid) -> Result<(), String> {
        let writer = {
            let mut state = self.0.lock().map_err(|_| "Recording state unavailable.")?;
            if state.writer.as_ref().is_some_and(|w| w.id != id) {
                return Err("This recording has changed.".into());
            }
            state.writer.take()
        };
        if let Some(writer) = writer {
            writer.finish()?;
        }
        Ok(())
    }

    pub(super) fn close(&self) -> Result<(), String> {
        let writer = {
            let mut state = self.0.lock().map_err(|_| "Recording state unavailable.")?;
            state.closed = true;
            state.writer.take()
        };
        if let Some(writer) = writer {
            writer.finish()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn timestamps_the_start_of_each_line_across_chunks_and_mixed_newlines() {
        let mut log = LineLog::new(Vec::new());
        let start = UNIX_EPOCH + Duration::from_millis(123);
        let later = start + Duration::from_secs(7);
        log.received(start, b"bo").unwrap();
        log.received(later, b"ot\r").unwrap();
        log.received(later, b"\n\r\nfan \xe2").unwrap();
        log.received(later, b"\x9c\x93\rOK\xff\nlast\xf0\x9f")
            .unwrap();
        log.finish().unwrap();
        assert_eq!(String::from_utf8(log.output).unwrap(),
            "[1970-01-01T00:00:00.123Z] boot\n[1970-01-01T00:00:07.123Z] \n[1970-01-01T00:00:07.123Z] fan ✓\n[1970-01-01T00:00:07.123Z] OK�\n[1970-01-01T00:00:07.123Z] last�\n");
    }

    #[test]
    fn timestamped_file_starts_on_request_and_finalizes_on_stop_or_session_close() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("boot.log");
        let second = dir.path().join("next.log");
        let recording = Recording::default();
        let id = Uuid::new_v4();
        recording.received(b"before\n");
        recording.start(id, &first, |e| panic!("{e}")).unwrap();
        assert!(recording.start(Uuid::new_v4(), &second, |_| {}).is_err());
        assert!(recording.stop(Uuid::new_v4()).is_err());
        recording.received(b"one\r\npar");
        recording.received(b"tial");
        recording.stop(id).unwrap();
        recording.received(b"after\n");
        let file = std::fs::read_to_string(&first).unwrap();
        let lines: Vec<_> = file.lines().collect();
        assert_eq!(lines.len(), 2);
        for (line, expected) in lines.iter().zip(["one", "partial"]) {
            let (stamp, text) = line.strip_prefix('[').unwrap().split_once("] ").unwrap();
            DateTime::parse_from_rfc3339(stamp).unwrap();
            assert_eq!(text, expected);
        }
        assert!(recording.start(Uuid::new_v4(), &first, |_| {}).is_err());
        assert_eq!(std::fs::read_to_string(&first).unwrap(), file);
        recording.start(Uuid::new_v4(), &second, |_| {}).unwrap();
        recording.received(b"unplugged");
        recording.close().unwrap();
        assert!(std::fs::read_to_string(second)
            .unwrap()
            .ends_with("] unplugged\n"));
        assert!(recording
            .start(Uuid::new_v4(), &dir.path().join("closed.log"), |_| {})
            .is_err());
    }

    #[test]
    fn reports_write_and_flush_errors_for_incomplete_logs() {
        struct FailingDisk {
            fail_flush: bool,
        }
        impl Write for FailingDisk {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.fail_flush {
                    Ok(bytes.len())
                } else {
                    Err(io::Error::other("write failed"))
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::other("flush failed"))
            }
        }
        let mut full = LineLog::new(FailingDisk { fail_flush: false });
        assert_eq!(
            full.received(UNIX_EPOCH, b"part").unwrap_err().to_string(),
            "write failed"
        );
        let mut lost = LineLog::new(FailingDisk { fail_flush: true });
        assert_eq!(
            lost.received(UNIX_EPOCH, b"part").unwrap_err().to_string(),
            "flush failed"
        );
        assert!(lost.finish().is_err());
    }
}
