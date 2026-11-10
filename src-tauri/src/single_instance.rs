//! One running instance per data directory, without extra dependencies.
//!
//! The first instance listens on a loopback port derived from its data
//! directory. A second launch (e.g. a manual start while auto-start already put
//! one in the tray) connects, asks the first one to show its window, and exits,
//! so two backends never automate the same match or write the same config.
//! If the ports belong to some other program the handshake fails and the app
//! simply starts normally: the guard can never stop the app from running.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const HELLO: &str = "aram-assistant-show-v1";
/// Liveness probe that does not show the window (used while restarting).
const PING: &str = "aram-assistant-ping-v1";
/// Set before an in-place restart: the new process waits for the old one to
/// release the port instead of waking it (which would make the restart exit).
pub const RESTART_ENV: &str = "ARAM_ASSISTANT_RESTARTING";
const ACK: &str = "aram-assistant-ok-v1";

/// Candidate loopback ports for a data directory, stable per path, in
/// 40000..60000. Windows (Hyper-V, WSL) reserves 100-port blocks that can
/// cover any single port, so later candidates sit far apart from the first.
pub fn ports_for(data_dir: &Path) -> [u16; 4] {
    // FNV-1a over the lowercased path (Windows paths are case-insensitive).
    let mut hash: u32 = 0x811c_9dc5;
    for byte in data_dir.to_string_lossy().to_lowercase().bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    let base = hash % 20_000;
    [0u32, 1, 2, 3].map(|i| 40_000 + ((base + i * 4_999) % 20_000) as u16)
}

pub enum Instance {
    /// We are the only instance; `serve` the listener to answer later launches.
    /// The ports are earlier candidates that were busy when we started.
    Primary(TcpListener, Vec<u16>),
    /// Another instance answered and was asked to show itself.
    AlreadyRunning,
    /// No candidate port could be claimed or answered: run without the guard.
    Unguarded,
}

/// Claim the first free candidate port, or wake the instance that holds one.
/// Every launch scans the same order, so the first port that is either ours
/// or free decides; ports held by other programs (or reserved) are skipped.
pub fn acquire(ports: &[u16]) -> Instance {
    if std::env::var_os(RESTART_ENV).is_some() {
        return acquire_after_restart(ports);
    }
    for (index, &port) in ports.iter().enumerate() {
        let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        if let Ok(listener) = TcpListener::bind(addr) {
            return Instance::Primary(listener, ports[..index].to_vec());
        }
        if handshake(addr, HELLO) {
            return Instance::AlreadyRunning;
        }
    }
    Instance::Unguarded
}

/// The previous process is exiting: wait up to ~5s for it to release its
/// port, without waking it and without claiming a later candidate meanwhile.
fn acquire_after_restart(ports: &[u16]) -> Instance {
    for _ in 0..50 {
        let mut old_still_alive = false;
        for (index, &port) in ports.iter().enumerate() {
            let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
            if handshake(addr, PING) {
                old_still_alive = true;
                break;
            }
            if let Ok(listener) = TcpListener::bind(addr) {
                return Instance::Primary(listener, ports[..index].to_vec());
            }
        }
        if !old_still_alive {
            // Nothing of ours answers and nothing could be bound.
            return Instance::Unguarded;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Instance::Unguarded
}

fn handshake(addr: SocketAddrV4, message: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.into(), Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    if writeln!(stream, "{}", message).is_err() {
        return false;
    }
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).is_ok() && reply.trim() == ACK
}

/// Answer later launches on background threads; `on_show` runs per request.
///
/// `earlier` are candidates that were busy at startup. If one frees up later,
/// a new launch would claim it and run as a second instance, so we keep trying
/// to take them over (every 0.5s) and answer on them too. Probing later ports
/// at startup instead would cost ~0.3s per port on Windows, on every launch.
pub fn serve(listener: TcpListener, earlier: Vec<u16>, on_show: impl Fn() + Send + Sync + 'static) {
    let on_show: Arc<dyn Fn() + Send + Sync> = Arc::new(on_show);
    answer(listener, Arc::clone(&on_show));
    if earlier.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let mut pending = earlier;
        while !pending.is_empty() {
            pending.retain(|&port| {
                match TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)) {
                    Ok(listener) => {
                        answer(listener, Arc::clone(&on_show));
                        false
                    }
                    Err(_) => true,
                }
            });
            std::thread::sleep(RECLAIM_EVERY);
        }
    });
}

