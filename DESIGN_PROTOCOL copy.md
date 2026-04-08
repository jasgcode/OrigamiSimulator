# TopoBench Design Protocol

A unified standard for building and organizing all TopoBench environments.

---

## 1. Taxonomy

TopoBench evaluates VLMs' topological spatial understanding across **5 categories** (from Piaget's developmental framework) at **2 cognitive levels**.

### Categories (developmental order)

| # | Category | Core Question |
|---|----------|---------------|
| 1 | **Continuity** | Are paths/surfaces/objects unbroken wholes? |
| 2 | **Separation** | Can distinct elements be distinguished? |
| 3 | **Order** | What is the sequential arrangement along a path? |
| 4 | **Enclosure** | What is inside/outside a boundary? How many holes? |
| 5 | **Knots** | Are objects entangled, linked, or knotted? |

### Cognitive Levels

| Level | Name | Description |
|-------|------|-------------|
| L1 | **Perception** | Static VQA — model receives image(s), outputs an answer. |
| L2 | **Planning** | Interactive — model receives observations, outputs action sequences. |

---

## 2. Core Abstraction: What is a "Task"?

Every task in TopoBench — regardless of category or level — is composed of two independent layers:

### Layer 1: Scene Renderer

A renderer that produces **visual stimuli** (images or interactive states). The renderer is parameterized by difficulty and randomness (seed), but is agnostic to what questions will be asked about the scene.

A single renderer can serve multiple question types. For example, the same maze rendering can support:
- "Is there a path from A to B?" (yes/no)
- "How many connected components are there?" (integer)
- "Which of these marked points can reach the exit?" (multiple choice)

### Layer 2: Question Templates

A set of **question definitions** that can be applied to a rendered scene. Each question definition specifies:
- A natural-language prompt (possibly with placeholders filled from scene metadata)
- The expected answer type
- How to derive the ground-truth answer from scene metadata

This separation means:
- Adding a new question to an existing renderer requires **zero rendering changes**.
- The same renderer can appear under different cognitive framings.
- Question difficulty and rendering difficulty are independently controllable.

---

## 3. Universal Data Format

No matter how unique a task is, every generated sample must conform to this minimal schema. This is the **contract** between data generation and evaluation.

### Required Fields

