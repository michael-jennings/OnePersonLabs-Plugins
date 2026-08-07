import fs from 'node:fs'
import path from 'node:path'

const AUTHORING_COMMAND_BY_STATE = {
  'delta-free-no-tasks': '$opsx-ff',
  'tasks-only': '$opsx-apply',
  'specs-without-tasks': '$opsx-continue',
}

function hasDeltaSpecs(changesRoot, change) {
  const specsDir = path.join(changesRoot, change, 'specs')
  if (!fs.existsSync(specsDir)) return false
  return fs
    .readdirSync(specsDir)
    .some((entry) => fs.statSync(path.join(specsDir, entry)).isDirectory())
}

export function hasTasks(changesRoot, change) {
  return fs.existsSync(path.join(changesRoot, change, 'tasks.md'))
}

export function authoredArtifactState(changesRoot, change) {
  const hasSpecs = hasDeltaSpecs(changesRoot, change)
  const hasTasksFile = hasTasks(changesRoot, change)
  if (!hasSpecs) return hasTasksFile ? 'tasks-only' : 'delta-free-no-tasks'
  return hasTasksFile ? 'delta-capable' : 'specs-without-tasks'
}

export function deltaCapableChanges(changesRoot, graph) {
  return new Set(
    unblockedNodes(graph).filter(
      (change) =>
        authoredArtifactState(changesRoot, change) === 'delta-capable',
    ),
  )
}

export function unblockedNodes(graph, archived = new Set()) {
  const backlogBlocked = new Set(
    (graph.blockedByBacklog ?? []).map((entry) => entry.change),
  )
  return graph.nodes
    .filter((node) => !backlogBlocked.has(node))
    .filter((node) =>
      graph.edges
        .filter((edge) => edge.to === node)
        .every((edge) => archived.has(edge.from)),
    )
    .sort()
}

export function backlogBlockedEvents(graph) {
  return (graph.blockedByBacklog ?? []).map((entry) => ({
    type: 'backlog-blocked',
    change: entry.change,
    blockedBy: entry.blockedBy,
    direct: entry.direct,
  }))
}

export function claimsByChange(claims, eligibleChanges = null) {
  const byChange = new Map()
  const allowedChanges = eligibleChanges ? new Set(eligibleChanges) : null
  for (const [unit, changes] of claims.entries()) {
    for (const change of changes) {
      if (allowedChanges && !allowedChanges.has(change)) continue
      if (!byChange.has(change)) byChange.set(change, new Set())
      byChange.get(change).add(unit)
    }
  }
  return byChange
}

export function overlapFree(candidate, inFlight, claimMap) {
  const candidateUnits = claimMap.get(candidate) ?? new Set()
  for (const active of inFlight) {
    const activeUnits = claimMap.get(active) ?? new Set()
    for (const unit of candidateUnits) {
      if (activeUnits.has(unit)) return false
    }
  }
  return true
}

export function buildAuthoringEvents(changesRoot, graph) {
  const events = []
  for (const change of unblockedNodes(graph)) {
    const state = authoredArtifactState(changesRoot, change)
    if (state === 'delta-capable') continue

    const commandName = AUTHORING_COMMAND_BY_STATE[state]
    if (!commandName) {
      throw new Error(`Unsupported authored artifact state: ${state}`)
    }

    events.push({
      type: 'author',
      change,
      command: `${commandName} ${change}`,
    })
  }
  return events
}
