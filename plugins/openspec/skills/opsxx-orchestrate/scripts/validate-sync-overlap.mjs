#!/usr/bin/env node

/**
 * Sync-Overlap Detector (per-wave)
 *
 * A sync unit is "claimed" by a change when that change has a delta requirement
 * under `openspec/changes/<change>/specs/<capability>/spec.md`. Because
 * $opsx-sync is agent-driven and merges individual requirement
 * intent, the safe unit is normally `<capability>::<requirement>`. If a delta
 * has no parseable requirement headings, this falls back to whole-capability
 * keying for that delta rather than falsely permitting concurrency.
 *
 * IMPORTANT -- this is a PER-WAVE check, not a global invariant. Two active
 * changes co-claiming a capability is perfectly legal for SERIAL work: one
 * archives (and syncs) before the other syncs, so they never collide. The
 * collision only matters when they land in the same parallel wave. That is why
 * this is NOT part of `pnpm run validate` (the full backlog legitimately has
 * co-claims) -- $opsxx-orchestrate calls it on each candidate wave to keep
 * co-claiming changes in separate waves.
 *
 * Usage:
 *   node .agents/skills/opsxx-orchestrate/scripts/validate-sync-overlap.mjs [--changes-root <dir>] [--json] [change ...]
 *
 *   change ...        Restrict the consideration set to these change names (a
 *                     wave). With none given, considers all active changes
 *                     (a full-backlog diagnostic).
 *   --changes-root D  Scan D instead of <repo>/openspec/changes (for tests).
 *   --json            Print { claims, conflicts } as JSON to stdout and exit 0
 *                     (data mode for the orchestrator to form disjoint waves).
 *
 * Exit 0: no sync unit is claimed by >1 change in the consideration set
 *         (or --json mode, always).
 * Exit 1: one or more sync units are co-claimed within the consideration set.
 *
 * See openspec/specs/architecture-change-orchestration/spec.md.
 */

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  let changesRoot = null
  let json = false
  const only = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') json = true
    else if (a === '--changes-root') changesRoot = argv[++i]
    else if (a.startsWith('--')) {
      /* ignore unknown flags */
    } else only.push(a)
  }
  if (!changesRoot) changesRoot = join(__dirname, '..', 'openspec', 'changes')
  return { changesRoot, json, only }
}

function normalizeRequirementName(name) {
  return name.trim().replace(/\s+/g, ' ')
}

function pushClaim(claims, unit, change) {
  if (!claims.has(unit)) claims.set(unit, [])
  claims.get(unit).push(change)
}

/** Parse capability::requirement sync units from a delta spec. */
export function parseDeltaClaims(capability, text) {
  const units = new Set()
  const lines = text.split(/\r?\n/)
  let inDeltaSection = false
  let inRenamedSection = false

  for (const raw of lines) {
    const heading = raw.match(/^##\s+([A-Z]+)\s+Requirements\s*$/)
    if (heading) {
      const op = heading[1]
      inDeltaSection = ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'].includes(op)
      inRenamedSection = op === 'RENAMED'
      continue
    }
    if (/^##\s+/.test(raw)) {
      inDeltaSection = false
      inRenamedSection = false
      continue
    }
    if (!inDeltaSection) continue

    const req = raw.match(/^###\s+Requirement:\s+(.+?)\s*$/)
    if (req) {
      units.add(`${capability}::${normalizeRequirementName(req[1])}`)
      continue
    }

    if (inRenamedSection) {
      const renamed = raw.match(
        /^\s*-\s*(?:FROM|TO):\s*`?###\s+Requirement:\s+([^`]+?)`?\s*$/i,
      )
      if (renamed)
        units.add(`${capability}::${normalizeRequirementName(renamed[1])}`)
    }
  }

  return [...units].sort()
}

/** Build sync-unit -> [changes] over the active (non-archive) change set. */
export function computeClaims(changesRoot, only) {
  const claims = new Map()
  if (!existsSync(changesRoot)) return claims

  let active = readdirSync(changesRoot).filter((entry) => {
    if (entry === 'archive') return false
    return statSync(join(changesRoot, entry)).isDirectory()
  })
  if (only && only.length) {
    const set = new Set(only)
    active = active.filter((c) => set.has(c))
  }

  for (const change of active) {
    const specsDir = join(changesRoot, change, 'specs')
    if (!existsSync(specsDir)) continue
    let caps
    try {
      caps = readdirSync(specsDir)
    } catch {
      continue
    }
    for (const cap of caps) {
      if (!statSync(join(specsDir, cap)).isDirectory()) continue
      const specPath = join(specsDir, cap, 'spec.md')
      let units = []
      if (existsSync(specPath)) {
        units = parseDeltaClaims(cap, readFileSync(specPath, 'utf8'))
      }
      if (units.length === 0) units = [cap]
      for (const unit of units) pushClaim(claims, unit, change)
    }
  }
  return claims
}

function main() {
  const { changesRoot, json, only } = parseArgs(process.argv.slice(2))
  const claims = computeClaims(changesRoot, only)
  const conflicts = [...claims.entries()]
    .filter(([, cs]) => cs.length > 1)
    .map(([unit, claimants]) => ({ unit, cap: unit, claimants }))

  if (json) {
    process.stdout.write(
      JSON.stringify({ claims: Object.fromEntries(claims), conflicts }) + '\n',
    )
    process.exit(0)
  }

  const scope = only.length ? `wave [${only.join(', ')}]` : 'all active changes'
  console.log('🔍 OpenSpec Sync-Overlap Check --', scope)

  if (conflicts.length === 0) {
    console.log('✅ No sync unit is co-claimed within this set')
    process.exit(0)
  }

  console.error('\n❌ Sync-overlap: sync units co-claimed within this set')
  console.error('(these changes cannot land in the same parallel wave)\n')
  for (const { unit, claimants } of conflicts) {
    console.error(`  unit: ${unit}`)
    for (const c of claimants) console.error(`    - ${c}`)
    console.error('')
  }
  process.exit(1)
}

// Only run main when invoked directly (allow importing computeClaims in tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
