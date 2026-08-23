/**
 * Permission engine.
 *
 * Resolves a query against the layered ruleset, prompts the user when the answer
 * is `ask`, and records the answer so the same question is not asked twice.
 *
 * The engine is deliberately synchronous in its decision logic and asynchronous
 * only where a human is involved. That separation makes the decision path
 * testable without a UI and keeps the prompt path from being able to change a
 * `deny` into an `allow`.
 */

import { relative, resolve } from "node:path"

import { Bus, Events } from "../util/bus.js"
import { newId } from "../util/id.js"
import { logger } from "../util/log.js"
import { deferred, type Deferred } from "../util/async.js"
import { PermissionRepo } from "../storage/repo.js"
import type {
  ApprovalRecord,
  ApprovalScope,
  PermissionAction,
  PermissionDecision,
  PermissionOption,
  PermissionPrompt,
  PermissionQuery,
  PermissionRule,
  PermissionSource,
  RiskLevel,
} from "./types.js"
import { PermissionDeniedError, SOURCE_PRECEDENCE } from "./types.js"
import {
  assessRisk,
  builtinRules,
  isPathAction,
  matchResource,
  specificity,
  suggestPattern,
} from "./rules.js"

const log = logger("permission")

/* ------------------------------------------------------------------ */
/* Ruleset                                                             */
/* ------------------------------------------------------------------ */

/**
 * An immutable, pre-sorted ruleset.
 *
 * Sorting once at construction rather than on every query matters: an agent
 * makes hundreds of permission checks per session and the ruleset can hold a
 * few hundred rules after the built-ins, config, and stored approvals are
 * merged.
 */
export class Ruleset {
  private readonly byAction = new Map<PermissionAction, PermissionRule[]>()

  constructor(rules: readonly PermissionRule[]) {
    for (const rule of rules) {
      const list = this.byAction.get(rule.action)
      if (list) list.push(rule)
      else this.byAction.set(rule.action, [rule])
    }
    for (const list of this.byAction.values()) {
      // Highest layer first, then most specific pattern first.
      list.sort((left, right) => {
        const layer = SOURCE_PRECEDENCE[right.source] - SOURCE_PRECEDENCE[left.source]
        if (layer !== 0) return layer
        return specificity(right.resource) - specificity(left.resource)
      })
    }
  }

  rulesFor(action: PermissionAction): readonly PermissionRule[] {
    return this.byAction.get(action) ?? []
  }

  all(): PermissionRule[] {
    return [...this.byAction.values()].flat()
  }

  with(rules: readonly PermissionRule[]): Ruleset {
    return new Ruleset([...this.all(), ...rules])
  }

