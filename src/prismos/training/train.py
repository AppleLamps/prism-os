# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch",
#   "transformers>=4.57",
#   "accelerate",
#   "huggingface_hub",
#   "onnx",
#   "onnxruntime",
#   "onnxruntime-genai",
#   "onnx-ir",
#   "numpy",
# ]
# ///
"""Fine-tunes FunctionGemma 270M on Prism OS's commands, measures it before and after on
held-out phrasings, exports the browser build, checks that the export answers like the
PyTorch model, and publishes both to the Hub.

Run as a Hugging Face Job (see src/prismos/README.md):

  hf jobs uv run --flavor a10g-small --secrets HF_TOKEN --timeout 4h \
    https://raw.githubusercontent.com/AppleLamps/prism-os/<branch>/src/prismos/training/train.py \
    --data <raw url of src/prismos/training> --repo <user>/prism-os-functiongemma

The data comes from scripts/prismos-dataset.ts: train.jsonl, eval.jsonl and tools.json.
Check it first, locally and without a GPU:

  python3 src/prismos/training/train.py --data src/prismos/training --repo x --check-data
"""
import argparse
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE = "google/functiongemma-270m-it"
WEB_REFERENCE = "onnx-community/functiongemma-270m-it-ONNX"
# The longest answers, three calls with an address or a search, take about 90 tokens.
MAX_NEW_TOKENS = 160
PHOTOS = ["Misty Lake", "Desert Light", "Pacific Edge", "Midnight City", "Forest Path", "Alpine Dawn",
          "Amalfi Morning", "North Falls", "Lavender Hour", "Concrete Curve", "Blue Lagoon", "Autumn Road"]

parser = argparse.ArgumentParser()
parser.add_argument("--data", required=True, help="URL or folder with train.jsonl, eval.jsonl and tools.json")
parser.add_argument("--repo", required=True, help="Hub repo for the result, e.g. user/prism-os-functiongemma")
parser.add_argument("--epochs", type=float, default=3)
parser.add_argument("--lr", type=float, default=5e-5)
parser.add_argument("--batch", type=int, default=16)
parser.add_argument("--micro", type=int, default=8)
parser.add_argument("--onnx-eval", type=int, default=100, help="eval rows to run through the ONNX export")
parser.add_argument("--skip-base-eval", action="store_true")
parser.add_argument("--base-result", default=None, help="the base model's score from an earlier run, e.g. 132/597, for the README when --skip-base-eval")
parser.add_argument("--skip-training", action="store_true", help="export --checkpoint (or the base model) without training, e.g. to test the export")
parser.add_argument("--checkpoint", default=None, help="a Hub repo whose pytorch/ folder holds weights to start from, or a local folder")
parser.add_argument("--eval-limit", type=int, default=0, help="score only this many eval rows, e.g. for a quick export test")
parser.add_argument("--no-publish", action="store_true", help="build and check everything, publish nothing")
parser.add_argument("--public", action="store_true", help="publish the repo as public; private by default")
parser.add_argument("--curve-rows", type=int, default=150, help="eval rows scored after each epoch, for the learning curve and the best epoch; 0 skips")
parser.add_argument("--check-data", action="store_true", help="check the data and the scorer, with no GPU and no downloads, and stop")
args = parser.parse_args()

random.seed(0)
work = Path("/tmp/prism")
work.mkdir(parents=True, exist_ok=True)


def fetch(name):
    source = args.data.rstrip("/") + "/" + name
    if source.startswith("http"):
        with urllib.request.urlopen(source) as response:
            return response.read().decode()
    return Path(source).read_text()


train_rows = [json.loads(line) for line in fetch("train.jsonl").splitlines() if line.strip()]
eval_rows = [json.loads(line) for line in fetch("eval.jsonl").splitlines() if line.strip()]
tools = json.loads(fetch("tools.json"))
if args.eval_limit:
    eval_rows = eval_rows[: args.eval_limit]
# The learning curve and the choice of epoch use dev rows, every k-th eval row, which the
# reported scores then leave out: a score never measures rows that chose the model.
dev_rows = []
if args.curve_rows > 0 and not args.check_data and len(eval_rows) > 2 * args.curve_rows:
    every = len(eval_rows) // args.curve_rows
    dev_rows = eval_rows[::every][: args.curve_rows]
    chosen = {id(row) for row in dev_rows}
    eval_rows = [row for row in eval_rows if id(row) not in chosen]
