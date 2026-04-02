"""
TopoBench Origami Tracking – InternVL API Evaluation

Loads dataset.json from ../screenshots/<benchmark>/, sends images + questions
to an OpenAI-compatible VLM API (InternVL), compares responses, reports accuracy.

Config loaded from .env file (BASE_URL, API_KEY, MODEL).

Usage:
    uv run eval.py                          # all benchmarks
    uv run eval.py --benchmarks bird-track-7 bird-track-8
    uv run eval.py --dry-run                # print questions, skip API calls
    uv run eval.py --concurrency 4          # parallel API requests
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv(Path(__file__).resolve().parent / ".env")

SCREENSHOTS_DIR = Path(__file__).resolve().parent.parent / "screenshots"
RESULTS_DIR = Path(__file__).resolve().parent / "results"

VLM_BASE_URL = os.environ["BASE_URL"]
VLM_API_KEY = os.environ["API_KEY"]
VLM_MODEL = os.environ["MODEL"]


# ---------------------------------------------------------------------------
# Image encoding
# ---------------------------------------------------------------------------

def image_to_content(path: Path) -> dict:
    """Build an OpenAI-compatible image_url content block."""
    b64 = base64.b64encode(path.read_bytes()).decode("utf-8")
    suffix = path.suffix.lstrip(".").lower()
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(suffix, "image/png")
    return {
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}"},
    }


# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

async def query_vlm(
    client: AsyncOpenAI,
    images: list[Path],
    question: str,
    semaphore: asyncio.Semaphore,
) -> str:
    """Send images + question to the VLM API and return the text response."""
    content: list[dict] = []
    for img_path in images:
        content.append(image_to_content(img_path))
    content.append({"type": "text", "text": question + "\nAnswer concisely."})

    async with semaphore:
        resp = await client.chat.completions.create(
            model=VLM_MODEL,
            messages=[{"role": "user", "content": content}],
            max_tokens=16384,
            temperature=0.0,
        )
        choice = resp.choices[0]
        msg = choice.message
        text = msg.content or ""
        reasoning = getattr(msg, "reasoning_content", None) or ""
        if not text:
            print(f"  DEBUG: empty content. finish_reason={choice.finish_reason}, "
                  f"usage={resp.usage}, raw_message={msg}", file=sys.stderr)
        return text.strip(), reasoning.strip()


# ---------------------------------------------------------------------------
# Answer comparison
# ---------------------------------------------------------------------------

def normalize_answer(text: str) -> str:
    return text.strip().lower().rstrip(".!,")


def compare_answer(predicted: str, expected: str, answer_type: str) -> bool:
    pred = normalize_answer(predicted)
    exp = normalize_answer(str(expected))

    if answer_type == "yes_no":
        pred_yes = "yes" in pred
        pred_no = "no" in pred
        if pred_yes and not pred_no:
            return exp == "yes"
        if pred_no and not pred_yes:
            return exp == "no"
        first_word = pred.split()[0] if pred.split() else ""
        return first_word == exp

    if answer_type in ("integer", "float"):
        try:
            return float(pred) == float(exp)
        except ValueError:
            nums = re.findall(r"-?\d+\.?\d*", pred)
            if nums:
                return float(nums[0]) == float(exp)
            return False

    if answer_type == "multiple_choice":
        return exp in pred

    if answer_type == "list":
        def parse_letters(text: str) -> set[str]:
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return {str(x).strip().upper() for x in parsed}
            except (json.JSONDecodeError, TypeError):
                pass
            cleaned = text.upper().replace(" AND ", ",").replace("AND", ",")
            items = re.findall(r"[A-Z]", cleaned)
            return set(items)

        pred_set = parse_letters(predicted)
        exp_set = parse_letters(str(expected))
        return pred_set == exp_set

    return pred == exp


# ---------------------------------------------------------------------------
# Dataset loading
# ---------------------------------------------------------------------------

def discover_benchmarks(benchmarks: list[str] | None) -> list[Path]:
    if benchmarks:
        dirs = [SCREENSHOTS_DIR / b for b in benchmarks]
    else:
        dirs = sorted(SCREENSHOTS_DIR.iterdir()) if SCREENSHOTS_DIR.exists() else []
    return [d for d in dirs if d.is_dir() and (d / "dataset.json").exists()]


def load_samples(benchmark_dir: Path) -> list[dict]:
    with open(benchmark_dir / "dataset.json") as f:
        samples = json.load(f)
    return [s for s in samples if all(k in s for k in ("id", "question", "answer", "images"))]


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

async def evaluate_sample(
    client: AsyncOpenAI,
    sample: dict,
    semaphore: asyncio.Semaphore,
    dry_run: bool,
) -> dict:
    sid = sample["id"]
    question = sample["question"]
    expected = sample["answer"]
    answer_type = sample.get("answer_type", "free_text")

    image_paths = [SCREENSHOTS_DIR / ip for ip in sample["images"] if (SCREENSHOTS_DIR / ip).exists()]

    reasoning = ""
    if dry_run:
        predicted, correct, elapsed = "", False, 0.0
    else:
        t0 = time.time()
        try:
            predicted, reasoning = await query_vlm(client, image_paths, question, semaphore)
        except Exception as e:
            predicted = f"[ERROR] {type(e).__name__}: {e}"
            print(f"  API error for sample {sid}: {e}", file=sys.stderr)
        elapsed = time.time() - t0
        correct = compare_answer(predicted, str(expected), answer_type)

    return {
        "benchmark": sample.get("_benchmark", ""),
        "id": sid,
        "question": question,
        "expected": expected,
        "predicted": predicted,
        "reasoning": reasoning,
        "correct": correct,
        "answer_type": answer_type,
        "elapsed": round(elapsed, 2),
        "metadata": sample.get("metadata", {}),
    }


async def run_evaluation(
    benchmark_dirs: list[Path],
    dry_run: bool,
    concurrency: int,
) -> dict:
    semaphore = asyncio.Semaphore(concurrency)
    client = AsyncOpenAI(base_url=VLM_BASE_URL, api_key=VLM_API_KEY)
    all_results: list[dict] = []

    for bdir in benchmark_dirs:
        name = bdir.name
        samples = load_samples(bdir)
        for s in samples:
            s["_benchmark"] = name

        print(f"\n{'='*60}")
        print(f"Benchmark: {name}  ({len(samples)} samples)")
        print(f"{'='*60}")

        tasks = [evaluate_sample(client, s, semaphore, dry_run) for s in samples]
        results_for_bench = await asyncio.gather(*tasks)

        bench_correct = 0
        for r in results_for_bench:
            tag = "OK" if r["correct"] else "WRONG"
            print(f"  [{r['id']}] {tag}  Q: {r['question']}")
            if not dry_run:
                print(f"         Expected: {r['expected']}  Predicted: {r['predicted']}")
            if r["correct"]:
                bench_correct += 1
            all_results.append(r)

        acc = bench_correct / len(samples) * 100 if samples else 0
        print(f"\n  {name}: {bench_correct}/{len(samples)} = {acc:.1f}%")

    await client.close()

    total_correct = sum(1 for r in all_results if r["correct"])
    total_count = len(all_results)
    overall_acc = total_correct / total_count * 100 if total_count else 0

    print(f"\n{'='*60}")
    print(f"OVERALL: {total_correct}/{total_count} = {overall_acc:.1f}%")
    print(f"{'='*60}")

    return {
        "model": VLM_MODEL,
        "base_url": VLM_BASE_URL,
        "total_correct": total_correct,
        "total_count": total_count,
        "accuracy": overall_acc,
        "results": all_results,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="TopoBench Origami Tracking Eval")
    parser.add_argument("--benchmarks", nargs="*", help="Benchmark folder names (default: all)")
    parser.add_argument("--dry-run", action="store_true", help="Print questions, skip API calls")
    parser.add_argument("--concurrency", type=int, default=4, help="Max parallel API requests")
    parser.add_argument("--output", type=str, default=None, help="Output JSON path")
    args = parser.parse_args()

    benchmark_dirs = discover_benchmarks(args.benchmarks)
    if not benchmark_dirs:
        print("No benchmarks found with dataset.json in screenshots/")
        sys.exit(1)

    print(f"Found {len(benchmark_dirs)} benchmark(s): {[d.name for d in benchmark_dirs]}")
    if not args.dry_run:
        print(f"Model: {VLM_MODEL}  Base URL: {VLM_BASE_URL}")

    results = asyncio.run(run_evaluation(benchmark_dirs, args.dry_run, args.concurrency))

    RESULTS_DIR.mkdir(exist_ok=True)
    if args.output:
        out_path = Path(args.output)
    else:
        ts = time.strftime("%Y%m%d_%H%M%S")
        out_path = RESULTS_DIR / f"eval_{ts}.json"

    with open(out_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to: {out_path}")


if __name__ == "__main__":
    main()
