# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch>=2.8",
#   "transformers==5.20.1",
#   "huggingface_hub",
#   "onnx==1.23.2",
#   "onnxruntime==1.31.0",
#   "numpy",
# ]
# ///
"""Fine-tunes FunctionGemma 270M on Prism OS's commands, measures it before and after on
held-out phrasings, writes the browser build, checks that the browser build answers like
the PyTorch model, and publishes both to the Hub.

Run as a Hugging Face Job (see src/prismos/README.md):

  hf jobs uv run --flavor a100-large --secrets HF_TOKEN --timeout 2h \
    https://raw.githubusercontent.com/AppleLamps/prism-os/<branch>/src/prismos/training/train.py \
    --data <raw url of src/prismos/training> --repo <user>/prism-os-functiongemma

The data comes from scripts/prismos-dataset.ts: train.jsonl, eval.jsonl and tools.json.
Check it first, locally and without a GPU:

  python3 src/prismos/training/train.py --data src/prismos/training --repo x --check-data

How it uses the GPU. Every prompt starts with the same ~3,290 tokens, the 50 tool
declarations, and only the last ~40 differ. So each batch runs that shared prefix once,
copies its keys and values to every row, and runs only each row's own tokens on top:
about a tenth of the work of running every row whole, with the same loss and gradients.
Evaluation does the same and decodes up to 64 sentences at once, grouped by length so no
row is padded. The weights stay in fp32 for AdamW and the math runs in bf16; weights
held in bf16 round away most small updates. With every update now landing, the default
learning rate is 2e-5: on the real model, held-out loss at 5e-5 fell as fast and then
rose sooner. The pinned versions are the ones this script was tested with.
"""
import argparse
import json
import math
import os
import random
import re
import shutil
import sys
import time
import urllib.request
from pathlib import Path

BASE = "google/functiongemma-270m-it"
WEB_REFERENCE = "onnx-community/functiongemma-270m-it-ONNX"
# The longest answers, three calls with an address or a search, take about 90 tokens.
MAX_NEW_TOKENS = 160
# <eos>, <start_function_response> and <end_of_turn> end an answer.
STOP_TOKENS = [1, 50, 106]
PHOTOS = ["Misty Lake", "Desert Light", "Pacific Edge", "Midnight City", "Forest Path", "Alpine Dawn",
          "Amalfi Morning", "North Falls", "Lavender Hour", "Concrete Curve", "Blue Lagoon", "Autumn Road"]

parser = argparse.ArgumentParser()
parser.add_argument("--data", required=True, help="URL or folder with train.jsonl, eval.jsonl and tools.json")
parser.add_argument("--repo", required=True, help="Hub repo for the result, e.g. user/prism-os-functiongemma")
parser.add_argument("--base", default=BASE, help="the model to fine-tune, a Hub repo or a local folder")
parser.add_argument("--epochs", type=float, default=3)
parser.add_argument("--lr", type=float, default=2e-5)
parser.add_argument("--batch", type=int, default=16, help="rows per optimizer step")
parser.add_argument("--micro", type=int, default=16, help="rows per forward pass; lower it on a GPU with less than 40 GB")
parser.add_argument("--gen-batch", type=int, default=64, help="sentences decoded at once during evaluation")
parser.add_argument("--dev-every", type=float, default=0.5, help="epochs between dev scores")
parser.add_argument("--train-limit", type=int, default=0, help="train on only this many rows, e.g. for a quick test")
parser.add_argument("--allow-cpu", action="store_true", help="run without a GPU, e.g. a small local test")
parser.add_argument("--onnx-eval", type=int, default=100, help="eval rows to run through the browser build")
parser.add_argument("--skip-base-eval", action="store_true")
parser.add_argument("--base-result", default=None, help="the base model's score from an earlier run, e.g. 132/597, for the README when --skip-base-eval")
parser.add_argument("--skip-training", action="store_true", help="export --checkpoint (or the base model) without training, e.g. to test the export")
parser.add_argument("--checkpoint", default=None, help="a Hub repo whose pytorch/ folder holds weights to start from, or a local folder")
parser.add_argument("--eval-limit", type=int, default=0, help="score only this many eval rows, e.g. for a quick export test")
parser.add_argument("--no-publish", action="store_true", help="build and check everything, publish nothing")
parser.add_argument("--public", action="store_true", help="publish the repo as public; private by default")
parser.add_argument("--curve-rows", type=int, default=150, help="eval rows scored every --dev-every epochs, for the learning curve and the best checkpoint; 0 skips")
parser.add_argument("--work", default="/tmp/prism", help="folder for the build")
parser.add_argument("--check-data", action="store_true", help="check the data and the scorer, with no GPU and no downloads, and stop")
args = parser.parse_args()