print(f"data: {len(train_rows)} train, {len(eval_rows)} eval, {len(dev_rows)} dev, {len(tools)} tools", flush=True)

# ---------------------------------------------------------------------------------------
# Scoring: the same rules as src/prismos/commands.ts, reduced to what the eval needs.

def parse_answer(text):
    for marker in ["<start_function_response>", "<end_of_turn>", "<eos>"]:
        text = text.split(marker)[0]
    calls = []
    for body in re.findall(r"<start_function_call>(.*?)(?:<end_function_call>|$)", text, flags=re.S):
        match = re.match(r"\s*call:([A-Za-z_]\w*)\s*\{(.*)\}\s*$", body, flags=re.S)
        if not match:
            calls.append(("<malformed>", {}))
            continue
        name, inner = match.group(1), match.group(2)
        arguments = {}
        for key, escaped, bare in re.findall(r"(\w+):(?:<escape>(.*?)<escape>|([^,}]*))", inner, flags=re.S):
            arguments[key] = escaped if escaped != "" else bare
        calls.append((name, arguments))
    text = re.sub(r"<start_function_call>.*?(<end_function_call>|$)", "", text, flags=re.S).replace("<escape>", "").strip()
    return calls, text


NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"]


def photo_index(value):
    """parsePhoto in src/prismos/commands.ts: a name, part of a name, a number, a word."""
    key = re.sub(r"^(the\s+)?(photo|picture|image|pic)\s*", "", str(value).strip().lower())
    key = re.sub(r"^(number|#|no\.?)\s*", "", key).strip()
    for index, name in enumerate(PHOTOS):
        if key == name.lower():
            return index
    for index, name in enumerate(PHOTOS):
        if len(key) >= 4 and key in name.lower():
            return index
    digits = re.match(r"^(\d{1,2})(st|nd|rd|th)?$", key)
    if digits and 1 <= int(digits.group(1)) <= 12:
        return int(digits.group(1)) - 1
    if key in NUMBER_WORDS:
        return NUMBER_WORDS.index(key)
    if key in ORDINALS:
        return ORDINALS.index(key)
    return key


SPOKEN_ENDINGS = {"com", "org", "net", "edu", "gov", "io", "co", "uk", "dev", "app", "ai", "tv", "me", "us", "ca", "de", "fr", "jp", "au", "info", "nu"}


def web_address(value):
    """webAddress in src/prismos/web-address.ts, reduced to what decides the page: an
    address said aloud ("wikipedia dot org") or typed with or without its scheme, "www."
    or a final slash is the same page."""
    text = str(value).strip().rstrip(".,;!?")
    if re.search(r"\s", text):
        joined = re.sub(r"\s+slash\s+", "/", re.sub(r"\s+dot\s+", ".", text, flags=re.I), flags=re.I)
        host = re.sub(r"^https?://", "", joined, flags=re.I)
        host = re.split(r"[/?#:]", host)[0]
        if re.search(r"\s", joined) or host.split(".")[-1].lower() not in SPOKEN_ENDINGS:
            return text.lower()
        text = joined
    text = re.sub(r"^https?://", "", text, flags=re.I)
    host, _, rest = text.partition("/")
    host = re.sub(r"^www\.", "", host.lower())
    return host + ("/" + rest.rstrip("/") if rest.rstrip("/") else "")


def math_text(value):
    """An arithmetic expression in symbols without spaces, as evaluateExpression in
    src/prismos/expression.ts reads it: "17 times 23", "17 * 23" and "17*23" are one."""
    text = str(value).lower()
    for words, symbol in [("multiplied by", "*"), ("times", "*"), ("divided by", "/"), ("over", "/"), ("plus", "+"),
                          ("minus", "-"), ("percent of", "%*"), ("% of", "%*"), ("×", "*"), ("÷", "/")]:
        text = text.replace(words, f" {symbol} ")
    text = re.sub(r"(\d)\s*x\s*(?=[\d.(])", r"\1*", text)
    return re.sub(r"\s+", "", text)


