#!/usr/bin/env node
// openspec-deps.mjs
//
// The single executable definition of the `## Dependencies` grammar.
//
// This module is the ONE source of truth for how cross-change dependencies are
// parsed.
//
// Grammar (three tiers under `## Dependencies`):
//   Required:    structural edges; each MAY carry an anchor `(via `<symbol>`)`.
//   Coherence:   semantic edges; real upstream for ordering, audit-exempt.
//   Downstream:  informational, NOT edges.
// Unlabeled bullets default to Required (preserves the pre-grammar behavior).
//
// Required + Coherence are both upstream edges for ordering + cycle detection.
// Only the audit (a downstream change) treats the tiers differently.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// A change-name token: backtick-wrapped, lowercase start, contains a hyphen,
// alphanumeric+hyphen only. Matches openspec-dependency-gate.sh's historical
// grep so resolution parity holds (`add-foo` matches; `packages/x.ts`,
// `SkillPoint`, `polyphony` do not).
const CHANGE_TOKEN = /`([a-z][a-z0-9]*-[a-z0-9-]+)`/g
// An anchor: `(via `<anything-not-backtick>`)`. Its backticked span is removed
// before token extraction so the anchor is never read as a phantom dependency.
const ANCHOR = /\(via\s+`([^`]+)`\s*\)/g
// A tier label line: the label word, optionally **bold**-wrapped, at line start.
// The optional emphasis is a PAIRED `**`/`__` only -- never a single `*`, which
// is a markdown list marker. This is what keeps a list item like
// `* Coherence note about ...` from being misread as a Coherence label (a single
// `*` no longer matches), while still honoring `**Downstream:**`,
// `Downstream coordination:`, and `Downstream (coordinate with `add-x`):` as
// labels. Matching the historical awk gate, the whole label line is consumed --
// inline tokens on a label line are NOT edges (declare each dep on its own
// bullet under the label).
const LABEL = /^\s*(?:\*\*|__)?\s*(required|coherence|downstream|upstream)\b/i

/**
 * Parse a proposal's `## Dependencies` section.
 * @param {string} text full proposal.md contents
 * @returns {{required: {name:string, anchor:string|null}[],
 *            coherence: {name:string, anchor:string|null}[],
 *            downstreamInfo: string[]}}
 */
export function parseDependencies(text) {
  const lines = text.split(/\r?\n/)
  let inSection = false
  let tier = 'required' // unlabeled bullets default to Required
  const required = []
  const coherence = []
  const downstreamInfo = []

  for (const raw of lines) {
    if (/^##\s+Dependencies\s*$/.test(raw)) {
      inSection = true
      continue
    }
    if (inSection && /^##\s/.test(raw)) break // next top-level section ends it
    if (!inSection) continue

    const labelMatch = raw.match(LABEL)
    if (labelMatch) {
      const word = labelMatch[1].toLowerCase()
      tier =
        word === 'upstream' || word === 'required'
          ? 'required'
          : word === 'coherence'
            ? 'coherence'
            : 'downstream'
      continue
    }

    if (tier === 'downstream') {
      if (raw.trim()) downstreamInfo.push(raw.trim())
      continue
    }

    // Required or Coherence content line. Capture the anchor (if any), then
    // strip its span so its backticks are not extracted as a change token.
    let anchor = null
    const anchorMatch = [...raw.matchAll(ANCHOR)]
    if (anchorMatch.length > 0) anchor = anchorMatch[0][1].trim()
    const stripped = raw.replace(ANCHOR, ' ')

    const names = [...stripped.matchAll(CHANGE_TOKEN)].map((m) => m[1])
    if (names.length === 0) continue

    // ONE edge per bullet: the first (primary) change token, carrying the
    // bullet's anchor. Any further backticked change-shaped tokens on the line
    // are rationale references, NOT edges -- this is the canonical "one upstream
    // per bullet" shape, and taking only the first kills phantom edges from a
    // second backticked token (e.g. `... (via `a`) `add-sneak``).
    const bucket = tier === 'coherence' ? coherence : required
    bucket.push({ name: names[0], anchor })
  }

  return { required, coherence, downstreamInfo }
}

/** Resolve a change name to active dir, backlog dir, or archived `archive/*-<name>`. */
export function resolveChange(changesRoot, name) {
  const activeDir = path.join(changesRoot, name)
  if (fs.existsSync(activeDir) && fs.statSync(activeDir).isDirectory()) {
    return isBacklogChange(changesRoot, name) ? 'backlog' : 'active'
  }
  const archiveDir = path.join(changesRoot, 'archive')
  if (fs.existsSync(archiveDir)) {
    for (const d of fs.readdirSync(archiveDir)) {
      // archive form: YYYY-MM-DD-<name>
      const m = d.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)
      if (m && m[1] === name) return 'archived'
    }
  }
  return null
}

