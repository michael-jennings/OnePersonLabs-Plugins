// Tests for scripts/codex-openspec-archive-order-gate.sh -- run with `node --test`.
//
// Strategy: the hook calls the dependency-audit skill's graph executable.
// Tests create a fixture directory whose skill script is a stub that
// emits controlled JSON graphs, letting us exercise the hook's decision logic
// without depending on real changes. No real change set is mutated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HOOK = path.resolve(
  import.meta.dirname,
  'codex-openspec-archive-order-gate.sh',
)

/**
 * Create a minimal fixture at a temp dir.
 * The fixture's dependency-audit script is a stub that outputs `graphJson`
 * when invoked with `--graph`, exactly mirroring the real parser's CLI contract.
 *
 * @param {object} graphJson - The graph object the stub should emit.
 * @returns {string} The fixture root path (used as CODEX_PROJECT_DIR).
 */
function makeFixture(graphJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oag-test-'))
  const scriptDirectory = path.join(
    root,
    '.agents',
    'skills',
    'opsxx-dependency-audit',
    'scripts',
  )
  fs.mkdirSync(scriptDirectory, { recursive: true })

  // Stub parser: outputs the canned graph JSON when called with --graph.
  const stubContent = [
    '#!/usr/bin/env node',
    `const graph = ${JSON.stringify(graphJson, null, 2)};`,
    "if (process.argv[2] === '--graph') {",
    "  process.stdout.write(JSON.stringify(graph, null, 2) + '\\n');",
    '  process.exit(0);',
    '}',
    'process.exit(2);',
  ].join('\n')
  fs.writeFileSync(path.join(scriptDirectory, 'opsxx-deps.mjs'), stubContent, {
    mode: 0o755,
  })

  return root
}

function cleanFixture(root) {
  fs.rmSync(root, { recursive: true, force: true })
}

/**
 * Run the hook with a synthetic mv command against a fixture root.
 * Returns { status, stderr }.
 */
function runHook(fixtureRoot, changeName) {
  const mvCmd = `mv openspec/changes/${changeName} openspec/changes/archive/2099-01-01-${changeName}`
  const input = JSON.stringify({ tool_input: { command: mvCmd } })
  const result = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CODEX_PROJECT_DIR: fixtureRoot },
    cwd: fixtureRoot,
  })
  return { status: result.status, stderr: result.stderr }
}