DURATION_NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                    "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30, "forty": 40,
                    "fifty": 50, "sixty": 60, "ninety": 90}
DURATION_UNITS = [(r"^(?:h|hr|hrs|hour|hours)$", 3600), (r"^(?:m|min|mins|minute|minutes)$", 60), (r"^(?:s|sec|secs|second|seconds)$", 1)]


def duration_seconds(value):
    """parseDuration in src/prismos/durations.ts: "5 min", "an hour and a half", "1:30"."""
    text = re.sub(r"\s+", " ", str(value).strip().lower().rstrip(".!?").replace("-", " "))
    text = re.sub(r"^(?:for|in) ", "", text)
    text = re.sub(r" (?:timer|countdown)$", "", text)
    clock = re.match(r"^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$", text)
    if clock:
        a, b, c = int(clock.group(1)), int(clock.group(2)), clock.group(3)
        return a * 60 + b if c is None else a * 3600 + b * 60 + int(c)
    if re.match(r"^\d+(?:\.\d+)?$", text):
        return round(float(text) * 60)
    text = re.sub(r"\bhalf an? (hour|minute)\b", r"0.5 \1", text)
    text = re.sub(r"\b(?:an?|one) (hour|minute) and a half\b", r"1.5 \1", text)
    text = re.sub(r"(\d)(?=[a-z])", r"\1 ", text)
    text = re.sub(r"([a-z])(?=\d)", r"\1 ", text)
    total, pending, any_unit = 0.0, None, False
    for word in [w for w in re.split(r"[ ,]", text) if w and w != "and"]:
        number = float(word) if re.match(r"^\d+(?:\.\d+)?$", word) else DURATION_NUMBERS.get(word)
        if number is not None:
            if pending is not None and not (pending >= 20 and pending % 10 == 0 and number < 10):
                return None
            pending = (pending or 0) + number
            continue
        unit = next((seconds for pattern, seconds in DURATION_UNITS if re.match(pattern, word)), None)
        if unit is None or pending is None:
            return None
        total += pending * unit
        pending, any_unit = None, True
    return round(total) if any_unit and pending is None else None


def plain_text(value):
    """Free text compared by its words: case, quotes, apostrophes and end marks aside."""
    text = re.sub(r"[\"“”'’]", "", str(value).lower())
    return " ".join(re.sub(r"[?.!,;:]+$", "", text).split())


def canonical(calls):
    result = []
    for name, arguments in calls:
        normalized = {}
        for key, value in arguments.items():
            value = str(value).strip()
            if name == "open_photo" and key == "photo":
                normalized[key] = photo_index(value)
            elif name == "open_website" and key == "address":
                normalized[key] = web_address(value)
            elif name == "calculate":
                normalized[key] = math_text(value)
            elif name == "start_timer":
                normalized[key] = duration_seconds(value) or plain_text(value)
            elif name == "search_web" or (name == "write_note" and key == "text"):
                normalized[key] = plain_text(value)
            else:
                normalized[key] = value.lower().replace(" ", "_")
        result.append((name, tuple(sorted(normalized.items()))))
    return result


def expected(row):
    assistant = row["messages"][2]
    if "tool_calls" in assistant:
        return [(call["function"]["name"], call["function"]["arguments"]) for call in assistant["tool_calls"]], None
    return [], assistant["content"]


def kind(row):
    calls, reply = expected(row)
    if reply is not None:
        return "reply"
    if len(calls) > 2:
        return "three calls"
    return "two calls" if len(calls) > 1 else calls[0][0]


def score(rows, generate, label, misses=25):
    started = time.time()
    totals, correct, failures = {}, {}, []
    for row in rows:
        calls, reply = expected(row)
        raw = generate(row["messages"])
        got_calls, got_text = parse_answer(raw)
        ok = (not got_calls and got_text != "") if reply is not None else canonical(got_calls) == canonical(calls)
        group = kind(row)
        totals[group] = totals.get(group, 0) + 1
        correct[group] = correct.get(group, 0) + int(ok)
        if not ok and len(failures) < misses:
            failures.append((row["messages"][1]["content"], calls or reply, raw[:200]))
    total = sum(totals.values())
    accuracy = sum(correct.values()) / max(total, 1)
    print(f"\n=== {label}: {sum(correct.values())}/{total} = {accuracy:.1%} ({time.time() - started:.0f} s)", flush=True)
    for group in sorted(totals):
        print(f"  {group:>18}: {correct[group]}/{totals[group]}", flush=True)
    for user, want, got in failures:
        print(f"  MISS {user!r}\n       want {want}\n       got  {got!r}", flush=True)
    return {"accuracy": accuracy, "correct": sum(correct.values()), "total": total,
            "by_kind": {group: [correct[group], totals[group]] for group in totals}}



