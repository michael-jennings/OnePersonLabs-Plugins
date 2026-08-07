#!/bin/bash
# codex-discipline-policy.sh
#
# Shared policy primitives for the three event-specific discipline hooks.
# This file is sourced by those hooks and is not configured as a hook itself.
#
# Bypass sentinel: <!-- discipline-bypass --> anywhere in the scanned text
# (or, in archive mode, in any .md inside the change dir) dismisses ALL
# checks for that invocation. Legacy sentinels <!-- mvp-meta --> and
# <!-- deferral-meta --> are still honored so existing archived files keep
# working; new uses must use <!-- discipline-bypass -->.
#
# Persistent allowlist: codex-discipline-gate.exceptions.txt
# holds phrases that are PERMANENTLY exempt -- one per line, '#' comments
# ignored. Unlike the one-shot sentinel, an allowlist entry survives across
# edits. It is for a RECURRING false positive that is genuinely outside what
# a check guards against (an external library's real release name like
# "Tauri v2", a fixed technical idiom), NOT for silencing a real violation.
# See is_excepted() for the two-part match rule (entry must be a substring of
# the flagged line AND contain the flagged needle, so it can't whitelist an
# unrelated violation on the same line).
#
# The bypass sentinel is a ONE-SHOT, not a permanent annotation. Block
# messages instruct the agent to remove it from the file in the next edit
# after the bypassed action completes (response-mode bypasses are
# naturally ephemeral). The agent must also justify out loud (a) which
# hits the sentinel covers, (b) why each is a false positive, (c) why
# rephrasing is not possible. Otherwise the sentinel is misuse.
#
# <!-- mvp-meta -->
# <!-- deferral-meta -->
# <!-- discipline-bypass -->
# (This file embeds all three so policy scans pass on it.
# The banned-phrase list below contains literal v1/v2 and deferral
# tokens as STRINGS THIS HOOK BLOCKS, not as rule violations.)
#
# ============================================================================
# MAINTAINING THE DEFERRAL PATTERNS (read before adding/changing one)
# ============================================================================
# When a real deferral slips past this gate ("2-min thing later", "not
# blocking anything", etc.), DON'T just bolt on the exact phrase. Derive a
# PATTERN for the class, then EARN it empirically:
#   1. Draft a candidate regex/phrase for the class (not just the one slip).
#   2. Test it against recent Codex session history -- grep the *.jsonl under
#      ~/.codex/sessions/, NEWEST-FIRST (`ls -t`), with a ~2min cap.
#   3. Script-extract a SHORT context window around each match (do NOT read
#      whole transcripts into context) and sample.
#   4. Classify the sample: true punt vs false positive.
#   5. Tune so it still catches every real prior hit but sheds the FPs.
#   6. Sanity-check for OVERFIT: if it matches essentially only the exact
#      known slip and nothing else, it's worthless -- loosen and re-test.
#   7. Adopt -- as a fixed string in BANNED_PHRASES if it's literal, or as a
#      regex (like the two below) if it needs alternation/gaps.
#
# Keep the lists LEAN. Collapse redundant entries -- one case-insensitive
# match beats fifteen capitalization variants; one regex beats ten near-dupe
# strings. A bloated list is as much a failure as a leaky one.
#
# Accept some false positives. If a flagged FP has NO clear standout extra
# indicator that would raise accuracy with high confidence (and survive the
# same history test without unexpected degradation), do NOT contort the
# pattern to dodge that one edge case -- a rare FP the author can bypass is
# cheaper than an overfit pattern that misses the next real slip. (This is
# why "not blocking" stayed OUT and only "not blocking anything" went in:
# broad "not blocking" drowns in legit "X is not a blocker for Y" prose.)
# ============================================================================

set -uo pipefail