```json
{
  "id": "string",
  "question": "string",
  "answer": "any",
  "images": ["string"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Globally unique sample identifier. Format: `{task}_{seed}_{question_type}_{index}` |
| `question` | `string` | The full natural-language question presented to the VLM. |
| `answer` | `any` | Ground-truth answer. Can be string, number, list, or structured object. |
| `images` | `list[string]` | Ordered list of image paths (relative to dataset root). At least one image. Multiple images for tasks that show before/after, sequences, or comparisons. |

### Optional Fields

These fields provide richer context for analysis but are not required by the evaluation pipeline.

```json
{
  "id": "enclosure_hole_detection_seed42_count_001",
  "question": "How many through-holes does this board have?",
  "answer": 3,
  "images": ["images/enclosure_hole_detection/seed42_001.png"],

  "task": "enclosure_hole_detection",
  "category": "enclosure",
  "level": "perception",
  "question_type": "count",
  "answer_type": "integer",
  "difficulty": 2,
  "options": ["1", "2", "3", "4", "5"],
  "metadata": {}
}
```

| Field | Type | Description |
|-------|------|-------------|
| `task` | `string` | Environment folder name |
| `category` | `string` | One of: `continuity`, `separation`, `order`, `enclosure`, `knots` |
| `level` | `string` | `perception` or `planning` |
| `question_type` | `string` | Task-defined question variant identifier |
| `answer_type` | `string` | Hint for the evaluator: `yes_no`, `multiple_choice`, `integer`, `float`, `list`, `free_text` |
| `difficulty` | `int` | Difficulty level (task-defined scale) |
| `options` | `list[string]` or `null` | Answer choices for multiple-choice questions |
| `metadata` | `object` | Arbitrary task-specific data (seed, parameters, scene graph, etc.) |

### Design Principles

1. **`id` + `question` + `answer` + `images` is the entire evaluation interface.** The evaluator only needs these four fields to score a model. Everything else is for analysis.
2. **`images` is always a list.** Even single-image tasks use `["path.png"]`. This keeps the schema uniform and naturally supports multi-image tasks (e.g., "Has reachability changed between these two mazes?").
3. **`answer` is loosely typed on purpose.** It can be `3`, `"yes"`, `["red","blue"]`, or `"B"`. The `answer_type` field tells the evaluator how to parse and compare.
4. **`metadata` is the escape hatch.** Anything task-specific — scene parameters, intermediate computation, debug info — goes here. It never affects evaluation.

---

## 4. Folder Structure

All environments live under `environments/` with a flat layout:

```
environments/
├── {category}_{task_name}/
│   ├── README.md                    # Task description, question types, examples
│   ├── metadata.json                # Machine-readable task metadata
│   ├── frontend/                    # Scene renderer (HTML + Three.js + TypeScript)
│   │   ├── index.html
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   └── src/
│   ├── gym/                         # Python Gym wrapper (Planning tasks only)
│   │   ├── env.py
│   │   ├── requirements.txt
│   │   └── example_usage.py
│   └── data/                        # Generated samples (gitignored if large)
```

### Naming Convention

- Folder name: `{category}_{task_name}` in **snake_case**
- Category: `continuity`, `separation`, `order`, `enclosure`, `knots`

---

## 5. Tech Stack

### Frontend (all environments)

| Component | Technology |
|-----------|-----------|
| Rendering | Three.js (WebGL) |
| Language | TypeScript |
| Build | Vite |
| Entry | `index.html` |

Every environment must have a working HTML frontend that can render its scenes.

### Backend (Planning tasks only)

| Component | Technology |
|-----------|-----------|
| Gym wrapper | Python `gymnasium` |
| Browser automation | Playwright (async) |
| Observation | RGB screenshot |
| Communication | Playwright `page.evaluate()` ↔ `window.topoBench.*` |

---

## 6. Perception Task Protocol (L1)

### Goal
Generate static images paired with questions and ground-truth answers.

### Frontend API

The renderer exposes `window.topoBench`:

```typescript
interface PerceptionAPI {
  /** Generate a new scene. Returns scene metadata (used to derive answers). */
  generate(config?: Record<string, any>): SceneMetadata;

  /** Export current scene as base64 PNG. */
  screenshot(): string;
}
```

Note: The frontend only renders and exports. **Question generation and answer derivation happen outside the renderer** — typically in a Python script that calls the renderer via Playwright, reads the scene metadata, and applies question templates to produce the final JSON samples.

### Question Template Definition

Each task defines its question types in `metadata.json` or a dedicated config:

```json
{
  "question_types": {
    "count_through": {
      "prompt": "How many through-holes does this board have?",
      "answer_type": "integer",
      "derive_answer": "metadata.through_hole_count"
    },
    "count_all": {
      "prompt": "How many holes (of any kind) are visible on this board?",
      "answer_type": "integer",
      "derive_answer": "metadata.total_hole_count"
    },
    "has_through": {
      "prompt": "Does this board have any holes that go all the way through?",
      "answer_type": "yes_no",
      "derive_answer": "metadata.through_hole_count > 0"
    }
  }
}
```

This makes the relationship explicit: **one renderer, many questions**.

---

## 7. Planning Task Protocol (L2)

### Goal
Provide a Gym-compatible interactive environment where a VLM agent acts on rendered frames.

### Frontend API

```typescript
interface PlanningAPI {
  reset(config?: Record<string, any>): StateResponse;
  step(action: any): StateResponse;
  getState(): StateResponse;
}