# ---------------------------------------------------------------------------------------
# --check-data: every expected answer, written as the model writes calls, must parse and
# score as correct, and fit in MAX_NEW_TOKENS. It needs no GPU, no model and no
# downloads, so the data and the scorer can be checked before a run is paid for:
#
#   python3 src/prismos/training/train.py --data src/prismos/training --repo x --check-data

def format_calls(calls):
    """FunctionGemma's call syntax, as the model writes it."""
    return "".join("<start_function_call>call:" + name + "{" + ",".join(f"{key}:<escape>{value}<escape>" for key, value in arguments.items())
                   + "}<end_function_call>" for name, arguments in calls)


def check_data():
    problems = []
    kinds = {}
    for split, rows in (("train", train_rows), ("eval", eval_rows)):
        for row in rows:
            calls, reply = expected(row)
            kinds[kind(row)] = kinds.get(kind(row), 0) + 1
            if reply is not None:
                continue
            got, text = parse_answer(format_calls(calls) + "<start_function_response>")
            if canonical(got) != canonical(calls) or text != "":
                problems.append(f"{split}: {row['messages'][1]['content']!r} doesn't survive the scorer: {got}")
            # About 3.5 characters a token, and one for each special token.
            if len(format_calls(calls)) / 3.5 > MAX_NEW_TOKENS - 20:
                problems.append(f"{split}: {row['messages'][1]['content']!r} may need more than {MAX_NEW_TOKENS} tokens")
    same = [
        ("calculate", {"expression": "17 times 23"}, {"expression": "17 * 23"}),
        ("calculate", {"expression": "10% of 250"}, {"expression": "10% * 250"}),
        ("calculate", {"expression": "250x0.75"}, {"expression": "250 * 0.75"}),
        ("start_timer", {"duration": "an hour and a half"}, {"duration": "90 minutes"}),
        ("start_timer", {"duration": "1:30"}, {"duration": "90 seconds"}),
        ("start_timer", {"duration": "twenty five minutes"}, {"duration": "25 min"}),
        ("search_web", {"query": "What's the weather in Tokyo"}, {"query": "whats the weather in tokyo?"}),
        ("open_website", {"address": "wikipedia dot org"}, {"address": "https://www.wikipedia.org/"}),
        ("write_note", {"text": "\"buy milk\"", "mode": "append"}, {"text": "Buy milk.", "mode": "append"}),
        ("open_photo", {"photo": "Blue Lagoon"}, {"photo": "11"}),
    ]
    for name, a, b in same:
        if canonical([(name, a)]) != canonical([(name, b)]):
            problems.append(f"the scorer tells apart equal calls: {name} {a} and {b}")
    different = [("calculate", {"expression": "17 * 23"}, {"expression": "17 + 23"}), ("start_timer", {"duration": "5 minutes"}, {"duration": "5 seconds"})]
    for name, a, b in different:
        if canonical([(name, a)]) == canonical([(name, b)]):
            problems.append(f"the scorer confuses {name} {a} and {b}")
    names = {tool["function"]["name"] for tool in tools}
    seen = {name for row in train_rows for name, _ in expected(row)[0]}
    for name in sorted(names - seen):
        problems.append(f"train never calls {name}")
    eval_seen = {name for row in eval_rows for name, _ in expected(row)[0]}
    for name in sorted(names - eval_seen):
        problems.append(f"eval never calls {name}")
    overlap = {row["messages"][1]["content"].lower() for row in train_rows} & {row["messages"][1]["content"].lower() for row in eval_rows}
    if overlap:
        problems.append(f"{len(overlap)} eval sentences also appear in train, e.g. {sorted(overlap)[:3]}")
    print("kinds:", ", ".join(f"{name} {count}" for name, count in sorted(kinds.items(), key=lambda item: -item[1])))
    for problem in problems[:40]:
        print("PROBLEM", problem)
    print(f"{len(problems)} problems in {len(train_rows)} train and {len(eval_rows)} eval rows, {len(names)} tools")
    sys.exit(1 if problems else 0)


