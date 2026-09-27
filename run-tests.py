# -*- coding: utf-8 -*-
"""
Verify the mutual-watch fix WITHOUT a terminal, and write a report.

Run by 跑测试.cmd (double-click). Finds node itself, runs every test file in the
repo's test/ directory, and writes a plain-language report so the result can be
read even if this window closes immediately.

Deliberately dependency-free and encoding-tolerant: this has to work on a machine
where the user never opens a terminal.
"""
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = REPO
REPORT = os.path.join(OUT_DIR, "sw-suite.txt")

NODE_CANDIDATES = [
    r"C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
    r"C:\Program Files\nodejs\node.exe",
    r"C:\Program Files (x86)\nodejs\node.exe",
    os.path.join(os.environ.get("LOCALAPPDATA") or "", "Programs", "nodejs", "node.exe"),
]

# Old-behaviour tests first, then the new regression test that pins the bug.
PREFERRED = [
    "selftest.mjs",
    "plugin-selfcheck.mjs",
    "reload-safety.mjs",
    "notify-test.mjs",
    "diagnose-test.mjs",
    "mutual-watch-test.mjs",
]


def find_node():
    for path in NODE_CANDIDATES:
        if path and os.path.isfile(path):
            return path
    for base in (os.environ.get("PATH") or "").split(os.pathsep):
        cand = os.path.join(base, "node.exe")
        if os.path.isfile(cand):
            return cand
    return None


def run(cmd, cwd, timeout=300):
    try:
        p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return "TIMEOUT", "timed out after %ss" % timeout
    except Exception as exc:  # noqa: BLE001
        return "ERROR", "%s: %s" % (type(exc).__name__, exc)


def main():
    try:
        os.makedirs(OUT_DIR, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass

    # The console is the user's only view of this, so make the Chinese actually render. A Chinese
    # Windows console defaults to GBK, and writing UTF-8 into it produces mojibake that looks like the
    # tool is broken - which, for a report whose entire job is to be readable, is a real bug.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - older/exotic streams simply keep their default
            pass

    lines = []

    def say(text=""):
        lines.append(text)
        print(text)

    say("=" * 72)
    say("  dsh-session-watch  测试报告")
    say("=" * 72)
    say("")

    node = find_node()
    if node is None:
        say("找不到 node.exe —— 测试没跑成。")
        say("这台机器上应该有一份内置的：")
        say(r"  C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe")
        write(lines)
        return 1

    say("node: %s" % node)
    rc, ver = run([node, "--version"], REPO)
    say("node 版本: %s" % ver.strip())
    say("仓库: %s" % REPO)
    say("")

    test_dir = os.path.join(REPO, "test")
    if not os.path.isdir(test_dir):
        say("找不到 test 目录：%s" % test_dir)
        write(lines)
        return 1

    files = [f for f in PREFERRED if os.path.isfile(os.path.join(test_dir, f))]
    for extra in sorted(os.listdir(test_dir)):
        if extra.endswith(".mjs") and extra not in files:
            files.append(extra)

    results = []
    for name in files:
        path = os.path.join(test_dir, name)
        rc, out = run([node, path], REPO)
        say("-" * 72)
        say("%s" % name)
        say("-" * 72)
        say(out.rstrip())
        ok = (rc == 0)
        say("")
        say(">>> %s: %s" % (name, "通过 PASS" if ok else "失败 FAIL (exit=%s)" % rc))
        say("")
        results.append((name, ok, rc))

    say("=" * 72)
    say("  汇总")
    say("=" * 72)
    failed = [n for (n, ok, _) in results if not ok]
    for (name, ok, rc) in results:
        say("  %-26s %s" % (name, "通过" if ok else "失败 (exit=%s)" % rc))
    say("")
    if failed:
        say("结论：有 %d 个测试失败 -> %s" % (len(failed), ", ".join(failed)))
        say("")
        say("这不算意外：mutual-watch-test.mjs 是专门为这个 bug 写的，")
        say("如果它在修复前就通过，那才是问题。请把这份报告整个发给我。")
    else:
        say("结论：全部通过。修复的回归测试和原有的 5 个测试都过了。")
        say("")
        say("下一步：重启 DSH 宿主，插件才会加载新代码（它现在还在跑旧的那一代）。")

    say("")
    say("报告也写到了：")
    say("  %s" % REPORT)

    write(lines)
    return 0 if not failed else 1


def write(lines):
    try:
        with open(REPORT, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
    except Exception as exc:  # noqa: BLE001
        print("(报告写不出去: %s)" % exc)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - never vanish with a traceback the user cannot read
        print("脚本崩了: %s: %s" % (type(exc).__name__, exc))
        try:
            with open(REPORT, "w", encoding="utf-8") as fh:
                fh.write("脚本崩了: %s: %s\n" % (type(exc).__name__, exc))
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
