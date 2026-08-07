import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChangeGraph } from '../../opsxx-dependency-audit/scripts/opsxx-deps.mjs'
import { computeClaims } from './validate-sync-overlap.mjs'
import {
  buildDirtyTargetDecision,
  buildCodexWorkerLaunch,
  buildLaunchPlan,
  buildDryRun,
  buildWorkerDescriptor,
  buildWorkerPrompt,
  cleanupArchivedWorkerWorktree,
  codexWorktreesRoot,
  collectWorkerStates,
  compareChangeArtifacts,
  copyWorktreeIncludedFiles,
  createWorkerWorktree,
  finalizeRun,
  inspectDirtyTarget,
  isCloseoutOnly,
  launchWorker,
  mergeWorkerResult,
  assertRetainedCapacity,
  preflightWorkerLaunch,
  recordLaunchedWorker,
  resumeArchivedChange,
  simulateScheduler,
  updateWorkerState,
  verifyWorkerResult,
  writeArchiveCheckpoint,
  MAX_LIVE_WORKTREE_WORKERS,
  MAX_WORKTREE_DIRS,
  PARENT_INTEGRATION_STEPS,
} from './opsxx-orchestrate.mjs'

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
)
const packagedSkillsRoot = path.join(projectRoot, 'openspec', 'skills')

function makeFixture(changes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-orch-test-'))
  const changesRoot = path.join(root, 'openspec', 'changes')
  fs.mkdirSync(path.join(changesRoot, 'archive'), { recursive: true })

  for (const change of changes) {
    const dir = path.join(changesRoot, change.name)
    fs.mkdirSync(path.join(dir, 'specs', change.capability ?? change.name), {
      recursive: true,
    })
    const deps = change.dependsOn
      ? `\n## Dependencies\n\nRequired:\n- \`${change.dependsOn}\` (via \`test-anchor\`)\n`
      : ''
    const proposal = change.backlog
      ? `Status: Backlog\n\n# ${change.name}\n${deps}`
      : `# ${change.name}\n${deps}`
    fs.writeFileSync(path.join(dir, 'proposal.md'), proposal)
    fs.writeFileSync(path.join(dir, 'tasks.md'), '- [ ] 1.1 Test task\n')
    fs.writeFileSync(
      path.join(dir, 'specs', change.capability ?? change.name, 'spec.md'),
      [
        '## ADDED Requirements',
        '',
        `### Requirement: ${change.requirement ?? change.name}`,
        'The system SHALL do the thing.',
        '',
        '#### Scenario: Basic case',
        '- **WHEN** it runs',
        '- **THEN** it works',
        '',
      ].join('\n'),
    )
  }

  return { root, changesRoot }
}

function writeChangeArtifactSet(
  root,
  change,
  {
    proposal = '# Proposal\n',
    design = '# Design\n',
    tasks = '- [ ] 1.1 Test task\n',
    spec = [
      '## ADDED Requirements',
      '',
      '### Requirement: Example',
      'The system SHALL work.',
      '',
      '#### Scenario: Example',
      '- **WHEN** it runs',
      '- **THEN** it works',
      '',
    ].join('\n'),
  } = {},
) {
  const changeDir = path.join(root, 'openspec', 'changes', change)
  fs.mkdirSync(path.join(changeDir, 'specs', 'example'), { recursive: true })
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), proposal)
  fs.writeFileSync(path.join(changeDir, 'design.md'), design)
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), tasks)
  fs.writeFileSync(path.join(changeDir, 'specs', 'example', 'spec.md'), spec)
}

test('worktree retention cap stays bounded', () => {
  assert.equal(MAX_WORKTREE_DIRS, 15)
  assert.equal(MAX_LIVE_WORKTREE_WORKERS, 15)
  assert.ok(MAX_LIVE_WORKTREE_WORKERS <= MAX_WORKTREE_DIRS)
})

test('only the worktree orchestrator package and canonical graph import remain', () => {
  assert.equal(
    fs.existsSync(
      path.join(
        projectRoot,
        '.agents',
        'skills',
        'opsxx-orchestrate-worktrees',
      ),
    ),
    false,
  )
  assert.equal(
    fs.existsSync(
      path.join(
        projectRoot,
        '.codex',
        'agents',
        'opsxx-orchestrate-worker.toml',
      ),
    ),
    false,
  )
  const codexConfig = path.join(projectRoot, '.codex', 'config.toml')
  if (fs.existsSync(codexConfig)) {
    assert.doesNotMatch(
      fs.readFileSync(codexConfig, 'utf8'),
      /openspecx_orchestrate_worker/u,
    )
  }

  const implementation = fs.readFileSync(
    path.join(packagedSkillsRoot, 'opsxx-orchestrate', 'scripts', 'opsxx-orchestrate.mjs'),
    'utf8',
  )
  assert.deepEqual(
    [...implementation.matchAll(/from '(\.\.\/\.\.\/[^']+)'/gu)].map(
      ([, modulePath]) => modulePath,
    ),
    ['../../opsxx-dependency-audit/scripts/opsxx-deps.mjs'],
  )
  assert.doesNotMatch(implementation, /waitForWorkers|--single-agent/u)
})