  /**
   * Finds the governing rule.
   *
   * A `deny` anywhere wins outright, regardless of layer, because a safety rule
   * whose effect depends on ordering is not a safety rule. Otherwise the first
   * match in precedence order decides.
   */
  resolve(action: PermissionAction, resource: string, cwd: string): PermissionRule | undefined {
    const candidates = this.rulesFor(action)
    let first: PermissionRule | undefined

    for (const rule of candidates) {
      if (!matchResource(action, rule.resource, resource, cwd)) continue
      if (rule.effect === "deny") {
        // A deny from a lower layer is still a deny, unless a higher layer
        // explicitly allowed this exact pattern.
        const overridden = candidates.some(
          (other) =>
            other.effect === "allow" &&
            SOURCE_PRECEDENCE[other.source] > SOURCE_PRECEDENCE[rule.source] &&
            other.resource === rule.resource,
        )
        if (!overridden) return rule
        continue
      }
      if (!first) first = rule
    }

    return first
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export interface PermissionEngineOptions {
  readonly cwd: string
  readonly projectId?: string
  /** Skips every prompt and allows anything not explicitly denied. */
  readonly yolo?: boolean
  /** Denies anything that would prompt, used for non-interactive runs. */
  readonly nonInteractive?: boolean
  /** How long to wait for a human answer before giving up. */
  readonly promptTimeoutMs?: number
}

interface PendingPrompt {
  readonly prompt: PermissionPrompt
  readonly deferred: Deferred<PermissionOption>
  readonly timer: NodeJS.Timeout
}

export class PermissionEngine {
  private base: Ruleset
  private readonly agentRules = new Map<string, PermissionRule[]>()
  private readonly sessionRules = new Map<string, PermissionRule[]>()
  private readonly pending = new Map<string, PendingPrompt>()
  private readonly denials = new Map<string, Array<{ action: string; resource: string; reason?: string }>>()
  private readonly repo: PermissionRepo
  private readonly options: PermissionEngineOptions

  constructor(rules: readonly PermissionRule[], options: PermissionEngineOptions) {
    this.base = new Ruleset([...builtinRules(), ...rules])
    this.options = options
    this.repo = new PermissionRepo()
    this.loadStored()
  }

  /** Loads persisted approvals for this project. */
  private loadStored(): void {
    try {
      const records = this.repo.list({ projectId: this.options.projectId })
      const rules = records
        .filter((record) => !record.expiresAt || record.expiresAt > Date.now())
        .map(
          (record): PermissionRule => ({
            action: record.action as PermissionAction,
            resource: record.pattern,
            effect: record.effect,
            source: "stored",
            reason: "Previously approved for this project.",
          }),
        )
      if (rules.length) this.base = this.base.with(rules)
      log.debug("loaded stored approvals", { count: rules.length })
    } catch (error) {
      log.warn("could not load stored approvals", { error: String(error) })
    }
  }

  /** Registers rules that apply only to a given agent. */
  setAgentRules(agent: string, rules: readonly PermissionRule[]): void {
    this.agentRules.set(
      agent,
      rules.map((rule) => ({ ...rule, source: "agent" as PermissionSource })),
    )
  }

  /** Registers rules that apply only for the lifetime of a session. */
  addSessionRule(sessionId: string, rule: PermissionRule): void {
    const list = this.sessionRules.get(sessionId) ?? []
    list.push({ ...rule, source: "session" })
    this.sessionRules.set(sessionId, list)
  }

  clearSession(sessionId: string): void {
    this.sessionRules.delete(sessionId)
    this.denials.delete(sessionId)
  }

  private rulesetFor(query: PermissionQuery): Ruleset {
    const extra: PermissionRule[] = []
    if (query.agent) extra.push(...(this.agentRules.get(query.agent) ?? []))
    if (query.sessionId) extra.push(...(this.sessionRules.get(query.sessionId) ?? []))
    return extra.length ? this.base.with(extra) : this.base
  }

  /**
   * Evaluates a query without prompting. Pure, so it can be used to decide
   * whether a tool should even be offered to the model.
   */
  evaluate(query: PermissionQuery): PermissionDecision {
    const cwd = this.options.cwd
    const resource = this.normalizeResource(query.action, query.resource)
    const risk = query.risk ?? assessRisk(query.action, resource)
    const rule = this.rulesetFor(query).resolve(query.action, resource, cwd)

    if (rule?.effect === "deny") {
      return {
        effect: "deny",
        rule,
        reason: rule.reason ?? `Blocked by a ${rule.source} rule matching \`${rule.resource}\`.`,
        risk,
      }
    }

    // Yolo mode collapses every `ask` into `allow`, but never touches `deny`.
    if (this.options.yolo) {
      return { effect: "allow", rule, reason: "Permission checks are disabled for this run.", risk }
    }

    if (rule?.effect === "allow") {
      return {
        effect: "allow",
        rule,
        reason: rule.reason ?? `Allowed by a ${rule.source} rule matching \`${rule.resource}\`.`,
        risk,
      }
    }

    return {
      effect: "ask",
      rule,
      reason: rule?.reason ?? "No rule covers this operation.",
      suggestedPattern: suggestPattern(query.action, resource, cwd),
      risk,
    }
  }

  /**
   * Evaluates and, if needed, prompts. Throws `PermissionDeniedError` when the
   * operation is not permitted; returns normally when it is.
   */
  async request(query: PermissionQuery & { title: string; detail?: string }): Promise<void> {
    const decision = this.evaluate(query)
    const resource = this.normalizeResource(query.action, query.resource)

    if (decision.effect === "allow") {
      log.debug("permission allowed", { action: query.action, resource })
      return
    }

    if (decision.effect === "deny") {
      this.recordDenial(query.sessionId, query.action, resource, decision.reason)
      throw new PermissionDeniedError(query.action, resource, decision.reason, decision.rule)
    }

    if (this.options.nonInteractive) {
      const reason =
        `This operation needs approval, and there is no interactive session to ask. ` +
        `Add a rule such as {"permission":{"${query.action}":{"${decision.suggestedPattern ?? resource}":"allow"}}} ` +
        `to the configuration, or run without --non-interactive.`
      this.recordDenial(query.sessionId, query.action, resource, reason)
      throw new PermissionDeniedError(query.action, resource, reason, decision.rule)
    }

    const chosen = await this.prompt({
      sessionId: query.sessionId ?? "",
      action: query.action,
      resource,
      title: query.title,
      detail: query.detail,
      risk: decision.risk,
      suggestedPattern: decision.suggestedPattern,
    })

    if (chosen.effect === "deny") {
      const reason = "The user declined this operation."
      if (chosen.scope !== "once") {
        this.persist(query, chosen, resource, "deny")
      }
      this.recordDenial(query.sessionId, query.action, resource, reason)
      throw new PermissionDeniedError(query.action, resource, reason)
    }

    if (chosen.scope !== "once") {
      this.persist(query, chosen, resource, "allow")
    }
  }

  /* ---------------------------------------------------------------- */
  /* Prompting                                                         */
  /* ---------------------------------------------------------------- */

  private async prompt(input: {
    sessionId: string
    action: PermissionAction
    resource: string
    title: string
    detail?: string
    risk: RiskLevel
    suggestedPattern?: string
  }): Promise<PermissionOption> {
    const id = newId("permission")
    const prompt: PermissionPrompt = {
      id,
      sessionId: input.sessionId,
      action: input.action,
      resource: input.resource,
      title: input.title,
      detail: input.detail,
      risk: input.risk,
      options: buildOptions(input.action, input.resource, input.suggestedPattern, input.risk),
    }

    const promise = deferred<PermissionOption>()
    const timeoutMs = this.options.promptTimeoutMs ?? 30 * 60_000
    const timer = setTimeout(() => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      entry.deferred.resolve(
        prompt.options.find((option) => option.effect === "deny") ?? {
          id: "deny",
          label: "Deny",
          effect: "deny",
          scope: "once",
        },
      )
    }, timeoutMs)
    if (typeof timer.unref === "function") timer.unref()

    this.pending.set(id, { prompt, deferred: promise, timer })
    Bus.publish(Events.permissionRequested, { prompt })
    log.info("permission prompt", { action: input.action, resource: input.resource, risk: input.risk })

    return promise.promise
  }

  /** Called by the UI when the user answers. */
  respond(promptId: string, optionId: string): boolean {
    const entry = this.pending.get(promptId)
    if (!entry) return false
    this.pending.delete(promptId)
    clearTimeout(entry.timer)
    const option =
      entry.prompt.options.find((candidate) => candidate.id === optionId) ??
      entry.prompt.options.find((candidate) => candidate.effect === "deny")
    if (!option) return false
    Bus.publish(Events.permissionResolved, {
      promptId,
      optionId: option.id,
      effect: option.effect,
    })
    entry.deferred.resolve(option)
    return true
  }

  /** Cancels every outstanding prompt, e.g. when the session is interrupted. */
  cancelAll(sessionId?: string): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (sessionId && entry.prompt.sessionId !== sessionId) continue
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.deferred.resolve({ id: "deny", label: "Cancelled", effect: "deny", scope: "once" })
    }
  }

  pendingPrompts(sessionId?: string): PermissionPrompt[] {
    return [...this.pending.values()]
      .filter((entry) => !sessionId || entry.prompt.sessionId === sessionId)
      .map((entry) => entry.prompt)
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                       */
  /* ---------------------------------------------------------------- */

  private persist(
    query: PermissionQuery,
    option: PermissionOption,
    resource: string,
    effect: "allow" | "deny",
  ): void {
    const pattern = option.pattern ?? resource
    const rule: PermissionRule = {
      action: query.action,
      resource: pattern,
      effect,
      source: option.scope === "session" ? "session" : "stored",
      reason:
        option.scope === "session"
          ? "Approved for this session."
          : "Approved for this project.",
    }

    if (option.scope === "session") {
      if (query.sessionId) this.addSessionRule(query.sessionId, rule)
      else this.base = this.base.with([rule])
      return
    }

    this.base = this.base.with([{ ...rule, source: "stored" }])

    const record: ApprovalRecord = {
      id: newId("permission"),
      action: query.action,
      pattern,
      effect,
      scope: option.scope,
      sessionId: option.scope === "session" ? query.sessionId : undefined,
      projectId: option.scope === "global" ? undefined : this.options.projectId,
      createdAt: Date.now(),
    }
    try {
      this.repo.grant(record)
      log.info("stored approval", { action: record.action, pattern, scope: record.scope })
    } catch (error) {
      log.warn("could not store approval", { error: String(error) })
    }
  }

  /* ---------------------------------------------------------------- */
  /* Denials                                                           */
  /* ---------------------------------------------------------------- */

  private recordDenial(
    sessionId: string | undefined,
    action: PermissionAction,
    resource: string,
    reason: string,
  ): void {
    if (!sessionId) return
    const list = this.denials.get(sessionId) ?? []
    // Keep the list short; the reminder only shows a handful anyway.
    if (!list.some((entry) => entry.action === action && entry.resource === resource)) {
      list.push({ action, resource, reason })
    }
    while (list.length > 20) list.shift()
    this.denials.set(sessionId, list)
    Bus.publish(Events.permissionDenied, { sessionId, action, resource, reason })
  }

  /** Denials since the last call, for the system reminder. */
  drainDenials(sessionId: string): Array<{ action: string; resource: string; reason?: string }> {
    const list = this.denials.get(sessionId) ?? []
    this.denials.set(sessionId, [])
    return list
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /** Path resources are normalised so patterns behave predictably. */
  private normalizeResource(action: PermissionAction, resource: string): string {
    if (!isPathAction(action)) return resource.trim().replace(/\s+/g, " ")
    return resolve(this.options.cwd, resource)
  }

  /** True when the path is outside the working directory. */
  isExternal(path: string): boolean {
    const relativePath = relative(this.options.cwd, resolve(this.options.cwd, path))
    return relativePath.startsWith("..") || relativePath.includes(`..${"/"}`)
  }

  /** Explains the current ruleset, used by `praxis config permissions`. */
  describe(): Array<{ action: string; resource: string; effect: string; source: string }> {
    return this.base
      .all()
      .map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
        source: rule.source,
      }))
      .sort((left, right) =>
        left.action === right.action
          ? specificity(right.resource) - specificity(left.resource)
          : left.action < right.action
            ? -1
            : 1,
      )
  }

  /** Forgets stored approvals, optionally filtered by action. */
  revoke(action?: PermissionAction): number {
    const removed = this.repo.revoke({ action, projectId: this.options.projectId })
    this.base = new Ruleset([
      ...builtinRules(),
      ...this.base.all().filter((rule) => rule.source !== "stored"),
    ])
    this.loadStored()
    return removed
  }
}