random.seed(0)
work = Path(args.work)
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
if args.train_limit:
    train_rows = train_rows[: args.train_limit]
# The learning curve and the choice of checkpoint use dev rows, every k-th eval row, which the
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
job_started = time.time()
device = "cuda" if torch.cuda.is_available() else "cpu"
if device == "cpu" and not args.allow_cpu:
    sys.exit("no GPU: torch can't see CUDA (torch " + torch.__version__ + "). Pass --allow-cpu for a local test.")
if device == "cuda":
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    gpu = torch.cuda.get_device_properties(0)
    print(f"GPU: {gpu.name}, {gpu.total_memory / 2**30:.0f} GB; torch {torch.__version__}, CUDA {torch.version.cuda}", flush=True)


def autocast():
    return torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=device == "cuda")


def helper(name):
    """A helper script from the data folder, e.g. onnx_weights.py, as a dict of its names."""
    scope = {"__name__": name.removesuffix(".py")}
    exec(compile(fetch(name), name, "exec"), scope)
    return scope


tokenizer = AutoTokenizer.from_pretrained(args.base)
start_from = {"pretrained_model_name_or_path": args.base}
if args.checkpoint:
    start_from = {"pretrained_model_name_or_path": args.checkpoint} if Path(args.checkpoint).exists() else {"pretrained_model_name_or_path": args.checkpoint, "subfolder": "pytorch"}
model = AutoModelForCausalLM.from_pretrained(**start_from, dtype=torch.float32, attn_implementation="sdpa").to(device)
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
    return {"prompt": len(prompt), "input_ids": full, "labels": [-100] * len(prompt) + full[len(prompt):]}


encoded = [encode(row) for row in train_rows]
example = encoded[0]
print("rendered example:", tokenizer.decode(example["input_ids"])[-400:], flush=True)

# The tokens every prompt starts with: the developer turn with the tool declarations.
# Every prompt goes on past it, with the user's sentence, so the first answer token is
# always predicted from a row's own tokens.
prompts = [item["input_ids"][: item["prompt"]] for item in encoded] + [prompt_ids(row["messages"]) for row in eval_rows + dev_rows]
shared = 0
while all(len(prompt) > shared + 1 and prompt[shared] == prompts[0][shared] for prompt in prompts):
    shared += 1
prefix = torch.tensor([prompts[0][:shared]], device=device)
lengths = [len(item["input_ids"]) for item in encoded]
answers = [len(item["input_ids"]) - item["prompt"] for item in encoded]
print(f"prompts: {min(map(len, prompts))} to {max(map(len, prompts))} tokens, the first {shared} shared by all", flush=True)
print(f"train tokens: {sum(lengths):,} an epoch, of which {len(encoded) * shared:,} are the shared prefix; answers up to {max(answers)} tokens", flush=True)
if max(answers) > MAX_NEW_TOKENS:
    print(f"WARNING: an answer of {max(answers)} tokens is longer than MAX_NEW_TOKENS = {MAX_NEW_TOKENS}", flush=True)
for item in encoded:
    item["input_ids"], item["labels"] = item["input_ids"][shared:], item["labels"][shared:]


def prefix_cache(rows):
    """The shared prefix's keys and values, once for each of `rows` rows. Under
    torch.no_grad() for decoding; with gradients for training, where the rows' losses
    reach the prefix through its keys and values exactly as through a whole row."""
    cache = model.model(input_ids=prefix, use_cache=True).past_key_values
    cache.batch_repeat_interleave(rows)
    return cache


# ---------------------------------------------------------------------------------------
# Decoding: greedy, as the browser decodes. Sentences of the same length decode together
# from one copy of the prefix, so no row has padding and each answer is the one it gets
# alone.

