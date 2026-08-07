#!/usr/bin/env python3
"""Lint written documentation files with the bundled STE linter."""
import importlib.util, json, os, sys
import re
from pathlib import Path
sys.dont_write_bytecode = True

DOCUMENT_EXTENSIONS = {
    ".adoc", ".asciidoc", ".cfg", ".conf", ".ini", ".json", ".md",
    ".mdx", ".rst", ".text", ".toml", ".txt", ".xml", ".yaml", ".yml",
}

RULE_HINTS = {
    "contraction": "expand the contraction",
    "passive_voice": "rewrite with an active subject",
    "ing_main_verb": "use a direct main verb",
    "nominalization": "replace the noun phrase with a verb",
    "phrasal_verb": "use a direct verb",
    "banned_word": "choose a plain alternative",
    "marketing_adjective": "remove the marketing wording",
    "modal_hedge": "state the instruction directly",
    "semicolon": "split the sentence",
    "long_sentence(>20w)": "split the sentence",
    "long_paragraph(>6s)": "split the paragraph",
}

def is_document_file(path):
    return path.suffix.lower() in DOCUMENT_EXTENSIONS

def emit(value): sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
def load_linter():
    root = Path(os.environ.get("PLUGIN_ROOT", Path(__file__).resolve().parents[1]))
    path = root / "tools" / "ste-lint.py"
    spec = importlib.util.spec_from_file_location("ste_lint", path)
    if spec is None or spec.loader is None: raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

def format_detail(path, detail):
    location = f"{path}:{detail['line']}:{detail['column']}"
    matched = detail.get("match") or "(line-level finding)"
    matched = " ".join(matched.split())
    if len(matched) > 120:
        matched = matched[:117] + "..."
    hint = RULE_HINTS.get(detail["rule"], "rewrite the flagged prose")
    return f"  - {location} {detail['rule']}: {matched!r} | {hint}"

def main():
    try: event = json.load(sys.stdin)
    except (json.JSONDecodeError, OSError): emit({"continue": True}); return
    if event.get("stop_hook_active"): emit({"continue": True}); return
    mode = os.environ.get("STE_LINT_MODE", "strict").strip().lower()
    if mode in {"off", "disabled", "0", "false"}: emit({"continue": True}); return
    tool_input = event.get("tool_input")
    if not isinstance(tool_input, dict): emit({"continue": True}); return
    file_name = tool_input.get("file_path")
    if not isinstance(file_name, str) or not file_name.strip(): emit({"continue": True}); return
    path = Path(file_name)
    if not is_document_file(path) or not path.is_file(): emit({"continue": True}); return
    try:
        message = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        emit({"continue": True}); return
    if not message.strip(): emit({"continue": True}); return
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
    failing_rules = {key for key, _ in failing}
    details = [detail for detail in result.get("details", []) if detail.get("rule") in failing_rules]
    details.sort(key=lambda detail: (detail.get("line", 0), detail.get("column", 0), detail.get("rule", "")))
    locations = "\n".join(format_detail(path, detail) for detail in details)
    reason = (
        f"STE {mode} lint found {sum(count for _, count in failing)} violation(s) in {path}: {summary}.\n"
        f"Locations:\n{locations}\n"
        "Use $ste-writing to revise the flagged prose. Set STE_LINT_MODE=flavored for natural technical prose or STE_LINT_MODE=off for intentional voice-led prose."
    )
    emit({"decision": "block", "reason": reason})

if __name__ == "__main__":
    try: main()
    except (ImportError, OSError, AttributeError, KeyError, TypeError) as error:
        print(f"STE linter hook skipped: {error}", file=sys.stderr); emit({"continue": True})