/* ------------------------------------------------------------------ */
/* Option construction                                                 */
/* ------------------------------------------------------------------ */

/**
 * Builds the answer options for a prompt.
 *
 * The set is tuned so the common case is one keystroke. For a low-risk
 * operation, "allow this pattern for the session" is the default because that is
 * almost always what the user wants; for a critical one, "deny" is the default
 * and the persistent options are removed entirely, because nobody should be able
 * to permanently approve `rm -rf /` by pressing Enter twice.
 */
export function buildOptions(
  action: PermissionAction,
  resource: string,
  suggestedPattern: string | undefined,
  risk: RiskLevel,
): PermissionOption[] {
  const pattern = suggestedPattern ?? resource
  const options: PermissionOption[] = []

  if (risk === "critical") {
    options.push({ id: "deny", label: "Reject", effect: "deny", scope: "once", primary: true })
    options.push({ id: "allow-once", label: "Allow once (dangerous)", effect: "allow", scope: "once" })
    return options
  }

  const isDefault = risk === "low" || risk === "medium"
  options.push({
    id: "allow-once",
    label: "Allow once",
    effect: "allow",
    scope: "once",
    primary: !isDefault,
  })
  options.push({
    id: "allow-session",
    label: `Always allow \`${pattern}\` this session`,
    effect: "allow",
    scope: "session",
    pattern,
    primary: isDefault,
  })

  if (risk !== "high") {
    options.push({
      id: "allow-project",
      label: `Always allow \`${pattern}\` in this project`,
      effect: "allow",
      scope: "project",
      pattern,
    })
  }

  options.push({ id: "deny", label: "Reject", effect: "deny", scope: "once" })
  options.push({
    id: "deny-session",
    label: `Never allow \`${pattern}\` this session`,
    effect: "deny",
    scope: "session",
    pattern,
  })

  return options
}

/* ------------------------------------------------------------------ */
/* Singleton                                                           */
/* ------------------------------------------------------------------ */

let instance: PermissionEngine | undefined

export function permissionEngine(): PermissionEngine {
  if (!instance) {
    instance = new PermissionEngine([], { cwd: process.cwd() })
  }
  return instance
}

export function setPermissionEngine(engine: PermissionEngine): void {
  instance = engine
}
