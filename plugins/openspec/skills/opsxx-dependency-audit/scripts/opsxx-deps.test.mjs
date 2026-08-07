// Tests for the skill-owned opsxx-deps.mjs -- run with `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import {
  parseDependencies,
  resolveChange,
  buildChangeGraph,
  assertResolvedDependencies,
  collectDanglingDependencies,
  auditGraph,
  isBacklogProposal,
  symbolTails,
  isDistinctiveTail,
} from './opsxx-deps.mjs'

// Scaffold a changes-root where audit's repoRoot (root/../..) is a non-git temp
// dir, so live-code grep deterministically returns false and producer
// verification depends only on artifact surface (what the test controls).
function auditFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-audit-'))
  const root = path.join(repo, 'openspec', 'changes')
  fs.mkdirSync(root, { recursive: true })
  const active = (name, body) => {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'proposal.md'), body)
  }
  const archived = (name, body) => {
    const d = path.join(root, 'archive', `2026-01-01-${name}`)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'proposal.md'), body)
  }
  return { repo, root, active, archived }
}
const reqDeps = (...bullets) =>
  `# Proposal\n\n## Dependencies\n\nRequired:\n${bullets.join('\n')}\n`

const SCRIPT = fileURLToPath(new URL('./opsxx-deps.mjs', import.meta.url))

// Run `--validate <proposal>` as a subprocess (the real CLI surface, so the
// enforcement-mode default is exercised exactly as the gate hook sees it).
// Returns the exit code; execFileSync throws on non-zero, where err.status is it.
function runValidate(proposalPath, env = {}) {
  try {
    execFileSync('node', [SCRIPT, '--validate', proposalPath], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    })
    return 0
  } catch (err) {
    return err.status
  }
}

function deps(body) {
  return `# Proposal\n\n## Dependencies\n\n${body}\n\n## Status\n\nok\n`
}

test('2.1 anchor is captured and never double-counted as a dependency', () => {
  const { required } = parseDependencies(
    deps(
      '- `add-foo` (via `PracticeExperience.prepare`) -- the impl is a stub',
    ),
  )
  assert.equal(required.length, 1)
  assert.equal(required[0].name, 'add-foo')
  assert.equal(required[0].anchor, 'PracticeExperience.prepare')
})

test('2.1 anchor with dots/slashes/uppercase is accepted, not treated as a change', () => {
  const { required } = parseDependencies(
    deps('- `add-bar` (via `packages/bridge/src/Spatial.ts`) -- structural'),
  )
  assert.equal(required.length, 1)
  assert.equal(required[0].name, 'add-bar')
  assert.equal(required[0].anchor, 'packages/bridge/src/Spatial.ts')
})

test('2.1 a Required edge without an anchor parses with anchor null', () => {
  const { required } = parseDependencies(deps('- `add-baz` -- no anchor yet'))
  assert.equal(required.length, 1)
  assert.equal(required[0].anchor, null)
})

test('2.2 unlabeled defaults to required; Coherence is an edge; Downstream excluded', () => {
  const { required, coherence, downstreamInfo } = parseDependencies(
    deps(
      '- `add-unlabeled` -- defaults to required\n\n' +
        'Coherence:\n' +
        '- `add-soft` -- prompt-context coupling\n\n' +
        'Downstream:\n' +
        '- `add-consumer` -- informational',
    ),
  )
  assert.deepEqual(
    required.map((e) => e.name),
    ['add-unlabeled'],
  )
  assert.deepEqual(
    coherence.map((e) => e.name),
    ['add-soft'],
  )
  assert.equal(
    required.some((e) => e.name === 'add-consumer'),
    false,
  )
  assert.equal(
    coherence.some((e) => e.name === 'add-consumer'),
    false,
  )
  assert.equal(downstreamInfo.length, 1)
})

test('2.2 explicit Required: and Upstream: labels both map to required', () => {
  const { required } = parseDependencies(
    deps('Required:\n- `add-one` -- x\n\nUpstream:\n- `add-two` -- y'),
  )
  assert.deepEqual(required.map((e) => e.name).sort(), ['add-one', 'add-two'])
})

