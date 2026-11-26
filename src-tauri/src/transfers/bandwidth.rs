use super::check_cancel;
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{atomic::AtomicBool, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct SftpBandwidth {
    pub(super) upload: RateLimit,
    pub(super) download: RateLimit,
}

// Old profiles have neither value. A KiB/s is exactly 1024 bytes per second.
pub(crate) fn settings(value: &Value) -> Result<(u64, u64), String> {
    let limit = |name: &str| match value.get(name) {
        None => Ok(0),
        Some(v) => v
            .as_u64()
            .filter(|&n| n <= 1_048_576)
            .ok_or_else(|| format!("{name} must be a whole number from 0 to 1048576 KiB/s")),
    };
    Ok((limit("sftpUploadLimitKiB")?, limit("sftpDownloadLimitKiB")?))
}

impl SftpBandwidth {
    pub(crate) fn configure(&self, (upload, download): (u64, u64)) {
        self.upload.set_rate(upload * 1024);
        self.download.set_rate(download * 1024);
    }
}

#[derive(Default)]
pub(super) struct RateLimit {
    clock: Mutex<Clock>,
    changed: Condvar,
}

#[derive(Default)]
struct Clock {
    bytes_per_second: u64,
    available_at: Option<Instant>,
    sequence: u64,
    waiting: VecDeque<u64>,
}

impl RateLimit {
    fn set_rate(&self, bytes_per_second: u64) {
        let mut clock = self.clock.lock().unwrap_or_else(|e| e.into_inner());
        if clock.bytes_per_second != bytes_per_second {
            clock.bytes_per_second = bytes_per_second;
            clock.available_at = None;
            self.changed.notify_all();
        }
    }

    // Reserve at most 50 ms of payload before I/O. All workers in one direction
    // use this clock; FIFO turns keep a large transfer from starving another.
    pub(super) fn grant(&self, requested: usize, cancel: &AtomicBool) -> Result<usize, String> {
        check_cancel(cancel)?;
        let mut clock = self.clock.lock().unwrap_or_else(|e| e.into_inner());
        if requested == 0 || clock.bytes_per_second == 0 {
            return Ok(requested);
        }
        let ticket = clock.sequence;
        clock.sequence = clock.sequence.wrapping_add(1);
        clock.waiting.push_back(ticket);
        loop {
            if let Err(error) = check_cancel(cancel) {
                clock.waiting.retain(|&id| id != ticket);
                self.changed.notify_all();
                return Err(error);
            }
            let now = Instant::now();
            let delay = clock
                .available_at
                .unwrap_or(now)
                .saturating_duration_since(now);
            let rate = clock.bytes_per_second;
            let first = clock.waiting.front() == Some(&ticket);
            if first && (delay.is_zero() || rate == 0) {
                clock.waiting.pop_front();
                let bytes = if rate == 0 {
                    requested
                } else {
                    let n = requested.min(rate.div_ceil(20) as usize);
                    clock.available_at =
                        Some(now + Duration::from_secs_f64(n as f64 / rate as f64));
                    n
                };
                self.changed.notify_all();
                return Ok(bytes);
            }
            let poll = Duration::from_millis(50);
            let timeout = if first { delay.min(poll) } else { poll };
            clock = self
                .changed
                .wait_timeout(clock, timeout)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppState;
    use serde_json::json;
    use std::sync::atomic::Ordering;
    use std::thread;

    #[test]
    fn shared_upload_budget_paces_two_workers_without_using_download_budget() {
        let limits = SftpBandwidth::default();
        limits.configure((32, 0));
        let cancel = AtomicBool::new(false);
        let start = Instant::now();
        thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    let mut remaining = 4096;
                    while remaining > 0 {
                        remaining -= limits.upload.grant(remaining, &cancel).unwrap();
                    }
                });
            }
            assert_eq!(limits.download.grant(65536, &cancel).unwrap(), 65536);
        });
        // 8192 bytes at 32 KiB/s, allowing one initial 50 ms quantum.
        assert!(start.elapsed() >= Duration::from_millis(199));
    }

    #[test]
    fn stopping_a_waiter_and_removing_a_live_cap_leave_the_queue_usable() {
        let limit = RateLimit::default();
        limit.set_rate(1024);
        // Hold the next grant so progress depends on cancellation and reconfiguration.
        limit.clock.lock().unwrap().available_at = Some(Instant::now() + Duration::from_secs(60));
        let cancel = AtomicBool::new(false);
        let keep = AtomicBool::new(false);
        thread::scope(|scope| {
            let stopped = scope.spawn(|| limit.grant(65536, &cancel));
            let continued = scope.spawn(|| limit.grant(65536, &keep));
            let deadline = Instant::now() + Duration::from_secs(5);
            while limit.clock.lock().unwrap().waiting.len() < 2 {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(1));
            }
            cancel.store(true, Ordering::Release);
            assert_eq!(stopped.join().unwrap().unwrap_err(), "Transfer cancelled");
            limit.set_rate(0);
            assert_eq!(continued.join().unwrap().unwrap(), 65536);
        });
        assert!(limit.clock.lock().unwrap().waiting.is_empty());
    }

    #[test]
    fn limits_migrate_persist_and_reject_invalid_values_atomically() {
        let folder = tempfile::tempdir().unwrap();
        let state = AppState::new(folder.path().to_owned()).unwrap();
        assert_eq!(settings(&json!({})).unwrap(), (0, 0));
        state
            .save_config(json!({"hosts":[],"settings":{
                "sftpUploadLimitKiB":0,"sftpDownloadLimitKiB":1_048_576
            }}))
            .unwrap();
        for invalid in [
            json!(-1),
            json!(3.5),
            json!("20"),
            json!(null),
            json!(1_048_577),
        ] {
            assert!(state
                .save_config(json!({"hosts":[],"settings":{
                    "sftpUploadLimitKiB":20,"sftpDownloadLimitKiB":invalid
                }}))
                .is_err());
        }
        let reopened = AppState::new(folder.path().to_owned()).unwrap();
        for state in [&state, &reopened] {
            assert_eq!(
                settings(&state.config().unwrap()["settings"]).unwrap(),
                (0, 1_048_576)
            );
            assert_eq!(
                state
                    .inner
                    .sftp_bandwidth
                    .upload
                    .clock
                    .lock()
                    .unwrap()
                    .bytes_per_second,
                0
            );
            assert_eq!(
                state
                    .inner
                    .sftp_bandwidth
                    .download
                    .clock
                    .lock()
                    .unwrap()
                    .bytes_per_second,
                1024 * 1_048_576
            );
        }
    }
}
