import assert from 'node:assert/strict'
import test from 'node:test'

import { archiveChangeFromCommand } from './codex-archive-command.mjs'

for (const [command, expected] of [
  [
    'mv openspec/changes/add-a openspec/changes/archive/2099-01-01-add-a',
    'add-a',
  ],
  [
    'command /usr/bin/mv -- "openspec/changes/add-b" "openspec/changes/archive/2099-01-01-add-b"',
    'add-b',
  ],
  [
    'git mv openspec/changes/add-c openspec/changes/archive/2099-01-01-add-c',
    'add-c',
  ],
]) {
  test(`detects archive command: ${command}`, () => {
    assert.equal(archiveChangeFromCommand(command), expected)
  })
}

for (const operator of [';', '|', '&&', '||']) {
  test(`ignores archive text behind quoted ${operator} operator`, () => {
    const command = `echo 'text ${operator} mv openspec/changes/add-a openspec/changes/archive/2099-add-a'`
    assert.equal(archiveChangeFromCommand(command), null)
  })
}

test('detects a real archive after a quoted embedded operator', () => {
  assert.equal(
    archiveChangeFromCommand(
      "echo 'not | a command' && mv openspec/changes/add-a openspec/changes/archive/2099-add-a",
    ),
    'add-a',
  )
})

test('detects an archive command after an unquoted newline', () => {
  assert.equal(
    archiveChangeFromCommand(
      'mkdir -p scratch\nmv openspec/changes/add-a openspec/changes/archive/2099-add-a',
    ),
    'add-a',
  )
})
