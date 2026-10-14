export * as OrchestrationComparison from "./comparison"

import { DateTime } from "effect"
import { Orchestration } from "@opencode-ai/schema/orchestration"
import { Hash } from "../util/hash"

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return undefined
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]
}

export function pendingLabels(details: ReadonlyArray<Orchestration.Detail>) {
  return details.flatMap((detail) => detail.tasks.flatMap((task) => {
    const attempt = detail.attempts.findLast((item) => item.taskID === task.id)
    if (!attempt || !["succeeded", "failed"].includes(attempt.status)) return []
    if (detail.triageLabels.some((label) => label.attemptID === attempt.id)) return []
    const rate = detail.run.policy?.roles.judge.labelSampleRate ?? 1
    if (Number.parseInt(Hash.sha256(attempt.id).slice(0, 8), 16) / 0xffffffff >= rate) return []
    return [{ runID: detail.run.id, taskID: task.id }]
  }))
}

export function judges(details: ReadonlyArray<Orchestration.Detail>): Orchestration.JudgeComparison {
  const observations = details.flatMap((detail) => detail.attempts.flatMap((attempt) => {
    const verdict = attempt.verdict
    if (!verdict) return []
    const choices = verdict.experiment?.arms.map((arm) => ({
      name: arm.arm,
      verdict: arm.verdict,
      authoritative: arm.arm === verdict.experiment?.authoritativeArm,
    })) ?? [{ name: verdict.overall?.result.provider ?? detail.run.policy?.roles.judge.provider ?? "unknown", verdict, authoritative: true }]
    return choices.map((choice) => ({
      ...choice,
      attemptID: attempt.id,
      taskID: attempt.taskID,
      runID: detail.run.id,
      overrides: detail.reviews.filter((review) => review.attemptID === attempt.id).length,
      gaps: detail.deliveries.some((delivery) => delivery.review.decision === "gaps") ? 1 : 0,
      label: detail.triageLabels.find((label) => label.attemptID === attempt.id)?.decision,
    }))
  }))
  const names = [...new Set(observations.map((item) => item.name))].sort()
  const arms = names.map((name) => {
    const values = observations.filter((item) => item.name === name)
    const latencies = values.flatMap((item) => item.verdict.overall?.result.latencyMs === undefined
      ? [] : [item.verdict.overall.result.latencyMs])
    return {
      name,
      provider: values.find((item) => item.verdict.overall)?.verdict.overall?.result.provider ?? name,
      calls: values.length,
      valid: values.filter((item) => item.verdict.overall?.result.status === "valid").length,
      fallbacks: values.filter((item) => item.verdict.overall?.result.status !== "valid").length,
      authoritative: values.filter((item) => item.authoritative).length,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      inputTokens: values.reduce((total, item) => total + (item.verdict.overall?.result.usage?.inputTokens ?? 0), 0),
      outputTokens: values.reduce((total, item) => total + (item.verdict.overall?.result.usage?.outputTokens ?? 0), 0),
      estimatedCostUsd: values.reduce((total, item) => total + [
        item.verdict.overall?.result,
        ...item.verdict.criteria.map((criterion) => criterion.result),
      ].reduce((cost, result) => cost + (result?.usage?.estimatedCostUsd ?? 0), 0), 0),
      humanOverrides: values.reduce((total, item) => total + item.overrides, 0),
      downstreamGaps: values.reduce((total, item) => total + item.gaps, 0),
      labeled: values.filter((item) => item.label).length,
      labelAgreement: values.filter((item) => item.label &&
        (item.verdict.decision === "accept" ? "looks_ready" : "needs_attention") === item.label).length,
    }
  })
  const paired = details.flatMap((detail) => detail.attempts.flatMap((attempt) =>
    attempt.verdict?.experiment?.assignment === "paired" ? [{
      runID: detail.run.id,
      taskID: attempt.taskID,
      attemptID: attempt.id,
      arms: attempt.verdict.experiment.arms,
    }] : []))
  const pairs = names.flatMap((first, index) => names.slice(index + 1).map((second) => {
    const compared = paired.flatMap((item) => {
      const a = item.arms.find((arm) => arm.arm === first)
      const b = item.arms.find((arm) => arm.arm === second)
      return a && b ? [{ a: a.verdict.decision, b: b.verdict.decision }] : []
    })
    return {
      first,
      second,
      compared: compared.length,
      agreed: compared.filter((item) => item.a === item.b).length,
      confusion: compared.reduce<Record<string, number>>((matrix, item) => {
        const key = `${item.a}:${item.b}`
        matrix[key] = (matrix[key] ?? 0) + 1
        return matrix
      }, {}),
    }
  }))
  const disagreements = paired.flatMap((item) => item.arms.flatMap((first, index) =>
    item.arms.slice(index + 1).flatMap((second) => first.verdict.decision === second.verdict.decision ? [] : [{
      runID: item.runID,
      taskID: item.taskID,
      attemptID: item.attemptID,
      first: first.arm,
      firstDecision: first.verdict.decision,
      second: second.arm,
      secondDecision: second.verdict.decision,
    }])))
  return { arms, pairs, disagreements }
}

