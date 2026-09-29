#!/usr/bin/env python3
"""Report numeric Codex rollout usage only; never emit paths, session IDs or messages."""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import sys

PRICING = {
    "source": "https://developers.openai.com/api/docs/pricing",
    "context_source": "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "verified_date": "2026-09-29",
    "currency": "USD",
    "unit": "per_1m_tokens",
    "short_context_input_limit": 272000,
    "fast_multiplier": 2,
    "standard_short": {
        "gpt-6-astra": {"input": "10", "cached_input": "1", "output": "50"},
        "gpt-6-sol": {"input": "2", "cached_input": "0.2", "output": "10"},
        "gpt-6-luna": {"input": "0.1", "cached_input": "0.01", "output": "0.5"},
    },
}
FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens",
          "output_tokens", "reasoning_output_tokens", "total_tokens")


class UsageError(Exception):
    """Messages are static error codes, never source data."""


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def first_metadata(filename):
    with filename.open("rb") as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except (ValueError, UnicodeError):
                raise UsageError("invalid_metadata") from None
            if record.get("type") == "session_meta":
                return record.get("payload", {})
    raise UsageError("missing_metadata")


def select_files(directory, files, root_file):
    root = root_file.resolve(strict=True)
    if directory:
        # Use the first metadata record. Forked history can contain copied parent metadata later.
        candidates = {p.resolve(): first_metadata(p) for p in directory.glob("*.jsonl")}
        if root not in candidates:
            raise UsageError("root_not_in_directory")
        selected = {root}
        identifiers = {candidates[root].get("id")}
        changed = True
        while changed:
            changed = False
            for filename, meta in candidates.items():
                parents = {meta.get("parent_thread_id"), meta.get("forked_from_id")} - {None}
                if filename not in selected and parents.intersection(identifiers):
                    selected.add(filename)
                    identifiers.add(meta.get("id"))
                    changed = True
    else:
        selected = {p.resolve(strict=True) for p in files}
        if root not in selected:
            raise UsageError("root_not_in_explicit_files")
    # Inode identity prevents counting the same file twice through hardlinks or symlinks.
    unique = {}
    for filename in [root, *sorted(selected - {root})]:
        info = filename.stat()
        unique.setdefault((info.st_dev, info.st_ino), filename)
    return list(unique.values()), root


def validate_counts(value):
    if not isinstance(value, dict):
        raise UsageError("invalid_usage")
    result = {}
    for key in FIELDS:
        count = value.get(key, 0 if key == "cache_write_input_tokens" else None)
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise UsageError("invalid_usage_count")
        result[key] = count
    if result["cached_input_tokens"] > result["input_tokens"]:
        raise UsageError("cache_exceeds_input")
    if result["reasoning_output_tokens"] > result["output_tokens"]:
        raise UsageError("reasoning_exceeds_output")
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        raise UsageError("total_usage_contract_mismatch")
    return result


def read_usage(filename, role):
    # Freeze each file's byte boundary while an active process may append more events.
    with filename.open("rb") as stream:
        size = filename.stat().st_size
        snapshot = stream.read(size)
    models, tiers = set(), set()
    last = None
    last_at = None
    token_events = updates = incomplete_tail = missing_last_usage = 0
    maximum = 0
    lines = snapshot.splitlines(keepends=True)
    for index, line in enumerate(lines):
        try:
            record = json.loads(line)
        except (ValueError, UnicodeError):
            if index == len(lines) - 1 and not line.endswith(b"\n"):
                incomplete_tail += 1
                continue
            raise UsageError("malformed_complete_log_line") from None
        payload = record.get("payload", {})
        if record.get("type") == "turn_context":
            if isinstance(payload.get("model"), str):
                models.add(payload["model"])
            tier = payload.get("service_tier")
            if tier is not None:
                tiers.add("standard" if tier in ("standard", "default") else "fast" if tier in ("fast", "priority") else "other")
        if record.get("type") != "event_msg" or payload.get("type") != "token_count":
            continue
        info = payload.get("info") or {}
        if info.get("total_token_usage") is None:
            continue
        current = validate_counts(info["total_token_usage"])
        if last and any(current[key] < last[key] for key in FIELDS):
            raise UsageError("cumulative_counter_decreased")
        token_events += 1
        if current != last:
            updates += 1
        # Repeated notifications are observations of a cumulative value, not extra consumption.
        last = current
        stamp = record.get("timestamp")
        try:
            last_at = datetime.fromisoformat(stamp.replace("Z", "+00:00")).isoformat()
        except (AttributeError, ValueError):
            last_at = None
        request_input = (info.get("last_token_usage") or {}).get("input_tokens")
        if isinstance(request_input, bool) or not isinstance(request_input, int) or request_input < 0:
            missing_last_usage += 1
        else:
            maximum = max(maximum, request_input)
    if not last:
        return None
    if len(models) != 1:
        raise UsageError("missing_model_or_model_switch")
    model = next(iter(models))
    # Unknown model strings are never copied from a private log into public output.
    if model not in PRICING["standard_short"]:
        raise UsageError("unsupported_model")
    return {"role": role, "model": model, "usage": last,
            "latest_usage_at": last_at, "token_count_events": token_events,
            "distinct_cumulative_updates": updates, "max_request_input_tokens": maximum,
            "missing_request_input_observations": missing_last_usage,
            "incomplete_tail_lines": incomplete_tail, "observed_service_tiers": sorted(tiers)}