test('freed slot admits the next archive-unblocked eligible change immediately', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-fast', capability: 'alpha', requirement: 'Fast' },
    { name: 'add-slow', capability: 'beta', requirement: 'Slow' },
    {
      name: 'add-after-fast',
      dependsOn: 'add-fast',
      capability: 'gamma',
      requirement: 'After',
    },
  ])

  try {
    const graph = buildChangeGraph(changesRoot)
    const claims = computeClaims(changesRoot)
    const { events } = simulateScheduler({
      graph,
      claims,
      completionOrder: ['add-fast', 'add-slow', 'add-after-fast'],
    })
    assert.deepEqual(
      events.find(
        (event) => event.type === 'integrate' && event.change === 'add-fast',
      ).steps,
      PARENT_INTEGRATION_STEPS,
    )
    assert.ok(
      PARENT_INTEGRATION_STEPS.indexOf('validate') <
        PARENT_INTEGRATION_STEPS.indexOf('opsx-sync'),
      'integrated validation must precede sync and archive',
    )
    const simplified = events.map(
      (event) => `${event.type}:${event.change ?? 'main'}`,
    )
    assert.ok(
      simplified.indexOf('admit:add-after-fast') >
        simplified.indexOf('archive:add-fast'),
      'dependent is admitted after upstream archive',
    )
    assert.ok(
      simplified.indexOf('admit:add-after-fast') <
        simplified.indexOf('worker-complete:add-slow'),
      'dependent starts before slow sibling drains',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree scheduler and launch plan skip backlog-blocked changes', () => {
  const { root, changesRoot } = makeFixture([
    {
      name: 'add-backlog-root',
      backlog: true,
      capability: 'backlog',
      requirement: 'Backlog',
    },
    {
      name: 'add-middle',
      dependsOn: 'add-backlog-root',
      capability: 'middle',
      requirement: 'Middle',
    },
    {
      name: 'add-leaf',
      dependsOn: 'add-middle',
      capability: 'leaf',
      requirement: 'Leaf',
    },
    { name: 'add-free', capability: 'free', requirement: 'Free' },
  ])

  try {
    const graph = buildChangeGraph(changesRoot)
    const claims = computeClaims(changesRoot)
    const schedule = simulateScheduler({ graph, claims })
    assert.deepEqual(
      schedule.events
        .filter((event) => event.type === 'admit')
        .map((event) => event.change),
      ['add-free'],
    )

    const launchPlan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: '/tmp/codex-home' },
    })
    assert.deepEqual(
      launchPlan.launches.map(({ descriptor }) => descriptor.change),
      ['add-free'],
    )
    assert.deepEqual(
      launchPlan.skippedWork.map((event) => event.change),
      ['add-leaf', 'add-middle'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree launch plan emits ff-change when a change has no specs and no tasks', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-fast-path', capability: 'fast', requirement: 'Fast Path' },
  ])
  fs.rmSync(path.join(changesRoot, 'add-fast-path', 'specs'), {
    recursive: true,
    force: true,
  })
  fs.rmSync(path.join(changesRoot, 'add-fast-path', 'tasks.md'), {
    force: true,
  })

  try {
    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.deepEqual(plan.authoringEvents, [
      {
        type: 'author',
        change: 'add-fast-path',
        command: '$opsx-ff add-fast-path',
      },
    ])
    assert.deepEqual(plan.launches, [])
    assert.deepEqual(plan.queuedLaunches, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree launch plan emits apply-change when a change has tasks but no specs', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-apply', capability: 'apply', requirement: 'Apply' },
  ])
  fs.rmSync(path.join(changesRoot, 'add-apply', 'specs'), {
    recursive: true,
    force: true,
  })

  try {
    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.deepEqual(plan.authoringEvents, [
      {
        type: 'author',
        change: 'add-apply',
        command: '$opsx-apply add-apply',
      },
    ])
    assert.deepEqual(plan.launches, [])
    assert.deepEqual(plan.queuedLaunches, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree launch plan emits continue-change when a change has specs but no tasks', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-continue', capability: 'continue', requirement: 'Continue' },
  ])
  fs.rmSync(path.join(changesRoot, 'add-continue', 'tasks.md'), {
    force: true,
  })

  try {
    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.deepEqual(plan.authoringEvents, [
      {
        type: 'author',
        change: 'add-continue',
        command: '$opsx-continue add-continue',
      },
    ])
    assert.deepEqual(plan.launches, [])
    assert.deepEqual(plan.queuedLaunches, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dry-run plan mirrors launch admission counts for non-overlapping delta-capable changes', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-alpha', capability: 'alpha', requirement: 'Alpha' },
    { name: 'add-beta', capability: 'beta', requirement: 'Beta' },
  ])

  try {
    const launchPlan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })

    const dryRun = buildDryRun({ changesRoot })

    assert.equal(launchPlan.admissionMode, 'bounded-ready-queue')
    assert.equal(dryRun.admissionMode, 'all-eligible')
    assert.equal(launchPlan.launches.length, dryRun.admittedWorkerCount)
    assert.deepEqual(
      launchPlan.launches.map(({ descriptor }) => descriptor.change),
      ['add-alpha', 'add-beta'],
    )
    assert.deepEqual(
      dryRun.events
        .filter((event) => event.type === 'admit')
        .map((event) => event.change),
      ['add-alpha', 'add-beta'],
    )
    assert.deepEqual(launchPlan.authoringEvents, dryRun.authoringEvents)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dry-run plan emits apply/ff authoring events consistently with launch plan', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-fast-path', capability: 'fast', requirement: 'Fast Path' },
    { name: 'add-apply', capability: 'apply', requirement: 'Apply Path' },
  ])
  fs.rmSync(path.join(changesRoot, 'add-fast-path', 'specs'), {
    recursive: true,
    force: true,
  })
  fs.rmSync(path.join(changesRoot, 'add-fast-path', 'tasks.md'), {
    force: true,
  })
  fs.rmSync(path.join(changesRoot, 'add-apply', 'specs'), {
    recursive: true,
    force: true,
  })

  try {
    const launchPlan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    const dryRun = buildDryRun({ changesRoot })

    assert.deepEqual(dryRun.authoringEvents, [
      {
        type: 'author',
        change: 'add-apply',
        command: '$opsx-apply add-apply',
      },
      {
        type: 'author',
        change: 'add-fast-path',
        command: '$opsx-ff add-fast-path',
      },
    ])
    assert.equal(launchPlan.admittedWorkerCount, 0)
    assert.equal(launchPlan.authoringEvents.length, 2)
    assert.deepEqual(launchPlan.authoringEvents, dryRun.authoringEvents)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('admission waits on archive state rather than worker completion state', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-root', capability: 'alpha', requirement: 'Root' },
    {
      name: 'add-dependent',
      dependsOn: 'add-root',
      capability: 'beta',
      requirement: 'Dependent',
    },
  ])

  try {
    const graph = buildChangeGraph(changesRoot)
    const claims = computeClaims(changesRoot)
    const { events } = simulateScheduler({ graph, claims })
    const simplified = events.map(
      (event) => `${event.type}:${event.change ?? 'main'}`,
    )
    assert.ok(
      simplified.indexOf('admit:add-dependent') >
        simplified.indexOf('archive:add-root'),
    )
    assert.ok(
      simplified.indexOf('admit:add-dependent') >
        simplified.indexOf('worker-complete:add-root'),
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('in-flight set remains overlap-free', () => {
  const { root, changesRoot } = makeFixture([
    {
      name: 'add-alpha',
      capability: 'shared-cap',
      requirement: 'Shared Requirement',
    },
    {
      name: 'add-beta',
      capability: 'shared-cap',
      requirement: 'Shared Requirement',
    },
    {
      name: 'add-gamma',
      capability: 'other-cap',
      requirement: 'Other Requirement',
    },
  ])

  try {
    const graph = buildChangeGraph(changesRoot)
    const claims = computeClaims(changesRoot)
    const { events } = simulateScheduler({ graph, claims })
    for (const event of events.filter((e) => e.type === 'admit')) {
      assert.ok(
        !(
          event.inFlight.includes('add-alpha') &&
          event.inFlight.includes('add-beta')
        ),
        'overlapping changes must never be in flight together',
      )
    }
    assert.equal(
      events.filter((event) => event.type === 'validate-main').length,
      1,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree scheduler queues eligible work beyond the live worker cap', () => {
  const changes = Array.from({ length: 17 }, (_, index) => ({
    name: `add-cap-${String(index).padStart(2, '0')}`,
    capability: `cap-${String(index).padStart(2, '0')}`,
    requirement: `Cap ${index}`,
  }))
  const { root, changesRoot } = makeFixture(changes)

  try {
    const graph = buildChangeGraph(changesRoot)
    const claims = computeClaims(changesRoot)
    const { events } = simulateScheduler({
      graph,
      claims,
      maxLiveWorkers: MAX_LIVE_WORKTREE_WORKERS,
    })
    const firstQueue = events.find((event) => event.type === 'queue')
    assert.ok(firstQueue, 'work past the live cap must be queued')
    assert.equal(
      events
        .filter((event) => event.type === 'admit')
        .slice(0, MAX_LIVE_WORKTREE_WORKERS).length,
      15,
    )
    assert.ok(
      events.findIndex(
        (event) => event.type === 'admit' && event.change === firstQueue.change,
      ) > events.findIndex((event) => event.type === 'archive'),
      'queued work is admitted only after a worker slot frees',
    )

    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.equal(plan.maxLiveWorkers, MAX_LIVE_WORKTREE_WORKERS)
    assert.equal(plan.launches.length, MAX_LIVE_WORKTREE_WORKERS)
    assert.equal(plan.queuedLaunches.length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('codex worker descriptors live under CODEX_HOME worktrees', () => {
  const descriptor = buildWorkerDescriptor({
    change: 'add-example',
    repoName: 'openspec',
    env: { CODEX_HOME: '/tmp/codex-home' },
  })

  assert.equal(
    codexWorktreesRoot({ CODEX_HOME: '/tmp/codex-home' }),
    '/tmp/codex-home/worktrees',
  )
  assert.equal(descriptor.worktreeRoot, '/tmp/codex-home/worktrees')
  assert.equal(
    descriptor.worktreePath,
    '/tmp/codex-home/worktrees/openspec-agent-add-example',
  )
  assert.equal(descriptor.branch, 'orchestrate/add-example')
})

test('worktree worker prompt replaces the assigned change name', () => {
  const prompt = buildWorkerPrompt('add-example')

  assert.match(prompt, /one OpenSpec change: `add-example`/)
  assert.doesNotMatch(prompt, /\$CHANGE-NAME/)
  assert.match(prompt, /\$opsx-apply add-example/)
  assert.match(prompt, /focused checks/)
  assert.match(prompt, /repository-global validation/)
  assert.match(prompt, /commit the branch/)
  assert.match(prompt, /Report any out-of-scope bug in `bubbledSideEffects`/)
  assert.match(prompt, /parent owns deduplication/)
  assert.doesNotMatch(prompt, /\$opsx-propose/)
  assert.doesNotMatch(prompt, /Run `\$opsx-verify/)
  assert.doesNotMatch(prompt, /Run `\$opsx-sync/)
  assert.match(prompt, /"status": "blocked\|conflicted\|failed"/)
})

test('codex worker launch uses direct argv and cwd with unusual paths', () => {
  const descriptor = buildWorkerDescriptor({
    change: 'add-example',
    repoName: 'openspec',
    env: { CODEX_HOME: '/tmp/codex home [one]' },
  })
  const launch = buildCodexWorkerLaunch({ descriptor })

  assert.equal(launch.command, 'codex')
  assert.deepEqual(launch.args.slice(0, 4), [
    'exec',
    '--json',
    '-o',
    '/tmp/codex home [one]/worktrees/.logs/add-example/summary.txt',
  ])
  assert.equal(
    launch.cwd,
    '/tmp/codex home [one]/worktrees/openspec-agent-add-example',
  )
  assert.equal(launch.change, 'add-example')
  assert.match(launch.prompt, /one OpenSpec change: `add-example`/)
  assert.match(launch.prompt, /\$opsx-apply add-example/)
  assert.equal(
    launch.summaryPath,
    '/tmp/codex home [one]/worktrees/.logs/add-example/summary.txt',
  )
})

test('codex worker launch accepts explicit model and reasoning controls', () => {
  const descriptor = buildWorkerDescriptor({
    change: 'add-example',
    repoName: 'openspec',
    env: { CODEX_HOME: '/tmp/codex-home' },
  })
  const launch = buildCodexWorkerLaunch({
    descriptor,
    env: {
      OPENSPECX_WORKER_MODEL: 'gpt-5.6-luna',
      OPENSPECX_WORKER_REASONING_EFFORT: 'high',
    },
  })

  assert.deepEqual(launch.args.slice(0, 7), [
    'exec',
    '--model',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort="high"',
    '--json',
    '-o',
  ])
})

test('launch plan returns codex exec descriptors for initially admitted work', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-alpha', capability: 'alpha', requirement: 'Alpha' },
    { name: 'add-beta', capability: 'beta', requirement: 'Beta' },
  ])

  try {
    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.equal(plan.admissionMode, 'bounded-ready-queue')
    assert.deepEqual(
      plan.launches.map(({ descriptor }) => descriptor.change),
      ['add-alpha', 'add-beta'],
    )
    assert.deepEqual(plan.queuedLaunches, [])
    for (const { descriptor, launch } of plan.launches) {
      assert.ok(
        descriptor.worktreePath.startsWith(
          path.join(root, 'codex-home', 'worktrees'),
        ),
      )
      assert.equal(launch.command, 'codex')
      assert.equal(launch.cwd, descriptor.worktreePath)
      assert.deepEqual(launch.args.slice(0, 3), ['exec', '--json', '-o'])
      assert.equal(launch.change, descriptor.change)
      assert.match(
        launch.prompt,
        new RegExp(`one OpenSpec change: \`${descriptor.change}\``),
      )
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('changes with no unchecked tasks bypass worker launch as closeout-only', () => {
  const { root, changesRoot } = makeFixture([
    {
      name: 'validate-terminal',
      capability: 'terminal',
      requirement: 'Terminal',
    },
  ])
  try {
    fs.writeFileSync(
      path.join(changesRoot, 'validate-terminal', 'tasks.md'),
      '- [x] 1.1 No implementation work remains\n',
    )
    assert.equal(
      isCloseoutOnly({ changesRoot, change: 'validate-terminal' }),
      true,
    )
    const plan = buildLaunchPlan({
      changesRoot,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.deepEqual(plan.closeoutOnly, ['validate-terminal'])
    assert.deepEqual(plan.launches, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dirty target inspection reports branch, dirty files, and distance from main head', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-dirty-target-'))
  const repo = path.join(root, 'repo')
  const codexHome = path.join(root, 'codex-home')
  const change = 'add-example'
  fs.mkdirSync(repo, { recursive: true })
  writeChangeArtifactSet(repo, change)

  try {
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'test@example.invalid'], repo)
    runGit(['config', 'user.name', 'Test User'], repo)
    runGit(['add', '.'], repo)
    runGit(['commit', '-m', 'initial'], repo)
    runGit(['branch', '-M', 'main'], repo)

    const descriptor = buildWorkerDescriptor({
      change,
      repoName: 'openspec',
      env: { CODEX_HOME: codexHome },
    })
    createWorkerWorktree({ descriptor, repoDir: repo })

    fs.writeFileSync(path.join(repo, 'main-update.txt'), 'main\n')
    runGit(['add', 'main-update.txt'], repo)
    runGit(['commit', '-m', 'main update'], repo)
    fs.writeFileSync(
      path.join(descriptor.worktreePath, 'worktree-progress.txt'),
      'progress\n',
    )

    const report = inspectDirtyTarget({ descriptor, repoDir: repo })

    assert.equal(report.change, change)
    assert.equal(report.branch, 'orchestrate/add-example')
    assert.deepEqual(report.dirtyFiles, ['worktree-progress.txt'])
    assert.equal(report.aheadOfMain, 0)
    assert.equal(report.behindMain, 1)
    assert.notEqual(report.workerHead, report.mainHead)
    assert.equal(
      report.artifactComparison.artifactsIdenticalIgnoringTaskCheckboxes,
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('artifact comparison ignores only tasks.md checkbox differences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-artifact-compare-'))
  const mainDir = path.join(root, 'main')
  const worktreeDir = path.join(root, 'worktree')
  const change = 'add-example'
  writeChangeArtifactSet(mainDir, change, {
    tasks: '- [x] 1.1 Test task\n- [ ] 1.2 Second task\n',
  })
  writeChangeArtifactSet(worktreeDir, change, {
    tasks: '- [ ] 1.1 Test task\n- [ ] 1.2 Second task\n',
  })

  try {
    const checkboxOnly = compareChangeArtifacts({
      change,
      mainDir,
      worktreeDir,
    })
    assert.equal(checkboxOnly.artifactsIdenticalIgnoringTaskCheckboxes, true)
    assert.deepEqual(checkboxOnly.differingArtifacts, [])
    assert.deepEqual(checkboxOnly.mainCompletedMissingInWorktree, [
      '1.1 Test task',
    ])
    assert.equal(checkboxOnly.completionEqual, false)

    fs.writeFileSync(
      path.join(worktreeDir, 'openspec', 'changes', change, 'proposal.md'),
      '# Proposal\n\nDifferent text.\n',
    )
    const drift = compareChangeArtifacts({ change, mainDir, worktreeDir })
    assert.equal(drift.artifactsIdenticalIgnoringTaskCheckboxes, false)
    assert.deepEqual(drift.differingArtifacts, ['proposal.md'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('dirty target decision warns on task direction and recommends restart only when completion matches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-dirty-decision-'))
  const mainDir = path.join(root, 'main')
  const worktreeDir = path.join(root, 'worktree')
  const change = 'add-example'
  writeChangeArtifactSet(mainDir, change, {
    tasks: '- [x] 1.1 Base task\n- [ ] 1.2 Extra task\n',
  })
  writeChangeArtifactSet(worktreeDir, change, {
    tasks: '- [x] 1.1 Base task\n- [x] 1.2 Extra task\n',
  })

  try {
    const extraComparison = compareChangeArtifacts({
      change,
      mainDir,
      worktreeDir,
    })
    assert.equal(extraComparison.artifactsIdenticalIgnoringTaskCheckboxes, true)
    assert.deepEqual(extraComparison.mainCompletedMissingInWorktree, [])
    assert.deepEqual(extraComparison.worktreeExtraCompleted, ['1.2 Extra task'])
    assert.equal(extraComparison.worktreeHasAllMainCompletedPlusMore, true)

    const extraDecision = buildDirtyTargetDecision({
      change,
      worktreePath: worktreeDir,
      branch: 'orchestrate/add-example',
      dirtyFiles: ['packages/example.ts'],
      workerHead: 'worker',
      mainHead: 'main',
      aheadOfMain: 1,
      behindMain: 2,
      artifactComparison: extraComparison,
    })
    assert.equal(extraDecision.recommendedAction, undefined)
    assert.equal(extraDecision.choices.length, 2)
    assert.match(extraDecision.question, /additional completed task/)
    assert.match(extraDecision.question, /- \[x\] 1\.2 Extra task/)

    fs.writeFileSync(
      path.join(worktreeDir, 'openspec', 'changes', change, 'tasks.md'),
      '- [ ] 1.1 Base task\n- [ ] 1.2 Extra task\n',
    )
    const missingComparison = compareChangeArtifacts({
      change,
      mainDir,
      worktreeDir,
    })
    const missingDecision = buildDirtyTargetDecision({
      change,
      worktreePath: worktreeDir,
      branch: 'orchestrate/add-example',
      dirtyFiles: ['packages/example.ts'],
      workerHead: 'worker',
      mainHead: 'main',
      aheadOfMain: 0,
      behindMain: 0,
      artifactComparison: missingComparison,
    })
    assert.match(
      missingDecision.question,
      /Main has completed tasks not completed in the worktree/,
    )
    assert.match(missingDecision.question, /1\.1 Base task/)

    fs.writeFileSync(
      path.join(worktreeDir, 'openspec', 'changes', change, 'tasks.md'),
      '- [x] 1.1 Base task\n- [ ] 1.2 Extra task\n',
    )
    const equalComparison = compareChangeArtifacts({
      change,
      mainDir,
      worktreeDir,
    })
    const equalDecision = buildDirtyTargetDecision({
      change,
      worktreePath: worktreeDir,
      branch: 'orchestrate/add-example',
      dirtyFiles: ['packages/example.ts'],
      workerHead: 'worker',
      mainHead: 'main',
      aheadOfMain: 0,
      behindMain: 0,
      artifactComparison: equalComparison,
    })
    assert.equal(equalDecision.recommendedAction, 'discard')
    assert.match(equalDecision.question, /Recommendation: discard/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('detached worker state is restartable and exposes completion without a batch barrier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worker-state-'))
  const descriptor = buildWorkerDescriptor({
    change: 'add-alpha',
    repoName: 'openspec',
    env: { CODEX_HOME: path.join(root, 'codex-home') },
  })
  const summaryPath = path.join(descriptor.logDir, 'summary.txt')
  fs.mkdirSync(descriptor.logDir, { recursive: true })

  try {
    const recorded = recordLaunchedWorker({
      launched: { child: { pid: 4242 }, summaryPath },
      descriptor,
      repoDir: root,
    })
    assert.equal(recorded.status, 'running')
    assert.equal(
      collectWorkerStates({ repoDir: root, isAlive: () => true })[0].status,
      'running',
    )

    fs.writeFileSync(
      summaryPath,
      JSON.stringify({
        change: descriptor.change,
        status: 'done',
        filesTouched: ['implementation.ts'],
        commit: 'abc123',
        checkStatus: 'passed',
        bubbledSideEffects: [],
        notes: '',
      }),
    )
    const completed = collectWorkerStates({
      repoDir: root,
      isAlive: () => false,
    })[0]
    assert.equal(completed.status, 'done')
    assert.equal(completed.summary.commit, 'abc123')

    const merged = updateWorkerState({
      change: descriptor.change,
      status: 'merged',
      repoDir: root,
    })
    assert.equal(merged.status, 'merged')
    assert.equal(
      collectWorkerStates({ repoDir: root, isAlive: () => false })[0].status,
      'merged',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('detached launch returns immediately and releases the child handle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-detached-launch-'))
  const descriptor = buildWorkerDescriptor({
    change: 'add-alpha',
    repoName: 'openspec',
    env: { CODEX_HOME: path.join(root, 'codex-home') },
  })
  fs.mkdirSync(
    path.join(descriptor.worktreePath, 'openspec', 'changes', 'add-alpha'),
    { recursive: true },
  )
  try {
    runGit(['init'], descriptor.worktreePath)
    runGit(
      ['config', 'user.email', 'test@example.invalid'],
      descriptor.worktreePath,
    )
    runGit(['config', 'user.name', 'Test User'], descriptor.worktreePath)
    runGit(['checkout', '-b', descriptor.branch], descriptor.worktreePath)
    fs.writeFileSync(
      path.join(
        descriptor.worktreePath,
        'openspec',
        'changes',
        'add-alpha',
        'tasks.md',
      ),
      '- [ ] Test\n',
    )
    runGit(['add', '.'], descriptor.worktreePath)
    runGit(['commit', '-m', 'fixture'], descriptor.worktreePath)
    let unrefCount = 0
    const launched = launchWorker({
      descriptor,
      detached: true,
      spawnImpl(_command, _args, options) {
        assert.equal(options.detached, true)
        return { pid: 4242, unref: () => unrefCount++ }
      },
    })
    assert.equal(launched.child.pid, 4242)
    assert.equal(unrefCount, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worker state collection preserves missing and malformed result evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worker-failure-'))
  const workersDir = path.join(root, '.temp', 'opsxx-orchestrate', 'workers')
  fs.mkdirSync(workersDir, { recursive: true })
  try {
    fs.writeFileSync(
      path.join(workersDir, 'add-alpha.json'),
      JSON.stringify({
        change: 'add-alpha',
        status: 'running',
        pid: 4242,
        summaryPath: path.join(root, 'missing-summary.json'),
      }),
    )
    fs.writeFileSync(path.join(workersDir, 'add-beta.json'), '{bad json')
    const incompleteSummary = path.join(root, 'incomplete-summary.json')
    fs.writeFileSync(
      incompleteSummary,
      JSON.stringify({ change: 'add-gamma', status: 'done', commit: 'abc123' }),
    )
    fs.writeFileSync(
      path.join(workersDir, 'add-gamma.json'),
      JSON.stringify({
        change: 'add-gamma',
        status: 'running',
        pid: 4343,
        summaryPath: incompleteSummary,
      }),
    )
    const blockedSummary = path.join(root, 'blocked-summary.json')
    fs.writeFileSync(
      blockedSummary,
      JSON.stringify({
        change: 'add-delta',
        status: 'blocked',
        filesTouched: [],
        reason: 'pre-image changed',
      }),
    )
    fs.writeFileSync(
      path.join(workersDir, 'add-delta.json'),
      JSON.stringify({
        change: 'add-delta',
        status: 'running',
        pid: 4444,
        summaryPath: blockedSummary,
      }),
    )

    const states = collectWorkerStates({
      repoDir: root,
      isAlive: () => false,
    })
    assert.deepEqual(
      states.map(({ change, status }) => ({ change, status })),
      [
        { change: 'add-alpha', status: 'failed' },
        { change: 'add-beta', status: 'malformed' },
        { change: 'add-delta', status: 'blocked' },
        { change: 'add-gamma', status: 'malformed' },
      ],
    )
    assert.match(states[0].error, /exited without a result/)
    assert.match(states[1].error, /Malformed worker runtime state/)
    assert.equal(states[2].summary.reason, 'pre-image changed')
    assert.match(states[3].error, /filesTouched/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('launch planning excludes persisted workers and reserves their live slots', () => {
  const { root, changesRoot } = makeFixture([
    { name: 'add-alpha', capability: 'alpha', requirement: 'Alpha' },
    { name: 'add-beta', capability: 'beta', requirement: 'Beta' },
  ])
  const workersDir = path.join(root, '.temp', 'opsxx-orchestrate', 'workers')
  fs.mkdirSync(workersDir, { recursive: true })
  fs.writeFileSync(
    path.join(workersDir, 'add-alpha.json'),
    JSON.stringify({
      change: 'add-alpha',
      status: 'running',
      pid: 4242,
      summaryPath: path.join(root, 'alpha-summary.json'),
    }),
  )

  try {
    const plan = buildLaunchPlan({
      changesRoot,
      repoDir: root,
      isAlive: () => true,
      env: { CODEX_HOME: path.join(root, 'codex-home') },
    })
    assert.equal(plan.liveWorkerCount, 1)
    assert.equal(plan.availableWorkerSlots, MAX_LIVE_WORKTREE_WORKERS - 1)
    assert.deepEqual(
      plan.launches.map(({ descriptor }) => descriptor.change),
      ['add-beta'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree worker prompt owns focused-check and bugfix summary contract', () => {
  const prompt = buildWorkerPrompt('add-example')

  assert.match(prompt, /focused checks/)
  assert.match(prompt, /out-of-scope bug/)
  assert.match(prompt, /checkStatus/)
  assert.match(prompt, /bubbledSideEffects/)
})

test('worktree include copying copies matched files and no-ops without include file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worktree-includes-'))
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'worktree')
  fs.mkdirSync(path.join(repo, 'local', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'ignored'), { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  fs.writeFileSync(
    path.join(repo, '.worktreeincludes'),
    [
      '# copied into worker checkouts',
      'local/config.json',
      'local/**/*.secret',
      'missing.txt',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(repo, 'local', 'config.json'), '{"ok":true}\n')
  fs.writeFileSync(
    path.join(repo, 'local', 'nested', 'token.secret'),
    'token\n',
  )
  fs.writeFileSync(path.join(repo, 'ignored', 'skip.secret'), 'skip\n')

  try {
    const descriptor = {
      change: 'add-example',
      worktreeRoot: root,
      worktreePath: worktree,
      branch: 'orchestrate/add-example',
    }
    const copied = copyWorktreeIncludedFiles({ descriptor, repoDir: repo })
    assert.deepEqual(copied, ['local/config.json', 'local/nested/token.secret'])
    assert.equal(
      fs.readFileSync(path.join(worktree, 'local', 'config.json'), 'utf8'),
      '{"ok":true}\n',
    )
    assert.equal(
      fs.readFileSync(
        path.join(worktree, 'local', 'nested', 'token.secret'),
        'utf8',
      ),
      'token\n',
    )
    assert.equal(
      fs.existsSync(path.join(worktree, 'ignored', 'skip.secret')),
      false,
    )

    fs.rmSync(path.join(repo, '.worktreeincludes'))
    assert.deepEqual(
      copyWorktreeIncludedFiles({ descriptor, repoDir: repo }),
      [],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worktree include copying rejects patterns outside the repo root', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opsx-worktree-includes-bad-'),
  )
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'worktree')
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(worktree, { recursive: true })
  fs.writeFileSync(path.join(repo, '.worktreeincludes'), '../outside.txt\n')

  try {
    assert.throws(
      () =>
        copyWorktreeIncludedFiles({
          descriptor: {
            change: 'add-example',
            worktreeRoot: root,
            worktreePath: worktree,
            branch: 'orchestrate/add-example',
          },
          repoDir: repo,
        }),
      /root-relative/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retained worktree capacity fails closed without deleting evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worktree-prune-'))
  const worktreeRoot = path.join(root, 'worktrees')
  fs.mkdirSync(worktreeRoot, { recursive: true })
  const now = Date.now() / 1000

  try {
    for (let i = 0; i < 16; i++) {
      const dir = path.join(
        worktreeRoot,
        `openspec-agent-old-${String(i).padStart(2, '0')}`,
      )
      fs.mkdirSync(dir, { recursive: true })
      fs.utimesSync(dir, now + i, now + i)
    }
    const unrelated = path.join(worktreeRoot, 'other-project-agent-old')
    fs.mkdirSync(unrelated)
    fs.utimesSync(unrelated, now - 100, now - 100)

    const descriptor = {
      change: 'new-change',
      worktreeRoot,
      worktreePath: path.join(worktreeRoot, 'openspec-agent-new-change'),
      branch: 'orchestrate/new-change',
    }
    assert.throws(
      () => assertRetainedCapacity({ descriptor }),
      /Retained orchestration state is at capacity \(16\/15\)/,
    )
    assert.equal(fs.existsSync(unrelated), true)
    assert.equal(
      fs
        .readdirSync(worktreeRoot)
        .filter((name) => name.startsWith('openspec-agent-')).length,
      16,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('retained worktree capacity permits a free slot without mutation', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opsx-worktree-prune-protected-'),
  )
  const worktreeRoot = path.join(root, 'worktrees')
  fs.mkdirSync(worktreeRoot, { recursive: true })
  const now = Date.now() / 1000

  try {
    for (let i = 0; i < 14; i++) {
      const dir = path.join(
        worktreeRoot,
        `openspec-agent-old-${String(i).padStart(2, '0')}`,
      )
      fs.mkdirSync(dir, { recursive: true })
      fs.utimesSync(dir, now + i, now + i)
    }
    const descriptor = {
      change: 'new-change',
      worktreeRoot,
      worktreePath: path.join(worktreeRoot, 'openspec-agent-new-change'),
      branch: 'orchestrate/new-change',
    }

    assert.deepEqual(assertRetainedCapacity({ descriptor }), [])
    assert.equal(fs.readdirSync(worktreeRoot).length, 14)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('create worker worktree copies root include files after git worktree add', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opsx-worker-create-includes-'),
  )
  const repo = path.join(root, 'repo')
  const codexHome = path.join(root, 'codex-home')
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'add-example'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(repo, 'openspec', 'changes', 'add-example', 'tasks.md'),
    '- [ ] Test\n',
  )

  try {
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'test@example.invalid'], repo)
    runGit(['config', 'user.name', 'Test User'], repo)
    runGit(['add', '.'], repo)
    runGit(['commit', '-m', 'initial'], repo)
    runGit(['branch', '-M', 'main'], repo)
    fs.mkdirSync(path.join(repo, '.local'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.worktreeincludes'),
      '.local/runtime.json\n',
    )
    fs.writeFileSync(
      path.join(repo, '.local', 'runtime.json'),
      '{"runtime":true}\n',
    )

    const descriptor = buildWorkerDescriptor({
      change: 'add-example',
      repoName: 'openspec',
      env: { CODEX_HOME: codexHome },
    })
    createWorkerWorktree({ descriptor, repoDir: repo })
    assert.equal(
      fs.readFileSync(
        path.join(descriptor.worktreePath, '.local', 'runtime.json'),
        'utf8',
      ),
      '{"runtime":true}\n',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fakeFs(existingPaths) {
  return {
    existsSync(candidate) {
      return existingPaths.has(candidate)
    },
    mkdirSync() {},
  }
}

function fakeExecFor({ branch = 'orchestrate/add-example', dirty = '' } = {}) {
  return (command, args) => {
    assert.equal(command, 'git')
    const joined = args.join(' ')
    if (joined.includes('branch --show-current')) return branch
    if (joined.includes('status --short')) return dirty
    throw new Error(`unexpected fake git call: ${joined}`)
  }
}

test('preflight rejects a worktree outside the Codex worktree root', () => {
  const descriptor = {
    change: 'add-example',
    branch: 'orchestrate/add-example',
    worktreeRoot: '/tmp/codex-home/worktrees',
    worktreePath: '/tmp/repo/agent-add-example',
  }

  assert.throws(
    () =>
      preflightWorkerLaunch({
        descriptor,
        fsImpl: fakeFs(new Set()),
        execFile: fakeExecFor(),
      }),
    /outside Codex worktree root/,
  )
})

test('preflight rejects wrong branch, missing change folder, and dirty worktree', () => {
  const descriptor = {
    change: 'add-example',
    branch: 'orchestrate/add-example',
    worktreeRoot: '/tmp/codex-home/worktrees',
    worktreePath: '/tmp/codex-home/worktrees/openspec-agent-add-example',
  }
  const existing = new Set([
    descriptor.worktreePath,
    path.join(
      descriptor.worktreePath,
      'openspec',
      'changes',
      descriptor.change,
    ),
  ])

  assert.throws(
    () =>
      preflightWorkerLaunch({
        descriptor,
        fsImpl: fakeFs(new Set([descriptor.worktreePath])),
        execFile: fakeExecFor(),
      }),
    /missing change folder/,
  )
  assert.throws(
    () =>
      preflightWorkerLaunch({
        descriptor,
        fsImpl: fakeFs(existing),
        execFile: fakeExecFor({ branch: 'main' }),
      }),
    /branch mismatch/,
  )
  assert.throws(
    () =>
      preflightWorkerLaunch({
        descriptor,
        fsImpl: fakeFs(existing),
        execFile: fakeExecFor({ dirty: ' M file.txt' }),
      }),
    /dirty/,
  )
})

test('preflight reads branch and status from a real worker worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worker-preflight-'))
  const repo = path.join(root, 'repo')
  const codexHome = path.join(root, 'codex-home')
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'add-example'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(repo, 'openspec', 'changes', 'add-example', 'tasks.md'),
    '- [ ] Test\n',
  )

  try {
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'test@example.invalid'], repo)
    runGit(['config', 'user.name', 'Test User'], repo)
    runGit(['add', '.'], repo)
    runGit(['commit', '-m', 'initial'], repo)
    runGit(['branch', '-M', 'main'], repo)

    const descriptor = buildWorkerDescriptor({
      change: 'add-example',
      repoName: 'openspec',
      env: { CODEX_HOME: codexHome },
    })
    createWorkerWorktree({ descriptor, repoDir: repo })
    const result = preflightWorkerLaunch({ descriptor })

    assert.equal(result.branch, 'orchestrate/add-example')
    assert.equal(runGit(['branch', '--show-current'], repo), 'main')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worker result merges into main and cleanup waits until after merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-worker-merge-'))
  const repo = path.join(root, 'repo')
  const codexHome = path.join(root, 'codex-home')
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'add-example'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(repo, 'openspec', 'changes', 'add-example', 'tasks.md'),
    '- [ ] Test\n',
  )

  try {
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'test@example.invalid'], repo)
    runGit(['config', 'user.name', 'Test User'], repo)
    runGit(['add', '.'], repo)
    runGit(['commit', '-m', 'initial'], repo)
    runGit(['branch', '-M', 'main'], repo)

    const descriptor = buildWorkerDescriptor({
      change: 'add-example',
      repoName: 'openspec',
      env: { CODEX_HOME: codexHome },
    })
    createWorkerWorktree({ descriptor, repoDir: repo })
    fs.writeFileSync(
      path.join(descriptor.worktreePath, 'worker-output.txt'),
      'done\n',
    )
    runGit(['add', 'worker-output.txt'], descriptor.worktreePath)
    runGit(['commit', '-m', 'worker output'], descriptor.worktreePath)
    const commit = runGit(['rev-parse', 'HEAD'], descriptor.worktreePath)

    assert.throws(
      () =>
        mergeWorkerResult({
          result: {
            change: 'add-example',
            status: 'done',
            commit: '0000000000000000000000000000000000000000',
            filesTouched: ['worker-output.txt'],
          },
          repoDir: repo,
        }),
      /commit mismatch/,
    )

    const merge = mergeWorkerResult({
      result: {
        change: 'add-example',
        status: 'done',
        commit,
        filesTouched: ['worker-output.txt'],
      },
      repoDir: repo,
    })
    assert.equal(merge.branch, 'orchestrate/add-example')
    assert.equal(
      fs.readFileSync(path.join(repo, 'worker-output.txt'), 'utf8'),
      'done\n',
    )

    assert.throws(
      () =>
        cleanupArchivedWorkerWorktree({
          descriptor,
          repoDir: repo,
          archiveCompleted: false,
          validationPassed: true,
        }),
      /successful archive and validation/,
    )
    assert.ok(fs.existsSync(descriptor.worktreePath))

    cleanupArchivedWorkerWorktree({
      descriptor,
      repoDir: repo,
      archiveCompleted: true,
      validationPassed: true,
    })
    assert.ok(!fs.existsSync(descriptor.worktreePath))
    assert.equal(runGit(['branch', '--list', descriptor.branch], repo), '')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('archive checkpoint survives restart, rejects unrelated dirt, and commits exact lifecycle paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-archive-resume-'))
  const repo = path.join(root, 'repo')
  const change = 'validate-terminal'
  const changeDir = path.join(repo, 'openspec', 'changes', change)
  fs.mkdirSync(path.join(changeDir, 'specs', 'example'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.gitignore'), '.temp/\n')
  fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## Why\n\nTest.\n')
  fs.writeFileSync(path.join(changeDir, 'design.md'), '## Design\n\nTest.\n')
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] Complete\n')
  fs.writeFileSync(
    path.join(changeDir, 'specs', 'example', 'spec.md'),
    '## ADDED Requirements\n\n### Requirement: Example\nThe system SHALL work.\n',
  )

  try {
    runGit(['init'], repo)
    runGit(['config', 'user.email', 'test@example.invalid'], repo)
    runGit(['config', 'user.name', 'Test User'], repo)
    runGit(['add', '.'], repo)
    runGit(['commit', '-m', 'initial'], repo)
    runGit(['branch', '-M', 'main'], repo)

    const checkpoint = writeArchiveCheckpoint({
      change,
      gates: ['opsx-verify', 'adversarial-review', 'smoke', 'validate'],
      repoDir: repo,
    })
    assert.equal(checkpoint.state, 'awaiting-root-archive')

    const archiveDir = path.join(
      repo,
      'openspec',
      'changes',
      'archive',
      `2026-07-14-${change}`,
    )
    fs.mkdirSync(path.dirname(archiveDir), { recursive: true })
    fs.renameSync(changeDir, archiveDir)
    fs.mkdirSync(path.join(repo, 'openspec', 'specs', 'example'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(repo, 'openspec', 'specs', 'example', 'spec.md'),
      '# Example\n',
    )
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'do not stage\n')

    assert.throws(
      () => resumeArchivedChange({ change, repoDir: repo }),
      /Archive produced unrelated dirty paths/,
    )
    fs.rmSync(path.join(repo, 'unrelated.txt'))

    const resumed = resumeArchivedChange({ change, repoDir: repo })
    assert.equal(resumed.state, 'committed')
    assert.equal(runGit(['status', '--porcelain'], repo), '')
    assert.equal(
      runGit(['show', '--format=', '--name-only', 'HEAD'], repo)
        .split('\n')
        .filter(Boolean)
        .some((entry) => entry === 'unrelated.txt'),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('checkpoint handling rejects dirty primary, corrupt state, and stale HEAD', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opsx-checkpoint-failures-'),
  )
  const change = 'validate-terminal'
  const changeDir = path.join(root, 'openspec', 'changes', change)
  const stateDir = path.join(root, '.temp', 'opsxx-orchestrate')
  fs.mkdirSync(changeDir, { recursive: true })
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] Complete\n')

  try {
    assert.throws(
      () =>
        writeArchiveCheckpoint({
          change,
          gates: ['opsx-verify', 'adversarial-review', 'smoke', 'validate'],
          repoDir: root,
          execFile(command, args) {
            assert.equal(command, 'git')
            return args[0] === 'status' ? '?? unrelated.txt\0' : 'head'
          },
        }),
      /Primary checkout must be clean/,
    )

    fs.mkdirSync(stateDir, { recursive: true })
    const checkpointPath = path.join(stateDir, `${change}.json`)
    fs.writeFileSync(checkpointPath, '{bad json')
    assert.throws(
      () => resumeArchivedChange({ change, repoDir: root }),
      /Corrupt archive checkpoint/,
    )

    fs.writeFileSync(
      checkpointPath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: 'awaiting-root-archive',
        repository: fs.realpathSync(root),
        primaryHead: 'old-head',
        change,
      })}\n`,
    )
    assert.throws(
      () =>
        resumeArchivedChange({
          change,
          repoDir: root,
          execFile() {
            return 'new-head'
          },
        }),
      /Checkpoint HEAD is stale/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('aggregate validation failure preserves committed checkpoints', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-finalize-failure-'))
  const stateDir = path.join(root, '.temp', 'opsxx-orchestrate')
  const checkpointPath = path.join(stateDir, 'validate-terminal.json')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    checkpointPath,
    `${JSON.stringify({ change: 'validate-terminal', state: 'committed' })}\n`,
  )
  try {
    assert.throws(
      () =>
        finalizeRun({
          repoDir: root,
          execFile(command) {
            if (command === 'pnpm') throw new Error('aggregate failed')
            return ''
          },
        }),
      /aggregate failed/,
    )
    assert.equal(fs.existsSync(checkpointPath), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('worker verification rejects touched-path escape and merge conflicts abort cleanly', () => {
  const commit = '1111111111111111111111111111111111111111'
  const result = {
    change: 'add-example',
    status: 'done',
    commit,
    filesTouched: ['openspec/specs/example/spec.md'],
  }
  const calls = []
  const execFile = (_command, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff-tree') return 'openspec/specs/example/spec.md\0'
    if (args[0] === 'merge' && args[1] !== '--abort')
      throw new Error('content conflict')
    return ''
  }
  assert.throws(
    () => verifyWorkerResult({ result, execFile }),
    /escaped the assigned change boundary/,
  )

  const safeResult = { ...result, filesTouched: ['implementation.ts'] }
  const safeExecFile = (_command, args) => {
    calls.push(args)
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff-tree') return 'implementation.ts\0'
    if (args[0] === 'merge' && args[1] !== '--abort')
      throw new Error('content conflict')
    return ''
  }
  assert.throws(
    () => mergeWorkerResult({ result: safeResult, execFile: safeExecFile }),
    /Worker merge conflicted/,
  )
  assert.equal(
    calls.some((args) => args[0] === 'merge' && args[1] === '--abort'),
    true,
  )
})

test('worker verification accepts directory-level touched-path reports', () => {
  const commit = '1111111111111111111111111111111111111111'
  const result = {
    change: 'add-example',
    status: 'done',
    commit,
    filesTouched: ['apps/web', 'openspec/changes/add-example/tasks.md'],
  }
  const execFile = (_command, args) => {
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff-tree') {
      return [
        'apps/web/src/adapter.ts',
        'apps/web/src/adapter.test.ts',
        'openspec/changes/add-example/tasks.md',
        '',
      ].join('\0')
    }
    return ''
  }

  const verified = verifyWorkerResult({ result, execFile })

  assert.deepEqual(verified.touchedPaths, [
    'apps/web/src/adapter.test.ts',
    'apps/web/src/adapter.ts',
    'openspec/changes/add-example/tasks.md',
  ])
})

test('worker verification uses Git as authority when a report omits touched paths', () => {
  const commit = '1111111111111111111111111111111111111111'
  const result = {
    change: 'add-example',
    status: 'done',
    commit,
    filesTouched: ['apps/web/src/adapter.ts'],
  }
  const execFile = (_command, args) => {
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff-tree') {
      return 'apps/web/src/adapter.ts\0apps/web/src/adapter.test.ts\0'
    }
    return ''
  }

  const verified = verifyWorkerResult({ result, execFile })

  assert.deepEqual(verified.touchedPaths, [
    'apps/web/src/adapter.test.ts',
    'apps/web/src/adapter.ts',
  ])
})

test('worker verification rejects directory reports with untouched paths', () => {
  const commit = '1111111111111111111111111111111111111111'
  const result = {
    change: 'add-example',
    status: 'done',
    commit,
    filesTouched: ['apps/web', 'packages/untouched'],
  }
  const execFile = (_command, args) => {
    if (args[0] === 'rev-parse') return commit
    if (args[0] === 'rev-list') return '1'
    if (args[0] === 'diff-tree') return 'apps/web/src/adapter.ts\0'
    return ''
  }

  assert.throws(
    () => verifyWorkerResult({ result, execFile }),
    /touched-path report does not match/,
  )
})

test('checkpoint requires every integrated gate and successful finalize cleans state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opsx-finalize-success-'))
  const change = 'validate-terminal'
  const changeDir = path.join(root, 'openspec', 'changes', change)
  fs.mkdirSync(changeDir, { recursive: true })
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '- [x] Complete\n')
  try {
    assert.throws(
      () =>
        writeArchiveCheckpoint({
          change,
          gates: ['opsx-verify'],
          repoDir: root,
        }),
      /Missing integrated gate evidence/,
    )
    const stateDir = path.join(root, '.temp', 'opsxx-orchestrate')
    const checkpointPath = path.join(stateDir, `${change}.json`)
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      checkpointPath,
      `${JSON.stringify({ change, state: 'committed', workerDescriptor: null })}\n`,
    )
    const finalized = finalizeRun({
      repoDir: root,
      execFile(command) {
        return command === 'pnpm' ? 'validated' : ''
      },
    })
    assert.deepEqual(finalized.cleaned, [change])
    assert.equal(fs.existsSync(checkpointPath), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test(
  'opt-in Windows qualification resolves native Git and Node',
  { skip: process.env.OPENSPECX_WINDOWS_QUALIFY !== '1' },
  () => {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$ErrorActionPreference="Stop"; (Get-Command git).Source; (Get-Command node).Source',
      ],
      { encoding: 'utf8' },
    )
    assert.match(output, /git(?:\.exe)?/iu)
    assert.match(output, /node(?:\.exe)?/iu)
  },
)

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
