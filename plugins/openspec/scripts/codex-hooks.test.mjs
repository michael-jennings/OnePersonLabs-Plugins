import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const hooksDir = join(repoRoot, 'scripts')
const hookPath = (name) => join(hooksDir, name)

function runHook(name, input, args = []) {
  return runHookWithEnv(name, input, args, { CODEX_PROJECT_DIR: repoRoot })
}

function runHookWithEnv(name, input, args = [], env = {}) {
  return execFileSync('bash', [hookPath(name), ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENSPEC_HOOK_TEST: '1', ...env },
    input: JSON.stringify(input),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function runHookStatus(name, input, env = {}) {
  try {
    const stdout = execFileSync('bash', [hookPath(name)], {
      cwd: repoRoot,
      env: { ...process.env, OPENSPEC_HOOK_TEST: '1', ...env },
      input: JSON.stringify(input),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '',
    }
  }
}

function makeHookToolchainRoot() {
  const root = mkdtempSync(join(tmpdir(), 'openspec-hook-toolchain-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(
    join(repoRoot, 'scripts', 'codex-node-toolchain-path.sh'),
    join(root, 'scripts', 'codex-node-toolchain-path.sh'),
  )
  return root
}

function makeArchiveQualityGateRoot({ validateExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openspec-archive-quality-test-'))
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'pnpm'),
    '#!/usr/bin/env bash\n' +
      '[[ "$*" == "run validate" ]] || exit 64\n' +
      `exit ${validateExit}\n`,
    { mode: 0o755 },
  )
  return { root, bin }
}

function writeTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'openspec-hook-test-'))
  const file = join(dir, 'transcript.jsonl')
  writeFileSync(
    file,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  )
  return { dir, file }
}

function assertStopContinues(output) {
  const decision = JSON.parse(output)
  assert.equal(decision.continue, true)
}

