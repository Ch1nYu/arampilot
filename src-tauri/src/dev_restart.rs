//! Tray restart for a debug build made from the source tree: rebuild in the
//! background without a console window, only when the sources changed, then
//! restart into the new build. Release builds just re-exec themselves.
//!
//! The dev app runs from a copy in `src-tauri/target/run`, because Windows
//! cannot overwrite a running exe and cargo writes `target/debug/tauri-app.exe`.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Emitter;

static BUILDING: AtomicBool = AtomicBool::new(false);

const SCAN_DIRS: &[&str] = &[
    "src",
    "src-tauri/src",
    "src-tauri/capabilities",
    "src-tauri/icons",
    "public",
];

const SCAN_FILES: &[&str] = &[
    "index.html",
    "package.json",
    "pnpm-lock.yaml",
    "vite.config.ts",
    "tsconfig.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "src-tauri/build.rs",
];

/// The source tree this debug build came from. Release builds do not embed the
/// build machine's path; dev restart is unavailable there anyway.
fn repo_root() -> PathBuf {
    #[cfg(debug_assertions)]
    {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }
    #[cfg(not(debug_assertions))]
    {
        PathBuf::new()
    }
}

pub fn run_dir(root: &Path) -> PathBuf {
    root.join("src-tauri").join("target").join("run")
}

pub fn run_exe_path(root: &Path) -> PathBuf {
    run_dir(root).join("tauri-app.exe")
}

pub fn debug_exe_path(root: &Path) -> PathBuf {
    root.join("src-tauri")
        .join("target")
        .join("debug")
        .join("tauri-app.exe")
}

fn old_exe_path(root: &Path) -> PathBuf {
    run_dir(root).join("tauri-app.old.exe")
}

fn fingerprint_path(root: &Path) -> PathBuf {
    run_dir(root).join("fingerprint.txt")
}

fn build_log_path(root: &Path) -> PathBuf {
    run_dir(root).join("build.log")
}

fn normalize_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn push_file_entry(
    root: &Path,
    path: &Path,
    entries: &mut Vec<(String, u64, u128)>,
) -> io::Result<()> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Ok(());
    }
    entries.push((
        normalize_rel(root, path),
        metadata.len(),
        modified_nanos(&metadata),
    ));
    Ok(())
}

fn collect_dir(root: &Path, dir: &Path, entries: &mut Vec<(String, u64, u128)>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() {
            if matches!(name.as_ref(), "node_modules" | "target" | "dist") {
                continue;
            }
            collect_dir(root, &path, entries)?;
        } else if file_type.is_file() {
            let metadata = entry.metadata()?;
            entries.push((
                normalize_rel(root, &path),
                metadata.len(),
                modified_nanos(&metadata),
            ));
        }
    }
    Ok(())
}

