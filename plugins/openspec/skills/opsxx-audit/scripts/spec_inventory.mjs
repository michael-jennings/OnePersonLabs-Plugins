#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

const optionValue = (name) => {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

const hasFlag = (name) => args.includes(name)

const repoRoot = path.resolve(
  optionValue('--root') ?? process.env.CODEX_PROJECT_DIR ?? process.cwd(),
)
const specsRoot = path.join(repoRoot, 'openspec', 'specs')
const capabilityFilter = optionValue('--capability')
const asJson = hasFlag('--json')

if (!existsSync(specsRoot)) {
  throw new Error(`OpenSpec specs root not found: ${specsRoot}`)
}

const parseFrontmatter = (lines) => {
  if (lines[0] !== '---') return { frontmatter: {}, bodyStart: 0 }

  const frontmatter = {}
  let index = 1
  for (; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === '---') break
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match) {
      frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '')
    }
  }

  return { frontmatter, bodyStart: index + 1 }
}

const normativePattern = /\b(SHALL|MUST|SHOULD|MAY)\b/

const parseSpec = (capability) => {
  const file = path.join(specsRoot, capability, 'spec.md')
  const content = readFileSync(file, 'utf8')
  const lines = content.split(/\r?\n/)
  const { frontmatter } = parseFrontmatter(lines)
  const requirements = []
  let currentRequirement = null
  let currentScenario = null

  const pushNormative = (lineNumber, text) => {
    if (!normativePattern.test(text)) return
    const target = currentScenario ?? currentRequirement
    if (!target) return
    target.normative.push({ line: lineNumber, text })
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1
    const requirementMatch = /^### Requirement:\s*(.+?)\s*$/.exec(line)
    if (requirementMatch) {
      currentRequirement = {
        name: requirementMatch[1],
        line: lineNumber,
        scenarios: [],
        normative: [],
      }
      requirements.push(currentRequirement)
      currentScenario = null
      return
    }

    const scenarioMatch = /^#### Scenario:\s*(.+?)\s*$/.exec(line)
    if (scenarioMatch && currentRequirement) {
      currentScenario = {
        name: scenarioMatch[1],
        line: lineNumber,
        normative: [],
      }
      currentRequirement.scenarios.push(currentScenario)
      return
    }

    pushNormative(lineNumber, line.trim())
  })

  return {
    capability,
    file: path.relative(repoRoot, file),
    frontmatter,
    requirements,
  }
}

const capabilities = readdirSync(specsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((capability) => !capabilityFilter || capability === capabilityFilter)
  .filter((capability) =>
    existsSync(path.join(specsRoot, capability, 'spec.md')),
  )
  .sort()

if (capabilityFilter && capabilities.length === 0) {
  throw new Error(`Spec capability not found: ${capabilityFilter}`)
}

const inventory = capabilities.map(parseSpec)

if (asJson) {
  process.stdout.write(`${JSON.stringify({ specs: inventory }, null, 2)}\n`)
} else {
  for (const spec of inventory) {
    const requirementCount = spec.requirements.length
    const scenarioCount = spec.requirements.reduce(
      (total, requirement) => total + requirement.scenarios.length,
      0,
    )
    const domain = spec.frontmatter.domain
      ? ` domain=${spec.frontmatter.domain}`
      : ''
    const packageName = spec.frontmatter.package
      ? ` package=${spec.frontmatter.package}`
      : ''

    process.stdout.write(
      `## ${spec.capability} (${requirementCount} requirements, ${scenarioCount} scenarios)${domain}${packageName}\n`,
    )
    process.stdout.write(`${spec.file}\n`)

    for (const requirement of spec.requirements) {
      process.stdout.write(`- R:${requirement.line} ${requirement.name}\n`)
      for (const scenario of requirement.scenarios) {
        process.stdout.write(`  - S:${scenario.line} ${scenario.name}\n`)
      }
    }

    process.stdout.write('\n')
  }
}