test('2.2 bold **Downstream:** and a non-pure label line (Downstream coordination:) both work', () => {
  const { required, downstreamInfo } = parseDependencies(
    deps(
      '- `add-keep` -- required edge\n\n' +
        'Downstream coordination:\n' + // prefix-label, not pure -- must still mean downstream
        '- `add-coord` -- informational\n\n' +
        '**Downstream:**\n' +
        '- `add-bold` -- informational',
    ),
  )
  assert.deepEqual(
    required.map((e) => e.name),
    ['add-keep'],
  )
  assert.equal(
    required.some((e) => e.name === 'add-coord' || e.name === 'add-bold'),
    false,
  )
  assert.equal(downstreamInfo.length, 2)
})

test('2.2 an asterisk list item starting with a label word is content, NOT a tier label', () => {
  // Regression: `*` is a list marker, not bold. A bullet whose text begins with
  // "Coherence" must not be swallowed as a Coherence label and lose its edge.
  const { required, coherence } = parseDependencies(
    deps('* Coherence-style note about `add-foo` -- still a real edge'),
  )
  assert.deepEqual(
    required.map((e) => e.name),
    ['add-foo'],
  )
  assert.equal(coherence.length, 0)
})

test('2.1 a second backticked token after the anchor is NOT a phantom edge', () => {
  // Only the first (primary) change token per bullet is an edge.
  const { required } = parseDependencies(
    deps(
      '- `add-foo` (via `a`) `add-sneak` -- rationale mentions another change',
    ),
  )
  assert.equal(required.length, 1)
  assert.equal(required[0].name, 'add-foo')
  assert.equal(required[0].anchor, 'a')
})

test('2.1 a malformed via-clause (no backticks) yields no anchor and no phantom', () => {
  const { required } = parseDependencies(
    deps('- `add-foo` (via something) -- loose prose'),
  )
  assert.equal(required.length, 1)
  assert.equal(required[0].name, 'add-foo')
  assert.equal(required[0].anchor, null)
})

test('2.3 resolution: active resolves, archived `*-<name>` resolves, unknown is null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  fs.mkdirSync(path.join(root, 'add-active'))
  fs.mkdirSync(path.join(root, 'archive', '2026-01-02-add-shipped'), {
    recursive: true,
  })
  assert.equal(resolveChange(root, 'add-active'), 'active')
  assert.equal(resolveChange(root, 'add-shipped'), 'archived')
  assert.equal(resolveChange(root, 'add-missing'), null)
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.3 buildChangeGraph: edges, archived-cleared, dangling, and cycle detection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const mk = (name, body) => {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'proposal.md'), deps(body))
  }
  fs.mkdirSync(path.join(root, 'archive', '2026-01-01-add-base'), {
    recursive: true,
  })
  mk('add-foundation', '- `add-base` -- already shipped (archived)')
  mk('add-feature', '- `add-foundation` (via `scripts/x.mjs`) -- needs it')
  mk('add-loose', '- `add-ghost` -- producer does not exist')

  const g = buildChangeGraph(root)
  assert.equal(g.acyclic, true)
  assert.ok(
    g.edges.some((e) => e.from === 'add-foundation' && e.to === 'add-feature'),
  )
  assert.ok(
    g.archivedEdges.some(
      (e) => e.from === 'add-base' && e.to === 'add-foundation',
    ),
  )
  assert.ok(g.dangling.some((d) => d.token === 'add-ghost'))

  // Introduce a 2-node cycle.
  fs.writeFileSync(
    path.join(root, 'add-foundation', 'proposal.md'),
    deps('- `add-feature` -- circular'),
  )
  const g2 = buildChangeGraph(root)
  assert.equal(g2.acyclic, false)
  assert.ok(
    g2.cycles.includes('add-feature') && g2.cycles.includes('add-foundation'),
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.5 anchor enforcement: block is the default; warn downgrades; anchored passes', () => {
  // Regression for add-dependency-edge-anchor-backfill: once the tree is
  // anchored the gate defaults to BLOCK -- a new Required edge without a
  // (via `anchor`) is rejected at write time, and `warn` is the opt-in window.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  fs.mkdirSync(path.join(root, 'add-upstream'), { recursive: true }) // resolvable active change
  const depDir = path.join(root, 'add-dependent')
  fs.mkdirSync(depDir, { recursive: true })
  const proposal = path.join(depDir, 'proposal.md')

  // Un-anchored Required edge.
  fs.writeFileSync(proposal, deps('- `add-upstream` -- no anchor on purpose'))
  assert.equal(
    runValidate(proposal),
    2,
    'block (default) rejects a missing anchor',
  )
  assert.equal(
    runValidate(proposal, { OPENSPEC_DEPS_ANCHOR_ENFORCE: 'warn' }),
    0,
    'warn downgrades a missing anchor to exit 0',
  )

  // Anchored edge passes at the block default.
  fs.writeFileSync(
    proposal,
    deps('- `add-upstream` (via `scripts/x.mjs`) -- now grounded'),
  )
  assert.equal(
    runValidate(proposal),
    0,
    'anchored Required edge passes at block default',
  )

  // An unresolved change-name still blocks regardless of anchor mode.
  fs.writeFileSync(
    proposal,
    deps('- `add-ghost` (via `x`) -- producer does not exist'),
  )
  assert.equal(runValidate(proposal), 2, 'unresolved upstream blocks')
  assert.equal(
    runValidate(proposal, { OPENSPEC_DEPS_ANCHOR_ENFORCE: 'warn' }),
    2,
    'unresolved upstream blocks even in warn mode (it is a syntactic fault, not an anchor gap)',
  )

  fs.rmSync(root, { recursive: true, force: true })
})

