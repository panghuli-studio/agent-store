//! An app started from Finder, the Dock or an agent-store:// link gets launchd's PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). The sidecar finds `claude` and `codex` on PATH, and a
//! terminal finds them through the user's shell profile, so the app takes PATH from a login
//! shell once at startup (#203).

use std::io::{IsTerminal, Read};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

// A slow profile only delays the first window by this much; on a timeout PATH stays as it was.
const TIMEOUT: Duration = Duration::from_secs(5);
const MARK: &str = "__AGENT_STORE_PATH__";

/// Puts the login shell's PATH first and keeps the inherited entries it lacks.
///
/// Must run before Tauri starts any thread: `set_var` is not safe while another thread
/// may read the environment.
pub fn apply() {
  // Started from a terminal: PATH is already the user's, and an interactive child shell
  // could stop on job control over that terminal.
  if std::io::stdin().is_terminal() {
    return;
  }
  let inherited = std::env::var("PATH").unwrap_or_default();
  if let Some(login) = login_shell_path(&shell(), TIMEOUT) {
    std::env::set_var("PATH", merge(&login, &inherited));
  }
}

fn shell() -> String {
  std::env::var("SHELL")
    .ok()
    .filter(|s| s.starts_with('/'))
    .unwrap_or_else(|| "/bin/zsh".into())
}

fn login_shell_path(shell: &str, timeout: Duration) -> Option<String> {
  // Interactive too: nvm and many npm setups add to PATH in ~/.zshrc, which a login shell
  // alone does not read. stdin is closed so an rc file that prompts cannot wait for input.
  // printenv rather than `echo $PATH`: fish joins a list variable with spaces.
  let script = format!("echo {MARK}; /usr/bin/printenv PATH; echo {MARK}");
  let mut child = Command::new(shell)
    .args(["-i", "-l", "-c", &script])
    .env("DISABLE_AUTO_UPDATE", "true")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
    .ok()?;
  let mut stdout = child.stdout.take()?;
  let (tx, rx) = mpsc::channel();
  // Stops at the closing mark, not at EOF: a daemon started by the profile can hold stdout open.
  std::thread::spawn(move || {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
      match stdout.read(&mut chunk) {
        Ok(0) | Err(_) => break,
        Ok(n) => buf.extend_from_slice(&chunk[..n]),
      }
      if String::from_utf8_lossy(&buf).matches(MARK).count() >= 2 {
        break;
      }
    }
    let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
  });
  let out = rx.recv_timeout(timeout).ok();
  let _ = child.kill();
  let _ = child.wait();
  between_marks(&out?).map(str::to_owned)
}

fn between_marks(out: &str) -> Option<&str> {
  let mut parts = out.split(MARK);
  parts.next()?;
  let path = parts.next()?.trim();
  parts.next()?;
  path.starts_with('/').then_some(path)
}

fn merge(first: &str, rest: &str) -> String {
  let mut seen = std::collections::HashSet::new();
  first
    .split(':')
    .chain(rest.split(':'))
    .filter(|s| !s.is_empty() && seen.insert(*s))
    .collect::<Vec<_>>()
    .join(":")
}