export function deliveryJudges(details: ReadonlyArray<Orchestration.Detail>): Orchestration.JudgeComparison {
  const reviews = details.flatMap((detail) => detail.deliveries.flatMap((delivery) =>
    delivery.review.overall ? [{ review: delivery.review, result: delivery.review.overall.result }] : []))
  const names = [...new Set(reviews.map((item) => item.result.provider))].sort()
  return {
    arms: names.map((name) => {
      const values = reviews.filter((item) => item.result.provider === name)
      const results = values.flatMap((item) => [
        item.result,
        ...item.review.clauses.map((clause) => clause.result),
      ])
      return {
        name,
        provider: name,
        calls: values.length,
        valid: values.filter((item) => item.result.status === "valid").length,
        fallbacks: values.filter((item) => item.result.status !== "valid").length,
        authoritative: values.length,
        latencyP50Ms: percentile(values.map((item) => item.result.latencyMs), 0.5),
        latencyP95Ms: percentile(values.map((item) => item.result.latencyMs), 0.95),
        inputTokens: results.reduce((total, item) => total + (item.usage?.inputTokens ?? 0), 0),
        outputTokens: results.reduce((total, item) => total + (item.usage?.outputTokens ?? 0), 0),
        estimatedCostUsd: results.reduce((total, item) => total + (item.usage?.estimatedCostUsd ?? 0), 0),
        humanOverrides: 0,
        downstreamGaps: values.filter((item) => item.review.decision === "gaps").length,
        labeled: 0,
        labelAgreement: 0,
      }
    }),
    pairs: [],
    disagreements: [],
  }
}

export function policies(details: ReadonlyArray<Orchestration.Detail>): Orchestration.PolicyComparison {
  const names = [...new Set(details.map((detail) => detail.run.policy?.name ?? "manual"))].sort()
  return {
    policies: names.map((name) => {
      const runs = details.filter((detail) => (detail.run.policy?.name ?? "manual") === name)
      const durations = runs.flatMap((detail) => {
        const delivered = detail.deliveries.find((item) => item.time.delivered)
        return delivered?.time.delivered
          ? [DateTime.toEpochMillis(delivered.time.delivered) - DateTime.toEpochMillis(detail.run.time.created)]
          : []
      })
      const acceptedTasks = runs.reduce((total, detail) => total + detail.tasks.filter((task) => task.status === "succeeded").length, 0)
      const delivered = runs.filter((detail) => detail.deliveries.some((item) => item.time.delivered)).length
      const attempts = runs.reduce((total, detail) => total + detail.attempts.length, 0)
      const reassignments = runs.reduce((total, detail) => total + detail.reassignments.length, 0)
      const humanRequests = runs.reduce((total, detail) => total + detail.humanRequests.length, 0)
      const judged = runs.flatMap((detail) => [
        ...detail.attempts.flatMap((attempt) =>
          (attempt.verdict?.experiment?.arms.map((arm) => arm.verdict) ?? (attempt.verdict ? [attempt.verdict] : []))
            .flatMap((verdict) => [...verdict.criteria.map((criterion) => criterion.result), ...(verdict.overall ? [verdict.overall.result] : [])])),
        ...detail.deliveries.flatMap((delivery) => [
          ...delivery.review.clauses.map((clause) => clause.result),
          ...(delivery.review.overall ? [delivery.review.overall.result] : []),
        ]),
        ...detail.reassignments.flatMap((decision) => decision.result ? [decision.result] : []),
        ...detail.tierRecommendations.map((recommendation) => recommendation.result),
      ])
      const generated = runs.flatMap((detail) => [
        ...detail.plans.flatMap((plan) => plan.generation ? [plan.generation] : []),
        ...detail.deliveries.flatMap((delivery) => delivery.summaryGeneration ? [delivery.summaryGeneration] : []),
      ])
      const executors = runs.flatMap((detail) => detail.evaluations.filter((evaluation) => evaluation.kind.startsWith("harness:")))
      const observed = executors.map((evaluation) => evaluation.evidence)
      return {
        name,
        runs: runs.length,
        delivered,
        acceptedTasks,
        attempts,
        reassignments,
        humanRequests,
        integrations: runs.reduce((total, detail) => total + detail.integrations.filter((item) => item.status === "completed").length, 0),
        attemptsPerAcceptedTask: acceptedTasks ? attempts / acceptedTasks : undefined,
        reassignmentsPerAcceptedTask: acceptedTasks ? reassignments / acceptedTasks : undefined,
        humanRequestsPerDelivery: delivered ? humanRequests / delivered : undefined,
        timeToDeliveryMs: percentile(durations, 0.5),
        inputTokens: judged.reduce((total, item) => total + (item.usage?.inputTokens ?? 0), 0) +
          generated.reduce((total, item) => total + (item.inputTokens ?? 0), 0) +
          observed.reduce((total, item) => total + (typeof item.inputTokens === "number" ? item.inputTokens : 0), 0),
        outputTokens: judged.reduce((total, item) => total + (item.usage?.outputTokens ?? 0), 0) +
          generated.reduce((total, item) => total + (item.outputTokens ?? 0), 0) +
          observed.reduce((total, item) => total + (typeof item.outputTokens === "number" ? item.outputTokens : 0), 0),
        estimatedCostUsd: judged.reduce((total, item) => total + (item.usage?.estimatedCostUsd ?? 0), 0) +
          observed.reduce((total, item) => total + (typeof item.reportedCostUsd === "number" ? item.reportedCostUsd : 0), 0),
        measuredCalls: judged.filter((item) => item.usage).length +
          generated.filter((item) => item.inputTokens !== undefined || item.outputTokens !== undefined).length +
          observed.filter((item) => typeof item.inputTokens === "number" || typeof item.outputTokens === "number").length,
        examples: runs.slice(0, 5).map((detail) => detail.run.id),
      }
    }),
  }
}
