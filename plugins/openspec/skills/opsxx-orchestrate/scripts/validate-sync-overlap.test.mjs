// Tests for the skill-owned validate-sync-overlap.mjs -- run with `node --test`.
//
// These invoke the REAL script (via --changes-root pointed at a temp fixture),
// not a re-implementation, so a regression in the production script is caught.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'validate-sync-overlap.mjs',
)

/** Build a synthetic openspec/changes layout. specs: [{change, caps[], deltas:{cap:reqs[]}}]. */
function makeFixture(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sov-test-'))
  const changesRoot = path.join(root, 'openspec', 'changes')
  fs.mkdirSync(path.join(changesRoot, 'archive'), { recursive: true })
  for (const { change, caps = [], deltas = {} } of specs) {
    fs.mkdirSync(path.join(changesRoot, change), { recursive: true })
    fs.writeFileSync(
      path.join(changesRoot, change, 'proposal.md'),
      `# ${change}\n`,
    )
    for (const cap of caps) {
      fs.mkdirSync(path.join(changesRoot, change, 'specs', cap), {
        recursive: true,
      })
    }
    for (const [cap, requirements] of Object.entries(deltas)) {
      const capDir = path.join(changesRoot, change, 'specs', cap)
      fs.mkdirSync(capDir, { recursive: true })
      fs.writeFileSync(
        path.join(capDir, 'spec.md'),
        [
          '## ADDED Requirements',
          '',
          ...requirements.flatMap((requirement) => [
            `### Requirement: ${requirement}`,
            'The system SHALL do the thing.',
            '',
            '#### Scenario: Basic case',
            '- **WHEN** it runs',
            '- **THEN** it works',
            '',
          ]),
        ].join('\n'),
      )
    }
  }
  return { root, changesRoot }
}

function run(changesRoot, extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [SCRIPT, '--changes-root', changesRoot, ...extraArgs],
    {
      encoding: 'utf8',
    },
  )
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('fails when two active changes claim the same capability', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-alpha', caps: ['event-system'] },
    { change: 'add-beta', caps: ['event-system', 'schema-types'] },
  ])
  try {
    const { status, stderr } = run(changesRoot)
    assert.equal(status, 1)
    assert.ok(stderr.includes('event-system'))
    assert.ok(stderr.includes('add-alpha') && stderr.includes('add-beta'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('passes when all capability claims are disjoint', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-one', caps: ['event-system'] },
    { change: 'add-two', caps: ['schema-types'] },
  ])
  try {
    assert.equal(run(changesRoot).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('passes when there are no active changes', () => {
  const { root, changesRoot } = makeFixture([])
  try {
    assert.equal(run(changesRoot).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('passes when active changes have no specs/ directories', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-no-delta', caps: [] },
    { change: 'add-also-no-delta', caps: [] },
  ])
  try {
    assert.equal(run(changesRoot).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('archive subdirectory is ignored when scanning active changes', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-current', caps: ['event-system'] },
  ])
  fs.mkdirSync(
    path.join(changesRoot, 'archive', 'add-old', 'specs', 'event-system'),
    {
      recursive: true,
    },
  )
  try {
    assert.equal(run(changesRoot).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('reports all claimants when three changes share a capability', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-x', caps: ['shared-cap'] },
    { change: 'add-y', caps: ['shared-cap'] },
    { change: 'add-z', caps: ['shared-cap'] },
  ])
  try {
    const { status, stderr } = run(changesRoot)
    assert.equal(status, 1)
    for (const n of ['shared-cap', 'add-x', 'add-y', 'add-z'])
      assert.ok(stderr.includes(n))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('passes when same-capability deltas touch disjoint requirements', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-alpha', deltas: { 'event-system': ['Alpha Routing'] } },
    { change: 'add-beta', deltas: { 'event-system': ['Beta Routing'] } },
  ])
  try {
    assert.equal(run(changesRoot).status, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fails when same-capability deltas touch the same requirement', () => {
  const { root, changesRoot } = makeFixture([
    {
      change: 'add-alpha',
      deltas: { 'event-system': ['Unified Event Stream'] },
    },
    {
      change: 'add-beta',
      deltas: { 'event-system': ['Unified Event Stream'] },
    },
  ])
  try {
    const { status, stderr } = run(changesRoot)
    assert.equal(status, 1)
    assert.ok(stderr.includes('event-system::Unified Event Stream'))
    assert.ok(stderr.includes('add-alpha') && stderr.includes('add-beta'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('restricting the consideration set to a non-colliding subset passes', () => {
  // Global set collides on event-system (alpha+beta), but the wave [alpha, gamma] does not.
  const { root, changesRoot } = makeFixture([
    { change: 'add-alpha', caps: ['event-system'] },
    { change: 'add-beta', caps: ['event-system'] },
    { change: 'add-gamma', caps: ['schema-types'] },
  ])
  try {
    assert.equal(run(changesRoot).status, 1, 'global set collides')
    assert.equal(
      run(changesRoot, ['add-alpha', 'add-gamma']).status,
      0,
      'disjoint wave passes',
    )
    assert.equal(
      run(changesRoot, ['add-alpha', 'add-beta']).status,
      1,
      'colliding wave fails',
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('--json emits claims and conflicts and exits 0', () => {
  const { root, changesRoot } = makeFixture([
    { change: 'add-alpha', caps: ['event-system'] },
    { change: 'add-beta', caps: ['event-system'] },
  ])
  try {
    const { status, stdout } = run(changesRoot, ['--json'])
    assert.equal(status, 0, '--json always exits 0 (data mode)')
    const data = JSON.parse(stdout)
    assert.deepEqual(data.claims['event-system'].sort(), [
      'add-alpha',
      'add-beta',
    ])
    assert.equal(data.conflicts.length, 1)
    assert.equal(data.conflicts[0].cap, 'event-system')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
