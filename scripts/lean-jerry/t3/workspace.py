"""Run one T3-authorized shell operation in the checkout chosen by T3."""
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import time


def execute(command, cwd, cancelled, timeout=90):
    root = pathlib.Path(cwd).resolve(strict=True)
    if not root.is_dir() or root in (pathlib.Path("/"), pathlib.Path.home()):
        raise ValueError("Choose a project directory in T3.")
    with tempfile.TemporaryDirectory(prefix="jerry-t3-") as scratch:
        scratch = os.path.realpath(scratch)
        # sandbox-exec checks resolved filesystem paths for every child process.
        roots = [str(root), scratch]
        system = ["/bin", "/sbin", "/usr", "/System", "/Library/Developer",
                  "/opt/homebrew", "/Applications/Xcode.app", "/private/etc", "/dev"]
        def subpaths(paths):
            return " ".join("(subpath " + json.dumps(p) + ")" for p in paths)
        policy = ("(version 1)(deny default)(import \"system.sb\")(allow process*)(allow sysctl-read)(allow file-map-executable)"
                  "(allow file-read-metadata)"
                  "(allow file-read* " + subpaths(roots + system) + ")"
                  "(allow file-write* " + subpaths(roots) + ' (literal "/dev/null"))')
        env = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
               "HOME": scratch, "TMPDIR": scratch, "LANG": "en_US.UTF-8"}
        with tempfile.TemporaryFile(dir=scratch) as log:
            process = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", policy,
                                        "/bin/sh", "-c", command], cwd=root, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            deadline = time.monotonic() + timeout
            reason = None
            try:
                while process.poll() is None:
                    if cancelled.wait(0.1) or time.monotonic() >= deadline or log.tell() > 8_000_000:
                        reason = "Command cancelled or resource limit reached."
                        break
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            size = log.tell()
            log.seek(max(0, size - 6000))
            return {"exitCode": process.returncode, "output": log.read().decode(errors="replace"),
                    "truncated": size > 6000, "error": reason}
