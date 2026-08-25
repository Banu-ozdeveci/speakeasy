package ch.ddis.speakeasy.api.handlers

import ch.ddis.speakeasy.api.*
import ch.ddis.speakeasy.feedback.AutomatedEvaluationQuestions
import io.javalin.http.Context
import io.javalin.openapi.*
import io.javalin.security.RouteRole

class GetAutomatedEvaluationQuestionsHandler : GetRestHandler<Unit>, AccessManagedRestHandler {
    override val permittedRoles: Set<RouteRole> = setOf(RestApiRole.ANYONE)
    override val route = "automated-evaluation/questions"
    override val parseAsJson = false

    @OpenApi(
        summary = "Reads automated evaluation questions from the data directory.",
        path = "/api/automated-evaluation/questions",
        operationId = OpenApiOperation.AUTO_GENERATE,
        methods = [HttpMethod.GET],
        tags = ["Evaluation"],
        responses = [
            OpenApiResponse("200", [OpenApiContent(String::class)]),
            OpenApiResponse("404", [OpenApiContent(ErrorStatus::class)])
        ]
    )
    override fun doGet(ctx: Context) {
        try {
            ctx.contentType("text/plain; charset=utf-8")
            ctx.header("Cache-Control", "no-store, no-cache, must-revalidate")
            ctx.result(AutomatedEvaluationQuestions.read())
        } catch (e: IllegalStateException) {
            throw ErrorStatusException(404, e.message ?: "Questions file not found", ctx)
        }
    }
}
