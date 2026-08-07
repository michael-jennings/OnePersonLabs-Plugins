#!/usr/bin/env python3
"""Lint the latest Codex assistant message with the episode's STE linter."""
import importlib.util, json, os, sys
import re
from pathlib import Path
sys.dont_write_bytecode = True

def emit(value): sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
def load_linter():
    root = Path(os.environ.get("PLUGIN_ROOT", Path(__file__).resolve().parents[1]))
    path = root / "tools" / "ste-lint.py"
    spec = importlib.util.spec_from_file_location("ste_lint", path)
    if spec is None or spec.loader is None: raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

def main():
    try: event = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError): emit({"continue": True}); return
    if event.get("stop_hook_active"): emit({"continue": True}); return
    mode = os.environ.get("STE_LINT_MODE", "strict").strip().lower()
    if mode in {"off", "disabled", "0", "false"}: emit({"continue": True}); return
    message = event.get("last_assistant_message")
    if not isinstance(message, str) or not message.strip(): emit({"continue": True}); return
    lowered = message.lower()
    for marker, marker_mode in (("<!-- ste:off -->", "off"), ("<!-- ste:flavored -->", "flavored"), ("[ste:off]", "off"), ("[ste:flavored]", "flavored")):
        if marker in lowered:
            mode = marker_mode
            message = re.sub(re.escape(marker), "", message, flags=re.I)
            lowered = message.lower()
    if mode == "off": emit({"continue": True}); return
    result = load_linter().lint(message); violations = dict(result["violations"])
    if mode == "flavored":
        for key in ("banned_word", "marketing_adjective", "phrasal_verb"): violations[key] = 0
    failing = [(key, count) for key, count in violations.items() if count]
    if not failing: emit({"continue": True}); return
    summary = ", ".join(f"{key}={count}" for key, count in failing[:8])
    emit({"decision": "block", "reason": f"STE {mode} lint found {sum(count for _, count in failing)} violation(s): {summary}. Rewrite technical prose. Use STE_LINT_MODE=flavored for natural technical prose or STE_LINT_MODE=off for intentional voice-led prose."})

if __name__ == "__main__":
    try: main()
    except (ImportError, OSError, AttributeError, KeyError, TypeError) as error:
        print(f"STE linter hook skipped: {error}", file=sys.stderr); emit({"continue": True})
