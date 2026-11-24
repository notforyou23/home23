"""Run one T3-authorized shell operation in the checkout chosen by T3."""
import json
import os
import pathlib
import signal
import subprocess
import tempfile
import threading


def execute(command, cwd, cancelled):
    root = pathlib.Path(cwd).resolve(strict=True)
    if not root.is_dir() or root in (pathlib.Path("/"), pathlib.Path.home()):
        raise ValueError("Choose a project directory in T3.")
    with tempfile.TemporaryDirectory(prefix="jerry-t3-") as scratch:
        scratch = os.path.realpath(scratch)
        # sandbox-exec checks resolved filesystem paths for every child process.
        roots = [str(root), scratch]
        system = ["/bin", "/sbin", "/usr", "/System", "/Library/Developer",
                  "/opt/homebrew", "/Applications/Xcode.app", "/private/etc", "/dev"]
        # The /usr/bin developer-tool shims require an external Xcode cache.
        # Use the selected toolchain directly inside the workspace sandbox.
        selected = subprocess.run(["/usr/bin/xcode-select", "-p"], capture_output=True, text=True)
        search_path = ["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        if selected.returncode == 0:
            developer = pathlib.Path(selected.stdout.strip()).resolve(strict=True)
            system.append(str(developer))
            search_path.insert(1, str(developer / "usr/bin"))

        def subpaths(paths):
            return " ".join("(subpath " + json.dumps(p) + ")" for p in paths)
        policy = ("(version 1)(deny default)(import \"system.sb\")(allow process*)(allow sysctl-read)(allow file-map-executable)"
                  "(allow file-read-metadata)(allow network*)"
                  "(allow file-read* " + subpaths(roots + system) + ")"
                  "(allow file-write* " + subpaths(roots) + ' (literal "/dev/null"))')
        env = {"PATH": os.pathsep.join(search_path),
               "HOME": scratch, "TMPDIR": scratch, "LANG": "en_US.UTF-8"}
        process = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", policy,
                                    "/bin/sh", "-c", command], cwd=root, env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        # Keep a bounded receipt without terminating verbose builds.
        tail = bytearray()
        total = 0

        def drain():
            nonlocal total
            with process.stdout as output:
                while True:
                    chunk = output.read1(65536)
                    if not chunk:
                        return
                    total += len(chunk)
                    tail.extend(chunk)
                    del tail[:-6000]

        reader = threading.Thread(target=drain)
        reader.start()
        try:
            while process.poll() is None:
                if cancelled.wait(0.1):
                    break
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            reader.join()
        return {"exitCode": process.returncode, "output": tail.decode(errors="replace"),
                "truncated": total > len(tail), "error": "Cancelled." if cancelled.is_set() else None}
