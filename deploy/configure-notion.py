"""Register an existing read-only Notion connection token without command-line/history exposure."""
import argparse
import getpass
import os
from pathlib import Path
import re


def configure(path, token, root):
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,256}", token):
        raise ValueError("Invalid Notion token format")
    root = root.replace("-", "").lower()
    if not re.fullmatch(r"[a-f0-9]{32}", root):
        raise ValueError("Invalid Notion root page ID")
    if not path.is_file() or path.is_symlink():
        raise ValueError("An existing regular deployment .env file is required")
    original = path.read_text()
    updates = {"NOTION_TOKEN": token, "NOTION_ROOT_PAGE_IDS": root}
    lines = []
    for line in original.splitlines():
        name = line.split("=", 1)[0].strip() if "=" in line else ""
        if name not in updates:
            lines.append(line)
    lines.extend(f"{name}={value}" for name, value in updates.items())
    temporary = path.with_name(path.name + ".notion-tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as target:
            target.write("\n".join(lines) + "\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", type=Path, required=True)
    parser.add_argument("--root", default="30cba097c65980b5bddbfd0a67de936a")
    args = parser.parse_args()
    configure(args.env, getpass.getpass("Existing read-only Notion token (hidden): ").strip(), args.root)
    print("Notion connection saved with mode 600. No service was restarted.")