INPUT=$(cat)
REPO_ROOT="${CODEX_PROJECT_DIR:-$(pwd)}"
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Persistent false-positive allowlist. Phrases here are PERMANENTLY exempt
# from the checks below -- unlike the one-shot bypass sentinel, which dies
# with the file edit that carried it. Use this only for a recurring phrasing
# that is genuinely and distinctly OUTSIDE what a check guards against (an
# external library's real release name, a fixed technical idiom). The file is
# committed and code-reviewed, so an over-broad entry is itself an auditable
# defect. See is_excepted() for match semantics and emit_block_report() for the
# agent-facing instructions.
EXCEPTIONS_FILE="$PLUGIN_ROOT/scripts/codex-discipline-gate.exceptions.txt"
[[ -f "$EXCEPTIONS_FILE" ]] || EXCEPTIONS_FILE="$REPO_ROOT/scripts/codex-discipline-gate.exceptions.txt"
declare -a DISCIPLINE_EXCEPTIONS=()

# ============================================================================
# Banned deferral phrases. Matched case-insensitively as fixed strings.
# ============================================================================
declare -a BANNED_PHRASES=(
  # Original hook-enforced set
  "future change"
  "out of scope"
  "deliberate accepted cost"
  "we will need to"
  "later we can"
  "deferred"
  "defer"

  # Aspirational-gap acceptance
  "accept the gap"
  "accept the slight"
  "accept the small"
  "accept the aspirational"
  "accept the cosmetic"

  # User-judgment dump
  "left for user judgment"

  # MVP-mindset acceptance (prose form; literal v1/v2 token check is below)
  "for now we'll just"
  "good enough for v1"
  "good enough for now"
  "we can revisit this"
  "tactical fix only"
  "minimum viable fix"
  "cost of fixing isn't worth"
  "ship now, fix later"
  "not worth the dance"
  "trivial enough to skip"

  # Producer-gap shortcuts (see AGENTS.md "Producer-gap detection")
  "file follow-up if load-bearing"
  "workaround keys on"
  "work around by keying"
  "proves insufficient post-merge"
  "structural and pre-existing"

  # Half-refactor laziness
  "left intact"
  "intentionally left"
  "future-work guidance"
  "future-work item"
  "future-work items"
  "will be revisited"
  "revisit later"
  "revisited later"
  "revisited when"
  "not in scope for this turn"
  "not worth pre-editing"
  "not worth touching now"
  "when those changes actually reach"
  "when that change gets to"
  "conservative scope"
  "leave them as-is"
  "leave it for later"
  "leave that for later"
  "will be moot"
  "become moot"
  "authored intentionally as"
  "historical record"
  "no urgency"
  "not enforcement"

  # Flippant dismissal of a punted item. Kept TIGHT on purpose: broad
  # "not blocking" / "not a blocker" is FP-heavy on legitimate "X is not a
  # blocker for Y" dependency prose, severity labels, and grep echoes (it was
  # tested and rejected). Only the dismissal-of-a-deferral phrasing is listed.
  "not blocking anything"
)

# "pre-existing" dismissal regex. Only flagged when used as a dismissal
# (followed by bug/issue/skip/etc., or terminating a sentence), so legit
# prose like "pre-existing test infrastructure" passes through.
PRE_EXISTING_DISMISSAL_REGEX='pre-existing.*(bug|issue|limitation|problem|defect|skip|not (addressing|fix))|pre-existing\.\s*$|pre-existing[,]'

# Trivializing-defer regex (ERE). Catches the "this is small, do it later"
# class: a time/effort-trivializing token followed within ~40 chars by a
# punt-to-later. Two trivializer arms:
#   - a HYPHENATED effort estimate ("2-min", "5-minute", "1-hr") -- the hyphen
#     is the standout indicator that distinguishes a task-size estimate from
#     the temporal idiom "20 minutes later" (player returns 20 minutes later),
#     which is a common FP. Requiring the hyphen kills that whole FP class; the
#     rare unhyphenated "2 min thing later" is an accepted miss (no clean
#     indicator separates it from temporal prose without contorting).
#   - the words quick|trivial|tiny|easy (unambiguously effort, never temporal).
# `small`/`minor` were dropped (they straddled unrelated clauses, e.g.
# "accept the small gap ... later"). Validated against session history:
# catches both known slips ("2-min thing later", "2-min ...->sync later") with
# low organic false-positive load.
TRIVIALIZING_DEFER_REGEX='([0-9]+-(min|minute|hr|hour)s?|quick|trivial|tiny|easy)[^.!?]{0,40}(later|eventually|down the (road|line)|another (time|session)|some other time|circle back|when i (get|come) (around|to|back))'