@torch.no_grad()
def torch_generate(many):
    training = model.training
    model.eval()
    ids = [prompt_ids(messages) for messages in many]
    answers = [""] * len(ids)
    groups = {}
    for index, row in enumerate(ids):
        groups.setdefault(len(row), []).append(index)
    stop = torch.tensor(STOP_TOKENS, device=device)
    for group in groups.values():
        for start in range(0, len(group), args.gen_batch):
            chunk = group[start:start + args.gen_batch]
            made = []
            with autocast():
                cache = prefix_cache(len(chunk))
                own = torch.tensor([ids[index][shared:] for index in chunk], device=device)
                out = model(input_ids=own, past_key_values=cache, use_cache=True, logits_to_keep=1)
                done = torch.zeros(len(chunk), dtype=torch.bool, device=device)
                for _ in range(MAX_NEW_TOKENS):
                    token = out.logits[:, -1].argmax(-1)
                    made.append(token)
                    done |= torch.isin(token, stop)
                    if bool(done.all()):
                        break
                    out = model(input_ids=token[:, None], past_key_values=out.past_key_values, use_cache=True)
            for index, tokens in zip(chunk, torch.stack(made, 1).tolist()):
                end = next((at + 1 for at, token in enumerate(tokens) if token in STOP_TOKENS), len(tokens))
                answers[index] = tokenizer.decode(tokens[:end], skip_special_tokens=False)
    model.train(training)
    return answers


def score(rows, generate, label, misses=25):
    started = time.time()
    raw = generate([row["messages"] for row in rows])
    totals, correct, failures, answers = {}, {}, [], []
    for row, text in zip(rows, raw):
        calls, reply = expected(row)
        got_calls, got_text = parse_answer(text)
        answers.append(canonical(got_calls) if got_calls else ("reply" if got_text else "nothing"))
        ok = (not got_calls and got_text != "") if reply is not None else canonical(got_calls) == canonical(calls)
        group = kind(row)
        totals[group] = totals.get(group, 0) + 1
        correct[group] = correct.get(group, 0) + int(ok)
        if not ok and len(failures) < misses:
            failures.append((row["messages"][1]["content"], calls or reply, text[:200]))
    total = sum(totals.values())
    accuracy = sum(correct.values()) / max(total, 1)
    print(f"\n=== {label}: {sum(correct.values())}/{total} = {accuracy:.1%} ({time.time() - started:.0f} s)", flush=True)
    for group in sorted(totals):
        print(f"  {group:>18}: {correct[group]}/{totals[group]}", flush=True)
    for user, want, got in failures:
        print(f"  MISS {user!r}\n       want {want}\n       got  {got!r}", flush=True)
    return {"accuracy": accuracy, "correct": sum(correct.values()), "total": total,
            "by_kind": {group: [correct[group], totals[group]] for group in totals}, "answers": answers}


def summary(result):
    return {key: value for key, value in result.items() if key != "answers"}


# The decoding above against Transformers' own generate(), one sentence at a time.
check_rows = (eval_rows or dev_rows)[:4]
batched = torch_generate([row["messages"] for row in check_rows])
alone = []
for row in check_rows:
    ids = torch.tensor([prompt_ids(row["messages"])], device=device)
    with torch.no_grad(), autocast():
        out = model.generate(ids, attention_mask=torch.ones_like(ids), max_new_tokens=MAX_NEW_TOKENS, do_sample=False,
                             eos_token_id=STOP_TOKENS, pad_token_id=tokenizer.pad_token_id)
    alone.append(tokenizer.decode(out[0, ids.shape[1]:], skip_special_tokens=False))
same = sum(parse_answer(a) == parse_answer(b) for a, b in zip(batched, alone))
print(f"decoding check: the batched decoder and generate() agree on {same}/{len(check_rows)} sentences", flush=True)
if same < len(check_rows):
    for a, b in zip(batched, alone):
        print(f"  batched {a[:120]!r}\n  alone   {b[:120]!r}", flush=True)

results = {"decoding_check": f"{same}/{len(check_rows)}"}
if not args.skip_base_eval:
    results["base"] = summary(score(eval_rows, torch_generate, "base FunctionGemma on held-out phrasings"))

# ---------------------------------------------------------------------------------------
# Training: full fine-tune, loss on the answer tokens only. The logits are computed only
# at those positions, since the 262,144-word vocabulary makes logits for a whole
# 3,300-token prompt cost gigabytes.

model.train()
optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.0, betas=(0.9, 0.98), fused=device == "cuda")
steps_per_epoch = math.ceil(len(encoded) / args.batch)
total_steps = 0 if args.skip_training else max(1, int(steps_per_epoch * args.epochs))
warmup = max(1, int(total_steps * 0.03))
dev_steps = max(1, round(steps_per_epoch * args.dev_every))