/** A backlog tracker is a filed reminder, not an implementation-order node. */
export function isBacklogProposal(text) {
  const firstContentLine = text.split(/\r?\n/).find((line) => line.trim())
  return Boolean(
    firstContentLine?.trim().match(/^(?:\*\*)?Status:\s*Backlog\b/i),
  )
}

function isBacklogChange(changesRoot, name) {
  const proposal = path.join(changesRoot, name, 'proposal.md')
  return (
    fs.existsSync(proposal) &&
    isBacklogProposal(fs.readFileSync(proposal, 'utf8'))
  )
}

/** List implementation-active change names (dirs under changesRoot, excluding archive/backlog). */
export function listActiveChanges(changesRoot) {
  return fs
    .readdirSync(changesRoot)
    .filter(
      (d) =>
        d !== 'archive' &&
        fs.statSync(path.join(changesRoot, d)).isDirectory() &&
        !isBacklogChange(changesRoot, d),
    )
    .sort()
}

/** List every non-archived change, including backlog proposals. */
export function listOpenChanges(changesRoot) {
  return fs
    .readdirSync(changesRoot)
    .filter(
      (d) =>
        d !== 'archive' && fs.statSync(path.join(changesRoot, d)).isDirectory(),
    )
    .sort()
}

/** Resolve dependency tokens for every open proposal, including backlog work. */
export function collectDanglingDependencies(changesRoot) {
  const dangling = []
  for (const change of listOpenChanges(changesRoot)) {
    const proposal = path.join(changesRoot, change, 'proposal.md')
    if (!fs.existsSync(proposal)) continue
    const { required, coherence } = parseDependencies(
      fs.readFileSync(proposal, 'utf8'),
    )
    for (const { name } of [...required, ...coherence]) {
      if (name === change || resolveChange(changesRoot, name) !== null) continue
      dangling.push({ token: name, change })
    }
  }
  return dangling
}

function buildBacklogBlockState(active, edges) {
  const activeSet = new Set(active)
  const backlogNodes = [
    ...new Set(
      edges
        .filter((edge) => !activeSet.has(edge.from) && activeSet.has(edge.to))
        .map((edge) => edge.from),
    ),
  ].sort()

  const pathsByChange = new Map()
  const queue = []
  for (const edge of edges) {
    if (activeSet.has(edge.from) || !activeSet.has(edge.to)) continue
    const pathToDependent = [edge.from, edge.to]
    queue.push({ root: edge.from, change: edge.to, path: pathToDependent })
    if (!pathsByChange.has(edge.to)) pathsByChange.set(edge.to, [])
    pathsByChange.get(edge.to).push({ from: edge.from, path: pathToDependent })
  }

  while (queue.length > 0) {
    const current = queue.shift()
    for (const edge of edges) {
      if (edge.from !== current.change || !activeSet.has(edge.to)) continue
      const nextPath = [...current.path, edge.to]
      const existing = pathsByChange.get(edge.to) ?? []
      const alreadySeen = existing.some(
        (entry) =>
          entry.from === current.root &&
          entry.path.join('\0') === nextPath.join('\0'),
      )
      if (alreadySeen) continue
      existing.push({ from: current.root, path: nextPath })
      pathsByChange.set(edge.to, existing)
      queue.push({ root: current.root, change: edge.to, path: nextPath })
    }
  }

  const blockedByBacklog = [...pathsByChange.entries()]
    .map(([change, paths]) => {
      const direct = paths
        .filter((entry) => entry.path.length === 2)
        .map((entry) => entry.from)
        .sort()
      return {
        change,
        blockedBy: [...new Set(paths.map((entry) => entry.from))].sort(),
        direct: [...new Set(direct)],
        paths: paths
          .map((entry) => ({ from: entry.from, path: entry.path }))
          .sort(
            (a, b) =>
              a.from.localeCompare(b.from) ||
              a.path.join('/').localeCompare(b.path.join('/')),
          ),
      }
    })
    .sort((a, b) => a.change.localeCompare(b.change))

  return { backlogNodes, blockedByBacklog }
}

