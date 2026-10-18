"""Shortcut audit of exactly the presets in a built bank (ported from
new_dataset/climb/audit-dataset.py): each preset is
matched to its own job validation row (by dot layout and steps, since job
preset names repeat across banks), then tools/shortcut-baselines.py runs per
tier on those pairs.

Usage: audit.py BANK.json [--work-dir DIR]
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def key(preset):
    return json.dumps([preset["facePoints"], preset["steps"]], sort_keys=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bank")
    parser.add_argument("--work-dir", default="new_dataset/climb", help="Directory holding the generated source banks.")
    args = parser.parse_args()
    work = ROOT / args.work_dir
    data = json.loads(Path(args.bank).read_text())
    for tier in (3, 5):
        want = {key(p): name for name, p in data.items() if int(p["difficulty"]) == tier}
        bank, rows, matched = {}, [], set()
        for job in glob.glob(f"{work}/*-bank/jobs/*.json"):
            if job.endswith((".done.json", ".validation.json")):
                continue
            report = job[:-5] + ".validation.json"
            if not os.path.exists(report):
                continue
            try:
                presets = json.loads(Path(job).read_text())
                results = {r["name"]: r for r in json.loads(Path(report).read_text()).get("results", [])}
            except (json.JSONDecodeError, OSError):
                continue
            for name, preset in presets.items():
                uid = want.get(key(preset))
                if uid and uid not in matched and name in results:
                    matched.add(uid)
                    bank[uid] = preset
                    rows.append(dict(results[name], name=uid))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as b, \
                tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as r:
            json.dump(bank, b)
            json.dump({"results": rows}, r)
        out = subprocess.run([sys.executable, str(ROOT / "tools/shortcut-baselines.py"), "--bank", b.name, "--report", r.name],
                             capture_output=True, text=True)
        print(f"== d{tier}: {len(matched)} of {len(want)} presets matched to their own validation row")
        print("\n".join(out.stdout.strip().splitlines()[-6:]))
        if out.stderr.strip():
            print(out.stderr.strip()[-500:])


if __name__ == "__main__":
    main()
