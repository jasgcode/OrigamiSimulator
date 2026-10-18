import importlib.util
import json
import tempfile
import sys
import io
from contextlib import redirect_stdout, redirect_stderr
import unittest
from pathlib import Path
from unittest.mock import patch


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


assembly = load_tool("assemble-uniform-1000")
pipeline = load_tool("generate-uniform-1000")
renderer = load_tool("render_dataset_parallel")
expert = load_tool("generate-expert-dataset")


class AssemblyTests(unittest.TestCase):
    def test_continuations_count_unique_examples_and_preserve_name_collisions(self):
        first = {"model": "/Bases/birdBase.svg", "steps": [{"fold": 0}],
                 "facePoints": {"0": [{"u": .3, "v": .3, "w": .4}]}}
        second = dict(first, steps=[{"fold": 70}])
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bird-d3-s0.json").write_text(json.dumps({"bird-01": first}))
            (root / "bird-d3-s0-p2.json").write_text(json.dumps({"bird-02": first}))
            (root / "bird-d3-s0-p3.json").write_text(json.dumps({"bird-01": second}))
            with patch.object(assembly, "SRC_DIR", root):
                result = list(assembly.collect_for_cell("bird-d3").values())
            self.assertEqual(len(result), 2)
            self.assertIn(first, result)
            self.assertIn(second, result)

    def test_duplicate_content_with_new_names_is_not_extra_yield(self):
        preset = {"model": "/Bases/birdBase.svg", "steps": [{"fold": 0}]}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bird-d3-s0.json").write_text(json.dumps({"a": preset, "b": preset}))
            with patch.object(assembly, "SRC_DIR", root):
                self.assertEqual(len(assembly.collect_for_cell("bird-d3")), 1)

    def test_expert_shards_are_assembled_only_when_requested(self):
        preset = {"model": "/Bases/birdBase.svg", "difficulty": 5, "steps": [{"fold": 0}] * assembly.EXPERT_FRAME_COUNT,
                  "facePoints": [{"faceId": i} for i in range(12)], "clusterPlacement": {"alpha": .7, "symmetry": "rotate180"}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "assembled.json"
            (root / "bird-d5.json").write_text(json.dumps({"expert": preset}))
            with patch.object(assembly, "SRC_DIR", root), patch.object(assembly, "ROOT", root), \
                 patch.object(assembly, "OUT_PATH", output), redirect_stdout(io.StringIO()):
                with patch.object(sys, "argv", ["assemble", "--include-expert"]):
                    self.assertEqual(assembly.main(), 0)
                self.assertEqual(json.loads(output.read_text())["bird-d5-01"], preset)
                with patch.object(sys, "argv", ["assemble"]):
                    self.assertEqual(assembly.main(), 0)
                self.assertEqual(json.loads(output.read_text()), {})
                self.assertTrue((root / "bird-d5.json").exists())

    def test_resume_excludes_legacy_expert_banks_without_modifying_them(self):
        current = {"model": "/Bases/birdBase.svg", "difficulty": 5,
                   "steps": [{"fold": 0}] * assembly.EXPERT_FRAME_COUNT, "facePoints": [{"faceId": i} for i in range(12)],
                   "clusterPlacement": {"alpha": .7, "symmetry": "rotate180"}}
        legacy = dict(current, facePoints=current["facePoints"][:6])
        six_frame = dict(current, steps=current["steps"][:6])
        ten_frame = dict(current, steps=current["steps"][:10])
        fixed = {k: v for k, v in current.items() if k != "clusterPlacement"}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            saved = root / "bird-d5-s0.json"
            saved.write_text(json.dumps({"old": legacy, "short": six_frame, "ten": ten_frame, "fixed": fixed}))
            original = saved.read_bytes()
            (root / "bird-d5-s0-p2.json").write_text(json.dumps({"new": current}))
            # The hard tier still accepts its six-point bank.
            (root / "bird-d4.json").write_text(json.dumps({"hard": dict(legacy, difficulty=4)}))
            warnings = io.StringIO()
            with patch.object(assembly, "SRC_DIR", root), redirect_stderr(warnings):
                self.assertEqual(assembly.collect_for_cell("bird-d5"), {"new": current})
                self.assertEqual(len(assembly.collect_for_cell("bird-d4")), 1)
            self.assertEqual(warnings.getvalue().count("expert requires 12-20 ordered points with sampled placement"), 2)
            self.assertEqual(warnings.getvalue().count(f"expert requires {assembly.EXPERT_FRAME_COUNT} frames"), 2)
            self.assertEqual(saved.read_bytes(), original)

    def test_expert_frame_count_matches_the_generator_contract(self):
        self.assertEqual(assembly.EXPERT_FRAME_COUNT, expert.TIER_CONTRACTS[5]["frames"])

    def test_pipeline_reports_kept_count(self):
        result = type("Result", (), {"stdout": "bird-d3 60 42\n"})()
        with patch.object(pipeline.subprocess, "run", return_value=result):
            self.assertEqual(pipeline.assemble_and_count()["bird-d3"], 42)


class ResumeTests(unittest.TestCase):
    def test_existing_shards_resume_without_reset_or_first_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            bank = root / "new_dataset/uniform-1000"
            bank.mkdir(parents=True)
            saved = bank / "bird-d3-s0.json"
            saved.write_text("{}")
            counts = {c[0]: pipeline.TARGET for c in pipeline.CELLS}
            out = io.StringIO()
            with patch.object(pipeline, "ROOT", root), patch.object(pipeline, "CELLS", list(pipeline.CELLS)), \
                 patch.object(sys, "argv", ["generate-uniform-1000.py", "--skip-render"]), \
                 patch.object(pipeline, "check_dev_server"), \
                 patch.object(pipeline, "wipe_outputs") as wipe, \
                 patch.object(pipeline, "run_matrix_pass1") as matrix, \
                 patch.object(pipeline, "assemble_and_count", return_value=counts), \
                 patch.object(pipeline.subprocess, "run"), redirect_stdout(out):
                self.assertEqual(pipeline.main(), 0)
            self.assertIn("[cells] skipping mapfold-d3:", out.getvalue())
            wipe.assert_not_called()
            matrix.assert_not_called()
            self.assertEqual(saved.read_text(), "{}")


class GenerationControlsTests(unittest.TestCase):
    def test_quality_threshold_reaches_first_pass_and_continuations(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "new_dataset/uniform-1000-logs").mkdir(parents=True)
            with patch.object(pipeline, "ROOT", root), \
                 patch.object(pipeline, "MIN_POINT_VIEW_QUALITY", 0.45), \
                 patch.object(pipeline.subprocess, "run") as run, redirect_stdout(io.StringIO()):
                run.return_value.returncode = 0
                pipeline.run_matrix_pass1()
                pipeline.run_one_shard(pipeline.CELLS[0], None, 20, 70, 0.05, 2)
            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                args = call.args[0]
                self.assertEqual(args[args.index("--min-point-view-quality") + 1], "0.45")


    def test_expert_tier_reaches_matrix_assembly_and_continuation_profiles(self):
        cells = pipeline.CELLS + pipeline.EXPERT_CELLS
        result = type("Result", (), {"stdout": "bird-d5 44 42\n", "returncode": 0})()
        with patch.object(pipeline, "CELLS", cells), \
             patch.object(pipeline.subprocess, "run", return_value=result) as run, redirect_stdout(io.StringIO()):
            pipeline.run_matrix_pass1()
            matrix_args = run.call_args.args[0]
            self.assertEqual(matrix_args[matrix_args.index("--difficulties") + 1], "1,3,4,5")
            self.assertEqual(pipeline.assemble_and_count()["bird-d5"], 42)
            self.assertIn("--include-expert", run.call_args.args[0])
            self.assertIn("bird-d5", [c[0] for c in pipeline.deficit_cells_from({})])
            self.assertGreaterEqual(pipeline.stage_profiles(0, 42)["d5"], 30)


    def test_mapfold_cells_are_skipped_at_the_clustered_tiers(self):
        cells = [(f"{key}-d{d}", path, d, d > 1, 15) for key, path in
                 (("mapfold", "/SimpleFolds/mapfold.svg"), ("bird", "/Bases/birdBase.svg")) for d in (1, 3, 4, 5)]
        out = io.StringIO()
        with redirect_stdout(out):
            kept = [c[0] for c in pipeline.drop_untwinnable_cells(cells)]
        self.assertEqual(kept, ["mapfold-d1", "mapfold-d4", "bird-d1", "bird-d3", "bird-d4", "bird-d5"])
        self.assertIn("skipping mapfold-d3, mapfold-d5", out.getvalue())


class RenderCompletionTests(unittest.TestCase):
    def test_resume_requires_matching_config_jsonl_and_images(self):
        preset = {"model": "/Bases/birdBase.svg", "steps": [{"fold": 0}]}
        with tempfile.TemporaryDirectory() as temp, patch.dict(renderer.os.environ, {"DATASET_DIR": temp}):
            root = Path(temp)
            (root / "metadata").mkdir()
            image = root / "sample.png"
            image.write_bytes(b"image fixture")
            record = {"presetConfig": preset, "images": ["sample.png"]}
            (root / "metadata/bird_metadata.json").write_text(json.dumps({"bird-01": record}))
            row = {"images": ["sample.png"], "meta_info": {"benchmark": "bird-01"}}
            manifest = root / "dataset.jsonl"
            manifest.write_text(json.dumps(row) + "\n")
            self.assertEqual(renderer.completed_presets({"bird-01": preset}), {"bird-01"})
            changed = dict(preset, steps=[{"fold": 70}])
            self.assertEqual(renderer.completed_presets({"bird-01": changed}), set())
            image.unlink()
            self.assertEqual(renderer.completed_presets({"bird-01": preset}), set())
            image.write_bytes(b"image fixture")
            manifest.unlink()
            self.assertEqual(renderer.completed_presets({"bird-01": preset}), set())


if __name__ == "__main__":
    unittest.main()