# Standalone v1/v2/v3 token regex (ERE).
MVP_TOKEN_REGEX='(^|[^A-Za-z0-9])v[123]([^A-Za-z0-9]|$)'

CANONICAL_SENTINEL='<!-- discipline-bypass -->'
LEGACY_SENTINEL_MVP='<!-- mvp-meta -->'
LEGACY_SENTINEL_DEFERRAL='<!-- deferral-meta -->'

# Follow-up indicator phrases. A kebab-3+ token on a line matching any of
# these gets treated as a follow-up reference and must resolve.
FOLLOWUP_INDICATORS='follow-up|follow up|pending |blocked on|deferred to|awaiting |TODO:[[:space:]]*file|should[[:space:]]+file|future work'

# ============================================================================
# Mode detection.
# ============================================================================
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || echo "")
NEW_STRING=$(echo "$INPUT" | jq -r '.tool_input.new_string // empty' 2>/dev/null || echo "")
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // empty' 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || echo "")

# ============================================================================
# Helpers.
# ============================================================================

# Check if any bypass sentinel (canonical or legacy) is present in text.
has_bypass_sentinel() {
  local text="$1"
  if echo "$text" | grep -qF "$CANONICAL_SENTINEL"; then return 0; fi
  if echo "$text" | grep -qF "$LEGACY_SENTINEL_MVP"; then return 0; fi
  if echo "$text" | grep -qF "$LEGACY_SENTINEL_DEFERRAL"; then return 0; fi
  return 1
}

# Check if any bypass sentinel is present in any .md under a directory.
dir_has_bypass_sentinel() {
  local dir="$1"
  if grep -rqF "$CANONICAL_SENTINEL" "$dir" --include='*.md' 2>/dev/null; then return 0; fi
  if grep -rqF "$LEGACY_SENTINEL_MVP" "$dir" --include='*.md' 2>/dev/null; then return 0; fi
  if grep -rqF "$LEGACY_SENTINEL_DEFERRAL" "$dir" --include='*.md' 2>/dev/null; then return 0; fi
  return 1
}

# Load the persistent allowlist into DISCIPLINE_EXCEPTIONS (lowercased), one
# entry per line, '#' comments and blank lines ignored. Called once before any
# scan so every mode (archive/write/response) honors the same list.
load_exceptions() {
  [[ -f "$EXCEPTIONS_FILE" ]] || return 0
  local line trimmed
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"       # ltrim
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"  # rtrim
    [[ -z "$trimmed" ]] && continue
    [[ "${trimmed:0:1}" == "#" ]] && continue
    DISCIPLINE_EXCEPTIONS+=("$(echo "$trimmed" | tr '[:upper:]' '[:lower:]')")
  done < "$EXCEPTIONS_FILE"
}