test('3.1 symbolTails: dotted/parenthetical anchors yield interface + method + path; distinctiveness', () => {
  const t1 = symbolTails('ICloudSyncAdapter.listArtifacts')
  assert.ok(
    t1.includes('ICloudSyncAdapter') &&
      t1.includes('listArtifacts') &&
      t1.includes('ICloudSyncAdapter.listArtifacts'),
  )
  const t2 = symbolTails('nowUtcMs() (packages/learning/src/time.ts)')
  assert.ok(
    t2.includes('nowUtcMs') && t2.includes('packages/learning/src/time.ts'),
  )
  const t3 = symbolTails('bend_gesture fact (BendGestureRecognizer)')
  assert.ok(t3.includes('bend_gesture') && t3.includes('BendGestureRecognizer'))
  assert.equal(t3.includes('fact'), false, '`fact` is a stop word, dropped')
  // distinctiveness: CamelCase / _ / . / - / path are discovery keys; bare words are not.
  assert.equal(isDistinctiveTail('ICloudSyncAdapter'), true)
  assert.equal(isDistinctiveTail('scope-chain'), true)
  assert.equal(isDistinctiveTail('director'), false)
})

test('3.2 audit classifies edges as ANCHOR_DRIFT / PENDING / PASS (deterministic, no VESTIGIAL)', () => {
  const fx = auditFixture()
  fx.active(
    'add-consumer',
    reqDeps(
      '- `add-prod-active` (via `FooSymbol`) -- a',
      '- `add-prod-pass` (via `BarSymbol`) -- b',
      '- `add-prod-drift` (via `GhostSymbol`) -- c',
    ),
  )
  fx.active(
    'add-prod-active',
    '# Proposal\n\n## What Changes\n\nIntroduces FooSymbol.\n',
  )
  fx.archived(
    'add-prod-pass',
    '# Proposal\n\n## What Changes\n\nShipped BarSymbol.\n',
  )
  fx.archived(
    'add-prod-drift',
    '# Proposal\n\n## What Changes\n\nUnrelated content.\n',
  )

  const a = auditGraph(fx.root)
  assert.deepEqual(
    a.anchorDrift.map((e) => e.from),
    ['add-prod-drift'],
  )
  assert.equal(
    a.pending.some((e) => e.from === 'add-prod-active'),
    true,
  )
  assert.equal(
    a.pass.some((e) => e.from === 'add-prod-pass'),
    true,
  )
  assert.equal('vestigial' in a, false, 'no VESTIGIAL bucket exists')
  fs.rmSync(fx.repo, { recursive: true, force: true })
})