const RECLAIM_EVERY: Duration = Duration::from_millis(500);

fn answer(listener: TcpListener, on_show: Arc<dyn Fn() + Send + Sync>) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
            let mut line = String::new();
            let mut reader = BufReader::new(&stream);
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let request = line.trim();
            if request == HELLO || request == PING {
                let mut writer = &stream;
                let _ = writeln!(writer, "{}", ACK);
                if request == HELLO {
                    on_show();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A loopback port that is free right now (bound by the OS, then released).
    fn free_port() -> u16 {
        let probe = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        probe.local_addr().unwrap().port()
    }

    /// Answer every connection with something that is not our ACK.
    fn foreign_listener() -> u16 {
        let foreign = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = foreign.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in foreign.incoming().flatten() {
                let mut s = &stream;
                let _ = writeln!(s, "HTTP/1.1 400 Bad Request");
            }
        });
        port
    }

    #[test]
    fn test_ports_are_stable_per_directory_spread_and_in_range() {
        let a = ports_for(Path::new(r"C:\Users\x\AppData\Roaming\lol-aram-assistant"));
        let b = ports_for(Path::new(r"c:\users\X\appdata\roaming\LOL-ARAM-ASSISTANT"));
        let c = ports_for(Path::new(r"D:\portable\lol-aram-assistant"));
        assert_eq!(a, b, "case-insensitive like Windows paths");
        assert_ne!(a[0], c[0]);
        for port in a {
            assert!((40_000..60_000).contains(&port));
        }
        // No two candidates share a 100-port reserved block.
        for i in 0..a.len() {
            for j in i + 1..a.len() {
                assert!(a[i].abs_diff(a[j]) >= 100, "{a:?}");
            }
        }
    }

    #[test]
    fn test_second_launch_wakes_the_first() {
        let ports = [free_port()];
        let Instance::Primary(listener, _) = acquire(&ports) else {
            panic!("first instance must own the port");
        };
        let shown = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&shown);
        serve(listener, Vec::new(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert!(matches!(acquire(&ports), Instance::AlreadyRunning));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(shown.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_taken_first_port_falls_through_to_the_next_candidate() {
        // The first candidate belongs to another program: both launches skip
        // it and meet on the second one.
        let ports = [foreign_listener(), free_port()];
        let Instance::Primary(listener, _) = acquire(&ports) else {
            panic!("first instance must claim the second candidate");
        };
        assert_eq!(listener.local_addr().unwrap().port(), ports[1]);
        serve(listener, Vec::new(), || {});
        assert!(matches!(acquire(&ports), Instance::AlreadyRunning));
    }

    #[test]
    fn test_primary_takes_over_an_earlier_port_once_it_frees_up() {
        // Something holds the first candidate when we start, then lets it go.
        // A later launch must still find us instead of claiming that port.
        let blocker = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let ports = [blocker.local_addr().unwrap().port(), free_port()];
        let Instance::Primary(listener, earlier) = acquire(&ports) else {
            panic!("first instance must claim the second candidate");
        };
        assert_eq!(earlier, vec![ports[0]]);
        serve(listener, earlier, || {});
        drop(blocker);
        std::thread::sleep(RECLAIM_EVERY + Duration::from_millis(500));
        assert!(matches!(acquire(&ports), Instance::AlreadyRunning));
    }

    #[test]
    fn test_foreign_listeners_on_every_candidate_leave_the_app_unguarded() {
        let ports = [foreign_listener(), foreign_listener()];
        assert!(matches!(acquire(&ports), Instance::Unguarded));
    }

    #[test]
    fn test_ping_answers_without_showing_the_window() {
        let port = free_port();
        let Instance::Primary(listener, _) = acquire(&[port]) else {
            panic!("first instance must own the port");
        };
        let shown = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&shown);
        serve(listener, Vec::new(), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert!(handshake(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port), PING));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(shown.load(Ordering::SeqCst), 0);
    }
}