/**
 * Build the active-only dependency graph.
 * Edges are blocker(upstream) -> dependent, tier-tagged. Archived upstreams are
 * recorded separately (they have shipped; they clear the edge).
 */
export function buildChangeGraph(changesRoot) {
  const active = listActiveChanges(changesRoot)
  const activeSet = new Set(active)
  const edges = [] // {from, to, tier, anchor}
  const archivedEdges = [] // {from, to, tier}  (upstream already shipped)
  const dangling = collectDanglingDependencies(changesRoot)

  for (const change of active) {
    const proposal = path.join(changesRoot, change, 'proposal.md')
    if (!fs.existsSync(proposal)) continue
    const { required, coherence } = parseDependencies(
      fs.readFileSync(proposal, 'utf8'),
    )
    for (const tierName of ['required', 'coherence']) {
      const list = tierName === 'required' ? required : coherence
      for (const { name, anchor } of list) {
        if (name === change) continue // self-reference is a no-op
        const res = resolveChange(changesRoot, name)
        if (res === 'active' && activeSet.has(name)) {
          edges.push({
            from: name,
            to: change,
            tier: tierName,
            anchor: anchor || null,
          })
        } else if (res === 'backlog') {
          edges.push({
            from: name,
            to: change,
            tier: tierName,
            anchor: anchor || null,
          })
        } else if (res === 'archived')
          archivedEdges.push({
            from: name,
            to: change,
            tier: tierName,
            anchor: anchor || null,
          })
        else if (!dangling.some((d) => d.token === name && d.change === change))
          dangling.push({ token: name, change })
      }
    }
  }

  // Cycle detection via Kahn over the active edge set.
  const indeg = new Map(active.map((n) => [n, 0]))
  const adj = new Map(active.map((n) => [n, []]))
  for (const e of edges) {
    if (activeSet.has(e.from) && activeSet.has(e.to)) {
      adj.get(e.from).push(e.to)
      indeg.set(e.to, indeg.get(e.to) + 1)
    }
  }
  const queue = active.filter((n) => indeg.get(n) === 0)
  let seen = 0
  while (queue.length) {
    const n = queue.shift()
    seen += 1
    for (const m of adj.get(n)) {
      indeg.set(m, indeg.get(m) - 1)
      if (indeg.get(m) === 0) queue.push(m)
    }
  }
  const acyclic = seen === active.length
  const cycles = acyclic ? [] : active.filter((n) => indeg.get(n) > 0)

  const { backlogNodes, blockedByBacklog } = buildBacklogBlockState(
    active,
    edges,
  )

  return {
    nodes: active,
    edges,
    archivedEdges,
    dangling,
    acyclic,
    cycles,
    backlogNodes,
    blockedByBacklog,
  }
}

/**
 * Fail-fast graph health check shared by ordering and orchestration callers.
 * The graph builder retains raw dangling records for diagnostics; consumers
 * must not act on that graph as if it were executable ordering data.
 */
