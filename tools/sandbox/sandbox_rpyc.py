"""Boot a sandbox whose RPyC server survives the mapped-folder mount race.

pywinsandbox's own logon script starts the RPyC server straight out of the mapped folder:

    cmd.exe /c "C:\\Users\\WDAGUtilityAccount\\Desktop\\anaconda\\python.exe ... target.py ..."

Measured failure of exactly that: `FileNotFoundError: Sandbox server didn't startup`. The logon command
runs at logon while the mapped folder is attached asynchronously by a separate driver, so the python.exe
path it names does not exist yet, the command dies immediately, and no server is ever started. This is the
same race that made our own file bus silent, and it is confirmed independently by the guest polling 158
times (~158s) before `C:\\share` appeared.

So this module keeps pywinsandbox's control channel - RPyC over TCP, which crosses the RDP boundary
without touching the guest's UI - and replaces only the bootstrap: the logon script polls for the mapped
folder and starts the server only once it exists.

It also avoids `OnlineSandbox.__init__` itself, which raises on Python 3.9 because it calls
`warn_explicit` without the `category` argument that signature requires, and which overwrites any logon
script supplied by the caller anyway. The pieces it uses (`OnlineSession`, `generate_config_file`) are the
library's own.
"""

import pathlib
import subprocess
import sys
import tempfile
import traceback

import rpyc

from winsandbox.config.config import SandboxConfig
from winsandbox.config.config_genereator import generate_config_file
from winsandbox.folder_mapper import (
    FolderMapper,
    PythonMapper,
    PythonUserSitePackagesMapper,
)
from winsandbox.session.online_session import OnlineSession, _is_server_responding
from winsandbox.utils import venv
from winsandbox.utils.path import shared_folder_path_in_sandbox
from winsandbox import target

# The mapped-folder mount has been observed to take ~158s; the budget is deliberately larger so a slow
# mount is not mistaken for a broken server.
DEFAULT_MOUNT_WAIT_SECONDS = 900
# The library's own default is 25s, which cannot cover a slow mount.
DEFAULT_CONNECT_TIMEOUT_SECONDS = 900


class SandboxBootError(RuntimeError):
    """A sandbox could not be brought up, with the reason named."""


class _SandboxShim:
    """The minimum `OnlineSession` needs from a sandbox: its config."""

    def __init__(self, config):
        self.config = config


def shared_directory():
    directory = pathlib.Path(tempfile.gettempdir()) / "gamebuddy_sandbox_bus"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _mapped(local_path):
    return str(shared_folder_path_in_sandbox(local_path)).replace("\\", "/")


def build_logon_script(
    server_address_path, mount_wait_seconds=DEFAULT_MOUNT_WAIT_SECONDS
):
    """A logon command that waits for the mount, then starts the RPyC server.

    The wait uses only cmd built-ins (`for /L`, `if exist`, `ping`), so nothing it touches can be absent
    because of the race. Only once the mapped `target.py` is visible does it hand over to python, by
    which point the shared folder is real.
    """
    remote_python = _mapped(sys.executable)
    remote_target = _mapped(target.__file__)
    mapped_address = _mapped(server_address_path)
    user_site = PythonUserSitePackagesMapper().path()
    remote_user_site = _mapped(user_site) if user_site.exists() else ""

    launch = '"{python}" "{target}" --disable-firewall "{address}"'.format(
        python=remote_python, target=remote_target, address=mapped_address
    )
    if remote_user_site:
        launch += ' "{site}"'.format(site=remote_user_site)

    wait = (
        'for /L %i in (1,1,{limit}) do @(if exist "{probe}" (exit /b 0) else ping -n 2 127.0.0.1 >nul)'
    ).format(limit=mount_wait_seconds, probe=remote_target)

    return 'cmd.exe /c "{wait} & {launch}"'.format(wait=wait, launch=launch)


def new_sandbox(
    mount_wait_seconds=DEFAULT_MOUNT_WAIT_SECONDS,
    connect_timeout_seconds=DEFAULT_CONNECT_TIMEOUT_SECONDS,
):
    """Create a sandbox and return (connection, address_path, config_path)."""
    shared = shared_directory()
    address_path = shared / "server_address"
    if address_path.exists():
        address_path.unlink()

    mappers = [
        FolderMapper(shared, read_only=False),
        PythonMapper(),
        PythonUserSitePackagesMapper(),
    ]
    if venv.is_inside_venv():
        mappers.append(FolderMapper(sys.base_prefix))

    config = SandboxConfig(
        folder_mappers=[mapper for mapper in mappers if mapper.path().exists()],
        networking=True,
        logon_script="",
        virtual_gpu=False,
    )

    # Let the library decide the mapped paths it would normally use, then take over the bootstrap.
    session = OnlineSession(_SandboxShim(config))
    session.configure_sandbox()
    config.logon_script = build_logon_script(address_path, mount_wait_seconds)

    configuration = generate_config_file(config)
    config_path = shared / "gamebuddy.wsb"
    # Windows Sandbox rejects a .wsb that begins with a BOM.
    config_path.write_text(configuration, encoding="utf-8")

    # `start` hands the file to the shell, which is how the platform expects to be launched.
    subprocess.Popen(["start", "", str(config_path)], shell=True)

    if not session.connect_to_sandbox(timeout=connect_timeout_seconds):
        raise SandboxBootError(
            'sandbox server did not start within {}s; if the platform reported "only one running '
            'Windows Sandbox instance is allowed", a previous session has not finished closing yet'.format(
                connect_timeout_seconds
            )
        )

    address, port = session.connect_to_sandbox(timeout=5)
    connection = rpyc.classic.connect(address, port)
    return connection, address_path, config_path


def run(connection, command, timeout_seconds=600):
    """Run a command in the guest and return (exit code, stdout, stderr)."""
    result = connection.modules.subprocess.run(
        ["cmd.exe", "/c", command],
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return result.returncode, result.stdout, result.stderr


if __name__ == "__main__":
    print("shared dir:", shared_directory())
    try:
        connection, address_path, config_path = new_sandbox()
    except Exception:
        print("BOOT FAILED")
        traceback.print_exc()
        raise SystemExit(1)

    print("config:", config_path)
    print(
        "address file:",
        address_path,
        "=",
        address_path.read_text() if address_path.exists() else "absent",
    )

    print("--- round trip ---")
    try:
        code, out, err = run(connection, "echo hello-from-guest & hostname")
        print("exit:", code)
        print("stdout:", repr(out))
        print("stderr:", repr(err))
    except Exception:
        print("ROUND TRIP FAILED")
        traceback.print_exc()
        raise SystemExit(1)

    print("--- guest tooling premise ---")
    code, out, err = run(
        connection, "where dotnet 2>nul & where node 2>nul & echo probe-done"
    )
    print("stdout:", repr(out))

    print("--- shutting down ---")
    try:
        run(connection, "shutdown /s /t 0")
    except Exception:
        pass
    print("shutdown requested")
