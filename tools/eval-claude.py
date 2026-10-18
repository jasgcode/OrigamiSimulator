#!/usr/bin/env python3
"""Answer a rendered dataset with Claude through the Claude Code CLI.

  python3 tools/eval-claude.py --dataset DATASET_DIR/dataset.jsonl \\
      --out preds.jsonl [--model claude-opus-5-5] [--workers 4] [--limit N]

Each row goes to `claude -p` as one user message: the row's images, then the
prompt TopoBench's order_origami task builds (lmms_eval_tasks/_common.py on
topobench main): the question, its post prompt, and the JSON answer suffix.
Tools are off, user settings and hooks are not loaded, and nothing is saved
between rows. Predictions are JSONL lines of {"id", "response"}, appended as
they finish; a rerun skips ids already in --out. Score them with
score-predictions.py. Image paths in the dataset resolve against its folder,
so the probe files from build-probes.py work too.
"""
import argparse
import base64
import json
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

POST_PROMPT = "Return JSON only using the required answer schema."
# _json_answer_suffix in topobench's lmms_eval_tasks/_common.py, for origami
# answers (a letter list without legal_values_spec counts as a string).
ANSWER_SUFFIX = 'Return JSON only: {"answer": "<value>"}. Do not output explanation.'
SYSTEM_PROMPT = "You are a helpful assistant."


def prompt_text(row):
    return "\n".join([row["question"], POST_PROMPT, ANSWER_SUFFIX])


def message(row, root):
    content = []
    for path in row["images"]:
        data = base64.b64encode((root / path).read_bytes()).decode("ascii")
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}})
    content.append({"type": "text", "text": prompt_text(row)})
    return json.dumps({"type": "user", "message": {"role": "user", "content": content}})


OVERLOAD_RETRIES = 3


def command(model):
    return ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--model", model, "--tools", "", "--system-prompt", SYSTEM_PROMPT, "--setting-sources", "",
            "--strict-mcp-config", "--no-session-persistence"]


def result_text(stdout):
    """The final result text from claude's stream-json output, or None."""
    for line in reversed(stdout.splitlines()):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            return event.get("result"), event
    return None, None


def answer(row, root, model, timeout):
    started = time.time()
    proc = subprocess.run(command(model), input=message(row, root), capture_output=True, text=True, timeout=timeout)
    text, event = result_text(proc.stdout)
    record = {"id": row["id"], "response": text if text is not None else "", "model": model,
              "seconds": round(time.time() - started, 1)}
    if event is None or event.get("is_error"):
        record["error"] = (proc.stderr or proc.stdout)[-500:]
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", required=True, help="dataset.jsonl or a probe JSONL beside it")
    parser.add_argument("--out", required=True, help="Predictions JSONL, appended to and resumed from")
    parser.add_argument("--model", default="claude-opus-5-5")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--limit", type=int, default=0, help="Answer at most this many rows")
    parser.add_argument("--timeout", type=int, default=900, help="Seconds per row")
    args = parser.parse_args(argv)

    dataset = Path(args.dataset)
    rows = [json.loads(line) for line in dataset.read_text().splitlines() if line.strip()]
    out = Path(args.out)
    done = set()
    if out.exists():
        # Errored rows are answered again; drop their records so the scorer,
        # which rejects duplicate ids, sees one prediction per row.
        kept = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
        kept = [record for record in kept if not record.get("error")]
        out.write_text("".join(json.dumps(record) + "\n" for record in kept))
        done = {record["id"] for record in kept}
    todo = [row for row in rows if row["id"] not in done]
    if args.limit:
        todo = todo[:args.limit]
    print(f"{len(rows)} rows, {len(done)} answered, {len(todo)} to answer with {args.model}", flush=True)

    lock = threading.Lock()
    errors = 0

    def run(row):
        nonlocal errors
        for attempt in range(OVERLOAD_RETRIES + 1):
            try:
                record = answer(row, dataset.parent, args.model, args.timeout)
            except subprocess.TimeoutExpired:
                record = {"id": row["id"], "response": "", "model": args.model, "error": "timeout"}
            # The API answers 529 Overloaded under load; it clears in a minute or two.
            if attempt == OVERLOAD_RETRIES or "Overloaded" not in record.get("error", ""):
                break
            time.sleep(60 * (attempt + 1))
        with lock:
            errors += bool(record.get("error"))
            with out.open("a") as fh:
                fh.write(json.dumps(record) + "\n")
            print(f"{row['id']}: {record['response'][:60]!r}{' ERROR' if record.get('error') else ''}", flush=True)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(run, todo))
    print(f"done: {len(todo) - errors} answered, {errors} errors", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