def learning_rate(step):
    if step < warmup:
        return args.lr * (step + 1) / warmup
    progress = (step - warmup) / max(1, total_steps - warmup)
    return args.lr * 0.5 * (1 + math.cos(math.pi * progress))


def micro_loss(batch):
    width = max(len(item["input_ids"]) for item in batch)
    pad = tokenizer.pad_token_id
    # Right padding: every pad comes after a row's last real token, so the causal mask
    # keeps it out of every position that counts.
    input_ids = torch.tensor([item["input_ids"] + [pad] * (width - len(item["input_ids"])) for item in batch], device=device)
    labels = torch.tensor([item["labels"] + [-100] * (width - len(item["labels"])) for item in batch], device=device)
    # Position t predicts token t + 1.
    targets = labels[:, 1:]
    mask = targets != -100
    with autocast():
        cache = prefix_cache(len(batch))
        hidden = model.model(input_ids=input_ids, past_key_values=cache, use_cache=True).last_hidden_state
        logits = model.lm_head(hidden[:, :-1][mask])
    logits = logits.float()
    softcap = getattr(model.config, "final_logit_softcapping", None)
    if softcap:
        logits = torch.tanh(logits / softcap) * softcap
    return torch.nn.functional.cross_entropy(logits, targets[mask])


print(f"\ntraining: {total_steps} steps of {args.batch} rows ({args.micro} a pass), lr {args.lr}, {args.epochs} epochs, "
      f"dev score every {dev_steps} steps", flush=True)
curve = []
best = {"accuracy": -1.0, "step": 0, "state": None}


def checkpoint(step):
    """Scores the dev rows; keeps the weights when they're the best so far."""
    if not dev_rows:
        return
    result = score(dev_rows, torch_generate, f"dev after step {step} ({step / steps_per_epoch:.2f} epochs)", misses=5)
    curve.append({"step": step, "epochs": round(step / steps_per_epoch, 2), "accuracy": result["accuracy"]})
    if result["accuracy"] > best["accuracy"]:
        best.update(accuracy=result["accuracy"], step=step, state={key: value.detach().to("cpu", copy=True) for key, value in model.state_dict().items()})


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
        passes = math.ceil(len(indices) / args.micro)
        for micro_start in range(0, len(indices), args.micro):
            batch = [encoded[i] for i in indices[micro_start:micro_start + args.micro]]
            loss = micro_loss(batch) / passes
            loss.backward()
            running += loss.item()
        norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        step += 1
        if step % 25 == 0 or step == 1:
            elapsed = time.time() - started
            memory = f", {torch.cuda.max_memory_allocated() / 2**30:.1f} GB peak" if device == "cuda" else ""
            print(f"step {step}/{total_steps} loss {running:.4f} grad {float(norm):.2f} lr {learning_rate(step - 1):.2e} "
                  f"{elapsed:.0f} s, {elapsed / step:.2f} s a step, {elapsed / step * (total_steps - step) / 60:.0f} min left{memory}", flush=True)
        if step % dev_steps == 0 and step < total_steps:
            checkpoint(step)

if total_steps > 0:
    print(f"training took {(time.time() - started) / 60:.1f} min", flush=True)
    checkpoint(total_steps)
if best["state"] is not None and best["step"] != total_steps:
    print(f"keeping the weights after step {best['step']}, the best on dev ({best['accuracy']:.1%})", flush=True)
    model.load_state_dict(best["state"])
best["state"] = None
del optimizer
results["curve"] = curve
results["best_step"] = best["step"]
results["train_minutes"] = round((time.time() - started) / 60, 1)

# The published weights are bf16, as the base model's are, and every later score uses them.
model.to(torch.bfloat16)
model.eval()
results["fine_tuned"] = summary(score(eval_rows, torch_generate, "fine-tuned FunctionGemma on held-out phrasings"))

# The weights go to the Hub before anything else can fail, so a problem with the browser
# build never costs the training run: --checkpoint <repo> --skip-training builds it again.
pytorch_dir = work / "pytorch"
if pytorch_dir.exists():
    shutil.rmtree(pytorch_dir)