interface StateResponse {
  observation: any;
  reward: number;
  done: boolean;
  success: boolean;
  step_count: number;
  info: Record<string, any>;
}
```

### Python Gym Wrapper

Every Planning task must have `gym/env.py` subclassing `gymnasium.Env` with:
- Playwright-based browser automation
- `reset()` → `(observation, info)`
- `step(action)` → `(observation, reward, terminated, truncated, info)`
- `render()` → RGB numpy array
- `close()` → cleanup

### Episode Termination

- `terminated = True` when success condition is met.
- `truncated = True` when `step_count >= max_steps`.

---

## 8. metadata.json

Every environment folder contains a `metadata.json`:

```json
{
  "name": "enclosure_hole_detection",
  "display_name": "Hole Detection & Counting",
  "category": "enclosure",
  "level": "perception",
  "description": "Determine the number and type of holes in a procedural 3D board.",
  "question_types": {
    "count_through": {
      "prompt": "How many through-holes does this board have?",
      "answer_type": "integer"
    },
    "count_all": {
      "prompt": "How many holes are visible on this board?",
      "answer_type": "integer"
    }
  },
  "difficulty_params": {},
  "status": "draft"
}
```

### Status Values

| Status | Meaning |
|--------|---------|
| `draft` | Work in progress |
| `ready` | Renderer + questions work, ready for pilot |
| `validated` | Tested with at least one VLM |
| `released` | Included in official benchmark |

---

## 9. Evaluation Protocol

### Perception

1. For each sample, send `images` + `question` to VLM.
2. Parse VLM response.
3. Compare with `answer` using the appropriate comparator (determined by `answer_type`).
4. Primary metric: **accuracy**.

### Planning

1. VLM agent loop: observe → act → observe → ... until done.
2. Metrics: **success rate**, **average steps**, **average reward**.

### Comparators by Answer Type

| `answer_type` | Comparison |
|---------------|-----------|
| `yes_no` | Case-insensitive exact match |
| `integer` / `float` | Numeric equality (with optional tolerance) |
| `multiple_choice` | Exact match on selected option |
| `list` | Ordered sequence match |
| `free_text` | Task-defined (regex, LLM judge, etc.) |

---

## 10. Current Environment Inventory

| Folder Name | Category | Level | Status | Description |
|---|---|---|---|---|
| `enclosure_hole_detection` | Enclosure | Perception | draft | Count holes/pits in procedural 3D boards |
| `enclosure_laser_alignment` | Enclosure | Planning | draft | Rotate stacked disks to align holes |
| `separation_one_stroke` | Separation | Planning | draft | Draw path to partition grid by color |
| `knots_untangle` | Knots | Planning | draft | Move rope endpoints to eliminate crossings |

---

## Appendix: Planned Environments

| Folder Name | Category | Level | Description |
|---|---|---|---|
| `continuity_maze_reachability` | Continuity | Perception | Path reachability in rendered mazes |
| `continuity_connectivity_invariance` | Continuity | Perception | Reachability change detection |
| `continuity_pipe_rotation` | Continuity | Planning | Rotate pipes to connect source to destination |
| `separation_figure_ground` | Separation | Perception | Object separation in complex scenes |
| `order_bead_string` | Order | Perception | Bead order on twisted strings |
| `order_origami_tracking` | Order | Perception | Point tracking through paper folds |
| `order_sliding_track` | Order | Planning | Slide blocks to target arrangement |
| `enclosure_fence_sheep` | Enclosure | Perception | Inside/outside boundary judgment |
| `enclosure_origami_same_side` | Enclosure | Perception | Same-face judgment on folded paper |
| `enclosure_chat_noir` | Enclosure | Planning | Encircle escaping cat on hex grid |
| `knots_knot_unknot` | Knots | Perception | Knot vs unknot classification |
| `knots_linked_unlinked` | Knots | Perception | Link detection between loops |