test('3.3 audit discovery: fires on undeclared producer-symbol mention; suppresses ambiguous + existing-edge', () => {
  const fx = auditFixture()
  // WidgetThing has a single producer (add-producer), seeded via add-declarer's anchor.
  fx.active(
    'add-producer',
    '# Proposal\n\n## What Changes\n\nProduces things.\n',
  )
  fx.active(
    'add-declarer',
    reqDeps('- `add-producer` (via `WidgetThing`) -- x'),
  )
  // Mentions WidgetThing in body, declares no edge -> CANDIDATE.
  fx.active(
    'add-mentioner',
    '# Proposal\n\n## What Changes\n\nWe consume WidgetThing here.\n',
  )
  // Mentions WidgetThing AND declares the edge -> SUPPRESSED.
  fx.active(
    'add-hasedge',
    '# Proposal\n\n## What Changes\n\nUses WidgetThing.\n\n## Dependencies\n\nRequired:\n- `add-producer` (via `WidgetThing`) -- x\n',
  )
  // SharedThing has TWO producers -> ambiguous, never a discovery key.
  fx.active('add-prodA', '# Proposal\n\n## What Changes\n\nA.\n')
  fx.active('add-prodB', '# Proposal\n\n## What Changes\n\nB.\n')
  fx.active('add-declA', reqDeps('- `add-prodA` (via `SharedThing`) -- x'))
  fx.active('add-declB', reqDeps('- `add-prodB` (via `SharedThing`) -- x'))
  fx.active(
    'add-ambmention',
    '# Proposal\n\n## What Changes\n\nWe touch SharedThing here.\n',
  )

  const a = auditGraph(fx.root)
  const has = (dep, up) =>
    a.undeclaredCandidates.some(
      (u) => u.dependent === dep && u.candidateUpstream === up,
    )
  assert.equal(
    has('add-mentioner', 'add-producer'),
    true,
    'fires on undeclared mention',
  )
  assert.equal(
    has('add-hasedge', 'add-producer'),
    false,
    'suppressed: edge already declared',
  )
  assert.equal(
    a.undeclaredCandidates.some((u) => u.viaSymbol === 'SharedThing'),
    false,
    'ambiguous symbol (2 producers) is never a discovery key',
  )
  fs.rmSync(fx.repo, { recursive: true, force: true })
})

test('3.4 audit always exits 0 (advisory) via the CLI', () => {
  const fx = auditFixture()
  fx.active('add-x', reqDeps('- `add-y` (via `Zzzz`) -- drift on purpose'))
  fx.active('add-y', '# Proposal\n\n## What Changes\n\nNo such symbol here.\n')
  // cmdAudit reads CODEX_PROJECT_DIR/openspec/changes.
  let code
  try {
    execFileSync('node', [SCRIPT, '--audit'], {
      env: { ...process.env, CODEX_PROJECT_DIR: fx.repo },
      stdio: 'pipe',
    })
    code = 0
  } catch (err) {
    code = err.status
  }
  assert.equal(code, 0, 'audit is advisory -- exit 0 even with a drift finding')
  fs.rmSync(fx.repo, { recursive: true, force: true })
})

