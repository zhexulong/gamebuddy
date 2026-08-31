//! mc-module entrypoint: boot on `subc-client-rs`'s `serve` (provider role).
//!
//! `serve` owns the handshake (read `--subc <connection-file>`, authenticate, send
//! HELLO{manifest}, await HELLO_ACK, then dispatch route data requests to the
//! handler). The handler opens the single-writer store in `on_hello_ack`.

#![forbid(unsafe_code)]

use std::error::Error;
use std::path::PathBuf;

use mc_module::{manifest, McHandler, DEFAULT_MODULE_ID};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // Fleet convention: a side-effect-free single-line --version, evaluated before
    // any runtime argument so supervisors and test substrates can probe the binary
    // without a connection file.
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("ck-mc {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let module_id = std::env::var(subc_protocol::SUBC_MODULE_ID_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODULE_ID.to_string());

    let connection_file = parse_subc_arg(std::env::args_os().skip(1))?;
    subc_client_rs::serve_with(
        &connection_file,
        manifest(&module_id),
        McHandler::new_with_connection_file(Some(connection_file.clone())),
    )
    .await?;
    Ok(())
}

fn parse_subc_arg<I>(mut args: I) -> Result<PathBuf, Box<dyn Error + Send + Sync>>
where
    I: Iterator<Item = std::ffi::OsString>,
{
    while let Some(arg) = args.next() {
        if arg == "--subc" {
            return args
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--subc requires a connection-file path".into());
        }
    }
    Err("missing --subc <connection-file>".into())
}