pub fn compute_fingerprint(root: &Path) -> io::Result<String> {
    let mut entries: Vec<(String, u64, u128)> = Vec::new();
    for dir in SCAN_DIRS {
        let path = root.join(dir);
        if path.is_dir() {
            collect_dir(root, &path, &mut entries)?;
        }
    }
    for file in SCAN_FILES {
        let path = root.join(file);
        if path.is_file() {
            push_file_entry(root, &path, &mut entries)?;
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = DefaultHasher::new();
    for (rel, size, mtime) in &entries {
        rel.hash(&mut hasher);
        size.hash(&mut hasher);
        mtime.hash(&mut hasher);
    }
    Ok(format!("{:016x}", hasher.finish()))
}

pub fn read_stored_fingerprint(root: &Path) -> Option<String> {
    let content = fs::read_to_string(fingerprint_path(root)).ok()?;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn write_fingerprint(root: &Path, fingerprint: &str) -> io::Result<()> {
    let dir = run_dir(root);
    fs::create_dir_all(&dir)?;
    fs::write(fingerprint_path(root), fingerprint)
}

pub fn needs_build(root: &Path) -> bool {
    let Ok(current) = compute_fingerprint(root) else {
        return true;
    };
    needs_build_with_fingerprint(root, &current)
}

fn needs_build_with_fingerprint(root: &Path, current: &str) -> bool {
    let Some(stored) = read_stored_fingerprint(root) else {
        return true;
    };
    !(stored == current && run_exe_path(root).is_file())
}

pub fn install_run_exe(root: &Path) -> io::Result<()> {
    let run_dir = run_dir(root);
    let debug_exe = debug_exe_path(root);
    let run_exe = run_exe_path(root);
    let old_exe = old_exe_path(root);
    fs::create_dir_all(&run_dir)?;
    let _ = fs::remove_file(&old_exe);
    let renamed = if run_exe.exists() {
        fs::rename(&run_exe, &old_exe)?;
        true
    } else {
        false
    };
    match fs::copy(&debug_exe, &run_exe) {
        Ok(_) => Ok(()),
        Err(e) => {
            if renamed {
                let _ = fs::rename(&old_exe, &run_exe);
            }
            Err(e)
        }
    }
}

pub fn cleanup_old_exe_on_startup() {
    if !cfg!(debug_assertions) {
        return;
    }
    let _ = fs::remove_file(old_exe_path(&repo_root()));
}

fn emit_log(app: &tauri::AppHandle, kind: &str, title: &str, reason: String) {
    let _ = app.emit(
        "lcu-log",
        serde_json::json!({ "kind": kind, "title": title, "reason": reason }),
    );
}

/// The compiler errors in a build log, at most `max`, each with its location;
/// the last non-empty lines when no error line is recognised. pnpm and tauri
/// wrapper lines (`ELIFECYCLE`, `beforeBuildCommand ... failed`) are noise.
fn build_error_summary(log: &str, max: usize) -> String {
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let mut errors: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let is_error = line.starts_with("error") || line.contains(": error ");
        let noise = line.contains("ELIFECYCLE") || line.contains("beforeBuildCommand");
        if !is_error || noise {
            continue;
        }
        // rustc prints the location on the next line: `--> src/lib.rs:10:5`.
        let entry = match lines.get(i + 1) {
            Some(next) if next.starts_with("-->") => format!("{line} {next}"),
            _ => line.to_string(),
        };
        if !errors.contains(&entry) {
            errors.push(entry);
        }
        if errors.len() == max {
            break;
        }
    }
    if errors.is_empty() {
        let start = lines.len().saturating_sub(max);
        return lines[start..].join("\n");
    }
    errors.join("\n")
}

fn read_build_error_summary(path: &Path) -> String {
    let mut content = String::new();
    if fs::File::open(path)
        .and_then(|mut f| f.read_to_string(&mut content))
        .is_err()
    {
        return String::new();
    }
    format!(
        "{}\n完整輸出：src-tauri/target/run/build.log",
        build_error_summary(&content, 3)
    )
}

fn run_build(root: &Path) -> io::Result<std::process::ExitStatus> {
    let run_dir = run_dir(root);
    fs::create_dir_all(&run_dir)?;
    let log_path = build_log_path(root);
    let log = fs::File::create(&log_path)?;
    let log_err = log.try_clone()?;

    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "pnpm", "tauri", "build", "--debug", "--no-bundle"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new("pnpm");
        c.args(["tauri", "build", "--debug", "--no-bundle"]);
        c
    };

    cmd.current_dir(root);
    cmd.stdout(std::process::Stdio::from(log));
    cmd.stderr(std::process::Stdio::from(log_err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.status()
}

fn spawn_restart(exe: PathBuf) -> io::Result<std::process::Child> {
    std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env(crate::single_instance::RESTART_ENV, "1")
        .spawn()
}

fn release_restart(app: &tauri::AppHandle) {
    match std::env::current_exe().and_then(spawn_restart) {
        Ok(_) => app.exit(0),
        Err(err) => eprintln!("restart failed: {err}"),
    }
}

fn dev_restart_available(root: &Path) -> bool {
    cfg!(debug_assertions) && root.join("package.json").is_file()
}

fn dev_restart_flow(app: tauri::AppHandle, root: PathBuf) {
    let current_fp = match compute_fingerprint(&root) {
        Ok(fp) => fp,
        Err(e) => {
            emit_log(
                &app,
                "err",
                "開發版重新啟動失敗",
                format!("無法計算原始碼指紋：{e}"),
            );
            return;
        }
    };

    if !needs_build_with_fingerprint(&root, &current_fp) {
        match spawn_restart(run_exe_path(&root)) {
            Ok(_) => app.exit(0),
            Err(e) => emit_log(
                &app,
                "err",
                "開發版重新啟動失敗",
                format!("無法啟動執行檔：{e}"),
            ),
        }
        return;
    }

    if BUILDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    emit_log(
        &app,
        "sys",
        "開發版重新編譯中",
        "背景編譯最新原始碼，完成後自動重新啟動".to_string(),
    );

    let status = match run_build(&root) {
        Ok(s) => s,
        Err(e) => {
            BUILDING.store(false, Ordering::SeqCst);
            emit_log(
                &app,
                "err",
                "開發版重新編譯失敗",
                format!("無法啟動編譯：{e}"),
            );
            return;
        }
    };

    if !status.success() {
        BUILDING.store(false, Ordering::SeqCst);
        let reason = read_build_error_summary(&build_log_path(&root));
        let _ = app.emit(
            "lcu-log",
            serde_json::json!({
                "kind": "err",
                "title": "開發版重新編譯失敗",
                "reason": reason,
            }),
        );
        return;
    }

    if let Err(e) = install_run_exe(&root) {
        BUILDING.store(false, Ordering::SeqCst);
        emit_log(
            &app,
            "err",
            "開發版重新編譯失敗",
            format!("安裝新執行檔失敗：{e}"),
        );
        return;
    }

    if let Err(e) = write_fingerprint(&root, &current_fp) {
        BUILDING.store(false, Ordering::SeqCst);
        emit_log(
            &app,
            "err",
            "開發版重新編譯失敗",
            format!("寫入指紋失敗：{e}"),
        );
        return;
    }

    match spawn_restart(run_exe_path(&root)) {
        Ok(_) => app.exit(0),
        Err(e) => {
            BUILDING.store(false, Ordering::SeqCst);
            emit_log(
                &app,
                "err",
                "開發版重新編譯失敗",
                format!("無法啟動新執行檔：{e}"),
            );
        }
    }
}

pub fn request_restart(app: tauri::AppHandle) {
    let root = repo_root();
    if !dev_restart_available(&root) {
        release_restart(&app);
        return;
    }
    std::thread::spawn(move || dev_restart_flow(app, root));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_repo(name: &str) -> PathBuf {
        let n = TEST_COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "aram_dev_restart_{name}_{}_{}",
            std::process::id(),
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn build_error_summary_keeps_compiler_errors_and_drops_wrapper_noise() {
        // The tsc failure from the real build.log of a broken build.
        let ts = [
            "$ tauri \"build\" \"--debug\" \"--no-bundle\"",
            "Running beforeBuildCommand `pnpm build`",
            "src/main.ts(1058,7): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/main.ts(1058,7): error TS6133: '__breakBuild' is declared but its value is never read.",
            "[ELIFECYCLE] Command failed with exit code 2.",
            "Error beforeBuildCommand `pnpm build` failed with exit code 2",
            "[ELIFECYCLE] Command failed with exit code 1.",
        ]
        .join("\n");
        assert_eq!(
            build_error_summary(&ts, 3),
            [
                "src/main.ts(1058,7): error TS2322: Type 'string' is not assignable to type 'number'.",
                "src/main.ts(1058,7): error TS6133: '__breakBuild' is declared but its value is never read.",
            ]
            .join("\n")
        );
        // rustc: the location line is attached to its error.
        let rs = [
            "   Compiling tauri-app v0.2.3",
            "error[E0425]: cannot find value `x` in this scope",
            "  --> src/lib.rs:10:5",
            "error: could not compile `tauri-app` (lib) due to 1 previous error",
        ]
        .join("\n");
        assert_eq!(
            build_error_summary(&rs, 3),
            [
                "error[E0425]: cannot find value `x` in this scope --> src/lib.rs:10:5",
                "error: could not compile `tauri-app` (lib) due to 1 previous error",
            ]
            .join("\n")
        );
        // Nothing recognisable: fall back to the last lines.
        assert_eq!(build_error_summary("a\n\nb\nc\nd\n", 3), "b\nc\nd");
    }

    fn write_file(path: &Path, content: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn fingerprint_is_stable_when_unchanged() {
        let root = temp_repo("stable");
        write_file(&root.join("src/main.txt"), b"hello");
        write_file(&root.join("package.json"), b"{}");

        let a = compute_fingerprint(&root).unwrap();
        let b = compute_fingerprint(&root).unwrap();
        assert_eq!(a, b);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fingerprint_changes_when_src_file_changes_size() {
        let root = temp_repo("size");
        write_file(&root.join("src/main.txt"), b"abc");
        let a = compute_fingerprint(&root).unwrap();

        write_file(&root.join("src/main.txt"), b"abcd");
        let b = compute_fingerprint(&root).unwrap();
        assert_ne!(a, b);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn fingerprint_ignores_node_modules_target_dist() {
        let root = temp_repo("ignored");
        write_file(&root.join("src/app.txt"), b"base");
        let base = compute_fingerprint(&root).unwrap();

        write_file(&root.join("src/node_modules/pkg/index.js"), b"ignored");
        write_file(&root.join("src/target/debug/out"), b"ignored");
        write_file(&root.join("src/dist/bundle.js"), b"ignored");
        let after = compute_fingerprint(&root).unwrap();
        assert_eq!(base, after);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn needs_build_false_only_when_stored_matches_and_run_exe_exists() {
        let root = temp_repo("needs");
        write_file(&root.join("src/app.txt"), b"v1");
        let fp = compute_fingerprint(&root).unwrap();

        // No stored fingerprint, no run exe.
        assert!(needs_build(&root));

        // Stored matches but run exe missing.
        write_fingerprint(&root, &fp).unwrap();
        assert!(needs_build(&root));

        // Stored matches and run exe exists.
        write_file(&run_exe_path(&root), b"exe");
        assert!(!needs_build(&root));

        // Stored differs even if run exe exists.
        write_fingerprint(&root, "deadbeef").unwrap();
        assert!(needs_build(&root));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn install_renames_existing_run_exe_and_copies_new_one() {
        let root = temp_repo("install");
        write_file(&debug_exe_path(&root), b"new-binary");
        write_file(&run_exe_path(&root), b"old-binary");

        install_run_exe(&root).unwrap();

        assert_eq!(fs::read(run_exe_path(&root)).unwrap(), b"new-binary");
        assert_eq!(fs::read(old_exe_path(&root)).unwrap(), b"old-binary");

        let _ = fs::remove_dir_all(&root);
    }
}