test('2.4 self-reference is ignored as an edge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  fs.mkdirSync(path.join(root, 'add-selfish'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'add-selfish', 'proposal.md'),
    deps('- `add-selfish` -- references itself'),
  )
  const g = buildChangeGraph(root)
  assert.equal(g.edges.length, 0)
  assert.equal(g.dangling.length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.6 backlog proposals are excluded from implementation-order graph nodes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const mk = (name, body) => {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'proposal.md'), body)
  }
  mk(
    'add-backlog-tracker',
    '**Status: Backlog. This change is not active work.**\n\n## Why\n\nTrack a deferred gap.\n',
  )
  mk('add-active-work', '# Proposal\n\n## Why\n\nReady to implement.\n')

  assert.equal(isBacklogProposal('**Status: Backlog. Not active.**\n'), true)
  assert.equal(isBacklogProposal('Status: Backlog. Not active.\n'), true)
  assert.equal(isBacklogProposal('# Proposal\n\nStatus: Backlog\n'), false)

  const g = buildChangeGraph(root)
  assert.deepEqual(g.nodes, ['add-active-work'])
  assert.equal(g.edges.length, 0)
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.6 active changes can order against backlog blockers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const backlogDir = path.join(root, 'add-backlog-tracker')
  const activeDir = path.join(root, 'add-active-work')
  fs.mkdirSync(backlogDir, { recursive: true })
  fs.mkdirSync(activeDir, { recursive: true })
  fs.writeFileSync(
    path.join(backlogDir, 'proposal.md'),
    '**Status: Backlog. This change is not active work.**\n',
  )
  const activeProposal = path.join(activeDir, 'proposal.md')
  fs.writeFileSync(
    activeProposal,
    deps(
      '- `add-backlog-tracker` (via `DeferredContract`) -- not orderable while backlog',
    ),
  )

  const g = buildChangeGraph(root)
  assert.deepEqual(g.nodes, ['add-active-work'])
  assert.deepEqual(g.backlogNodes, ['add-backlog-tracker'])
  assert.deepEqual(g.blockedByBacklog, [
    {
      change: 'add-active-work',
      blockedBy: ['add-backlog-tracker'],
      direct: ['add-backlog-tracker'],
      paths: [
        {
          from: 'add-backlog-tracker',
          path: ['add-backlog-tracker', 'add-active-work'],
        },
      ],
    },
  ])
  assert.deepEqual(g.edges, [
    {
      from: 'add-backlog-tracker',
      to: 'add-active-work',
      tier: 'required',
      anchor: 'DeferredContract',
    },
  ])
  assert.deepEqual(g.dangling, [])
  assert.equal(
    runValidate(activeProposal),
    0,
    'dependency gate accepts backlog blockers as upstreams',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.6 backlog blockers propagate transitively through active dependents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const mk = (name, body) => {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'proposal.md'), body)
  }
  mk('add-backlog-root', 'Status: Backlog\n\n## Why\n\nDeferred producer.\n')
  mk(
    'add-middle',
    deps('- `add-backlog-root` (via `DeferredContract`) -- blocked by backlog'),
  )
  mk(
    'add-leaf',
    deps('- `add-middle` (via `MiddleContract`) -- blocked transitively'),
  )
  mk('add-free', '# Proposal\n\n## Why\n\nReady.\n')

  const g = buildChangeGraph(root)
  assert.deepEqual(g.nodes, ['add-free', 'add-leaf', 'add-middle'])
  assert.deepEqual(g.backlogNodes, ['add-backlog-root'])
  assert.deepEqual(
    g.blockedByBacklog.map((entry) => entry.change),
    ['add-leaf', 'add-middle'],
  )
  assert.deepEqual(
    g.blockedByBacklog.find((entry) => entry.change === 'add-leaf'),
    {
      change: 'add-leaf',
      blockedBy: ['add-backlog-root'],
      direct: [],
      paths: [
        {
          from: 'add-backlog-root',
          path: ['add-backlog-root', 'add-middle', 'add-leaf'],
        },
      ],
    },
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.6 archived upstreams are not backlog blockers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  fs.mkdirSync(path.join(root, 'archive', '2026-01-01-add-shipped'), {
    recursive: true,
  })
  const activeDir = path.join(root, 'add-active-work')
  fs.mkdirSync(activeDir, { recursive: true })
  fs.writeFileSync(
    path.join(activeDir, 'proposal.md'),
    deps('- `add-shipped` (via `ShippedContract`) -- already archived'),
  )

  const g = buildChangeGraph(root)
  assert.deepEqual(g.backlogNodes, [])
  assert.deepEqual(g.blockedByBacklog, [])
  assert.deepEqual(
    g.archivedEdges.map((edge) => edge.from),
    ['add-shipped'],
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('3.5 audit separates backlog-blocked pending from ordinary pending', () => {
  const fx = auditFixture()
  fx.active(
    'add-backlog-root',
    'Status: Backlog\n\n## What Changes\n\nEventually produces DeferredContract.\n',
  )
  fx.active(
    'add-active-prod',
    '# Proposal\n\n## What Changes\n\nProduces ActiveContract.\n',
  )
  fx.active(
    'add-consumer-backlog',
    reqDeps(
      '- `add-backlog-root` (via `DeferredContract`) -- blocked by backlog',
    ),
  )
  fx.active(
    'add-consumer-active',
    reqDeps('- `add-active-prod` (via `ActiveContract`) -- ordinary pending'),
  )

  const a = auditGraph(fx.root)
  assert.equal(
    a.backlogPending.some((edge) => edge.from === 'add-backlog-root'),
    true,
  )
  assert.equal(
    a.pending.some((edge) => edge.from === 'add-active-prod'),
    true,
  )
  assert.equal(a.counts.backlogPending, 1)
  fs.rmSync(fx.repo, { recursive: true, force: true })
})

test('2.6 missing upstreams still fail validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const activeDir = path.join(root, 'add-active-work')
  fs.mkdirSync(activeDir, { recursive: true })
  const activeProposal = path.join(activeDir, 'proposal.md')
  fs.writeFileSync(
    activeProposal,
    deps(
      '- `add-missing-producer` (via `MissingContract`) -- still unresolved',
    ),
  )

  const g = buildChangeGraph(root)
  assert.deepEqual(g.nodes, ['add-active-work'])
  assert.equal(g.edges.length, 0)
  assert.deepEqual(g.dangling, [
    { token: 'add-missing-producer', change: 'add-active-work' },
  ])
  assert.equal(
    runValidate(activeProposal),
    2,
    'dependency gate still rejects missing upstreams',
  )
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.7 shared graph assertion reports the exact missing-dependency contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-'))
  const activeDir = path.join(root, 'add-consumer')
  fs.mkdirSync(activeDir, { recursive: true })
  fs.writeFileSync(
    path.join(activeDir, 'proposal.md'),
    deps('- `missing-change` (via `MissingContract`) -- unresolved'),
  )
  const graph = buildChangeGraph(root)
  assert.throws(() => assertResolvedDependencies(graph), {
    message:
      'MISSING DEPENDENCY! `add-consumer` depends on `missing-change` which does not exist in ./openspec/changes or ./openspec/changes/archive',
  })
  fs.rmSync(root, { recursive: true, force: true })
})

test('2.7 graph CLI fails while audit remains advisory and reports dangling dependencies', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-cli-'))
  const root = path.join(repo, 'openspec', 'changes')
  const activeDir = path.join(root, 'add-consumer')
  fs.mkdirSync(activeDir, { recursive: true })
  fs.writeFileSync(
    path.join(activeDir, 'proposal.md'),
    deps('- `missing-change` (via `MissingContract`) -- unresolved'),
  )
  assert.throws(
    () =>
      execFileSync('node', [SCRIPT, '--graph'], {
        cwd: repo,
        env: { ...process.env, CODEX_PROJECT_DIR: repo },
        stdio: 'pipe',
      }),
    /MISSING DEPENDENCY! `add-consumer` depends on `missing-change`/,
  )
  const audit = execFileSync('node', [SCRIPT, '--audit'], {
    cwd: repo,
    env: { ...process.env, CODEX_PROJECT_DIR: repo },
    encoding: 'utf8',
  })
  assert.match(audit, /MISSING DEPENDENCY -- graph resolution is incomplete/)
  assert.match(audit, /`add-consumer` depends on `missing-change`/)
  fs.rmSync(repo, { recursive: true, force: true })
})

test('2.8 audit scans backlog proposals instead of only implementation-active nodes', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'odeps-backlog-'))
  const root = path.join(repo, 'openspec', 'changes')
  const backlogDir = path.join(root, 'add-backlog-consumer')
  fs.mkdirSync(backlogDir, { recursive: true })
  fs.writeFileSync(
    path.join(backlogDir, 'proposal.md'),
    'Status: Backlog\n\n' +
      deps('- `missing-change` (via `MissingContract`) -- unresolved'),
  )
  assert.deepEqual(collectDanglingDependencies(root), [
    { token: 'missing-change', change: 'add-backlog-consumer' },
  ])
  const graph = buildChangeGraph(root)
  assert.deepEqual(graph.nodes, [])
  assert.deepEqual(graph.dangling, [
    { token: 'missing-change', change: 'add-backlog-consumer' },
  ])
  assert.throws(() => assertResolvedDependencies(graph), /MISSING DEPENDENCY!/)
  const audit = auditGraph(root)
  assert.deepEqual(audit.dangling, [
    { token: 'missing-change', change: 'add-backlog-consumer' },
  ])
  fs.rmSync(repo, { recursive: true, force: true })
})
