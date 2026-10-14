import { QuestionV2 } from "@opencode-ai/core/question"
import { Orchestration } from "@opencode-ai/core/orchestration"
import { OrchestrationScheduler } from "@opencode-ai/core/orchestration/scheduler"
import { Location } from "@opencode-ai/core/location"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { QuestionNotFoundError } from "@opencode-ai/protocol/errors"
import { response } from "../location"

function missingRequest(id: QuestionV2.ID) {
  return new QuestionNotFoundError({ requestID: id, message: `Question request not found: ${id}` })
}

export const QuestionHandler = HttpApiBuilder.group(Api, "server.question", (handlers) =>
  Effect.gen(function* () {
    const orchestrationQuestions = Effect.gen(function* () {
      const location = yield* Location.Service
      const orchestration = yield* Orchestration.Service
      const runs = yield* orchestration.list({ projectID: location.project.id })
      const details = yield* Effect.forEach(runs, (run) => orchestration.get(run.id).pipe(Effect.orDie), { concurrency: 4 })
      return details.flatMap((detail) => detail.humanRequests.flatMap((item) => {
        if (item.status !== "open" || !detail.run.sessionID) return []
        return [{
          runID: detail.run.id,
          requestID: item.id,
          assumption: item.assumption,
          request: {
            id: QuestionV2.ID.make(`que_orch_${item.id}`),
            sessionID: detail.run.sessionID,
            tool: item.kind === "clarification" ? undefined : {
              messageID: detail.run.sessionID,
              callID: `orch-human-${item.kind}`,
            },
            questions: [{
              header: "Run question",
              question: item.prompt,
              options: item.choices.map((choice) => ({ label: choice, description: choice })),
              custom: true,
            }],
          } satisfies QuestionV2.Request,
        }]
      }))
    })
    const withOwnedQuestion = Effect.fnUntraced(function* <A, E>(
      sessionID: QuestionV2.Request["sessionID"],
      requestID: QuestionV2.ID,
      use: (question: QuestionV2.Interface) => Effect.Effect<A, E>,
    ) {
      const question = yield* QuestionV2.Service
      const request = (yield* question.list()).find((request) => request.id === requestID)
      if (!request || request.sessionID !== sessionID) return yield* missingRequest(requestID)
      return yield* use(question)
    })

    return handlers
      .handle(
        "question.request.list",
        Effect.fn(function* () {
          return yield* response(Effect.gen(function* () {
            const ordinary = yield* (yield* QuestionV2.Service).list()
            const orchestration = yield* orchestrationQuestions
            return [...ordinary, ...orchestration.map((item) => item.request)]
          }))
        }),
      )
      .handle(
        "session.question.list",
        Effect.fn(function* (ctx) {
          const requests = [
            ...(yield* (yield* QuestionV2.Service).list()),
            ...(yield* orchestrationQuestions).map((item) => item.request),
          ]
          return { data: requests.filter((request) => request.sessionID === ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.question.reply",
        Effect.fn(function* (ctx) {
          const virtual = (yield* orchestrationQuestions).find((item) =>
            item.request.id === ctx.params.requestID && item.request.sessionID === ctx.params.sessionID)
          if (virtual) {
            const answer = ctx.payload.answers[0]?.[0]
            if (!answer) return yield* missingRequest(ctx.params.requestID)
            const location = yield* Location.Service
            yield* OrchestrationScheduler.Service.use((scheduler) => scheduler.answerRequest({
              runID: virtual.runID,
              requestID: virtual.requestID,
              answer,
              source: Location.Ref.make({ directory: location.directory }),
            })).pipe(Effect.catch(() => missingRequest(ctx.params.requestID)))
            return HttpApiSchema.NoContent.make()
          }
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reply({ requestID: ctx.params.requestID, answers: ctx.payload.answers })
              .pipe(Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.question.reject",
        Effect.fn(function* (ctx) {
          const virtual = (yield* orchestrationQuestions).find((item) =>
            item.request.id === ctx.params.requestID && item.request.sessionID === ctx.params.sessionID)
          if (virtual) {
            const location = yield* Location.Service
            yield* OrchestrationScheduler.Service.use((scheduler) => scheduler.answerRequest({
              runID: virtual.runID,
              requestID: virtual.requestID,
              answer: virtual.assumption ?? "No answer provided",
              source: Location.Ref.make({ directory: location.directory }),
            })).pipe(Effect.catch(() => missingRequest(ctx.params.requestID)))
            return HttpApiSchema.NoContent.make()
          }
          yield* withOwnedQuestion(ctx.params.sessionID, ctx.params.requestID, (question) =>
            question
              .reject(ctx.params.requestID)
              .pipe(Effect.catchTag("QuestionV2.NotFoundError", () => missingRequest(ctx.params.requestID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