def total(records):
    usage = {key: sum(row["usage"][key] for row in records) for key in FIELDS}
    usage["uncached_input_tokens"] = usage["input_tokens"] - usage["cached_input_tokens"]
    usage["uncached_input_plus_output_tokens"] = usage["uncached_input_tokens"] + usage["output_tokens"]
    return usage


def estimate(model, usage, eligible):
    if not eligible:
        return {"standard_usd": None, "fast_usd": None}
    rates = PRICING["standard_short"][model]
    cost = (Decimal(usage["uncached_input_tokens"]) * Decimal(rates["input"])
            + Decimal(usage["cached_input_tokens"]) * Decimal(rates["cached_input"])
            + Decimal(usage["output_tokens"]) * Decimal(rates["output"])) / Decimal(1000000)
    return {"standard_usd": float(cost), "fast_usd": float(cost * 2)}


def build_report(filenames, root, selection, final=False):
    started = utc_now()
    records = [row for filename in filenames
               if (row := read_usage(filename, "root" if filename == root else "subagent"))]
    if not records:
        raise UsageError("no_usage_observed")
    maximum = max(row["max_request_input_tokens"] for row in records)
    missing = sum(row["missing_request_input_observations"] for row in records)
    totals = total(records)
    eligible = maximum <= PRICING["short_context_input_limit"] and missing == 0 and totals["cache_write_input_tokens"] == 0
    grouped = defaultdict(list)
    for row in records:
        grouped[row["model"]].append(row)
    by_model = [{"model": model, "files": len(group), "usage": total(group),
                 "api_equivalent_estimate": estimate(model, total(group), eligible)}
                for model, group in sorted(grouped.items())]
    money = {key: float(sum(Decimal(str(row["api_equivalent_estimate"][key])) for row in by_model)) if eligible else None
             for key in ("standard_usd", "fast_usd")}
    return {
        "schema_version": 1, "status": "final_requested" if final else "active_checkpoint",
        "snapshot_started_at": started, "snapshot_completed_at": utc_now(),
        "selection": {"method": selection, "files_selected": len(filenames), "files_with_usage": len(records),
                      "root_files": sum(row["role"] == "root" for row in records),
                      "subagent_files": sum(row["role"] == "subagent" for row in records)},
        "method": "Take the last cumulative total_token_usage once per distinct file; never sum cumulative event notifications. Output includes reasoning output.",
        "usage": totals, "by_model": by_model,
        "by_role": [{"role": role, "files": len(group), "usage": total(group)}
                    for role in ("root", "subagent") if (group := [row for row in records if row["role"] == role])],
        "observations": {"latest_usage_at": max((row["latest_usage_at"] for row in records if row["latest_usage_at"]), default=None),
                         "oldest_last_usage_at": min((row["latest_usage_at"] for row in records if row["latest_usage_at"]), default=None),
                         "token_count_events": sum(row["token_count_events"] for row in records),
                         "distinct_cumulative_updates": sum(row["distinct_cumulative_updates"] for row in records),
                         "incomplete_tail_lines": sum(row["incomplete_tail_lines"] for row in records),
                         "max_request_input_tokens": maximum,
                         "missing_request_input_observations": missing,
                         "all_observed_requests_within_short_context": maximum <= PRICING["short_context_input_limit"] and missing == 0,
                         "observed_service_tiers": sorted({tier for row in records for tier in row["observed_service_tiers"]})},
        "pricing": PRICING, "api_equivalent_estimate": {**money, "status": "estimated" if eligible else "requires_per_request_or_cache_write_analysis"},
        "limitations": ["This is an API token-price equivalent, not a ChatGPT OAuth charge or invoice.",
                        "Standard and Fast are alternative assumptions; no tier is inferred from a user preference.",
                        "Cached input is included in input; reasoning output is included in output and is not added again.",
                        "Active files are sampled sequentially; rerun after work finishes. --final does not stop or verify process completion.",
                        "Tool fees, hosting, embeddings, taxes, data-residency uplift and external Hermes inference are excluded.",
                        "Token totals describe this implementation session, not production wiki users or retrieval benchmark payloads."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--files", type=Path, nargs="+", help="Explicit rollout files; repeated real files are deduplicated")
    group.add_argument("--directory", type=Path, help="Flat rollout directory; select the root and first-metadata descendant graph")
    parser.add_argument("--root-file", type=Path, required=True, help="Actual root rollout path, never inferred from copied metadata")
    parser.add_argument("--output", type=Path, required=True, help="Public aggregate JSON output; contains no source IDs or paths")
    parser.add_argument("--final", action="store_true", help="Label an operator-requested final snapshot; does not stop active work")
    args = parser.parse_args()
    filenames, root = select_files(args.directory, args.files, args.root_file)
    output_identity = None
    if args.output.exists():
        output_stat = args.output.stat()
        output_identity = (output_stat.st_dev, output_stat.st_ino)
    if args.output.resolve() in filenames or any(
        output_identity == (info.st_dev, info.st_ino)
        for info in (filename.stat() for filename in filenames)
    ):
        raise UsageError("output_overwrites_source")
    report = build_report(filenames, root, "first_metadata_descendant_graph" if args.directory else "explicit_files", args.final)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "files": len(filenames), "usage": report["usage"],
                      "api_equivalent_estimate": report["api_equivalent_estimate"]}))


if __name__ == "__main__":
    try:
        main()
    except UsageError as error:
        print(f"Usage report failed ({error}). No private source details are printed.", file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Usage report failed (invalid_input_or_io). No private source details are printed.", file=sys.stderr)
        sys.exit(1)