if args.check_data:
    check_data()

import numpy as np  # noqa: E402
import torch  # noqa: E402
from huggingface_hub import HfApi, hf_hub_download  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

torch.manual_seed(0)
device = "cuda" if torch.cuda.is_available() else "cpu"

tokenizer = AutoTokenizer.from_pretrained(BASE)
start_from = {"pretrained_model_name_or_path": BASE}
if args.checkpoint:
    start_from = {"pretrained_model_name_or_path": args.checkpoint} if Path(args.checkpoint).exists() else {"pretrained_model_name_or_path": args.checkpoint, "subfolder": "pytorch"}
model = AutoModelForCausalLM.from_pretrained(**start_from, dtype=torch.bfloat16, attn_implementation="eager").to(device)
api = HfApi(token=os.environ.get("HF_TOKEN"))


def as_ids(value):
    if hasattr(value, "keys"):
        value = value["input_ids"]
    if hasattr(value, "tolist"):
        value = value.tolist()
    if value and isinstance(value[0], list):
        value = value[0]
    return list(value)


def prompt_ids(messages):
    return as_ids(tokenizer.apply_chat_template(messages[:2], tools=tools, add_generation_prompt=True, tokenize=True))


def encode(row):
    prompt = prompt_ids(row["messages"])
    full = as_ids(tokenizer.apply_chat_template(row["messages"], tools=tools, tokenize=True))
    assert full[: len(prompt)] == prompt, "the prompt isn't a prefix of the full chat"
    return {"input_ids": full, "labels": [-100] * len(prompt) + full[len(prompt):]}


example = encode(train_rows[0])
print("prompt tokens:", sum(1 for label in example["labels"] if label == -100), flush=True)
print("rendered example:", tokenizer.decode(example["input_ids"])[-400:], flush=True)

@torch.no_grad()
def torch_generate(messages):
    ids = torch.tensor([prompt_ids(messages)], device=device)
    output = model.generate(ids, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, eos_token_id=[1, 50, 106])
    return tokenizer.decode(output[0, ids.shape[1]:], skip_special_tokens=False)


results = {}
model.eval()
if not args.skip_base_eval:
    results["base"] = score(eval_rows, torch_generate, "base FunctionGemma on held-out phrasings")

# ---------------------------------------------------------------------------------------
# Training: full fine-tune, loss on the answer tokens only. The logits are computed only
# at those positions, since the 262,144-word vocabulary makes logits for a whole
# 3,300-token prompt cost gigabytes.

encoded = [encode(row) for row in train_rows]
lengths = [len(item["input_ids"]) for item in encoded]
answers = [sum(1 for label in item["labels"] if label != -100) for item in encoded]
print(f"train tokens: {sum(lengths):,} an epoch, {max(lengths)} the longest row, answers up to {max(answers)} tokens", flush=True)
if max(answers) > MAX_NEW_TOKENS:
    print(f"WARNING: an answer of {max(answers)} tokens is longer than MAX_NEW_TOKENS = {MAX_NEW_TOKENS}", flush=True)
model.train()
model.gradient_checkpointing_enable()
optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.0, betas=(0.9, 0.98))
steps_per_epoch = math.ceil(len(encoded) / args.batch)
total_steps = 0 if args.skip_training else int(steps_per_epoch * args.epochs)
warmup = max(1, int(total_steps * 0.03))
accumulate = args.batch // args.micro


def learning_rate(step):
    if step < warmup:
        return args.lr * (step + 1) / warmup
    progress = (step - warmup) / max(1, total_steps - warmup)
    return args.lr * 0.5 * (1 + math.cos(math.pi * progress))