# is_excepted <content-line> <needle>
# Returns 0 (suppress this hit) when some allowlist entry covers it.
# An entry E covers a hit when BOTH hold:
#   (1) E (case-insensitive) is a substring of the flagged content line, AND
#   (2) E itself contains the flagged <needle> (the v-token or banned phrase).
# (2) is the safety rail: an entry can only suppress the specific FP class it
# names, never an unrelated real violation that happens to share the line --
# e.g. exception "tauri v2" cannot whitelist "good enough for v1" on the same
# line. When <needle> is empty (regex-class hits with no literal needle, e.g.
# trivializing-defer), only (1) applies, so name those entries precisely.
is_excepted() {
  [[ ${#DISCIPLINE_EXCEPTIONS[@]} -eq 0 ]] && return 1
  local content needle e
  content=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  needle=$(echo "$2" | tr '[:upper:]' '[:lower:]')
  for e in "${DISCIPLINE_EXCEPTIONS[@]}"; do
    [[ "$content" == *"$e"* ]] || continue
    if [[ -z "$needle" || "$e" == *"$needle"* ]]; then
      return 0
    fi
  done
  return 1
}

# Scan text for MVP token hits. Each hit appended to named array as:
#   "<prefix>:<line>:<verbatim>::<token>"
# where <token> is the captured v1/v2/v3 string.
scan_mvp_text() {
  local text="$1"
  local -n out=$2
  local prefix="$3"
  local match line content tok
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    line="${match%%:*}"
    content="${match#*:}"
    # Emit one hit per DISTINCT v-token actually present on the line, each
    # tested against the allowlist independently. A single first-token-only
    # hit would let an allowlisted token (a real external version like "v2")
    # shield a genuine MVP token (e.g. "v1") sharing the same line.
    for tok in v1 v2 v3; do
      echo "$content" | grep -qE "(^|[^A-Za-z0-9])${tok}([^A-Za-z0-9]|\$)" || continue
      is_excepted "$content" "$tok" && continue
      out+=("${prefix}|${line}|${content}|${tok}")
    done
  done < <(echo "$text" | grep -nE "$MVP_TOKEN_REGEX" 2>/dev/null || true)
}

# Scan text for deferral phrase hits + pre-existing dismissal hits.
# Each hit appended to named array as:
#   "<prefix>|<line>|<verbatim>|<phrase>"
scan_deferral_text() {
  local text="$1"
  local -n out=$2
  local prefix="$3"
  local phrase match line content

  for phrase in "${BANNED_PHRASES[@]}"; do
    while IFS= read -r match; do
      [[ -z "$match" ]] && continue
      line="${match%%:*}"
      content="${match#*:}"
      is_excepted "$content" "$phrase" && continue
      out+=("${prefix}|${line}|${content}|${phrase}")
    done < <(echo "$text" | grep -inF "$phrase" 2>/dev/null || true)
  done

  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    if echo "$match" | grep -iqE "$PRE_EXISTING_DISMISSAL_REGEX"; then
      line="${match%%:*}"
      content="${match#*:}"
      is_excepted "$content" "pre-existing" && continue
      out+=("${prefix}|${line}|${content}|pre-existing (dismissal)")
    fi
  done < <(echo "$text" | grep -inF "pre-existing" 2>/dev/null || true)

  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    line="${match%%:*}"
    content="${match#*:}"
    is_excepted "$content" "" && continue
    out+=("${prefix}|${line}|${content}|trivializing-defer")
  done < <(echo "$text" | grep -inE "$TRIVIALIZING_DEFER_REGEX" 2>/dev/null || true)
}

# Scan a .md file for MVP + deferral hits.
scan_md_file_all() {
  local file="$1"
  local -n mvp_out=$2
  local -n def_out=$3
  local prefix="$4"
  local body
  body=$(cat "$file" 2>/dev/null || echo "")
  scan_mvp_text "$body" mvp_out "$prefix"
  scan_deferral_text "$body" def_out "$prefix"
}

# Resolve a follow-up token. Returns 0 if known, 1 if not.
# Expects $REPO_ROOT and the global associative array KNOWN_CHANGE_NAMES.
resolve_followup_token() {
  local raw="$1"
  local t
  t=$(echo "$raw" | sed -E 's/[.,;:`)\]]+$//')
  local stripped
  stripped=$(echo "$t" | sed -E 's/^(.+[a-zA-Z0-9])\.[a-zA-Z0-9]{2,4}$/\1/')

  [[ -n "${KNOWN_CHANGE_NAMES[$t]:-}" ]] && return 0
  [[ -n "${KNOWN_CHANGE_NAMES[$stripped]:-}" ]] && return 0

  local n="$stripped"

  [[ -e "$REPO_ROOT/.agents/skills/$n" || -e "$REPO_ROOT/.agents/skills/$n.md" ]] && return 0

  local root
  local -a roots=("$REPO_ROOT")
  local sub
  while IFS= read -r sub; do
    [[ -n "$sub" ]] && roots+=("$sub")
  done < <(compgen -G "$REPO_ROOT/apps/*" 2>/dev/null)
  while IFS= read -r sub; do
    [[ -n "$sub" ]] && roots+=("$sub")
  done < <(compgen -G "$REPO_ROOT/packages/*" 2>/dev/null)

  local -a parts=()
  local IFS_BAK="$IFS"
  IFS='-' read -r -a parts <<< "$n"
  IFS="$IFS_BAK"

  local r
  for r in "${roots[@]}"; do
    [[ -d "$r/node_modules" ]] || continue
    [[ -e "$r/node_modules/$n" ]] && return 0
    if compgen -G "$r/node_modules/.pnpm/$n@*" >/dev/null 2>&1; then return 0; fi

    if [[ ${#parts[@]} -ge 2 ]]; then
      local i j scope name
      for ((i=1; i<${#parts[@]}; i++)); do
        scope="${parts[0]}"
        for ((j=1; j<i; j++)); do scope="${scope}-${parts[j]}"; done
        name="${parts[i]}"
        for ((j=i+1; j<${#parts[@]}; j++)); do name="${name}-${parts[j]}"; done

        [[ -e "$r/node_modules/@${scope}/${name}" ]] && return 0
        if compgen -G "$r/node_modules/.pnpm/@${scope}+${name}@*" >/dev/null 2>&1; then return 0; fi
      done
    fi
  done

  return 1
}

# Emit the grouped block report.
# Arguments:
#   $1 = mode label ("edit", "response", "archive")
#   $2 = context label (e.g. "your edit to: /path/foo.md")
#   $3 = name of MVP hits array (nameref)
#   $4 = name of deferral hits array (nameref)
#   $5 = name of followup hits array (nameref; may be empty)
emit_block_report() {
  local mode="$1"
  local ctx="$2"
  local -n mvp_hits=$3
  local -n def_hits=$4
  local -n fu_hits=$5
  local total=$((${#mvp_hits[@]} + ${#def_hits[@]} + ${#fu_hits[@]}))

  {
    echo "[discipline-gate / $mode] BLOCK: $total discipline issue(s) in $ctx"
    echo ""
    echo "The text quoted below was identified as potentially violating discipline"
    echo "rules. Read each quote carefully -- this is the exact text the hook sees."
    echo "Some hits may be false positives, but most are real and need rewriting."

    if [[ ${#mvp_hits[@]} -gt 0 ]]; then
      echo ""
      echo "## MVP framing  (${#mvp_hits[@]} hit(s))"
      local hit prefix line content token
      for hit in "${mvp_hits[@]}"; do
        IFS='|' read -r prefix line content token <<< "$hit"
        if [[ -n "$prefix" ]]; then
          echo "  ${prefix}L${line}: ${content}"
        else
          echo "  L${line}: ${content}"
        fi
        echo "          ^ token: \"${token}\""
      done
      echo ""
      echo "  Rule: a single shipped product at a single quality bar. No phasing"
      echo "  of architecture or quality-of-implementation across version labels."
      echo "  External library versions (Tauri 2.x, OAuth 1.0, TanStack 5.x) are"
      echo "  legitimate but only when meta-discussing the third-party project;"
      echo "  the bypass sentinel covers those cases."
    fi

    if [[ ${#def_hits[@]} -gt 0 ]]; then
      echo ""
      echo "## Deferral phrasing  (${#def_hits[@]} hit(s))"
      local hit prefix line content phrase
      for hit in "${def_hits[@]}"; do
        IFS='|' read -r prefix line content phrase <<< "$hit"
        if [[ -n "$prefix" ]]; then
          echo "  ${prefix}L${line}: ${content}"
        else
          echo "  L${line}: ${content}"
        fi
        echo "          ^ phrase: \"${phrase}\""
      done
      echo ""
      echo "  Rule: every deferral must point at a real openspec/changes/<name>/"
      echo "  directory (case 2: propose/apply/sync/archive THIS turn), or be"
      echo "  removed (the concern was not real)."
    fi

    if [[ ${#fu_hits[@]} -gt 0 ]]; then
      echo ""
      echo "## Unresolved follow-up tokens  (${#fu_hits[@]} hit(s))"
      printf '  - %s\n' "${fu_hits[@]}" | sort -u
      echo ""
      echo "  Rule: each token must resolve to an active/archived change, a"
      echo "  project rule, a project skill, or a dependency. To create the"
      echo "  pointed-to change: opsx-new <token>  (proposal-only is fine)."
    fi

    echo ""
    echo "----------------------------------------------------------------------"
    echo "Fix all of the above in one revision. A partial fix will block again"
    echo "on whatever remains -- the hook re-evaluates every check on retry."
    echo ""
    echo "BYPASS SENTINEL  <!-- discipline-bypass -->  IS A LAST RESORT."
    echo "It is acceptable ONLY when BOTH of these hold:"
    echo ""
    echo "  (1) the flagged text is a genuine false positive -- e.g. a literal"
    echo "      external library version reference (\"Tauri 2.x\", \"OAuth 1.0\");"
    echo "      an honest meta-discussion of the rule itself; or a "
    echo "      \"⏳ DEFERRED: {change}\" notification."
    echo ""
    echo "  (2) AND there is no equivalent rephrasing that would clear the"
    echo "      check without changing meaning."
    echo ""
    echo "Before adding the sentinel, state in your response (or commit message"
    echo "for edit-mode invocations):"
    echo "  (a) which specific hit(s) above the sentinel is covering,"
    echo "  (b) why each of those hits is a false positive,"
    echo "  (c) why no rephrasing is possible."
    echo ""
    echo "The sentinel is a ONE-SHOT, not a permanent annotation. After the"
    echo "bypassed action completes, REMOVE the sentinel from the file in your"
    echo "next edit (response-mode bypasses are naturally ephemeral, no removal"
    echo "needed). If the file is written again later, you will need to"
    echo "re-justify and re-add the sentinel -- that friction is intentional."
    echo ""
    echo "Legacy sentinels  <!-- mvp-meta -->  and  <!-- deferral-meta -->  are"
    echo "still honored for backwards-compat with archived files, but new use"
    echo "should use  <!-- discipline-bypass -->  only."
    echo ""
    echo "If you can rephrase any flagged hit, rephrase it. The sentinel is"
    echo "not a shortcut to skip the rephrase."
    echo ""
    echo "----------------------------------------------------------------------"
    echo "PERSISTENT ALLOWLIST -- for a RECURRING false positive, not a one-off."
    echo ""
    echo "If a flagged phrase is one the hook will keep mis-flagging because it"
    echo "is legitimately and DISTINCTLY OUTSIDE what the check guards against"
    echo "-- an external library's real release name (\"Tauri v2\"), a fixed"
    echo "technical idiom -- do not re-bypass it every time. Add it once to:"
    echo ""
    echo "  $EXCEPTIONS_FILE"
    echo ""
    echo "One phrase per line; '#' comments and blank lines are ignored. Make"
    echo "each entry SPECIFIC -- include the surrounding words (\"Tauri v2\", NOT"
    echo "bare \"v2\") so it can only suppress that exact false-positive class and"
    echo "never an unrelated real violation sharing the line. The allowlist is"
    echo "committed and code-reviewed; a bare or over-broad entry is itself a"
    echo "defect. This is NOT for silencing a real violation you'd rather not"
    echo "fix -- if the phrase actually is MVP-framing or a deferral, fix the"
    echo "phrase. The allowlist is only for phrasings the hook should never have"
    echo "considered in scope. For a genuine one-off, use the sentinel above."
  } >&2
}

# Load the persistent allowlist once; every event-specific hook honors it.
load_exceptions
