#!/usr/bin/env node
// Deterministic scheduler substrate for opsxx-orchestrate.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  assertResolvedDependencies,
  buildChangeGraph,
} from '../../opsxx-dependency-audit/scripts/opsxx-deps.mjs'
import { computeClaims } from './validate-sync-overlap.mjs'
import {
  backlogBlockedEvents,
  buildAuthoringEvents,
  deltaCapableChanges,
  claimsByChange,
  overlapFree,
  unblockedNodes,
} from './opsxx-orchestrate-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = process.env.CODEX_PROJECT_DIR
  ? path.resolve(process.env.CODEX_PROJECT_DIR)
  : path.resolve(__dirname, '../../../..')
export const MAX_WORKTREE_DIRS = 15
export const MAX_LIVE_WORKTREE_WORKERS = Math.min(15, MAX_WORKTREE_DIRS)
export const CHECKPOINT_SCHEMA_VERSION = 1
export const PARENT_INTEGRATION_STEPS = [
  'merge',
  'opsx-verify',
  'adversarial-review',
  'smoke',
  'validate',
  'opsx-sync',
  'opsx-archive',
]

const WORKER_PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '..', 'resources', 'worker-prompt.md'),
  'utf8',
)

function parseArgs(argv) {
  const args = {
    changesRoot: path.join(repoRoot, 'openspec', 'changes'),
    json: false,
    completionOrder: [],
    launchWorkers: false,
    dryLaunch: false,
    resumeDirtyTargets: [],
    discardDirtyTargets: [],
    checkpointArchive: null,
    resumeArchive: null,
    finalizeRun: false,
    integrateWorker: null,
    collectWorkers: false,
    gates: [],
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--changes-root') args.changesRoot = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--launch-workers') args.launchWorkers = true
    else if (arg === '--dry-launch') args.dryLaunch = true
    else if (arg === '--resume-dirty-target')
      args.resumeDirtyTargets.push(argv[++i])
    else if (arg === '--discard-dirty-target')
      args.discardDirtyTargets.push(argv[++i])
    else if (arg === '--checkpoint-archive') args.checkpointArchive = argv[++i]
    else if (arg === '--resume-archive') args.resumeArchive = argv[++i]
    else if (arg === '--finalize-run') args.finalizeRun = true
    else if (arg === '--integrate-worker') args.integrateWorker = argv[++i]
    else if (arg === '--collect-workers') args.collectWorkers = true
    else if (arg === '--gate') args.gates.push(argv[++i])
    else if (arg === '--completion-order') {
      args.completionOrder = argv[++i]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  for (const change of [
    ...args.resumeDirtyTargets,
    ...args.discardDirtyTargets,
    args.checkpointArchive,
    args.resumeArchive,
    args.integrateWorker,
  ].filter(Boolean)) {
    validateChangeName(change)
  }
  return args
}

function shellOut(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options }).trim()
}

function shellOutRaw(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

function validateChangeName(change) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(change)) {
    throw new Error(`Invalid change name for worker launch: ${change}`)
  }
}

export function buildWorkerPrompt(change) {
  validateChangeName(change)
  return WORKER_PROMPT_TEMPLATE.replaceAll('$CHANGE-NAME', change)
}

export function workerBranch(change) {
  validateChangeName(change)
  return `orchestrate/${change}`
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

export function codexWorktreesRoot(env = process.env) {
  return path.join(codexHome(env), 'worktrees')
}

export function buildWorkerDescriptor({
  change,
  repoName = path.basename(repoRoot),
  env = process.env,
} = {}) {
  validateChangeName(change)
  const worktreeRoot = path.resolve(codexWorktreesRoot(env))
  const worktreePath = path.join(worktreeRoot, `${repoName}-agent-${change}`)
  const logDir = path.join(worktreeRoot, '.logs', change)
  return {
    change,
    branch: workerBranch(change),
    worktreeRoot,
    worktreePath,
    logDir,
  }
}

export function runtimeStateRoot({ repoDir = repoRoot } = {}) {
  return path.join(repoDir, '.temp', 'opsxx-orchestrate')
}

function gitOutput(repoDir, args, execFile = shellOut) {
  return execFile('git', args, { cwd: repoDir })
}

export function gitStatusPaths({
  repoDir = repoRoot,
  execFile = shellOutRaw,
} = {}) {
  const output = gitOutput(
    repoDir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    execFile,
  )
  const records = output.split('\0').filter(Boolean)
  const paths = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const hasStatusPrefix = /^[ MADRCU?!]{2} /u.test(record)
    const hasTrimmedStatusPrefix =
      !hasStatusPrefix && /^[MADRCU?!] /u.test(record)
    const status = hasStatusPrefix
      ? record.slice(0, 2)
      : hasTrimmedStatusPrefix
        ? record[0]
        : ''
    paths.push(
      normalizeRelativePath(
        hasStatusPrefix
          ? record.slice(3)
          : hasTrimmedStatusPrefix
            ? record.slice(2)
            : record,
      ),
    )
    if (
      /[RC]/u.test(status) &&
      records[index + 1] &&
      !/^[ MADRCU?!]{2} /u.test(records[index + 1])
    ) {
      paths.push(normalizeRelativePath(records[++index]))
    }
  }
  return [...new Set(paths)].sort()
}

export function assertPrimaryClean({
  repoDir = repoRoot,
  execFile = shellOut,
} = {}) {
  const dirtyPaths = gitStatusPaths({ repoDir, execFile })
  if (dirtyPaths.length > 0) {
    throw new Error(
      `Primary checkout must be clean before orchestration mutation:\n${dirtyPaths.join('\n')}`,
    )
  }
}