test('discipline gate emits JSON block decisions in Stop mode', () => {
  const { dir, file } = writeTranscript([
    {
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I will leave this for a future change.',
          },
        ],
      },
    },
  ])

  try {
    const output = runHook('codex-response-discipline-gate.sh', {
      transcript_path: file,
    })
    const decision = JSON.parse(output)
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /future change/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill judge gate blocks skill edits without a supported review pass', () => {
  const { dir, file } = writeTranscript([
    {
      name: 'Edit',
      tool_input: {
        file_path: '/tmp/project/.agents/skills/example-skill/SKILL.md',
      },
    },
  ])

  try {
    const output = runHook('codex-skill-judge-gate.sh', {
      transcript_path: file,
    })
    const decision = JSON.parse(output)
    assert.equal(decision.decision, 'block')
    assert.match(decision.reason, /\$skill-judge/)
    assert.match(decision.reason, /\$skill-review/)
    assert.doesNotMatch(
      decision.reason,
      /knowledge-delta|freedom miscalibration/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill judge gate allows skill edits after skill judge review', () => {
  const { dir, file } = writeTranscript([
    {
      name: 'Edit',
      tool_input: {
        file_path: '/tmp/project/.agents/skills/example-skill/SKILL.md',
      },
    },
    {
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments:
          '{"cmd":"rtk sed -n \\"1,80p\\" .agents/skills/skill-judge/SKILL.md"}',
      },
    },
  ])

  try {
    assertStopContinues(
      runHook('codex-skill-judge-gate.sh', { transcript_path: file }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill judge gate allows skill edits after skill review audit', () => {
  const { dir, file } = writeTranscript([
    {
      name: 'Edit',
      tool_input: {
        file_path: '/tmp/project/.agents/skills/example-skill/SKILL.md',
      },
    },
    {
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments:
          '{"cmd":"rtk sed -n \\"1,80p\\" .agents/skills/skill-review/SKILL.md"}',
      },
    },
  ])

  try {
    assertStopContinues(
      runHook('codex-skill-judge-gate.sh', { transcript_path: file }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('skill judge gate allows skill edits after adversarial review fallback', () => {
  const { dir, file } = writeTranscript([
    {
      name: 'Edit',
      tool_input: {
        file_path: '/tmp/project/.agents/skills/example-skill/SKILL.md',
      },
    },
    {
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments:
          '{"cmd":"rtk sed -n \\"1,80p\\" .agents/skills/adversarial-review/SKILL.md"}',
      },
    },
  ])

  try {
    assertStopContinues(
      runHook('codex-skill-judge-gate.sh', { transcript_path: file }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('archive quality gate normalizes Node and pnpm PATH before validation', () => {
  const projectRoot = makeHookToolchainRoot()
  const fakeHome = join(projectRoot, 'home')
  const fakeNodeBin = join(
    fakeHome,
    '.nvm',
    'versions',
    'node',
    'v99.0.0',
    'bin',
  )
  const fakePnpmBin = join(fakeHome, '.local', 'share', 'pnpm')
  const brokenBin = join(projectRoot, 'broken-bin')
  mkdirSync(fakeNodeBin, { recursive: true })
  mkdirSync(fakePnpmBin, { recursive: true })
  mkdirSync(brokenBin, { recursive: true })

  writeFileSync(
    join(fakeNodeBin, 'node'),
    '#!/usr/bin/env bash\n' +
      'if [[ "$1" == "--version" ]]; then echo v99.0.0; exit 0; fi\n' +
      `exec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(fakePnpmBin, 'pnpm'),
    '#!/usr/bin/env bash\n' +
      `if [[ "$(command -v node)" != "${join(fakeNodeBin, 'node')}" ]]; then\n` +
      '  echo "wrong node: $(command -v node)" >&2\n' +
      '  exit 127\n' +
      'fi\n' +
      '[[ "$*" == "run validate" ]] || exit 64\n' +
      'exit 0\n',
    { mode: 0o755 },
  )
  writeFileSync(
    join(brokenBin, 'pnpm'),
    '#!/usr/bin/env bash\n' +
      'echo "exec: node: not found" >&2\n' +
      'exit 127\n',
    { mode: 0o755 },
  )

  try {
    const result = runHookStatus(
      'codex-openspec-archive-quality-gate.sh',
      {
        tool_input: {
          command:
            'mv openspec/changes/add-one openspec/changes/archive/2099-01-01-add-one',
        },
      },
      {
        CODEX_PROJECT_DIR: projectRoot,
        HOME: fakeHome,
        NVM_DIR: join(fakeHome, '.nvm'),
        PATH: `${brokenBin}:/usr/bin:/bin`,
      },
    )
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('archive quality gate fails closed when the parser runtime is unavailable', () => {
  const projectRoot = makeHookToolchainRoot()
  const emptyHome = join(projectRoot, 'empty-home')
  mkdirSync(emptyHome)
  try {
    const result = runHookStatus(
      'codex-openspec-archive-quality-gate.sh',
      {
        tool_input: {
          command:
            'mv openspec/changes/add-one openspec/changes/archive/2099-01-01-add-one',
        },
      },
      {
        CODEX_PROJECT_DIR: projectRoot,
        HOME: emptyHome,
        NVM_DIR: join(emptyHome, 'missing-nvm'),
        PATH: '/usr/bin:/bin',
      },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /parser requires Node\.js/u)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('archive quality gate fails closed when archive input decoding fails', () => {
  const fixture = makeArchiveQualityGateRoot()
  writeFileSync(join(fixture.bin, 'jq'), '#!/usr/bin/env bash\nexit 127\n', {
    mode: 0o755,
  })
  try {
    const result = runHookStatus(
      'codex-openspec-archive-quality-gate.sh',
      {
        tool_input: {
          command:
            'mv openspec/changes/add-one openspec/changes/archive/2099-01-01-add-one',
        },
      },
      {
        CODEX_PROJECT_DIR: fixture.root,
        PATH: `${fixture.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /input could not be decoded/u)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('archive quality gate allows an archive after ordinary validation passes', () => {
  const fixture = makeArchiveQualityGateRoot()
  try {
    const result = runHookStatus(
      'codex-openspec-archive-quality-gate.sh',
      {
        tool_input: {
          command:
            'mv openspec/changes/add-feature openspec/changes/archive/2099-01-01-add-feature',
        },
      },
      {
        CODEX_PROJECT_DIR: fixture.root,
        PATH: `${fixture.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    )
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('archive quality gate preserves validation blocking for non-cutover changes', () => {
  const fixture = makeArchiveQualityGateRoot({ validateExit: 1 })
  try {
    const result = runHookStatus(
      'codex-openspec-archive-quality-gate.sh',
      {
        tool_input: {
          command:
            'mv openspec/changes/fix-unrelated-docs openspec/changes/archive/2099-01-01-fix-unrelated-docs',
        },
      },
      {
        CODEX_PROJECT_DIR: fixture.root,
        PATH: `${fixture.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /pnpm run validate failed/)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate blocks backticked known skill names', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const referencePath = join(root, '.agents', 'references', 'example.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(root, '.agents', 'references'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(referencePath, 'Use `test-skill --with-args` before editing.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: referencePath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /use the native dollar-sigil form/i)
    assert.match(result.stderr, /`test-skill --with-args`/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate allows dollar-sigil skill names', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const referencePath = join(root, '.agents', 'references', 'example.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(root, '.agents', 'references'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(referencePath, 'Use $test-skill before editing.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: referencePath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate exits before skill discovery outside agent tooling paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const sourcePath = join(root, 'packages', 'demo', 'src', 'example.md')
  mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true })
  writeFileSync(sourcePath, 'This app doc mentions `test-skill` literally.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: sourcePath } },
      {
        CODEX_PROJECT_DIR: root,
        CODEX_HOME: join(root, 'missing-codex-home'),
        HOME: join(root, 'missing-home'),
      },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate skips unrelated nested agent markdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const generatedPath = join(root, '.agents', 'generated', 'example.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(root, '.agents', 'generated'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(generatedPath, 'Generated note mentions `test-skill`.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: generatedPath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate skips non-markdown agent reference files', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const referencePath = join(root, '.agents', 'references', 'example.txt')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(root, '.agents', 'references'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(referencePath, 'Generated note mentions `test-skill`.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: referencePath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate scans user skill paths outside the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const home = join(root, 'home')
  const repoSkillDir = join(root, '.agents', 'skills', 'test-skill')
  const userSkillDir = join(home, '.agents', 'skills', 'user-skill')
  const userSkillPath = join(userSkillDir, 'SKILL.md')
  mkdirSync(repoSkillDir, { recursive: true })
  mkdirSync(userSkillDir, { recursive: true })
  writeFileSync(
    join(repoSkillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(userSkillPath, 'Use `test-skill` from here.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: userSkillPath } },
      { CODEX_PROJECT_DIR: root, HOME: home },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /`test-skill`/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate skips stock OpenSpec skill files', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const stockSkillDir = join(root, '.agents', 'skills', 'opsx-apply')
  const stockSkillPath = join(stockSkillDir, 'SKILL.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(stockSkillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(stockSkillPath, 'Stock docs mention `test-skill` literally.\n')

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: stockSkillPath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate still scans OpenSpec extension skill files', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const extensionSkillDir = join(root, '.agents', 'skills', 'opsxx-helper')
  const extensionSkillPath = join(extensionSkillDir, 'SKILL.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(extensionSkillDir, { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )
  writeFileSync(
    extensionSkillPath,
    'Extension docs mention `test-skill` literally.\n',
  )

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: extensionSkillPath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 2)
    assert.match(result.stderr, /`test-skill`/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate scans skill-owned support surfaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const supportPaths = [
    join(root, '.agents', 'skills', 'helper-skill', 'references', 'guide.md'),
    join(root, '.agents', 'skills', 'helper-skill', 'scripts', 'runner.sh'),
    join(root, '.agents', 'skills', 'helper-skill', 'agents', 'openai.yaml'),
  ]
  mkdirSync(skillDir, { recursive: true })
  for (const supportPath of supportPaths) {
    mkdirSync(dirname(supportPath), { recursive: true })
  }
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )

  try {
    for (const supportPath of supportPaths) {
      writeFileSync(supportPath, 'Use `test-skill` here.\n')
      const result = runHookStatus(
        'codex-skill-reference-sigil-gate.sh',
        { tool_input: { file_path: supportPath } },
        { CODEX_PROJECT_DIR: root },
      )
      assert.equal(result.status, 2, supportPath)
      assert.match(result.stderr, /`test-skill`/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate scans declarative Codex config and root scripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'test-skill')
  const supportPaths = [
    join(root, '.codex', 'hooks.json'),
    join(root, 'scripts', 'example.mjs'),
  ]
  mkdirSync(skillDir, { recursive: true })
  for (const supportPath of supportPaths) {
    mkdirSync(dirname(supportPath), { recursive: true })
  }
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: test-skill\ndescription: test\n---\n',
  )

  try {
    for (const supportPath of supportPaths) {
      writeFileSync(supportPath, 'Use `test-skill` here.\n')
      const result = runHookStatus(
        'codex-skill-reference-sigil-gate.sh',
        { tool_input: { file_path: supportPath } },
        { CODEX_PROJECT_DIR: root },
      )
      assert.equal(result.status, 2, supportPath)
      assert.match(result.stderr, /`test-skill`/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skill reference sigil gate falls back to folder names and honors same-line bypass', () => {
  const root = mkdtempSync(join(tmpdir(), 'openspec-skill-sigil-test-'))
  const skillDir = join(root, '.agents', 'skills', 'folder-skill')
  const referencePath = join(root, '.agents', 'references', 'example.md')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(join(root, '.agents', 'references'), { recursive: true })
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '# Missing frontmatter on purpose\n',
  )
  writeFileSync(
    referencePath,
    'Literal `folder-skill` token. <!-- skill-reference-sigil-bypass -->\n',
  )

  try {
    const result = runHookStatus(
      'codex-skill-reference-sigil-gate.sh',
      { tool_input: { file_path: referencePath } },
      { CODEX_PROJECT_DIR: root },
    )
    assert.equal(result.status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