model.save_pretrained(pytorch_dir, safe_serialization=True)
tokenizer.save_pretrained(pytorch_dir)
if not args.no_publish and not args.skip_training:
    api.create_repo(args.repo, repo_type="model", exist_ok=True, private=not args.public)
    api.upload_folder(folder_path=str(pytorch_dir), path_in_repo="pytorch", repo_id=args.repo, repo_type="model",
                      commit_message=f"PyTorch weights: {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} held-out")
    print(f"saved the PyTorch weights to {args.repo}/pytorch", flush=True)

# ---------------------------------------------------------------------------------------
# The browser build: onnx-community/functiongemma-270m-it-ONNX's q4f16 graph, the file
# Transformers.js runs on WebGPU, with the fine-tuned weights written in place of its
# own, see onnx_weights.py. The graph is the reference's node for node, so the browser
# loads and runs it as it runs the reference.

web_dir = work / "web"
if web_dir.exists():
    shutil.rmtree(web_dir)
(web_dir / "onnx").mkdir(parents=True)
web_file = web_dir / "onnx" / "model_q4f16.onnx"
# Real files, not the Hub cache's symbolic links, which onnx refuses for external data.
reference = hf_hub_download(WEB_REFERENCE, "onnx/model_q4f16.onnx", local_dir=work / "reference")
hf_hub_download(WEB_REFERENCE, "onnx/model_q4f16.onnx_data", local_dir=work / "reference")
state = {key: value.float().cpu().numpy() for key, value in model.state_dict().items()}
helper("onnx_weights.py")["write_weights"](state, reference, str(web_file), layers=model.config.num_hidden_layers)
del state
print(f"wrote the fine-tuned weights into {WEB_REFERENCE}'s q4f16 graph", flush=True)
# Logits for the last position only, see last_token_logits.py: the graph computes them
# for the whole 3,300-token prompt, about 3 GB that generation never reads.
helper("last_token_logits.py")["last_token_logits"](str(web_file))

