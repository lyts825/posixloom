//! PosixLoom's single binary exposes a verified launcher and an internal process host.
//! Module boundaries keep protocol decoding, platform resources and supply-chain checks separate.
mod launcher;
mod protocol;
#[cfg(not(windows))]
mod unix_exec;
#[cfg(windows)]
mod windows_exec;
mod worker;

fn main() {
    let mut arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments
        .first()
        .is_some_and(|value| value == "__exec-host")
    {
        if arguments.len() != 2 || arguments[1] != "--protocol-v1" {
            eprintln!(
                "posixloom-host: use __exec-host --protocol-v1 for the internal process protocol"
            );
            std::process::exit(2);
        }
        worker::run();
        return;
    }
    // Public commands always pass through the verified launcher. Keep the explicit
    // launch spelling for existing integrations, without requiring it for normal use.
    if arguments.first().is_some_and(|value| value == "launch") {
        arguments.remove(0);
    }
    launcher::launch(arguments);
}