function hashDirectory(directory, fsImpl = fs) {
  if (!fsImpl.existsSync(directory))
    throw new Error(`Missing directory: ${directory}`)
  const hash = createHash('sha256')
  for (const relative of walkFiles(directory, '', fsImpl)) {
    hash.update(normalizeRelativePath(relative))
    hash.update('\0')
    hash.update(fsImpl.readFileSync(path.join(directory, relative)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function deltaCapabilities(changeDir, fsImpl = fs) {
  const specsDir = path.join(changeDir, 'specs')
  if (!fsImpl.existsSync(specsDir)) return []
  return fsImpl
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function checkpointPath({ repoDir = repoRoot, change }) {
  validateChangeName(change)
  return path.join(runtimeStateRoot({ repoDir }), `${change}.json`)
}

function workerStatePath({ repoDir = repoRoot, change }) {
  validateChangeName(change)
  return path.join(runtimeStateRoot({ repoDir }), 'workers', `${change}.json`)
}

function readWorkerState({ repoDir = repoRoot, change, fsImpl = fs }) {
  const target = workerStatePath({ repoDir, change })
  if (!fsImpl.existsSync(target)) {
    throw new Error(`Missing worker runtime state for ${change}: ${target}`)
  }
  try {
    return JSON.parse(fsImpl.readFileSync(target, 'utf8'))
  } catch (error) {
    throw new Error(
      `Malformed worker runtime state for ${change}: ${error.message}`,
    )
  }
}

export function updateWorkerState({
  change,
  status,
  repoDir = repoRoot,
  fsImpl = fs,
} = {}) {
  const state = readWorkerState({ repoDir, change, fsImpl })
  const target = workerStatePath({ repoDir, change })
  const updated = { ...state, status, updatedAt: new Date().toISOString() }
  fsImpl.writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`)
  return updated
}

function withRuntimeLock({ repoDir = repoRoot, fsImpl = fs }, action) {
  const stateRoot = runtimeStateRoot({ repoDir })
  fsImpl.mkdirSync(stateRoot, { recursive: true })
  const lockPath = path.join(stateRoot, 'run.lock')
  let descriptor
  try {
    descriptor = fsImpl.openSync(lockPath, 'wx')
  } catch {
    throw new Error(
      `Orchestration runtime state is concurrently claimed: ${lockPath}`,
    )
  }
  try {
    return action(stateRoot)
  } finally {
    fsImpl.closeSync(descriptor)
    fsImpl.rmSync(lockPath, { force: true })
  }
}

export function writeArchiveCheckpoint({
  change,
  gates,
  workerCommit = null,
  workerDescriptor = null,
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  validateChangeName(change)
  const requiredGates = [
    'opsx-verify',
    'adversarial-review',
    'smoke',
    'validate',
  ]
  const gateSet = new Set(gates)
  const missing = requiredGates.filter((gate) => !gateSet.has(gate))
  if (missing.length > 0)
    throw new Error(`Missing integrated gate evidence: ${missing.join(', ')}`)
  assertPrimaryClean({ repoDir, execFile })
  const changeDir = path.join(repoDir, 'openspec', 'changes', change)
  const checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    state: 'awaiting-root-archive',
    runId: randomUUID(),
    repository: fsImpl.realpathSync(repoDir),
    primaryHead: gitOutput(repoDir, ['rev-parse', 'HEAD'], execFile),
    change,
    reviewedDigest: hashDirectory(changeDir, fsImpl),
    workerDescriptor,
    workerCommit,
    gates: [...gateSet].sort(),
    capabilities: deltaCapabilities(changeDir, fsImpl),
  }
  return withRuntimeLock({ repoDir, fsImpl }, (stateRoot) => {
    const target = checkpointPath({ repoDir, change })
    if (fsImpl.existsSync(target))
      throw new Error(`Checkpoint already exists: ${target}`)
    const temporary = path.join(stateRoot, `.${change}.${checkpoint.runId}.tmp`)
    fsImpl.writeFileSync(
      temporary,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      {
        flag: 'wx',
      },
    )
    fsImpl.renameSync(temporary, target)
    return checkpoint
  })
}

function readCheckpoint({ repoDir = repoRoot, change, fsImpl = fs }) {
  const target = checkpointPath({ repoDir, change })
  if (!fsImpl.existsSync(target))
    throw new Error(`Missing archive checkpoint: ${target}`)
  let checkpoint
  try {
    checkpoint = JSON.parse(fsImpl.readFileSync(target, 'utf8'))
  } catch (error) {
    throw new Error(`Corrupt archive checkpoint ${target}: ${error.message}`)
  }
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION)
    throw new Error(`Unsupported checkpoint schema for ${change}`)
  if (checkpoint.change !== change)
    throw new Error(`Checkpoint change mismatch for ${change}`)
  if (checkpoint.repository !== fsImpl.realpathSync(repoDir))
    throw new Error(`Checkpoint repository mismatch for ${change}`)
  return checkpoint
}

function findArchivedChange({ repoDir = repoRoot, change, fsImpl = fs }) {
  const archiveRoot = path.join(repoDir, 'openspec', 'changes', 'archive')
  const matches = fsImpl.existsSync(archiveRoot)
    ? fsImpl
        .readdirSync(archiveRoot)
        .filter((entry) => entry.endsWith(`-${change}`))
    : []
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one archive for ${change}; found ${matches.length}`,
    )
  return path.join(archiveRoot, matches[0])
}

export function resumeArchivedChange({
  change,
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  return withRuntimeLock({ repoDir, fsImpl }, () => {
    const checkpoint = readCheckpoint({ repoDir, change, fsImpl })
    if (checkpoint.state !== 'awaiting-root-archive')
      throw new Error(`Checkpoint for ${change} is not awaiting root archive`)
    const head = gitOutput(repoDir, ['rev-parse', 'HEAD'], execFile)
    if (head !== checkpoint.primaryHead)
      throw new Error(`Checkpoint HEAD is stale for ${change}`)
    const activeDir = path.join(repoDir, 'openspec', 'changes', change)
    if (fsImpl.existsSync(activeDir))
      throw new Error(`Change remains active after archive handoff: ${change}`)
    const archiveDir = findArchivedChange({ repoDir, change, fsImpl })
    if (hashDirectory(archiveDir, fsImpl) !== checkpoint.reviewedDigest)
      throw new Error(`Archived artifact digest changed for ${change}`)
    const allowedPrefixes = [
      `openspec/changes/${change}/`,
      `${normalizeRelativePath(path.relative(repoDir, archiveDir))}/`,
    ]
    const allowedExact = new Set(
      checkpoint.capabilities.map(
        (capability) => `openspec/specs/${capability}/spec.md`,
      ),
    )
    const dirtyPaths = gitStatusPaths({ repoDir, execFile })
    const unexpected = dirtyPaths.filter(
      (dirtyPath) =>
        !allowedExact.has(dirtyPath) &&
        !allowedPrefixes.some((prefix) => dirtyPath.startsWith(prefix)),
    )
    if (unexpected.length > 0)
      throw new Error(
        `Archive produced unrelated dirty paths:\n${unexpected.join('\n')}`,
      )
    const stagePaths = [
      ...allowedPrefixes.map((prefix) => prefix.slice(0, -1)),
      ...allowedExact,
    ]
    gitOutput(repoDir, ['add', '-A', '--', ...stagePaths], execFile)
    try {
      gitOutput(
        repoDir,
        ['commit', '-m', `chore(openspec): archive ${change}`],
        execFile,
      )
    } catch (error) {
      checkpoint.state = 'archived-dirty'
      fsImpl.writeFileSync(
        checkpointPath({ repoDir, change }),
        `${JSON.stringify(checkpoint, null, 2)}\n`,
      )
      throw error
    }
    checkpoint.state = 'committed'
    checkpoint.lifecycleCommit = gitOutput(
      repoDir,
      ['rev-parse', 'HEAD'],
      execFile,
    )
    fsImpl.writeFileSync(
      checkpointPath({ repoDir, change }),
      `${JSON.stringify(checkpoint, null, 2)}\n`,
    )
    assertPrimaryClean({ repoDir, execFile })
    return checkpoint
  })
}

function hasGlobMagic(value) {
  return /[*?[\]{}]/.test(value)
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/')
}

function normalizeIncludePattern(pattern) {
  const normalized = normalizeRelativePath(pattern).replace(/^\.\//, '')
  if (path.isAbsolute(pattern) || normalized.split('/').includes('..')) {
    throw new Error(
      `.worktreeincludes pattern must be root-relative: ${pattern}`,
    )
  }
  return normalized
}

function globToRegExp(pattern) {
  const normalized = normalizeRelativePath(pattern)
  let source = '^'
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]
    const next = normalized[i + 1]
    if (char === '*' && next === '*') {
      source += '.*'
      i++
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  source += '$'
  return new RegExp(source)
}

function staticGlobBase(pattern) {
  const segments = normalizeRelativePath(pattern).split('/')
  const base = []
  for (const segment of segments) {
    if (hasGlobMagic(segment)) break
    base.push(segment)
  }
  if (base.length === segments.length) base.pop()
  return base.join('/')
}

function walkFiles(dir, prefix = '', fsImpl = fs) {
  if (!fsImpl.existsSync(dir)) return []
  const entries = fsImpl
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const relative = prefix ? path.join(prefix, entry.name) : entry.name
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory())
      files.push(...walkFiles(fullPath, relative, fsImpl))
    else if (entry.isFile()) files.push(relative)
  }
  return files
}

function readWorktreeIncludePatterns(repoDir, fsImpl = fs) {
  const includePath = path.join(repoDir, '.worktreeincludes')
  if (!fsImpl.existsSync(includePath)) return []
  return fsImpl
    .readFileSync(includePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => normalizeIncludePattern(line))
}

function matchIncludedFiles({ repoDir, patterns, fsImpl = fs }) {
  const matches = new Set()
  for (const pattern of patterns) {
    const normalizedPattern = normalizeRelativePath(pattern)
    if (!hasGlobMagic(normalizedPattern)) {
      const absolute = path.join(repoDir, normalizedPattern)
      if (fsImpl.existsSync(absolute) && fsImpl.statSync(absolute).isFile()) {
        matches.add(normalizedPattern)
      }
      continue
    }

    const base = staticGlobBase(normalizedPattern)
    const baseDir = path.join(repoDir, base)
    const matcher = globToRegExp(normalizedPattern)
    for (const relPath of walkFiles(baseDir, base, fsImpl)) {
      const normalizedRelPath = normalizeRelativePath(relPath)
      if (matcher.test(normalizedRelPath)) matches.add(normalizedRelPath)
    }
  }
  return [...matches].sort()
}

export function copyWorktreeIncludedFiles({
  descriptor,
  repoDir = repoRoot,
  fsImpl = fs,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  const patterns = readWorktreeIncludePatterns(repoDir, fsImpl)
  if (patterns.length === 0) return []
  const includedFiles = matchIncludedFiles({ repoDir, patterns, fsImpl })
  for (const relPath of includedFiles) {
    const source = path.join(repoDir, relPath)
    const destination = path.join(descriptor.worktreePath, relPath)
    fsImpl.mkdirSync(path.dirname(destination), { recursive: true })
    fsImpl.copyFileSync(source, destination)
  }
  return includedFiles
}

function workerDirectoryPrefix(descriptor) {
  const basename = path.basename(descriptor.worktreePath)
  if (basename.endsWith(descriptor.change)) {
    return basename.slice(0, basename.length - descriptor.change.length)
  }
  return `${path.basename(repoRoot)}-agent-`
}

export function assertRetainedCapacity({
  descriptor,
  maxDirs = MAX_WORKTREE_DIRS,
  fsImpl = fs,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  if (!Number.isInteger(maxDirs) || maxDirs < 1) {
    throw new Error(`maxDirs must be a positive integer, got ${maxDirs}`)
  }
  if (!fsImpl.existsSync(descriptor.worktreeRoot)) return []
  const prefix = workerDirectoryPrefix(descriptor)
  const entries = fsImpl
    .readdirSync(descriptor.worktreeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const fullPath = path.join(descriptor.worktreeRoot, entry.name)
      return {
        name: entry.name,
        fullPath,
        mtimeMs: fsImpl.statSync(fullPath).mtimeMs,
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  if (entries.length >= maxDirs) {
    throw new Error(
      `Retained orchestration state is at capacity (${entries.length}/${maxDirs}); explicit operator recovery is required`,
    )
  }
  return []
}

export function buildCodexWorkerLaunch({ descriptor, env = process.env } = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  const summaryPath = path.join(descriptor.logDir, 'summary.txt')
  const prompt = buildWorkerPrompt(descriptor.change)
  const model = env.OPENSPECX_WORKER_MODEL?.trim()
  const reasoningEffort = env.OPENSPECX_WORKER_REASONING_EFFORT?.trim()
  if (model?.includes('\0')) throw new Error('worker model contains NUL')
  if (
    reasoningEffort &&
    !new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).has(
      reasoningEffort,
    )
  ) {
    throw new Error(`unsupported worker reasoning effort: ${reasoningEffort}`)
  }
  const modelArgs = model ? ['--model', model] : []
  const reasoningArgs = reasoningEffort
    ? ['-c', `model_reasoning_effort="${reasoningEffort}"`]
    : []
  return {
    command: 'codex',
    args: [
      'exec',
      ...modelArgs,
      ...reasoningArgs,
      '--json',
      '-o',
      summaryPath,
      prompt,
    ],
    cwd: descriptor.worktreePath,
    change: descriptor.change,
    prompt,
    summaryPath,
  }
}

function parseStatusShort(text) {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
      raw: line,
    }))
}

function walkMarkdownFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return []
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  const files = []
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name)
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory())
      files.push(...walkMarkdownFiles(fullPath, relative))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(relative)
  }
  return files
}