// --- Scenario 1: change has an active upstream -> blocked (exit 2) ---
test('blocks archive when the change has an active upstream', () => {
  // add-upstream -> add-downstream (add-upstream is still active)
  const graph = {
    nodes: ['add-upstream', 'add-downstream'],
    edges: [
      {
        from: 'add-upstream',
        to: 'add-downstream',
        tier: 'required',
        anchor: null,
      },
    ],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  try {
    const { status, stderr } = runHook(root, 'add-downstream')
    assert.equal(
      status,
      2,
      'expected exit 2 (blocked) when active upstream exists',
    )
    assert.ok(
      stderr.includes('add-upstream'),
      `expected blocking upstream named in stderr; got: ${stderr}`,
    )
    assert.ok(
      stderr.includes('add-downstream'),
      `expected blocked change named in stderr; got: ${stderr}`,
    )
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 2: upstream itself has no upstreams -> allowed (exit 0) ---
test('allows archive when the change has no active upstreams', () => {
  // add-upstream depends on nothing -- no edge has `to == add-upstream`
  const graph = {
    nodes: ['add-upstream', 'add-downstream'],
    edges: [
      {
        from: 'add-upstream',
        to: 'add-downstream',
        tier: 'required',
        anchor: null,
      },
    ],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  try {
    const { status } = runHook(root, 'add-upstream')
    assert.equal(status, 0, 'expected exit 0 (allowed) for the leaf upstream')
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 3: all upstreams archived -> active edges[] is empty -> allowed ---
test('allows archive when all upstreams are already archived', () => {
  // add-shipped is archived (archivedEdges), not in edges[] -- so no active upstreams.
  const graph = {
    nodes: ['add-consumer'],
    edges: [], // archived upstreams are NOT in edges[]
    archivedEdges: [
      { from: 'add-shipped', to: 'add-consumer', tier: 'required' },
    ],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  try {
    const { status } = runHook(root, 'add-consumer')
    assert.equal(status, 0, 'expected exit 0 when all upstreams are archived')
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 4: non-archive mv is ignored (exit 0) ---
test('ignores mv commands that are not archive operations', () => {
  const graph = {
    nodes: [],
    edges: [],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  const input = JSON.stringify({
    tool_input: { command: 'mv foo.txt bar.txt' },
  })
  const result = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CODEX_PROJECT_DIR: root },
    cwd: root,
  })
  try {
    assert.equal(result.status, 0, 'expected exit 0 for non-archive mv')
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 5: Coherence-tier active upstream also blocks ---
test('blocks archive on Coherence-tier upstream (Coherence is a real ordering edge)', () => {
  // The graph edges[] includes both required and coherence edges -- both block.
  const graph = {
    nodes: ['add-coherence-upstream', 'add-coherence-dependent'],
    edges: [
      {
        from: 'add-coherence-upstream',
        to: 'add-coherence-dependent',
        tier: 'coherence',
        anchor: null,
      },
    ],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  try {
    const { status } = runHook(root, 'add-coherence-dependent')
    assert.equal(
      status,
      2,
      'expected exit 2: Coherence upstream is still a real ordering edge',
    )
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 6: multiple active upstreams -> all are named in the error ---
test('names all blocking upstreams when multiple are active', () => {
  const graph = {
    nodes: ['add-a', 'add-b', 'add-c'],
    edges: [
      { from: 'add-a', to: 'add-c', tier: 'required', anchor: null },
      { from: 'add-b', to: 'add-c', tier: 'required', anchor: null },
    ],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  try {
    const { status, stderr } = runHook(root, 'add-c')
    assert.equal(
      status,
      2,
      'expected exit 2 when multiple upstreams are active',
    )
    assert.ok(
      stderr.includes('add-a'),
      `expected add-a in stderr; got: ${stderr}`,
    )
    assert.ok(
      stderr.includes('add-b'),
      `expected add-b in stderr; got: ${stderr}`,
    )
  } finally {
    cleanFixture(root)
  }
})

// --- Scenario 7: non-Bash tool input (e.g. no tool_input.command) is ignored ---
test('ignores input that has no command field', () => {
  const graph = {
    nodes: [],
    edges: [],
    archivedEdges: [],
    dangling: [],
    acyclic: true,
    cycles: [],
  }
  const root = makeFixture(graph)
  const input = JSON.stringify({ tool_input: { path: '/some/file' } })
  const result = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CODEX_PROJECT_DIR: root },
    cwd: root,
  })
  try {
    assert.equal(result.status, 0, 'expected exit 0 for non-Bash input')
  } finally {
    cleanFixture(root)
  }
})

test('fails closed when dependency graph output has no edges array', () => {
  const root = makeFixture({ nodes: [] })
  try {
    const { status, stderr } = runHook(root, 'add-example')
    assert.equal(status, 2)
    assert.match(stderr, /graph output is malformed/u)
  } finally {
    cleanFixture(root)
  }
})

test('fails closed when the configured project root is unavailable', () => {
  const root = makeFixture({ edges: [] })
  const missing = path.join(root, 'missing')
  const input = JSON.stringify({
    tool_input: {
      command:
        '/usr/bin/mv openspec/changes/add-example openspec/changes/archive/2099-add-example',
    },
  })
  try {
    const result = spawnSync('bash', [HOOK], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CODEX_PROJECT_DIR: missing },
      cwd: root,
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /project root is unavailable/u)
  } finally {
    cleanFixture(root)
  }
})

test('fails closed when the archive parser runtime is unavailable', () => {
  const root = makeFixture({ edges: [] })
  const home = path.join(root, 'empty-home')
  fs.mkdirSync(home)
  const input = JSON.stringify({
    tool_input: {
      command:
        'mv openspec/changes/add-example openspec/changes/archive/2099-add-example',
    },
  })
  try {
    const result = spawnSync('bash', [HOOK], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_PROJECT_DIR: root,
        HOME: home,
        NVM_DIR: path.join(home, 'missing-nvm'),
        PATH: '/usr/bin:/bin',
      },
      cwd: root,
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /parser requires Node\.js/u)
  } finally {
    cleanFixture(root)
  }
})

test('fails closed when archive hook input decoding fails', () => {
  const root = makeFixture({ edges: [] })
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'jq'), '#!/usr/bin/env bash\nexit 127\n', {
    mode: 0o755,
  })
  const input = JSON.stringify({
    tool_input: {
      command:
        'mv openspec/changes/add-example openspec/changes/archive/2099-add-example',
    },
  })
  try {
    const result = spawnSync('bash', [HOOK], {
      input,
      encoding: 'utf8',
      env: {
        ...process.env,
        CODEX_PROJECT_DIR: root,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      cwd: root,
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /input could not be decoded/u)
  } finally {
    cleanFixture(root)
  }
})