def micro_loss(batch):
    width = max(len(item["input_ids"]) for item in batch)
    pad = tokenizer.pad_token_id
    input_ids = torch.tensor([item["input_ids"] + [pad] * (width - len(item["input_ids"])) for item in batch], device=device)
    attention = torch.tensor([[1] * len(item["input_ids"]) + [0] * (width - len(item["input_ids"])) for item in batch], device=device)
    labels = torch.tensor([item["labels"] + [-100] * (width - len(item["labels"])) for item in batch], device=device)
    with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
        hidden = model.model(input_ids=input_ids, attention_mask=attention).last_hidden_state
    # Position t predicts token t + 1.
    targets = labels[:, 1:]
    mask = targets != -100
    selected = hidden[:, :-1][mask]
    logits = model.lm_head(selected).float()
    softcap = getattr(model.config, "final_logit_softcapping", None)
    if softcap:
        logits = torch.tanh(logits / softcap) * softcap
    return torch.nn.functional.cross_entropy(logits, targets[mask])


print(f"\ntraining: {total_steps} steps of {args.batch}, lr {args.lr}, {args.epochs} epochs", flush=True)
curve = []
best = {"accuracy": -1.0, "step": 0, "state": None}


def checkpoint(step):
    """Scores the dev rows; keeps the weights when they're the best so far."""
    if not dev_rows:
        return
    model.gradient_checkpointing_disable()
    model.eval()
    result = score(dev_rows, torch_generate, f"dev after step {step} ({step / steps_per_epoch:.2f} epochs)", misses=5)
    curve.append({"step": step, "epochs": round(step / steps_per_epoch, 2), "accuracy": result["accuracy"]})
    if result["accuracy"] > best["accuracy"]:
        best.update(accuracy=result["accuracy"], step=step, state={key: value.detach().to("cpu", copy=True) for key, value in model.state_dict().items()})
    model.train()
    model.gradient_checkpointing_enable()


step = 0
started = time.time()
order = list(range(len(encoded)))
while step < total_steps:
    random.shuffle(order)
    for start in range(0, len(order), args.batch):
        if step >= total_steps:
            break
        indices = order[start:start + args.batch]
        for group in optimizer.param_groups:
            group["lr"] = learning_rate(step)
        optimizer.zero_grad(set_to_none=True)
        running = 0.0
        for micro_start in range(0, len(indices), args.micro):
            batch = [encoded[i] for i in indices[micro_start:micro_start + args.micro]]
            loss = micro_loss(batch) / accumulate
            loss.backward()
            running += loss.item()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        if step % 25 == 0:
            print(f"step {step}/{total_steps} loss {running:.4f} lr {learning_rate(step):.2e} {time.time() - started:.0f} s", flush=True)
        step += 1
        if step % steps_per_epoch == 0 and step < total_steps:
            checkpoint(step)

if total_steps > 0:
    checkpoint(total_steps)
if best["state"] is not None and best["step"] != total_steps:
    print(f"keeping the weights after step {best['step']}, the best on dev ({best['accuracy']:.1%})", flush=True)
    model.load_state_dict(best["state"])
best["state"] = None
results["curve"] = curve
results["best_step"] = best["step"]

model.gradient_checkpointing_disable()
model.eval()
results["fine_tuned"] = score(eval_rows, torch_generate, "fine-tuned FunctionGemma on held-out phrasings")

# The weights go to the Hub before anything else can fail, so an export problem never
# costs the training run: --checkpoint <repo> --skip-training exports them again.
if not args.no_publish and not args.skip_training:
    early_dir = work / "pytorch"
    if early_dir.exists():
        shutil.rmtree(early_dir)
    model.save_pretrained(early_dir, safe_serialization=True)
    tokenizer.save_pretrained(early_dir)
    api.create_repo(args.repo, repo_type="model", exist_ok=True, private=not args.public)
    api.upload_folder(folder_path=str(early_dir), path_in_repo="pytorch", repo_id=args.repo, repo_type="model",
                      commit_message=f"PyTorch weights: {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} held-out")
    print(f"saved the PyTorch weights to {args.repo}/pytorch", flush=True)

# ---------------------------------------------------------------------------------------
# The browser build: ONNX Runtime GenAI's builder with 4-bit weights in blocks of 32 and
# fp16 elsewhere, the layout of onnx-community/functiongemma-270m-it-ONNX's q4f16 file,
# which Transformers.js loads on WebGPU.