function changeArtifactPaths({ checkoutDir, change }) {
  const changeDir = path.join(checkoutDir, 'openspec', 'changes', change)
  const relPaths = ['proposal.md', 'design.md', 'tasks.md']
  for (const specPath of walkMarkdownFiles(path.join(changeDir, 'specs'))) {
    relPaths.push(path.join('specs', specPath))
  }
  return relPaths
}

function normalizeTasksArtifact(text) {
  return text.replace(/^(\s*-\s*)\[[ xX]\](\s+)/gm, '$1[ ]$2')
}

function normalizeArtifactText(relPath, text) {
  return relPath === 'tasks.md' ? normalizeTasksArtifact(text) : text
}

function readArtifactText({ checkoutDir, change, relPath, fsImpl = fs }) {
  const fullPath = path.join(
    checkoutDir,
    'openspec',
    'changes',
    change,
    relPath,
  )
  if (!fsImpl.existsSync(fullPath)) return undefined
  return fsImpl.readFileSync(fullPath, 'utf8')
}

function normalizeTaskText(text) {
  return text.trim().replace(/\s+/g, ' ')
}

function parseTaskRows(text = '') {
  const rows = []
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s+(.+?)\s*$/)
    if (!match) continue
    rows.push({
      done: match[1].toLowerCase() === 'x',
      text: normalizeTaskText(match[2]),
      line: line.trim(),
    })
  }
  return rows
}

