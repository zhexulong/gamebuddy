//! Cross-platform helper to suppress the console window that Windows spawns for
//! every child process. The dashboard shells out to external tools such as
//! `opencode` and `pi`; without `CREATE_NO_WINDOW` each spawn flashes a console
//! window, so opening the dashboard on Windows can pop a dozen-plus terminals.
//!
//! On non-Windows targets these are no-ops, so call sites stay uniform.

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply `CREATE_NO_WINDOW` to a `std::process::Command` on Windows.
pub trait NoWindowExt {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindowExt for std::process::Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}

/// Apply `CREATE_NO_WINDOW` to a `tokio::process::Command` on Windows.
pub trait NoWindowExtTokio {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindowExtTokio for tokio::process::Command {
    #[cfg(windows)]
    fn no_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }

    #[cfg(not(windows))]
    fn no_window(&mut self) -> &mut Self {
        self
    }
}