hf_dir = work / "hf"
if hf_dir.exists():
    shutil.rmtree(hf_dir)
model.save_pretrained(hf_dir, safe_serialization=True)
tokenizer.save_pretrained(hf_dir)
for name in ["generation_config.json"]:
    shutil.copy(hf_hub_download(BASE, name), hf_dir / name)

builder_out = work / "builder"
cache = work / "builder-cache"
for path in [builder_out, cache]:
    if path.exists():
        shutil.rmtree(path)
command = [sys.executable, "-m", "onnxruntime_genai.models.builder", "-i", str(hf_dir), "-o", str(builder_out),
           "-p", "int4", "-e", "webgpu", "-c", str(cache), "--extra_options", "int4_block_size=32", "int4_accuracy_level=4"]
print("\n" + " ".join(command), flush=True)
subprocess.run(command, check=True)
print("builder output:", sorted(p.name for p in builder_out.iterdir()), flush=True)

import onnx  # noqa: E402

web_dir = work / "web"
if web_dir.exists():
    shutil.rmtree(web_dir)
(web_dir / "onnx").mkdir(parents=True)
graph = onnx.load(builder_out / "model.onnx")
onnx.save_model(graph, web_dir / "onnx" / "model_q4f16.onnx", save_as_external_data=True,
                all_tensors_to_one_file=True, location="model_q4f16.onnx_data")

# Compare with the reference build: same inputs, outputs and operators.
reference = onnx.load(hf_hub_download(WEB_REFERENCE, "onnx/model_q4f16.onnx"), load_external_data=False)
mine = onnx.load(web_dir / "onnx" / "model_q4f16.onnx", load_external_data=False)
def signature(m):
    from collections import Counter
    return ([i.name for i in m.graph.input], [o.name for o in m.graph.output],
            sorted(Counter((n.domain, n.op_type) for n in m.graph.node).items()))
same = signature(reference)[:2] == signature(mine)[:2] and signature(reference)[2] == signature(mine)[2]
print("matches the reference build's inputs, outputs and operators:", same, flush=True)
if not same:
    for a, b, label in zip(signature(reference), signature(mine), ["inputs", "outputs", "ops"]):
        if a != b:
            print(f"  {label} differ:\n    reference {a}\n    mine      {b}", flush=True)

# Logits for the last position only, see last_token_logits.py: the builder's graph
# computes them for the whole 3,300-token prompt, about 3 GB that generation never reads.
helper_scope = {"__name__": "last_token_logits"}
exec(compile(fetch("last_token_logits.py"), "last_token_logits.py", "exec"), helper_scope)
helper_scope["last_token_logits"](str(web_dir / "onnx" / "model_q4f16.onnx"))

for name in ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "config.json", "generation_config.json"]:
    shutil.copy(hf_hub_download(WEB_REFERENCE, name), web_dir / name)
config = json.loads((web_dir / "config.json").read_text())
config["transformers.js_config"] = {"use_external_data_format": {"model_q4f16.onnx": 1}, "kv_cache_dtype": {"q4f16": "float16"}}
(web_dir / "config.json").write_text(json.dumps(config, indent=2))

# ---------------------------------------------------------------------------------------
# The export answers through ONNX Runtime with a KV cache, as Transformers.js runs it.

import onnxruntime as ort  # noqa: E402

# The CPU provider may lack an fp16 kernel the WebGPU build uses. Then the same weights
# are built for the CPU, int4 in blocks of 32 with fp32 activations, and checked there.
checked_file = web_dir / "onnx" / "model_q4f16.onnx"
try:
    session = ort.InferenceSession(str(checked_file), providers=["CPUExecutionProvider"])
    checked = "q4f16 (the browser file)"
except Exception as error:  # noqa: BLE001
    print("the CPU provider can't load the q4f16 file:", str(error)[:300], flush=True)
    cpu_out = work / "builder-cpu"
    subprocess.run([sys.executable, "-m", "onnxruntime_genai.models.builder", "-i", str(hf_dir), "-o", str(cpu_out),
                    "-p", "int4", "-e", "cpu", "-c", str(cache), "--extra_options", "int4_block_size=32", "int4_accuracy_level=4"], check=True)
    checked_file = cpu_out / "model.onnx"
    session = ort.InferenceSession(str(checked_file), providers=["CPUExecutionProvider"])
    checked = "q4 CPU build of the same weights"