export function assertResolvedDependencies(graph) {
  if (graph.dangling.length === 0) return graph
  const first = graph.dangling[0]
  throw new Error(
    `MISSING DEPENDENCY! \`${first.change}\` depends on \`${first.token}\` ` +
      'which does not exist in ./openspec/changes or ./openspec/changes/archive',
  )
}

// ---- Audit (advisory) ------------------------------------------------------
//
// `--audit` keeps the grounded graph HONEST without ever blocking. Three jobs,
// all deterministic (no model inference -- the program's founding finding was
// that whole-graph re-derivation guesses at ~50-70% recall, the wrong
// instrument). See add-dependency-graph-audit/design.md.

// Symbols too generic to anchor discovery on -- a substring hit would be noise.
const DISCOVERY_STOP = new Set([
  'proposal',
  'tasks',
  'index',
  'schema',
  'config',
  'types',
  'utils',
  'context',
  'state',
  'model',
  'event',
  'events',
  'runtime',
  'spec',
  'specs',
  'fact',
  'facts',
])

/** Resolve a change name to its directory (active or archived), or null. */
export function changeDir(changesRoot, name) {
  const active = path.join(changesRoot, name)
  if (fs.existsSync(active) && fs.statSync(active).isDirectory()) return active
  const archiveDir = path.join(changesRoot, 'archive')
  if (fs.existsSync(archiveDir)) {
    for (const d of fs.readdirSync(archiveDir)) {
      const m = d.match(/^\d{4}-\d{2}-\d{2}-(.+)$/)
      if (m && m[1] === name) return path.join(archiveDir, d)
    }
  }
  return null
}

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function walkMd(dir) {
  let out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name)
    if (e.isDirectory()) out = out.concat(walkMd(fp))
    else if (e.name.endsWith('.md')) out.push(fp)
  }
  return out
}

/** A change's readable artifact surface: proposal + tasks + all delta specs. */
export function changeSurface(changesRoot, name, cache = new Map()) {
  if (cache.has(name)) return cache.get(name)
  const dir = changeDir(changesRoot, name)
  let text = ''
  if (dir) {
    text += readIfExists(path.join(dir, 'proposal.md')) + '\n'
    text += readIfExists(path.join(dir, 'tasks.md')) + '\n'
    for (const f of walkMd(path.join(dir, 'specs')))
      text += readIfExists(f) + '\n'
  }
  cache.set(name, text)
  return text
}

/**
 * Searchable tokens from an anchor string. The leading symbol (up to the first
 * space / '(' / '{') plus any path-like (`a/b`) token. `nowUtcMs() (packages/.../x.ts)`
 * -> [`nowUtcMs`, `packages/.../x.ts`]; `IAudioEngine.playMidiSequence` -> itself.
 */
export function symbolTails(anchor) {
  if (!anchor) return []
  const tails = new Set()
  // 1. path-like tokens (contain a slash) -- kept whole.
  for (const tok of anchor.split(/\s+/)) {
    const t = tok.replace(/[`(),]/g, '')
    if (t.includes('/')) tails.add(t)
  }
  // 2. identifier tokens from the anchor with paths, `{...}` cruft, and quoted
  //    strings removed. A dotted member (`Foo.bar`) also contributes `Foo` and
  //    `bar` so a producer that exposes the interface or the method (but not the
  //    literal dotted string) still verifies.
  const cleaned = anchor
    .replace(/\S*\/\S*/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/'[^']*'|"[^"]*"/g, ' ')
  // Whole tokens kept intact (so hyphenated/dotted identifiers like `scope-chain`
  // and `llm.director` survive as distinctive keys, not just their fragments).
  for (const tok of cleaned.split(/\s+/)) {
    const w = tok.replace(/[`(),:]/g, '').replace(/\.$/, '')
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(w)) tails.add(w)
  }
  // Plus split components (so a producer exposing the interface or method of a
  // dotted member still verifies leniently).
  for (const m of cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9_]/g)) {
    const id = m[0].replace(/\.$/, '')
    if (id) tails.add(id)
    if (id.includes('.')) for (const p of id.split('.')) if (p) tails.add(p)
  }
  return [...tails].filter(
    (t) => t.length >= 4 && !DISCOVERY_STOP.has(t.toLowerCase()),
  )
}