function completedTaskSet(rows) {
  return new Set(rows.filter((row) => row.done).map((row) => row.text))
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

function setsEqual(left, right) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  )
}

export function compareChangeArtifacts({
  change,
  mainDir = repoRoot,
  worktreeDir,
  fsImpl = fs,
} = {}) {
  if (!change) throw new Error('change is required')
  if (!worktreeDir) throw new Error('worktreeDir is required')

  const artifactPaths = [
    ...new Set([
      ...changeArtifactPaths({ checkoutDir: mainDir, change }),
      ...changeArtifactPaths({ checkoutDir: worktreeDir, change }),
    ]),
  ].sort()

  const differingArtifacts = []
  const missingInMain = []
  const missingInWorktree = []

  for (const relPath of artifactPaths) {
    const mainText = readArtifactText({
      checkoutDir: mainDir,
      change,
      relPath,
      fsImpl,
    })
    const worktreeText = readArtifactText({
      checkoutDir: worktreeDir,
      change,
      relPath,
      fsImpl,
    })
    if (mainText === undefined && worktreeText !== undefined) {
      missingInMain.push(relPath)
      continue
    }
    if (mainText !== undefined && worktreeText === undefined) {
      missingInWorktree.push(relPath)
      continue
    }
    if (mainText === undefined && worktreeText === undefined) continue
    if (
      normalizeArtifactText(relPath, mainText) !==
      normalizeArtifactText(relPath, worktreeText)
    ) {
      differingArtifacts.push(relPath)
    }
  }

  const mainTasksText =
    readArtifactText({
      checkoutDir: mainDir,
      change,
      relPath: 'tasks.md',
      fsImpl,
    }) ?? ''
  const worktreeTasksText =
    readArtifactText({
      checkoutDir: worktreeDir,
      change,
      relPath: 'tasks.md',
      fsImpl,
    }) ?? ''
  const mainTasks = parseTaskRows(mainTasksText)
  const worktreeTasks = parseTaskRows(worktreeTasksText)
  const mainCompleted = completedTaskSet(mainTasks)
  const worktreeCompleted = completedTaskSet(worktreeTasks)
  const mainCompletedMissingInWorktree = setDifference(
    mainCompleted,
    worktreeCompleted,
  )
  const worktreeExtraCompleted = setDifference(worktreeCompleted, mainCompleted)

  return {
    artifactPaths,
    artifactsIdenticalIgnoringTaskCheckboxes:
      differingArtifacts.length === 0 &&
      missingInMain.length === 0 &&
      missingInWorktree.length === 0,
    differingArtifacts,
    missingInMain,
    missingInWorktree,
    mainCompletedMissingInWorktree,
    worktreeExtraCompleted,
    completionEqual: setsEqual(mainCompleted, worktreeCompleted),
    worktreeHasAllMainCompletedPlusMore:
      mainCompletedMissingInWorktree.length === 0 &&
      worktreeExtraCompleted.length > 0,
    worktreeTaskList: worktreeTasks.map((row) => row.line),
  }
}