for name in ["tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "config.json", "generation_config.json"]:
    shutil.copy(hf_hub_download(WEB_REFERENCE, name), web_dir / name)
config = json.loads((web_dir / "config.json").read_text())
config["transformers.js_config"] = {"use_external_data_format": {"model_q4f16.onnx": 1}, "kv_cache_dtype": {"q4f16": "float16"}}
(web_dir / "config.json").write_text(json.dumps(config, indent=2))
results["onnx_bytes"] = sum(p.stat().st_size for p in (web_dir / "onnx").iterdir())

# ---------------------------------------------------------------------------------------
# The browser build answers through ONNX Runtime with a KV cache, as Transformers.js runs
# it, on the CPU: 4-bit weights, fp16 activations. The shared prefix runs once; each
# sentence goes on from a copy of its keys and values, which gives the same tokens as
# running each prompt whole (checked on the first sentences below).

import onnxruntime as ort  # noqa: E402

subset = eval_rows[: args.onnx_eval]
try:
    options = ort.SessionOptions()
    options.intra_op_num_threads = os.cpu_count() or 0
    session = ort.InferenceSession(str(web_file), options, providers=["CPUExecutionProvider"])
    inputs = {i.name: i for i in session.get_inputs()}
    outputs = [o.name for o in session.get_outputs()]
    kv_names = [name for name in inputs if name.startswith("past_key_values")]
    kv_type = np.float16 if "float16" in inputs[kv_names[0]].type else np.float32
    empty = {name: np.zeros((1, model.config.num_key_value_heads, 0, model.config.head_dim), dtype=kv_type) for name in kv_names}

    def onnx_step(ids, past, position):
        feed = {"input_ids": np.array([ids], dtype=np.int64), "attention_mask": np.ones((1, position + len(ids)), dtype=np.int64),
                "position_ids": np.arange(position, position + len(ids), dtype=np.int64)[None, :], **past}
        named = dict(zip(outputs, session.run(None, {key: value for key, value in feed.items() if key in inputs})))
        present = {f"past_key_values.{name[len('present.'):]}": value for name, value in named.items() if name.startswith("present.")}
        return int(np.argmax(named["logits"][0, -1])), present

    onnx_started = time.time()
    _, prefix_past = onnx_step(prompts[0][:shared], empty, 0)
    print(f"ONNX: the shared prefix took {time.time() - onnx_started:.0f} s on {os.cpu_count()} CPUs", flush=True)

    def onnx_answer(messages, whole=False):
        ids = prompt_ids(messages)
        feed, past, position = (ids, empty, 0) if whole else (ids[shared:], prefix_past, shared)
        generated = []
        for _ in range(MAX_NEW_TOKENS):
            token, past = onnx_step(feed, past, position)
            generated.append(token)
            if token in STOP_TOKENS:
                break
            position += len(feed)
            feed = [token]
        return tokenizer.decode(generated, skip_special_tokens=False)

    whole = [onnx_answer(row["messages"], whole=True) for row in subset[:2]]
    reuse_prefix = whole == [onnx_answer(row["messages"]) for row in subset[:2]]
    print(f"ONNX: going on from the shared prefix gives the same answers as whole prompts: {reuse_prefix}", flush=True)

    def onnx_generate(many):
        answers = []
        for index, messages in enumerate(many):
            answers.append(onnx_answer(messages, whole=not reuse_prefix))
            if (index + 1) % 25 == 0:
                print(f"  ONNX {index + 1}/{len(many)}, {time.time() - onnx_started:.0f} s", flush=True)
        return answers

    onnx_result = score(subset, onnx_generate, f"browser build (ONNX q4f16) on {len(subset)} held-out phrasings")
    torch_result = score(subset, torch_generate, f"fine-tuned PyTorch on the same {len(subset)}")
    agree = sum(a == b for a, b in zip(onnx_result["answers"], torch_result["answers"]))
    print(f"the browser build and PyTorch give the same answer for {agree}/{len(subset)} sentences", flush=True)
    results["onnx_q4f16"] = summary(onnx_result)
    results["torch_same_subset"] = summary(torch_result)
    results["onnx_agrees_with_torch"] = f"{agree}/{len(subset)}"
    if onnx_result["accuracy"] < torch_result["accuracy"] - 0.1:
        print("WARNING: the browser build scores more than 10 points below PyTorch", flush=True)
except Exception as error:  # noqa: BLE001
    # The browser build still ships, as unchecked, with the error in results.json.
    print(f"WARNING: the browser build couldn't be checked: {error!r}", flush=True)
    results["onnx_error"] = repr(error)[:500]
results["prompt_tokens"] = len(prompts[0])

# ---------------------------------------------------------------------------------------
# Publish: the browser build at the root, as Transformers.js expects, and the PyTorch
# weights in pytorch/ for the next round of training.

base_row = f"{results['base']['correct']}/{results['base']['total']}" if "base" in results else (args.base_result or "not measured")
onnx_row = (f"{results['onnx_q4f16']['correct']}/{results['onnx_q4f16']['total']}" if "onnx_q4f16" in results else "not checked")
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
(`onnx/model_q4f16.onnx`, the graph of
[{WEB_REFERENCE}](https://huggingface.co/{WEB_REFERENCE}) with these weights). The
PyTorch weights are in `pytorch/`.

## Results on held-out phrasings

Every eval sentence uses a phrasing template that never appears in training. The
checkpoint kept was the best on a separate dev set of eval sentences, which these scores
leave out.

| Model | Correct |
| --- | --- |
| Base FunctionGemma | {base_row} |
| Fine-tuned (PyTorch, bf16) | {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} |
| Fine-tuned, browser build (q4f16), first {len(subset)} | {onnx_row} |

Use is subject to the [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
"""
results["job_minutes"] = round((time.time() - job_started) / 60, 1)
(web_dir / "README.md").write_text(readme)
(web_dir / "results.json").write_text(json.dumps(results, indent=2))
shutil.copytree(pytorch_dir, web_dir / "pytorch")

if args.no_publish:
    print("\nRESULTS", json.dumps(results), flush=True)
    print(f"--no-publish: built and checked in {results['job_minutes']} min, published nothing", flush=True)
    sys.exit(0)
# Private unless asked: the browser can only load a public repo, so the owner makes it
# public once they have checked the results.
api.create_repo(args.repo, repo_type="model", exist_ok=True, private=not args.public)
api.upload_folder(folder_path=str(web_dir), repo_id=args.repo, repo_type="model",
                  commit_message=f"Fine-tuned on Prism OS commands: {results['fine_tuned']['correct']}/{results['fine_tuned']['total']} held-out")
print("\nRESULTS", json.dumps(results), flush=True)
print(f"published https://huggingface.co/{args.repo} in {results['job_minutes']} min", flush=True)