/**
 * A tail distinctive enough to seed undeclared-edge discovery: a path, a
 * dotted/snake/kebab identifier, or CamelCase. A bare lowercase common word
 * (`scope`, `director`, `session`) is too generic -- it stays usable for
 * verification but is never a discovery key.
 */
export function isDistinctiveTail(t) {
  return (
    t.includes('/') ||
    t.includes('.') ||
    t.includes('_') ||
    t.includes('-') ||
    /[A-Z]/.test(t)
  )
}

/** Does a symbol/path appear in the live, tracked codebase? */
function symbolInLiveCode(tail, repoRoot) {
  if (tail.includes('/')) return fs.existsSync(path.join(repoRoot, tail))
  try {
    execFileSync('git', ['grep', '-lF', '--', tail], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    return true // exit 0 -> at least one match
  } catch {
    return false
  } // exit 1 -> no match (or non-git env)
}

/** Commit count touching a file (a cheap age proxy); null outside git. */
function gitAge(filePath, repoRoot) {
  if (!filePath || !fs.existsSync(filePath)) return null
  try {
    const out = execFileSync('git', ['log', '--oneline', '--', filePath], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
      .toString()
      .trim()
    return out ? out.split('\n').length : 0
  } catch {
    return null
  }
}

const inSurface = (tails, surface) => tails.some((t) => surface.includes(t))

/**
 * A change's surface with its own `## Dependencies` section removed. Used when
 * asking "does the DEPENDENT substantively reference symbol X" -- the anchor
 * `(via X)` lives in that section, so leaving it in would make every consumer
 * trivially "reference" its own anchor (and mask VESTIGIAL / inflate discovery).
 */
function stripDepsSection(text) {
  const out = []
  let inDeps = false
  for (const l of text.split(/\r?\n/)) {
    if (/^##\s+Dependencies\s*$/.test(l)) {
      inDeps = true
      continue
    }
    if (inDeps && /^##\s/.test(l)) inDeps = false
    if (!inDeps) out.push(l)
  }
  return out.join('\n')
}

/**
 * Deterministic dependency audit. Returns a findings object; never throws on
 * graph content, always advisory.
 */
export function auditGraph(changesRoot) {
  const repoRoot = path.resolve(changesRoot, '..', '..')
  const graph = buildChangeGraph(changesRoot)
  const dangling = collectDanglingDependencies(changesRoot)
  const cache = new Map()
  const surf = (name) => changeSurface(changesRoot, name, cache)
  const allEdges = [...graph.edges, ...graph.archivedEdges]

  // Job 1: anchor-truth verification (Required edges only). We classify only on
  // what is deterministically knowable: does the upstream produce the anchored
  // symbol? "Does the dependent still NEED it" is NOT grep-determinable (a valid
  // edge rarely repeats the symbol outside its own anchor), so there is no
  // VESTIGIAL bucket -- that would be a guess, the instrument we rejected.
  const backlogBlockedChanges = new Map(
    graph.blockedByBacklog.map((entry) => [entry.change, entry.blockedBy]),
  )
  const backlogNodes = new Set(graph.backlogNodes)
  const anchorDrift = [],
    pending = [],
    backlogPending = [],
    pass = [],
    unverifiable = []
  for (const e of allEdges) {
    if (e.tier !== 'required') continue
    const tails = symbolTails(e.anchor)
    if (tails.length === 0) {
      unverifiable.push({ from: e.from, to: e.to, anchor: e.anchor })
      continue
    }
    const archived = resolveChange(changesRoot, e.from) === 'archived'
    const producerHas =
      inSurface(tails, surf(e.from)) ||
      (archived && tails.some((t) => symbolInLiveCode(t, repoRoot)))
    const rec = { from: e.from, to: e.to, anchor: e.anchor, tails }
    if (!producerHas) anchorDrift.push(rec)
    else if (
      !archived &&
      (backlogNodes.has(e.from) || backlogBlockedChanges.has(e.to))
    ) {
      backlogPending.push({
        ...rec,
        blockedBy: [
          ...new Set([
            ...(backlogNodes.has(e.from) ? [e.from] : []),
            ...(backlogBlockedChanges.get(e.to) ?? []),
          ]),
        ].sort(),
      })
    } else if (!archived)
      pending.push(rec) // upstream chartered but unlanded -- edge stands
    else pass.push(rec)
  }

  // Job 2: coherence reconfirmation.
  const reconfirm = allEdges
    .filter((e) => e.tier === 'coherence')
    .map((e) => ({
      from: e.from,
      to: e.to,
      age: gitAge(
        path.join(changeDir(changesRoot, e.to) || '', 'proposal.md'),
        repoRoot,
      ),
    }))

  // Job 3: deterministic undeclared-edge discovery via a symbol index.
  const index = new Map() // tail -> Set(producer change)
  for (const e of allEdges) {
    if (e.tier !== 'required') continue
    for (const t of symbolTails(e.anchor)) {
      if (!isDistinctiveTail(t)) continue // generic words are not discovery keys
      if (!index.has(t)) index.set(t, new Set())
      index.get(t).add(e.from)
    }
  }
  const declared = new Set(allEdges.map((e) => `${e.to} ${e.from}`))
  const undeclaredCandidates = []
  const seen = new Set()
  for (const B of graph.nodes) {
    const surface = stripDepsSection(surf(B))
    for (const [tail, producers] of index) {
      if (producers.size !== 1) continue // ambiguous symbol -> skip
      const A = [...producers][0]
      if (A === B || declared.has(`${B} ${A}`)) continue
      if (!surface.includes(tail)) continue
      const key = `${B} ${A}`
      if (seen.has(key)) continue
      seen.add(key)
      undeclaredCandidates.push({
        dependent: B,
        candidateUpstream: A,
        viaSymbol: tail,
      })
    }
  }

  return {
    anchorDrift,
    pending,
    backlogPending,
    pass,
    unverifiable,
    reconfirm,
    undeclaredCandidates,
    dangling,
    counts: {
      anchorDrift: anchorDrift.length,
      pending: pending.length,
      backlogPending: backlogPending.length,
      pass: pass.length,
      unverifiable: unverifiable.length,
      reconfirm: reconfirm.length,
      undeclaredCandidates: undeclaredCandidates.length,
    },
    coverageNote:
      'Discovery is deterministic: it sees only symbols that at least one declared Required ' +
      'anchor already names. A produced symbol no edge anchors on is invisible to discovery (by ' +
      'design -- high precision over inferential recall).',
  }
}

// ---- CLI -------------------------------------------------------------------

function changesRootFromProposal(proposalPath) {
  // <root>/openspec/changes/<name>/proposal.md  ->  <root>/openspec/changes
  return path.resolve(path.dirname(proposalPath), '..')
}

function defaultChangesRoot() {
  const root = process.env.CODEX_PROJECT_DIR || process.cwd()
  return path.join(root, 'openspec', 'changes')
}

function cmdValidate(proposalPath) {
  if (!fs.existsSync(proposalPath)) return 0 // edit may have failed; nothing to check
  const changesRoot = changesRootFromProposal(proposalPath)
  const selfName = path.basename(path.dirname(proposalPath))
  const { required, coherence } = parseDependencies(
    fs.readFileSync(proposalPath, 'utf8'),
  )
  const all = [...required, ...coherence].filter((e) => e.name !== selfName)

  const unresolved = [
    ...new Set(
      all
        .filter((e) => resolveChange(changesRoot, e.name) === null)
        .map((e) => e.name),
    ),
  ]
  const missingAnchors = required
    .filter((e) => e.name !== selfName && !e.anchor)
    .map((e) => e.name)
  const mode = (
    process.env.OPENSPEC_DEPS_ANCHOR_ENFORCE || 'block'
  ).toLowerCase()

  if (unresolved.length > 0) {
    blockedUnresolved(selfName, unresolved)
    return 2
  }
  if (mode === 'block' && missingAnchors.length > 0) {
    blockedMissingAnchor(selfName, missingAnchors)
    return 2
  }
  if (mode !== 'block' && missingAnchors.length > 0) {
    process.stderr.write(
      `\nNOTE: openspec dependency gate -- Required edge(s) without a (via \`anchor\`) in ` +
        `openspec/changes/${selfName}/proposal.md:\n` +
        missingAnchors.map((n) => `    - ${n}`).join('\n') +
        `\nAnchors make edges auditable. Enforcement defaults to 'block'; this NOTE means you ran with OPENSPEC_DEPS_ANCHOR_ENFORCE=warn (the opt-in migration window).\n\n`,
    )
  }
  return 0
}

function blockedUnresolved(selfName, unresolved) {
  process.stderr.write(
    [
      '',
      'BLOCKED: openspec dependency gate -- unresolved upstream dependency',
      '',
      `  proposal: openspec/changes/${selfName}/proposal.md`,
      '',
      "These upstream deps under '## Dependencies' do not resolve to any",
      'implementation-active or archived change folder:',
      '',
      ...unresolved.map((u) => `    - ${u}`),
      '',
      'Each is either a typo, a backlog tracker, or a producer that does not exist yet.',
      '  - Typo: fix the name to match the real change folder.',
      '  - Backlog tracker: promote it before declaring an ordering edge.',
      "  - Missing producer: file '<name>' as its own change FIRST",
      '    (producer-gap discipline -- AGENTS.md), then keep the dep.',
      "  - Not a change reference: don't backtick it; '## Dependencies'",
      '    bullets are reserved for change-to-change edges.',
      '',
      "Source of truth: each proposal's '## Dependencies' (upstream only).",
      'Live ordering view: /opsxext:order   Advance one change: /opsxext:advance',
      'Format spec: .agents/references/openspec/cross-change-dependencies.md',
      '',
    ].join('\n') + '\n',
  )
}

function blockedMissingAnchor(selfName, names) {
  process.stderr.write(
    [
      '',
      'BLOCKED: openspec dependency gate -- Required edge missing a (via `anchor`)',
      '',
      `  proposal: openspec/changes/${selfName}/proposal.md`,
      '',
      'These Required edges have no anchor; enforcement is in block mode:',
      '',
      ...names.map((n) => `    - ${n}`),
      '',
      'Add the symbol/file/contract that justifies each edge, e.g.',
      '    - `add-foo` (via `IAudioEngine.playMidiSequence`) -- why',
      'or move it under a `Coherence:` label if it is a semantic-only coupling.',
      '',
    ].join('\n') + '\n',
  )
}

function cmdGraph() {
  const changesRoot = defaultChangesRoot()
  if (!fs.existsSync(changesRoot)) {
    process.stderr.write(
      `openspec-deps: no changes directory at ${changesRoot} ` +
        `(run from the repo root, or set CODEX_PROJECT_DIR)\n`,
    )
    return 1
  }
  const graph = assertResolvedDependencies(buildChangeGraph(changesRoot))
  process.stdout.write(JSON.stringify(graph, null, 2) + '\n')
  return 0
}

function cmdAudit(jsonMode) {
  const changesRoot = defaultChangesRoot()
  if (!fs.existsSync(changesRoot)) {
    process.stderr.write(
      `openspec-deps: no changes directory at ${changesRoot} ` +
        `(run from the repo root, or set CODEX_PROJECT_DIR)\n`,
    )
    return 1
  }
  const a = auditGraph(changesRoot)
  if (jsonMode) {
    process.stdout.write(JSON.stringify(a, null, 2) + '\n')
    return 0 // advisory: always 0
  }
  const L = []
  const c = a.counts
  L.push('# Dependency-graph audit (advisory -- exit 0 always)')
  L.push('')

  if (a.dangling.length) {
    L.push('## MISSING DEPENDENCY -- graph resolution is incomplete')
    for (const d of a.dangling)
      L.push(
        `  - \`${d.change}\` depends on \`${d.token}\` which does not exist in ./openspec/changes or ./openspec/changes/archive`,
      )
    L.push('')
  }
  L.push(
    `Required edges: PASS ${c.pass} | PENDING ${c.pending} (unlanded upstream, edge stands) | ` +
      `BACKLOG_BLOCKED ${c.backlogPending} | ` +
      `DRIFT ${c.anchorDrift} | UNVERIFIABLE ${c.unverifiable}`,
  )
  L.push('')

  if (a.anchorDrift.length) {
    L.push(
      '## ANCHOR_DRIFT -- upstream does not produce the anchored symbol (act on these)',
    )
    for (const e of a.anchorDrift)
      L.push(
        `  - ${e.to}  <- ${e.from}  (via \`${e.anchor}\`)  [searched: ${e.tails.join(', ')}]`,
      )
    L.push('')
  }
  if (a.unverifiable.length) {
    L.push('## UNVERIFIABLE -- Required edge with no usable anchor symbol')
    for (const e of a.unverifiable)
      L.push(`  - ${e.to}  <- ${e.from}  (anchor: ${e.anchor ?? 'none'})`)
    L.push('')
  }
  if (a.backlogPending.length) {
    L.push(
      '## BACKLOG_BLOCKED -- Required edge is valid but blocked by backlog status',
    )
    for (const e of a.backlogPending) {
      L.push(
        `  - ${e.to}  <- ${e.from}  (via \`${e.anchor}\`; blocked by ${e.blockedBy.join(', ')})`,
      )
    }
    L.push('')
  }
  if (a.undeclaredCandidates.length) {
    L.push(
      '## UNDECLARED_CANDIDATE -- dependent references a known-produced symbol but declares no edge (triage)',
    )
    for (const u of a.undeclaredCandidates)
      L.push(
        `  - ${u.dependent}  -> ${u.candidateUpstream}  (mentions \`${u.viaSymbol}\`)`,
      )
    L.push('')
  }
  if (a.reconfirm.length) {
    L.push(
      '## RECONFIRM -- Coherence edges (not grep-verifiable; re-affirm or retire)',
    )
    for (const e of a.reconfirm)
      L.push(`  - ${e.to}  <- ${e.from}  (age: ${e.age ?? 'n/a'} commits)`)
    L.push('')
  }
  if (
    !a.dangling.length &&
    !a.anchorDrift.length &&
    !a.unverifiable.length &&
    !a.undeclaredCandidates.length
  ) {
    L.push(
      'No drift, unverifiable, or undeclared-candidate findings. Graph is honest.',
    )
    L.push('')
  }
  L.push(`Coverage: ${a.coverageNote}`)
  process.stdout.write(L.join('\n') + '\n')
  return 0
}

function main(argv) {
  const [cmd, arg] = argv
  if (cmd === '--validate') {
    if (!arg) {
      process.stderr.write(
        'usage: openspec-deps.mjs --validate <proposalPath>\n',
      )
      return 2
    }
    return cmdValidate(arg)
  }
  if (cmd === '--graph') return cmdGraph()
  if (cmd === '--audit') return cmdAudit(argv.includes('--json'))
  process.stderr.write(
    'usage: openspec-deps.mjs --validate <proposalPath> | --graph | --audit [--json]\n',
  )
  return 2
}

// Run as CLI only when invoked directly (importable as a library otherwise).
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)))
}