export function inspectDirtyTarget({
  descriptor,
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  if (!fsImpl.existsSync(descriptor.worktreePath)) return null
  const statusText = execFile('git', [
    '-C',
    descriptor.worktreePath,
    'status',
    '--short',
  ])
  const dirtyEntries = parseStatusShort(statusText)
  if (dirtyEntries.length === 0) return null

  const branch = execFile('git', [
    '-C',
    descriptor.worktreePath,
    'branch',
    '--show-current',
  ])
  const workerHead = execFile('git', [
    '-C',
    descriptor.worktreePath,
    'rev-parse',
    'HEAD',
  ])
  const mainHead = execFile('git', ['-C', repoDir, 'rev-parse', 'HEAD'])
  const distanceText = execFile('git', [
    '-C',
    repoDir,
    'rev-list',
    '--left-right',
    '--count',
    `${mainHead}...${workerHead}`,
  ])
  const [behindText, aheadText] = distanceText.split(/\s+/)
  return {
    change: descriptor.change,
    worktreePath: descriptor.worktreePath,
    branch,
    dirtyFiles: dirtyEntries.map((entry) => entry.path),
    dirtyEntries,
    workerHead,
    mainHead,
    behindMain: Number.parseInt(behindText, 10),
    aheadOfMain: Number.parseInt(aheadText, 10),
    artifactComparison: compareChangeArtifacts({
      change: descriptor.change,
      mainDir: repoDir,
      worktreeDir: descriptor.worktreePath,
      fsImpl,
    }),
  }
}

export function inspectDirtyTargets({
  descriptors,
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  return descriptors
    .map((descriptor) =>
      inspectDirtyTarget({ descriptor, repoDir, execFile, fsImpl }),
    )
    .filter(Boolean)
}

export function buildDirtyTargetDecision(report) {
  if (!report) throw new Error('report is required')
  const comparison = report.artifactComparison
  const warnings = []
  if (!comparison.artifactsIdenticalIgnoringTaskCheckboxes) {
    warnings.push(
      [
        'WARNING: OpenSpec artifacts differ from main beyond task completion markers.',
        comparison.differingArtifacts.length > 0
          ? `Differing artifacts: ${comparison.differingArtifacts.join(', ')}`
          : '',
        comparison.missingInMain.length > 0
          ? `Missing in main: ${comparison.missingInMain.join(', ')}`
          : '',
        comparison.missingInWorktree.length > 0
          ? `Missing in worktree: ${comparison.missingInWorktree.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  if (comparison.mainCompletedMissingInWorktree.length > 0) {
    warnings.push(
      `WARNING: Main has completed tasks not completed in the worktree: ${comparison.mainCompletedMissingInWorktree.join('; ')}`,
    )
  }
  if (comparison.worktreeHasAllMainCompletedPlusMore) {
    warnings.push(
      [
        `The worktree has ${comparison.worktreeExtraCompleted.length} additional completed task(s), which may justify resuming.`,
        'Worktree task list:',
        ...comparison.worktreeTaskList.map((line) => `  ${line}`),
      ].join('\n'),
    )
  }

  const recommendedAction =
    comparison.artifactsIdenticalIgnoringTaskCheckboxes &&
    comparison.completionEqual
      ? 'discard'
      : undefined
  const recommendation =
    recommendedAction === 'discard'
      ? 'Recommendation: discard the dirty worktree and start fresh because artifacts and task completion match main.'
      : undefined

  const question = [
    `Dirty target worktree for ${report.change}`,
    `Path: ${report.worktreePath}`,
    `Branch: ${report.branch || '<detached>'}`,
    `Dirty files: ${report.dirtyFiles.length > 0 ? report.dirtyFiles.join(', ') : '<none>'}`,
    `Worker HEAD: ${report.workerHead}`,
    `Main HEAD: ${report.mainHead}`,
    `Distance from main: ${report.aheadOfMain} ahead, ${report.behindMain} behind`,
    `Artifacts: ${comparison.artifactsIdenticalIgnoringTaskCheckboxes ? 'identical after ignoring tasks.md checkbox markers' : 'different from main'}`,
    ...warnings,
    recommendation,
    'Choose one:',
    '1. Resume the change on the dirty worktree',
    '2. Discard the dirty worktree and start fresh',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    change: report.change,
    question,
    choices: [
      { value: 'resume', label: 'Resume the change on the dirty worktree' },
      { value: 'discard', label: 'Discard the dirty worktree and start fresh' },
    ],
    recommendedAction,
    warnings,
  }
}

export function preflightWorkerLaunch({
  descriptor,
  execFile = shellOut,
  fsImpl = fs,
  allowDirty = false,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  const resolvedRoot = path.resolve(descriptor.worktreeRoot)
  const resolvedWorktree = path.resolve(descriptor.worktreePath)
  if (
    resolvedWorktree !== resolvedRoot &&
    !resolvedWorktree.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(
      `Worker worktree ${resolvedWorktree} is outside Codex worktree root ${resolvedRoot}`,
    )
  }
  if (!fsImpl.existsSync(resolvedWorktree)) {
    throw new Error(`Worker worktree does not exist: ${resolvedWorktree}`)
  }
  const changeDir = path.join(
    resolvedWorktree,
    'openspec',
    'changes',
    descriptor.change,
  )
  if (!fsImpl.existsSync(changeDir)) {
    throw new Error(`Worker worktree is missing change folder: ${changeDir}`)
  }
  const branch = execFile('git', [
    '-C',
    resolvedWorktree,
    'branch',
    '--show-current',
  ])
  if (branch !== descriptor.branch) {
    throw new Error(
      `Worker worktree branch mismatch: expected ${descriptor.branch}, got ${branch || '<detached>'}`,
    )
  }
  const dirtyFiles = execFile('git', [
    '-C',
    resolvedWorktree,
    'status',
    '--short',
  ])
  if (dirtyFiles && !allowDirty) {
    throw new Error(`Worker worktree is dirty:\n${dirtyFiles}`)
  }
  return {
    branch,
    dirtyFiles: parseStatusShort(dirtyFiles).map((entry) => entry.path),
  }
}

export function createWorkerWorktree({
  descriptor,
  sourceRef = 'HEAD',
  protectedWorktreePaths = new Set(),
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  fsImpl.mkdirSync(descriptor.worktreeRoot, { recursive: true })
  assertRetainedCapacity({
    descriptor,
    protectedWorktreePaths,
    repoDir,
    execFile,
    fsImpl,
  })
  execFile(
    'git',
    [
      'worktree',
      'add',
      descriptor.worktreePath,
      '-b',
      descriptor.branch,
      sourceRef,
    ],
    { cwd: repoDir },
  )
  copyWorktreeIncludedFiles({ descriptor, repoDir, fsImpl })
  return descriptor
}

export function launchWorker({
  descriptor,
  spawnImpl = spawn,
  allowDirty = false,
  detached = false,
} = {}) {
  preflightWorkerLaunch({ descriptor, allowDirty })
  const launch = buildCodexWorkerLaunch({ descriptor })
  fs.mkdirSync(descriptor.logDir, { recursive: true })
  const stdoutPath = path.join(descriptor.logDir, 'worker.jsonl')
  const stderrPath = path.join(descriptor.logDir, 'worker.stderr.log')
  const stdoutFd = fs.openSync(stdoutPath, 'w')
  const stderrFd = fs.openSync(stderrPath, 'w')
  const child = spawnImpl(launch.command, launch.args, {
    cwd: launch.cwd,
    detached,
    stdio: ['ignore', stdoutFd, stderrFd],
  })
  fs.closeSync(stdoutFd)
  fs.closeSync(stderrFd)
  if (detached && typeof child.unref === 'function') child.unref()
  return { ...launch, child }
}

export function recordLaunchedWorker({
  launched,
  descriptor,
  repoDir = repoRoot,
  fsImpl = fs,
} = {}) {
  if (!Number.isInteger(launched?.child?.pid))
    throw new Error(
      `Worker process for ${descriptor?.change ?? '<unknown>'} has no pid`,
    )
  const target = workerStatePath({ repoDir, change: descriptor.change })
  fsImpl.mkdirSync(path.dirname(target), { recursive: true })
  const state = {
    change: descriptor.change,
    status: 'running',
    pid: launched.child.pid,
    descriptor,
    summaryPath: launched.summaryPath,
    startedAt: new Date().toISOString(),
  }
  fsImpl.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, {
    flag: 'wx',
  })
  return state
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function collectWorkerStates({
  repoDir = repoRoot,
  fsImpl = fs,
  isAlive = processIsAlive,
} = {}) {
  const workersDir = path.join(runtimeStateRoot({ repoDir }), 'workers')
  if (!fsImpl.existsSync(workersDir)) return []
  return fsImpl
    .readdirSync(workersDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => {
      let state
      try {
        state = JSON.parse(
          fsImpl.readFileSync(path.join(workersDir, entry), 'utf8'),
        )
      } catch (error) {
        return {
          change: path.basename(entry, '.json'),
          status: 'malformed',
          error: `Malformed worker runtime state: ${error.message}`,
        }
      }
      if (
        typeof state.change !== 'string' ||
        !Number.isInteger(state.pid) ||
        typeof state.summaryPath !== 'string'
      ) {
        return {
          change: state.change ?? path.basename(entry, '.json'),
          status: 'malformed',
          error: 'Worker runtime state is missing required fields',
        }
      }
      if (state.status === 'merged') return state
      if (fsImpl.existsSync(state.summaryPath)) {
        try {
          const summary = readWorkerSummary({
            launched: { change: state.change, summaryPath: state.summaryPath },
            fsImpl,
          })
          return { ...state, status: summary.status, summary }
        } catch (error) {
          return { ...state, status: 'malformed', error: error.message }
        }
      }
      return isAlive(state.pid)
        ? state
        : {
            ...state,
            status: 'failed',
            error: 'worker exited without a result',
          }
    })
}

function parseWorkerSummaryText(text) {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('worker summary is empty')
  try {
    return JSON.parse(trimmed)
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
    if (!fenced) throw new Error('worker summary is not valid JSON')
    return JSON.parse(fenced[1])
  }
}

const WORKER_SUMMARY_STATUSES = new Set([
  'done',
  'blocked',
  'conflicted',
  'failed',
])

export function readWorkerSummary({ launched, fsImpl = fs } = {}) {
  if (!launched?.summaryPath)
    throw new Error('launched worker summary path is required')
  const expectedChange = launched.change ?? launched.prompt
  if (!fsImpl.existsSync(launched.summaryPath)) {
    throw new Error(`worker summary is missing: ${launched.summaryPath}`)
  }
  const summary = parseWorkerSummaryText(
    fsImpl.readFileSync(launched.summaryPath, 'utf8'),
  )
  if (summary.change !== expectedChange) {
    throw new Error(
      `worker summary change mismatch: expected ${expectedChange}, got ${summary.change ?? '<missing>'}`,
    )
  }
  if (!WORKER_SUMMARY_STATUSES.has(summary.status)) {
    throw new Error(
      `worker summary for ${expectedChange} has unsupported status: ${summary.status ?? '<missing>'}`,
    )
  }
  if (!Array.isArray(summary.filesTouched)) {
    throw new Error(
      `worker summary for ${expectedChange} did not include filesTouched`,
    )
  }
  if (summary.status === 'done') {
    if (!summary.commit) {
      throw new Error(
        `worker summary for ${expectedChange} did not include a commit`,
      )
    }
    if (!summary.checkStatus) {
      throw new Error(
        `worker summary for ${expectedChange} did not include checkStatus`,
      )
    }
    if (!Array.isArray(summary.bubbledSideEffects)) {
      throw new Error(
        `worker summary for ${expectedChange} did not include bubbledSideEffects`,
      )
    }
  } else if (!summary.reason && !summary.notes) {
    throw new Error(
      `worker summary for ${expectedChange} did not include reason or notes`,
    )
  }
  return summary
}

export function verifyWorkerResult({
  result,
  repoDir = repoRoot,
  execFile = shellOut,
} = {}) {
  if (!result || result.status !== 'done') {
    throw new Error(
      `Worker result is not done for ${result?.change ?? '<unknown>'}`,
    )
  }
  if (!result.commit) {
    throw new Error(
      `Worker result for ${result.change} did not include a commit`,
    )
  }
  const branch = workerBranch(result.change)
  const branchHead = execFile('git', ['rev-parse', branch], { cwd: repoDir })
  if (branchHead !== result.commit) {
    throw new Error(
      `Worker commit mismatch for ${result.change}: expected branch head ${branchHead}, got ${result.commit}`,
    )
  }
  const commitsAhead = Number(
    execFile('git', ['rev-list', '--count', `HEAD..${branch}`], {
      cwd: repoDir,
    }),
  )
  if (commitsAhead !== 1) {
    throw new Error(
      `Worker branch ${branch} must contain exactly one integration commit; found ${commitsAhead}`,
    )
  }
  const touchedPaths = execFile(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', result.commit],
    { cwd: repoDir },
  )
    .split('\0')
    .filter(Boolean)
    .map(normalizeRelativePath)
    .sort()
  const reportedPaths = [
    ...new Set(result.filesTouched.map(normalizeRelativePath)),
  ].sort()
  const pathCovers = (reportedPath, touchedPath) =>
    touchedPath === reportedPath || touchedPath.startsWith(`${reportedPath}/`)
  const allReportedPathsTouched = reportedPaths.every((reportedPath) =>
    touchedPaths.some((touchedPath) => pathCovers(reportedPath, touchedPath)),
  )
  if (!allReportedPathsTouched) {
    throw new Error(
      `Worker touched-path report does not match commit ${result.commit}`,
    )
  }
  const forbidden = touchedPaths.filter(
    (touchedPath) =>
      touchedPath.startsWith('openspec/specs/') ||
      touchedPath.startsWith('openspec/changes/archive/') ||
      (touchedPath.startsWith('openspec/changes/') &&
        !touchedPath.startsWith(`openspec/changes/${result.change}/`)),
  )
  if (forbidden.length > 0) {
    throw new Error(
      `Worker commit escaped the assigned change boundary:\n${forbidden.join('\n')}`,
    )
  }
  return { branch, branchHead, touchedPaths }
}

export function mergeWorkerResult({
  result,
  repoDir = repoRoot,
  execFile = shellOut,
} = {}) {
  const { branch, branchHead } = verifyWorkerResult({
    result,
    repoDir,
    execFile,
  })
  try {
    execFile(
      'git',
      [
        'merge',
        '--no-ff',
        branch,
        '-m',
        `Merge ${result.change} worker result`,
      ],
      { cwd: repoDir },
    )
  } catch (error) {
    try {
      execFile('git', ['merge', '--abort'], { cwd: repoDir })
    } catch {
      // A failed merge can exit before Git creates merge state.
    }
    throw new Error(
      `Worker merge conflicted for ${result.change}: ${error.message}`,
    )
  }
  return { branch, commit: branchHead }
}

export function cleanupWorkerWorktree({
  descriptor,
  repoDir = repoRoot,
  execFile = shellOut,
  force = false,
} = {}) {
  if (!descriptor) throw new Error('descriptor is required')
  execFile(
    'git',
    [
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      descriptor.worktreePath,
    ],
    { cwd: repoDir },
  )
  execFile('git', ['branch', '-D', descriptor.branch], { cwd: repoDir })
}

export function cleanupArchivedWorkerWorktree({
  descriptor,
  archiveCompleted,
  validationPassed,
  repoDir = repoRoot,
  execFile = shellOut,
  force = false,
} = {}) {
  if (!archiveCompleted || !validationPassed) {
    throw new Error(
      'Worker worktree cleanup requires successful archive and validation',
    )
  }
  cleanupWorkerWorktree({ descriptor, repoDir, execFile, force })
}

export function finalizeRun({
  repoDir = repoRoot,
  execFile = shellOut,
  fsImpl = fs,
} = {}) {
  assertPrimaryClean({ repoDir, execFile })
  const stateRoot = runtimeStateRoot({ repoDir })
  const checkpointFiles = fsImpl.existsSync(stateRoot)
    ? fsImpl
        .readdirSync(stateRoot)
        .filter((entry) => entry.endsWith('.json'))
        .sort()
    : []
  const checkpoints = checkpointFiles.map((entry) => {
    const checkpoint = JSON.parse(
      fsImpl.readFileSync(path.join(stateRoot, entry), 'utf8'),
    )
    if (checkpoint.state !== 'committed')
      throw new Error(
        `Cannot finalize run with retained ${checkpoint.state} state for ${checkpoint.change}`,
      )
    return { entry, checkpoint }
  })
  execFile('pnpm', ['run', 'validate'], { cwd: repoDir })
  for (const { entry, checkpoint } of checkpoints) {
    const descriptor = checkpoint.workerDescriptor
    if (descriptor && fsImpl.existsSync(descriptor.worktreePath)) {
      cleanupArchivedWorkerWorktree({
        descriptor,
        archiveCompleted: true,
        validationPassed: true,
        repoDir,
        execFile,
      })
    }
    if (descriptor?.logDir)
      fsImpl.rmSync(descriptor.logDir, { recursive: true, force: true })
    fsImpl.rmSync(workerStatePath({ repoDir, change: checkpoint.change }), {
      force: true,
    })
    fsImpl.rmSync(path.join(stateRoot, entry), { force: true })
  }
  return {
    aggregateValidation: 'passed',
    cleaned: checkpoints.map(({ checkpoint }) => checkpoint.change),
  }
}

function dirtyTargetActionSets(args) {
  const resume = new Set(args.resumeDirtyTargets)
  const discard = new Set(args.discardDirtyTargets)
  const overlap = [...resume].filter((change) => discard.has(change))
  if (overlap.length > 0) {
    throw new Error(`Dirty target action conflict for: ${overlap.join(', ')}`)
  }
  return { resume, discard }
}

function worktreeExists(descriptor, fsImpl = fs) {
  return fsImpl.existsSync(descriptor.worktreePath)
}

function nextCompletion(inFlight, completionOrder) {
  for (const change of completionOrder) {
    if (inFlight.has(change)) return change
  }
  return [...inFlight].sort()[0]
}

export function simulateScheduler({
  graph,
  claims,
  completionOrder = [],
  maxLiveWorkers = MAX_LIVE_WORKTREE_WORKERS,
} = {}) {
  if (
    !Number.isInteger(maxLiveWorkers) ||
    maxLiveWorkers < 1 ||
    maxLiveWorkers > MAX_LIVE_WORKTREE_WORKERS
  ) {
    throw new Error(
      `maxLiveWorkers must be between 1 and ${MAX_LIVE_WORKTREE_WORKERS}`,
    )
  }
  const claimMap = claimsByChange(claims)
  const archived = new Set()
  const admitted = new Set()
  const inFlight = new Set()
  const queued = new Set()
  const events = []
  const archivedOrder = []

  function admit() {
    let admittedThisPass = false
    for (const candidate of unblockedNodes(graph, archived)) {
      if (admitted.has(candidate) || archived.has(candidate)) continue
      if (!overlapFree(candidate, inFlight, claimMap)) continue
      if (inFlight.size >= maxLiveWorkers) {
        if (!queued.has(candidate)) {
          queued.add(candidate)
          events.push({
            type: 'queue',
            change: candidate,
            queued: [...queued].sort(),
          })
        }
        continue
      }
      queued.delete(candidate)
      admitted.add(candidate)
      inFlight.add(candidate)
      events.push({
        type: 'admit',
        change: candidate,
        inFlight: [...inFlight].sort(),
      })
      admittedThisPass = true
    }
    return admittedThisPass
  }

  admit()

  while (inFlight.size > 0) {
    const change = nextCompletion(inFlight, completionOrder)
    events.push({
      type: 'worker-complete',
      change,
      inFlight: [...inFlight].sort(),
    })
    inFlight.delete(change)
    events.push({
      type: 'integrate',
      change,
      steps: PARENT_INTEGRATION_STEPS,
    })
    archived.add(change)
    archivedOrder.push(change)
    events.push({ type: 'archive', change, archived: [...archived].sort() })
    events.push({ type: 'cleanup-worktree', change })
    admit()
  }

  if (archivedOrder.length > 0) {
    events.push({ type: 'validate-main', changes: archivedOrder })
  }

  return { events, archivedOrder }
}

export function selectInitialAdmissions({
  graph,
  claims,
  maxLiveWorkers = Number.POSITIVE_INFINITY,
  occupiedChanges = [],
} = {}) {
  const claimMap = claimsByChange(claims)
  const occupied = new Set(occupiedChanges)
  const inFlight = [...occupied].sort()
  const admissions = []
  const queued = []
  for (const candidate of unblockedNodes(graph)) {
    if (occupied.has(candidate)) continue
    if (!overlapFree(candidate, inFlight, claimMap)) continue
    if (admissions.length >= maxLiveWorkers) {
      queued.push(candidate)
      continue
    }
    admissions.push(candidate)
    inFlight.push(candidate)
  }
  return { admissions: admissions.sort(), queued: queued.sort() }
}

export function isCloseoutOnly({ changesRoot, change, fsImpl = fs } = {}) {
  const tasksPath = path.join(changesRoot, change, 'tasks.md')
  if (!fsImpl.existsSync(tasksPath)) return false
  return !/^\s*- \[ \]/mu.test(fsImpl.readFileSync(tasksPath, 'utf8'))
}

function ensureGraphHealthy(graph) {
  if (!graph.acyclic) {
    throw new Error(`Dependency graph has a cycle: ${graph.cycles.join(', ')}`)
  }
  assertResolvedDependencies(graph)
}

export function buildDryRun({ changesRoot, completionOrder = [] }) {
  const graph = buildChangeGraph(changesRoot)
  ensureGraphHealthy(graph)
  const skippedWork = backlogBlockedEvents(graph)

  const authoringEvents = buildAuthoringEvents(changesRoot, graph)
  if (authoringEvents.length > 0) {
    return {
      admissionMode: 'all-eligible',
      maxLiveWorkers: MAX_WORKTREE_DIRS,
      admittedWorkerCount: 0,
      skippedWork,
      authoringEvents,
      events: [],
    }
  }
  const overlapClaims = claimsByChange(
    computeClaims(changesRoot),
    deltaCapableChanges(changesRoot, graph),
  )
  const schedule = simulateScheduler({
    graph,
    claims: overlapClaims,
    completionOrder,
  })
  const admittedWorkerCount = schedule.events.filter(
    (event) => event.type === 'admit',
  ).length
  return {
    admissionMode: 'all-eligible',
    maxLiveWorkers: MAX_LIVE_WORKTREE_WORKERS,
    admittedWorkerCount,
    skippedWork,
    authoringEvents,
    events: schedule.events,
  }
}

export function buildLaunchPlan({
  changesRoot,
  env = process.env,
  repoDir = path.resolve(changesRoot, '..', '..'),
  fsImpl = fs,
  isAlive = processIsAlive,
}) {
  const graph = buildChangeGraph(changesRoot)
  ensureGraphHealthy(graph)
  const skippedWork = backlogBlockedEvents(graph)
  const authoringEvents = buildAuthoringEvents(changesRoot, graph)
  if (authoringEvents.length > 0) {
    return {
      admissionMode: 'bounded-ready-queue',
      maxLiveWorkers: MAX_LIVE_WORKTREE_WORKERS,
      admittedWorkerCount: 0,
      queuedWorkerCount: 0,
      skippedWork,
      authoringEvents,
      closeoutOnly: [],
      launches: [],
      queuedLaunches: [],
    }
  }
  const claims = claimsByChange(
    computeClaims(changesRoot),
    deltaCapableChanges(changesRoot, graph),
  )
  const workerStates = collectWorkerStates({ repoDir, fsImpl, isAlive })
  const occupiedChanges = workerStates.map(({ change }) => change)
  const liveWorkerCount = workerStates.filter(
    ({ status }) => status === 'running',
  ).length
  const availableWorkerSlots = Math.max(
    0,
    MAX_LIVE_WORKTREE_WORKERS - liveWorkerCount,
  )
  const { admissions, queued } = selectInitialAdmissions({
    graph,
    claims,
    maxLiveWorkers: availableWorkerSlots,
    occupiedChanges,
  })
  const closeoutOnly = admissions
    .filter((change) => isCloseoutOnly({ changesRoot, change }))
    .sort()
  const implementationAdmissions = admissions.filter(
    (change) => !closeoutOnly.includes(change),
  )
  const launches = implementationAdmissions.map((change) => {
    const descriptor = buildWorkerDescriptor({ change, env })
    const launch = buildCodexWorkerLaunch({ descriptor })
    return { descriptor, launch }
  })
  const queuedLaunches = queued.map((change) => ({
    descriptor: buildWorkerDescriptor({ change, env }),
  }))
  return {
    admissionMode: 'bounded-ready-queue',
    maxLiveWorkers: MAX_LIVE_WORKTREE_WORKERS,
    liveWorkerCount,
    availableWorkerSlots,
    admittedWorkerCount: launches.length,
    queuedWorkerCount: queuedLaunches.length,
    closeoutOnly,
    skippedWork,
    authoringEvents,
    launches,
    queuedLaunches,
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.collectWorkers) {
      process.stdout.write(
        `${JSON.stringify({ workers: collectWorkerStates() }, null, 2)}\n`,
      )
      return
    }
    if (args.integrateWorker) {
      assertPrimaryClean()
      const descriptor = buildWorkerDescriptor({ change: args.integrateWorker })
      const launch = buildCodexWorkerLaunch({ descriptor })
      const summary = readWorkerSummary({
        launched: { ...launch, change: args.integrateWorker },
      })
      mergeWorkerResult({ result: summary })
      assertPrimaryClean()
      updateWorkerState({ change: args.integrateWorker, status: 'merged' })
      console.log(
        `merged ${args.integrateWorker}; run $opsx-verify, $adversarial-review, smoke, and validation before --checkpoint-archive`,
      )
      return
    }
    if (args.checkpointArchive) {
      const descriptor = buildWorkerDescriptor({
        change: args.checkpointArchive,
      })
      let workerCommit = null
      let workerDescriptor = null
      try {
        workerCommit = shellOut('git', ['rev-parse', descriptor.branch], {
          cwd: repoRoot,
        })
        workerDescriptor = descriptor
      } catch {
        // Closeout-only changes intentionally have no worker branch.
      }
      const checkpoint = writeArchiveCheckpoint({
        change: args.checkpointArchive,
        gates: args.gates,
        workerCommit,
        workerDescriptor,
      })
      console.log(
        `awaiting root archive for ${checkpoint.change}; after $opsx-archive, run: node .agents/skills/opsxx-orchestrate/scripts/opsxx-orchestrate.mjs --resume-archive ${checkpoint.change}`,
      )
      return
    }
    if (args.resumeArchive) {
      const checkpoint = resumeArchivedChange({ change: args.resumeArchive })
      console.log(`committed archive lifecycle for ${checkpoint.change}`)
      return
    }
    if (args.finalizeRun) {
      process.stdout.write(`${JSON.stringify(finalizeRun(), null, 2)}\n`)
      return
    }
    if (args.launchWorkers) {
      assertPrimaryClean()
      const plan = buildLaunchPlan(args)
      const descriptors = plan.launches.map(({ descriptor }) => descriptor)
      const dirtyReports = inspectDirtyTargets({ descriptors })
      const dirtyDecisions = dirtyReports.map((report) =>
        buildDirtyTargetDecision(report),
      )
      const { resume, discard } = dirtyTargetActionSets(args)
      const dirtyChanges = new Set(dirtyReports.map((report) => report.change))
      const actionWithoutDirtyTarget = [...resume, ...discard].filter(
        (change) => !dirtyChanges.has(change),
      )
      if (actionWithoutDirtyTarget.length > 0) {
        throw new Error(
          `Dirty target action provided for clean or absent target: ${actionWithoutDirtyTarget.join(', ')}`,
        )
      }
      const unresolvedDirtyDecisions = dirtyDecisions.filter(
        (decision) =>
          !resume.has(decision.change) && !discard.has(decision.change),
      )
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify({ ...plan, dirtyTargetChoices: dirtyDecisions }, null, 2)}\n`,
        )
      }
      if (unresolvedDirtyDecisions.length > 0) {
        if (!args.json) {
          for (const decision of unresolvedDirtyDecisions) {
            console.log(decision.question)
            console.log('')
          }
        }
        throw new Error(
          'Dirty target worktrees require operator choice before launch. Re-run with --resume-dirty-target <change> or --discard-dirty-target <change>.',
        )
      }
      for (const descriptor of descriptors.filter((descriptor) =>
        discard.has(descriptor.change),
      )) {
        cleanupWorkerWorktree({ descriptor, force: true })
      }
      for (const descriptor of descriptors) {
        if (resume.has(descriptor.change) || worktreeExists(descriptor))
          continue
        createWorkerWorktree({
          descriptor,
          protectedWorktreePaths: new Set(
            descriptors.map((item) => item.worktreePath),
          ),
        })
      }
      for (const descriptor of descriptors) {
        preflightWorkerLaunch({
          descriptor,
          allowDirty: resume.has(descriptor.change),
        })
        const statePath = workerStatePath({ change: descriptor.change })
        if (fs.existsSync(statePath)) {
          throw new Error(
            `Worker runtime state already exists for ${descriptor.change}: ${statePath}`,
          )
        }
      }
      const launchedWorkers = []
      for (const descriptor of descriptors) {
        const launched = launchWorker({
          descriptor,
          allowDirty: resume.has(descriptor.change),
          detached: true,
        })
        launchedWorkers.push(recordLaunchedWorker({ launched, descriptor }))
      }
      process.stdout.write(
        `${JSON.stringify({ launchedWorkers, closeoutOnly: plan.closeoutOnly }, null, 2)}\n`,
      )
      return
    }
    if (args.dryLaunch) {
      const plan = buildLaunchPlan(args)
      const descriptors = plan.launches.map(({ descriptor }) => descriptor)
      const dirtyTargetChoices = inspectDirtyTargets({ descriptors }).map(
        (report) => buildDirtyTargetDecision(report),
      )
      const result = { ...plan, dirtyTargetChoices }
      if (args.json || args.dryLaunch) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      }
      return
    }

    const result = buildDryRun(args)
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    console.log(
      `worktree orchestration plan (admission=${result.admissionMode}, admitted-workers=${result.admittedWorkerCount})`,
    ) // <!-- skill-reference-sigil-bypass -->
    for (const event of result.authoringEvents) {
      console.log(`author ${event.change}: ${event.command}`)
    }
    for (const event of result.skippedWork ?? []) {
      console.log(
        `skip ${event.change}: backlog-blocked by ${event.blockedBy.join(', ')}`,
      )
    }
    for (const event of result.events) {
      if (event.type === 'admit') console.log(`admit ${event.change}`)
      else if (event.type === 'worker-complete')
        console.log(`complete ${event.change}`)
      else if (event.type === 'integrate')
        console.log(`integrate ${event.change}: ${event.steps.join(' -> ')}`)
      else if (event.type === 'archive') console.log(`archive ${event.change}`)
      else if (event.type === 'cleanup-worktree')
        console.log(`cleanup-worktree ${event.change}`)
      else if (event.type === 'validate-main')
        console.log(`validate-main once for ${event.changes.length} change(s)`)
    }
  } catch (error) {
    console.error(`[worktree-orchestrator] ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
