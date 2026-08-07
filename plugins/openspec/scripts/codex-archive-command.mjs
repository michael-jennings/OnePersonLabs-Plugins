#!/usr/bin/env node

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function splitSegments(command) {
  const segments = []
  let current = ''
  let quote = null
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      current += character
      continue
    }
    const pair = command.slice(index, index + 2)
    if (
      character === ';' ||
      character === '|' ||
      character === '\n' ||
      character === '\r' ||
      pair === '&&' ||
      pair === '||'
    ) {
      if (current.trim()) segments.push(current.trim())
      current = ''
      if (pair === '&&' || pair === '||') index += 1
      continue
    }
    current += character
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function words(segment) {
  const result = []
  let current = ''
  let quote = null
  let escaped = false
  let started = false

  const finish = () => {
    if (started) result.push(current)
    current = ''
    started = false
  }

  for (const character of segment) {
    if (escaped) {
      current += character
      started = true
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      else current += character
      started = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
    } else if (/\s/u.test(character)) finish()
    else {
      current += character
      started = true
    }
  }
  if (escaped) current += '\\'
  finish()
  return result
}

function operands(tokens) {
  let index = 0
  if (tokens[index] === 'command') {
    index += 1
    while (tokens[index]?.startsWith('-')) index += 1
  }

  const executable = tokens[index]
  if (!executable) return null
  if (path.basename(executable) === 'git' && tokens[index + 1] === 'mv') {
    index += 2
  } else if (path.basename(executable) === 'mv') {
    index += 1
  } else return null

  while (tokens[index]?.startsWith('-')) index += 1
  return tokens.slice(index)
}

export function archiveChangeFromCommand(command) {
  for (const segment of splitSegments(command)) {
    const values = operands(words(segment))
    if (!values || values.length < 2) continue
    const source = values[0].replace(/\/$/u, '')
    const destination = values[1].replace(/\/$/u, '')
    const match = /(?:^|\/)openspec\/changes\/([a-z][a-z0-9-]*)$/u.exec(source)
    if (
      match &&
      /(?:^|\/)openspec\/changes\/archive(?:\/|$)/u.test(destination)
    ) {
      return match[1]
    }
  }
  return null
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const change = archiveChangeFromCommand(process.argv[2] ?? '')
  if (change) process.stdout.write(`${change}\n`)
  else process.exitCode = 3
}
