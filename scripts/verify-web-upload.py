#!/usr/bin/env python3
"""Web dist upload contract.

Behavioral harness: runs the real deploy/upload-web-dist.sh with real rsync and
real SHA tools, replacing only the "remote host" with a local directory through
injected remote-exec / copy wrappers. Plus a source-level ratchet that keeps the
workflow wired to the script.

Usage: python3 scripts/verify-web-upload.py
Exit: 0 when every case passes, 1 otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "deploy" / "upload-web-dist.sh"
WORKFLOW = ROOT / ".github" / "workflows" / "deploy.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"
PACKAGE = ROOT / "package.json"

BIG_NAMES = [f"auth/login-loop-0{i}.mp4" for i in range(1, 6)]
failures: list[str] = []
results: list[tuple[str, bool, str]] = []


def record(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ((" :: " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(name)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def big_bytes(i: int) -> bytes:
    return (b"X" + bytes([i]) * 1023) * 256  # 256 KiB per file


class Fixture:
    def __init__(self, base: pathlib.Path):
        self.base = base
        self.local = base / "local"
        self.remote = base / "remote"
        self.tools = base / "tools"
        self.inbox = self.tools / "inbox"
        self.deploy = self.tools / "deploy"
        self.share = self.tools / "share"
        self.sidecars = self.tools / "sidecars"
        for d in (self.local / "assets", self.local / "auth", self.remote / "assets",
                  self.remote / "auth", self.inbox, self.deploy, self.share,
                  self.sidecars / "static"):
            d.mkdir(parents=True, exist_ok=True)
        self.remote_exec = self.tools / "remote_exec.sh"
        self.copy_sh = self.tools / "copy.sh"
        self.count = self.tools / "remote_exec.count"
        self.copy_log = self.tools / "copy.log"
        self.sync_log = self.tools / "rsync.log"
        self.manifest = self.tools / "lnkpi-web-manifest.sha256"
        self.tgz = self.tools / "lnkpi-web-dist.tgz"
        self._build_local()
        self._build_remote()
        self._build_sidecars()
        self._build_wrappers()

    def _build_sidecars(self) -> None:
        (self.sidecars / "nginx.conf").write_bytes(b"# nginx fixture\n")
        (self.sidecars / "deploy-web.sh").write_bytes(b"#!/usr/bin/env bash\ntrue\n")
        # #723 的分享默认 OG 卡，内容固定用于逐字节比对。
        (self.sidecars / "static" / "share-og-default.png").write_bytes(b"\x89PNG-f1xture-og-card")

    def _build_local(self) -> None:
        for i, name in enumerate(BIG_NAMES, 1):
            (self.local / name).write_bytes(big_bytes(i))
        (self.local / "assets" / "index-NEW01.js").write_bytes(b"/* new index chunk */")
        (self.local / "assets" / "vendor-NEW02.js").write_bytes(b"/* new vendor chunk */")
        (self.local / "index.html").write_bytes(b"<html>new build</html>")
        (self.local / "auth" / "poster.jpg").write_bytes(b"poster")

    def _build_remote(self) -> None:
        old = time.time() - 7200
        for i, name in enumerate(BIG_NAMES, 1):
            p = self.remote / name
            p.write_bytes(big_bytes(i))
            os.utime(p, (old, old))  # same content, different mtime: --checksum must skip the transfer
        (self.remote / "assets" / "index-OLD01.js").write_bytes(b"/* old 1 */")
        (self.remote / "assets" / "vendor-OLD02.js").write_bytes(b"/* old 2 */")
        (self.remote / "assets" / "misc-OLD03.js").write_bytes(b"/* old 3 */")
        (self.remote / "index.html").write_bytes(b"<html>old build</html>")
        (self.remote / "auth" / "poster.jpg").write_bytes(b"poster")
        (self.remote / "brand").mkdir(exist_ok=True)
        (self.remote / "brand" / "logo.png").write_bytes(b"historical, must survive without --delete")

    def _build_wrappers(self) -> None:
        self.remote_exec.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"echo 1 >> '{self.count}'\n"
            f"cd '{self.remote}'\n"
            'exec bash -c "$1"\n',
            encoding="utf-8",
        )
        self.copy_sh.write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"log='{self.copy_log}'\n"
            f"inbox='{self.inbox}'\n"
            'for f in "$@"; do\n'
            "  case \"$f\" in *:*) continue ;; esac\n"
            '  [[ -f "$f" ]] || continue\n'
            '  cp "$f" "$inbox/"\n'
            '  basename "$f" >> "$log"\n'
            "done\n",
            encoding="utf-8",
        )
        self.remote_exec.chmod(0o755)
        self.copy_sh.chmod(0o755)
        self.count.touch()
        self.copy_log.touch()

    def rel_files(self, root: pathlib.Path) -> dict[str, bytes]:
        return {
            str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()
        }

    def local_files(self) -> dict[str, bytes]:
        return self.rel_files(self.local)

    def remote_files(self) -> dict[str, bytes]:
        return self.rel_files(self.remote)


def run_upload(fx: Fixture, *, verify_only: bool = False, legacy: bool = False,
               rsync_bin: str = "rsync", extra: dict[str, str] | None = None):
    if not SCRIPT.exists():
        return subprocess.CompletedProcess(args=["bash", str(SCRIPT)], returncode=127,
                                          stdout="", stderr=f"missing {SCRIPT}")
    env = os.environ.copy()
    env.update({
        "LNKPI_WEB_DIST": str(fx.local),
        "LNKPI_WEB_REMOTE_DIST": str(fx.remote),
        "LNKPI_WEB_REMOTE_DEPLOY_DIR": str(fx.deploy),
        "LNKPI_WEB_SHARE_DIR": str(fx.share),
        "LNKPI_WEB_RSYNC_DEST": str(fx.remote) + "/",
        "LNKPI_WEB_REMOTE_EXEC": f"bash {fx.remote_exec}",
        "LNKPI_WEB_COPY": f"bash {fx.copy_sh}",
        "LNKPI_WEB_SYNC_LOG": str(fx.sync_log),
        "LNKPI_WEB_WORK": str(fx.tools),
        "LNKPI_WEB_INBOX": str(fx.inbox),
        "LNKPI_WEB_REMOTE_HOST": "deploy-cvm",
        "LNKPI_WEB_SIDECARS": str(fx.sidecars),
        "LNKPI_WEB_RSYNC_BIN": rsync_bin,
        "LNKPI_WEB_VERIFY_ONLY": "1" if verify_only else "0",
        "LNKPI_WEB_UPLOAD_LEGACY": "1" if legacy else "0",
    })
    if extra:
        env.update(extra)
    try:
        return subprocess.run(["bash", str(SCRIPT)], cwd=ROOT, env=env,
                              capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired as e:
        return subprocess.CompletedProcess(args=["bash"], returncode=124,
                                          stdout=e.stdout or "", stderr=str(e))


def read_log(fx: Fixture) -> str:
    return fx.sync_log.read_text(encoding="utf-8", errors="replace") if fx.sync_log.exists() else ""


def transferred_count(log: str) -> int | None:
    # rsync 2.6.x: "Number of files transferred: N"
    # rsync 3.x:   "Number of regular files transferred: N"
    m = re.search(r"Number of (?:regular )?files transferred:\s*([\d,]+)", log)
    return int(m.group(1).replace(",", "")) if m else None


# ---------------------------------------------------------------- scenarios

def s1_no_big_transfer() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s1-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx)
        log = read_log(fx)
        n = transferred_count(log)
        lines = [ln for ln in log.splitlines() if any(name.split("/")[-1] in ln for name in BIG_NAMES)]
        content_transfers = [ln for ln in lines if ln.startswith((">", "<"))]
        ok = (r.returncode == 0 and n is not None and n <= 3
              and len(lines) >= 5 and not content_transfers
              and "MANIFEST_OK" in r.stdout)
        record("S1_big_files_not_transferred", ok,
               f"exit={r.returncode} transferred={n} big_lines={len(lines)} "
               f"content_transfers={content_transfers[:2]} stdout={r.stdout[-200:]} stderr={r.stderr[-200:]}")


def s2_all_files_match() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s2-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx)
        local, remote = fx.local_files(), fx.remote_files()
        missing = [p for p in local if p not in remote]
        mismatched = [p for p in local if p in remote and sha(local[p]) != sha(remote[p])]
        ok = r.returncode == 0 and not missing and not mismatched and "MANIFEST_OK" in r.stdout
        record("S2_remote_matches_local_manifest", ok,
               f"exit={r.returncode} missing={missing[:3]} mismatched={mismatched[:3]} stderr={r.stderr[-200:]}")


def s3_old_assets_cleaned() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s3-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx)
        want = {p.split("/")[-1] for p in fx.local_files() if p.startswith("assets/")}
        got = {p.split("/")[-1] for p in fx.remote_files() if p.startswith("assets/")}
        survived = (fx.remote / "brand" / "logo.png").exists()
        ok = r.returncode == 0 and got == want and survived
        record("S3_only_assets_cleaned_no_delete", ok,
               f"exit={r.returncode} want={sorted(want)} got={sorted(got)} non_assets_history_survived={survived}")


def s4_corruption_blocks() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s4-") as t:
        fx = Fixture(pathlib.Path(t))
        first = run_upload(fx)
        (fx.remote / "index.html").write_bytes(b"<html>tampered by probe</html>")
        r = run_upload(fx, verify_only=True)
        ok = first.returncode == 0 and r.returncode != 0 and "MANIFEST_OK" not in r.stdout
        record("S4_corrupted_remote_fails_verification", ok,
               f"first_exit={first.returncode} verify_exit={r.returncode} stdout={r.stdout[-200:]}")


def s5_legacy_switch() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s5-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx, legacy=True)
        copied = fx.copy_log.read_text(encoding="utf-8").splitlines()
        local, remote = fx.local_files(), fx.remote_files()
        same = all(p in remote and sha(v) == sha(remote[p]) for p, v in local.items())
        ok = (r.returncode == 0 and same and "lnkpi-web-dist.tgz" in copied
              and "UPLOAD_MODE=legacy" in r.stdout and "MANIFEST_OK" in r.stdout)
        record("S5_legacy_tar_path_delivers_same_tree", ok,
               f"exit={r.returncode} same={same} copied={copied} stdout={r.stdout[-200:]} stderr={r.stderr[-200:]}")


def s6_rsync_missing_falls_back() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s6-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx, rsync_bin="lnkpi-rsync-deliberately-absent")
        copied = fx.copy_log.read_text(encoding="utf-8").splitlines()
        local, remote = fx.local_files(), fx.remote_files()
        same = all(p in remote and sha(v) == sha(remote[p]) for p, v in local.items())
        ok = (r.returncode == 0 and same and "lnkpi-web-dist.tgz" in copied
              and "UPLOAD_MODE=legacy" in r.stdout)
        record("S6_missing_rsync_auto_falls_back", ok,
               f"exit={r.returncode} same={same} copied={copied} stdout={r.stdout[-200:]}")


def s7_probe_wiring() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s7-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx)
        calls = len(fx.count.read_text(encoding="utf-8").split())
        log = read_log(fx)
        manifest_lines = len(fx.manifest.read_text(encoding="utf-8").splitlines()) if fx.manifest.exists() else -1
        expected = len(fx.local_files())
        portable = (transferred_count("Number of files transferred: 2") == 2
                    and transferred_count("Number of regular files transferred: 3") == 3)
        ok = (r.returncode == 0 and calls > 0 and log.strip() != ""
              and manifest_lines == expected and transferred_count(log) is not None
              and portable)
        record("S7_probe_is_wired", ok,
               f"exit={r.returncode} remote_calls={calls} log_bytes={len(log)} "
               f"manifest_lines={manifest_lines} expected={expected}")


def s8_share_og_seeded() -> None:
    with tempfile.TemporaryDirectory(prefix="wu-s8-") as t:
        fx = Fixture(pathlib.Path(t))
        r = run_upload(fx)
        target = fx.share / "share-og-default.png"
        source = fx.sidecars / "static" / "share-og-default.png"
        mode = (target.stat().st_mode & 0o777) if target.exists() else None
        copied = fx.copy_log.read_text(encoding="utf-8").splitlines()
        ok = (r.returncode == 0 and target.exists()
              and target.read_bytes() == source.read_bytes()
              and mode == 0o644 and "share-og-default.png" in copied)
        record("S8_share_og_card_seeded_unchanged", ok,
               f"exit={r.returncode} exists={target.exists()} mode={mode} copied={copied} "
               f"stderr={r.stderr[-200:]}")


# ------------------------------------------------------------ source ratchet

def read(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def ss1_workflow_calls_script() -> None:
    s = read(WORKFLOW)
    m = re.search(r"- name: Upload web dist and nginx config(.+?)(?=\n      - name:)", s, re.S)
    step = m.group(1) if m else ""
    ok = bool(step) and "bash deploy/upload-web-dist.sh" in step and "scp /tmp/lnkpi-web-dist.tgz" not in step
    record("SS1_workflow_upload_step_delegates_to_script", ok,
           f"step_found={bool(step)} step={step[-240:]}")


def rsync_command_block(s: str) -> str:
    """Collect the real rsync invocation, including its backslash continuations."""
    out: list[str] = []
    collecting = False
    for ln in s.splitlines():
        if not collecting and re.search(r'"\$RSYNC_BIN"\s+-', ln):
            collecting = True
        if collecting:
            out.append(ln)
            if not ln.rstrip().endswith("\\"):
                break
    return "\n".join(out)


def ss2_checksum_present() -> None:
    s = read(SCRIPT)
    # 类别化判据只看真实命令行，不看注释里对 "--delete" 的说明文字。
    block = rsync_command_block(s)
    ok = (bool(s) and bool(block) and "--checksum" in block
          and "--delete" not in block and "-c " in s)
    record("SS2_script_uses_checksum_and_no_delete", ok,
           f"script_bytes={len(s)} rsync_block={block!r}")


def ss3_no_swallowed_verification() -> None:
    s = read(SCRIPT)
    ok = bool(s) and "|| true" not in s and "MANIFEST_OK" in s and "exit 1" in s
    record("SS3_verification_failure_not_swallowed", ok,
           f"script_bytes={len(s)} has_or_true={'|| true' in s}")


def ss4_ci_and_package_wired() -> None:
    ci, pkg = read(CI), read(PACKAGE)
    try:
        scripts = json.loads(pkg).get("scripts", {}) if pkg else {}
    except json.JSONDecodeError:
        scripts = {}
    ok = ("verify-web-upload" in ci and "pnpm verify-web-upload" in ci
          and "verify-web-upload" in scripts)
    record("SS4_ci_and_package_expose_contract", ok,
           f"ci_has_step={'pnpm verify-web-upload' in ci} pkg_script={scripts.get('verify-web-upload')}")


def ss5_share_og_broadcast_wired() -> None:
    s, workflow = read(SCRIPT), read(WORKFLOW)
    ok = ("share-og-default.png" in s and "cp -f " in s and "chmod 644" in s
          and "#723" in s and "#723" in workflow)
    record("SS5_share_og_broadcast_kept", ok,
           f"script_has_og={'share-og-default.png' in s} workflow_has_723={'#723' in workflow}")


def main() -> int:
    cases = [
        s1_no_big_transfer, s2_all_files_match, s3_old_assets_cleaned,
        s4_corruption_blocks, s5_legacy_switch, s6_rsync_missing_falls_back,
        s7_probe_wiring, s8_share_og_seeded,
        ss1_workflow_calls_script, ss2_checksum_present,
        ss3_no_swallowed_verification, ss4_ci_and_package_wired,
        ss5_share_og_broadcast_wired,
    ]
    for case in cases:
        try:
            case()
        except Exception as exc:  # a crashing case is a failing case, not a harness abort
            record(case.__name__, False, f"exception {type(exc).__name__}: {exc}")
    print(f"\nRESULT {len(cases) - len(failures)}/{len(cases)} passed; failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
