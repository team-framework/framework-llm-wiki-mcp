#!/usr/bin/env python3
"""Validate and package the standalone Framework Wiki plugin without credentials."""

import argparse
import json
from pathlib import Path
import re
import struct
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "plugins" / "framework-llm-wiki"
SKILLS = {"wiki-answer", "wiki-metrics", "wiki-change"}
ENDPOINT = "https://framework-wiki.chaeyn.com/mcp"
ALLOWED = {
    "plugin.json", "mcp.json", "README.md", "assets/framework.png", "assets/composer-icon.svg",
    "skills/wiki-answer/SKILL.md", "skills/wiki-answer/references/retrieval.md",
    "skills/wiki-metrics/SKILL.md", "skills/wiki-change/SKILL.md",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(source):
    require(source.is_dir() and not source.is_symlink(), "Plugin source must be a real directory")
    files = {}
    for item in sorted(source.rglob("*")):
        require(not item.is_symlink(), f"Symlink is not allowed: {item.relative_to(source)}")
        if item.is_file():
            relative = item.relative_to(source).as_posix()
            require(relative in ALLOWED, f"Unexpected package file: {relative}")
            files[relative] = item.read_bytes()
    require(set(files) == ALLOWED, "The package must contain every expected manifest, skill, and asset")

    manifest = json.loads(files["plugin.json"])
    require(manifest.get("$schema") == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "Invalid plugin schema")
    require(manifest.get("name") == source.name == "framework-llm-wiki", "Plugin directory and manifest name must match")
    require(re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")), "A semantic version is required")
    require(not {"skills", "apps", "mcpServers", "interface"} & manifest.keys(), "Use portable manifest fields")
    presentation = manifest["extensions"]["com.openai"]["interface"]
    require(0 < len(presentation["shortDescription"]) <= 30, "Subtitle must be at most 30 characters")
    prompts = presentation["defaultPrompt"]
    require(isinstance(prompts, str) or (isinstance(prompts, list) and 1 <= len(prompts) <= 3 and all(isinstance(p, str) for p in prompts)), "Invalid default prompts")
    require(presentation["capabilities"] == ["Read"], "The connected MCP is read-only")
    for field in ("logo", "composerIcon"):
        require(presentation[field].startswith("./") and presentation[field][2:] in files, f"Missing contained {field} asset")

    mcp = json.loads(files["mcp.json"])
    require(mcp == {
        "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        "mcpServers": {"framework-wiki": {"type": "streamable-http", "url": ENDPOINT}},
    }, "MCP connection must use the existing OAuth endpoint without embedded credentials")

    for skill in SKILLS:
        content = files[f"skills/{skill}/SKILL.md"].decode("utf-8")
        frontmatter = re.match(r"\A---\n(.*?)\n---\n", content, re.S)
        require(frontmatter is not None, f"Missing frontmatter: {skill}")
        fields = dict(re.findall(r"^(name|description): (.+)$", frontmatter[1], re.M))
        require(fields.get("name") == skill and fields.get("description", "").strip(), f"Invalid skill metadata: {skill}")

    png = files["assets/framework.png"]
    require(png.startswith(b"\x89PNG\r\n\x1a\n") and png[12:16] == b"IHDR", "Invalid PNG logo")
    width, height = struct.unpack(">II", png[16:24])
    require(48 <= width == height <= 4096 and len(png) <= 5 * 1024 * 1024, "Logo must be a square supported image")
    svg = ElementTree.fromstring(files["assets/composer-icon.svg"])
    require(svg.tag == "{http://www.w3.org/2000/svg}svg" and svg.get("viewBox") == "0 0 128 128", "Invalid composer icon")
    require(all(element.tag.rsplit("}", 1)[-1] in {"svg", "rect", "path"} for element in svg.iter()), "Composer icon must contain only static geometry")

    credential = re.compile(r"-----BEGIN .*PRIVATE KEY-----|(?:gh[pousr]_|github_pat_|sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{20,}")
    for name, data in files.items():
        if not name.endswith(".png"):
            require(not credential.search(data.decode("utf-8")), f"Credential-like material found in {name}")
    return manifest, files


def package(output, source=SOURCE):
    manifest, files = validate(source)
    output = output.expanduser().resolve()
    require(not output.is_relative_to(source.resolve()), "Write the ZIP outside the plugin directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name, data in files.items():
            entry = ZipInfo(f"{manifest['name']}/{name}", date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    with ZipFile(output) as archive:
        require(archive.testzip() is None, "Archive integrity check failed")
    return {"archive": str(output), "name": manifest["name"], "version": manifest["version"], "files": len(files)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.output), ensure_ascii=False))
    except (ValueError, KeyError) as error:
        parser.exit(1, f"Plugin package validation failed: {error}\n")