inputs = {i.name: i for i in session.get_inputs()}
kv_names = [name for name in inputs if name.startswith("past_key_values")]
kv_type = np.float16 if "float16" in inputs[kv_names[0]].type else np.float32
heads, head_dim = 1, 256


def onnx_generate(messages):
    ids = list(prompt_ids(messages))
    past = {name: np.zeros((1, heads, 0, head_dim), dtype=kv_type) for name in kv_names}
    generated = []
    feed_ids = ids
    position = 0
    for _ in range(MAX_NEW_TOKENS):
        length = len(feed_ids)
        feed = {
            "input_ids": np.array([feed_ids], dtype=np.int64),
            "attention_mask": np.ones((1, position + length), dtype=np.int64),
            "position_ids": np.arange(position, position + length, dtype=np.int64)[None, :],
            **past,
        }
        outputs = session.run(None, feed)
        named = dict(zip([o.name for o in session.get_outputs()], outputs))
        token = int(np.argmax(named["logits"][0, -1]))
        generated.append(token)
        if token in (1, 50, 106):
            break
        past = {f"past_key_values.{name[len('present.'):]}": value for name, value in named.items() if name.startswith("present.")}
        position += length
        feed_ids = [token]
    return tokenizer.decode(generated, skip_special_tokens=False)


subset = eval_rows[: args.onnx_eval]
results["onnx_q4f16"] = score(subset, onnx_generate, f"ONNX {checked} on {len(subset)} held-out phrasings")
results["onnx_checked"] = checked
results["torch_same_subset"] = score(subset, torch_generate, f"fine-tuned PyTorch on the same {len(subset)}")
results["prompt_tokens"] = sum(1 for label in example["labels"] if label == -100)
results["onnx_matches_reference_layout"] = same
results["onnx_bytes"] = sum(p.stat().st_size for p in (web_dir / "onnx").iterdir())

# ---------------------------------------------------------------------------------------
# Publish: the browser build at the root, as Transformers.js expects, and the PyTorch
# weights in pytorch/ for the next round of training.

base_row = f"{results['base']['correct']}/{results['base']['total']}" if "base" in results else (args.base_result or "not measured")
readme = f"""---
license: gemma
base_model: google/functiongemma-270m-it
library_name: transformers.js
tags: [function-calling, prism-os, webgpu]
---

# Prism OS command center model

FunctionGemma 270M fine-tuned on the commands of
[Prism OS](https://github.com/AppleLamps/prism-os), a desktop in the browser whose window
manager is a handwired numeric program. It turns a sentence into Prism OS's function
calls, or a short reply. It runs in the browser with Transformers.js on WebGPU
(`onnx/model_q4f16.onnx`). The PyTorch weights are in `pytorch/`.

## Results on held-out phrasings

Every eval sentence uses a phrasing template that never appears in training. The epoch
kept was the best on a separate dev set of eval sentences, which these scores leave out.

| Model | Correct |
| --- | --- |
| Base FunctionGemma | {base_row} |
| Fine-tuned (PyTorch, bf16) | {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} |
| Fine-tuned, ONNX {checked}, first {len(subset)} | {results['onnx_q4f16']['correct']}/{results['onnx_q4f16']['total']} |

Use is subject to the [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
"""
(web_dir / "README.md").write_text(readme)
(web_dir / "results.json").write_text(json.dumps(results, indent=2))
shutil.copytree(hf_dir, web_dir / "pytorch")

if args.no_publish:
    print("\nRESULTS", json.dumps(results), flush=True)
    print("--no-publish: built and checked, published nothing", flush=True)
    sys.exit(0)
# Private unless asked: the browser can only load a public repo, so the owner makes it
# public once they have checked the results.
api.create_repo(args.repo, repo_type="model", exist_ok=True, private=not args.public)
api.upload_folder(folder_path=str(web_dir), repo_id=args.repo, repo_type="model",
                  commit_message=f"Fine-tuned on Prism OS commands: {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} held-out")
print("\nRESULTS", json.dumps(results), flush=True)
print(f"published https://huggingface.co/{args.repo}", flush=True)
