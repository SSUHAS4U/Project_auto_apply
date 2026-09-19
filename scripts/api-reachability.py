#!/usr/bin/env python3
"""Which backend endpoints does anything actually call?

Run from the repository root:

    python scripts/api-reachability.py           # report
    python scripts/api-reachability.py --strict  # exit 1 if anything is unreachable

WHY THIS EXISTS
---------------
On 2026-09-19 this found 53 of 173 endpoints with no caller anywhere in the repository — 31%
of the authenticated HTTP surface doing nothing, and no way to tell which 31% without asking.
An endpoint kept "just in case" is one nobody tests and everybody still has to secure.

THE TRAP IT ALSO FOUND, WHICH MATTERS MORE
------------------------------------------
`PilotController` had 12 of 12 endpoints uncalled. The obvious conclusion — delete the `pilot`
package — was WRONG: `ExtensionController` holds a `PilotOrchestrator` and the Chrome extension
drives it through `/api/extension/auto-apply/queue`. The controller was dead; the service behind
it was load-bearing.

So: **this script answers "is this ROUTE called", never "is this CODE dead".** A route with no
caller is a candidate for deletion, not a verdict. Check the handler's collaborators before
removing anything. See docs/adr/ADR-002-backend-boundaries.md.
"""
import re
import sys
import pathlib
import collections

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Endpoints that legitimately have no in-repo caller. Each needs a reason, not just a name.
ALLOWED = {
    "/health": "polled by the deploy check and any external uptime monitor",
    "/api/ingest-diag/runs": "read-only diagnostics, called by a human debugging a run",
    "/api/sources": "machine/admin surface, called ad hoc with the API token",
}

CLIENT_GLOBS = (
    "frontend/src/**/*.ts", "frontend/src/**/*.tsx",
    "extension/**/*.js", "worker/src/**/*.js", "desktop/**/*.js",
    ".github/workflows/*.yml", "scripts/*",
)


def mapped_endpoints():
    """Every @*Mapping in the backend, as (controller, verb, full path)."""
    out = []
    for c in ROOT.glob("backend/src/main/java/com/jobpilot/**/*Controller.java"):
        src = c.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'@RequestMapping\("([^"]*)"\)', src)
        base = m.group(1) if m else ""
        for mm in re.finditer(
                r'@(Get|Post|Put|Delete|Patch)Mapping\((?:value\s*=\s*)?"([^"]*)"\)', src):
            out.append((c.name, mm.group(1).upper(), (base + mm.group(2)) or "/"))
    return sorted(set(out))


def called_paths():
    """Every /api/... or /health literal any client mentions."""
    found = set()
    for pat in CLIENT_GLOBS:
        for p in ROOT.glob(pat):
            if "node_modules" in str(p) or not p.is_file():
                continue
            try:
                t = p.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            found |= set(re.findall(r'[\'"`](/api/[A-Za-z0-9_\-/{}$.:]*)', t))
            if "/health" in t:
                found.add("/health")
    return found


def _norm(s):
    """Collapse {id} and ${x} so a templated call matches a templated mapping."""
    return re.sub(r"\{[^}]*\}|\$\{[^}]*\}", "*", s.rstrip("/"))


def main():
    strict = "--strict" in sys.argv
    eps = mapped_endpoints()
    called = {_norm(c) for c in called_paths()}

    def is_called(path):
        n = _norm(path)
        return any(c == n or c.startswith(n + "/") or n.startswith(c + "/") for c in called)

    dead = collections.defaultdict(list)
    live_count = 0
    for ctrl, verb, path in eps:
        if is_called(path) or path in ALLOWED:
            live_count += 1
        else:
            dead[ctrl].append(f"{verb} {path}")

    unreachable = sum(len(v) for v in dead.values())
    print(f"mapped: {len(eps)}   reachable: {live_count}   NO CALLER: {unreachable}")
    if ALLOWED:
        print(f"(allow-listed: {len(ALLOWED)} — see ALLOWED in this file)")
    print()

    for ctrl in sorted(dead, key=lambda c: -len(dead[c])):
        print(f"{ctrl}  ({len(dead[ctrl])} uncalled)")
        for e in dead[ctrl]:
            print(f"    {e}")
        print()

    if unreachable:
        print("Reminder: an uncalled ROUTE is not proof of dead CODE. Check what the handler")
        print("collaborates with before deleting anything — see the module docstring.")

    if strict and unreachable:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
