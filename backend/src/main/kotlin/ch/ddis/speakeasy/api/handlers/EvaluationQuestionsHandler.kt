package ch.ddis.speakeasy.api.handlers

import ch.ddis.speakeasy.api.*
import ch.ddis.speakeasy.feedback.AutomatedEvaluationQuestions
import io.javalin.http.Context
import io.javalin.openapi.*
import io.javalin.security.RouteRole
import ch.ddis.speakeasy.db.UserEntity
import ch.ddis.speakeasy.user.PlainPassword
import ch.ddis.speakeasy.user.UserManager
import ch.ddis.speakeasy.util.sessionToken

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

data class EvaluationCredentialPair(
    var username: String = "",
    var password: String = ""
)

data class EvaluationCredentialCheckRequest(
    var credentials: Array<EvaluationCredentialPair> = emptyArray()
)

data class EvaluationCredentialCheckResult(
    val username: String,
    val ok: Boolean,
    val reason: String? = null
)

class PostAutomatedEvaluationCredentialsCheckHandler : PostRestHandler<List<EvaluationCredentialCheckResult>>, AccessManagedRestHandler {
    override val permittedRoles: Set<RouteRole> = setOf(RestApiRole.ADMIN)
    override val route = "automated-evaluation/credentials/check"

    @OpenApi(
        summary = "Checks automated evaluation bot credentials. Opens a bot session when the password is valid but the user is inactive, without changing the admin session.",
        path = "/api/automated-evaluation/credentials/check",
        operationId = OpenApiOperation.AUTO_GENERATE,
        methods = [HttpMethod.POST],
        tags = ["Evaluation"],
        requestBody = OpenApiRequestBody([OpenApiContent(EvaluationCredentialCheckRequest::class)]),
        responses = [
            OpenApiResponse("200", [OpenApiContent(Array<EvaluationCredentialCheckResult>::class)]),
            OpenApiResponse("400", [OpenApiContent(ErrorStatus::class)]),
            OpenApiResponse("401", [OpenApiContent(ErrorStatus::class)])
        ]
    )
    override fun doPost(ctx: Context): List<EvaluationCredentialCheckResult> {
        val request = try {
            ctx.bodyAsClass(EvaluationCredentialCheckRequest::class.java)
        } catch (e: Exception) {
            throw ErrorStatusException(400, "Invalid parameters.", ctx)
        }
        val adminSessionToken = ctx.sessionToken()
        return request.credentials.map { pair ->
            val username = pair.username.trim()
            val user = if (username.isEmpty()) null else UserManager.getMatchingUser(username, PlainPassword(pair.password))
            when {
                username.isEmpty() || !UserManager.checkUsernameExists(username) ->
                    EvaluationCredentialCheckResult(username, false, "does_not_exist")
                user == null ->
                    EvaluationCredentialCheckResult(username, false, "wrong_password")
                UserManager.checkIfUserIsActive(username) ->
                    EvaluationCredentialCheckResult(username, true)
                else -> activateBotSession(username, user, adminSessionToken)
            }
        }
    }

    private fun activateBotSession(
        username: String,
        user: UserEntity,
        adminSessionToken: String?
    ): EvaluationCredentialCheckResult {
        return try {
            AccessManager.setUserForSession(newSessionToken(adminSessionToken), user)
            EvaluationCredentialCheckResult(username, true)
        } catch (e: Exception) {
            EvaluationCredentialCheckResult(username, false, "not_logged_in")
        }
    }

    private fun newSessionToken(excluded: String?): String {
        val random = kotlin.random.Random.Default
        var token: String
        do {
            token = List(AccessManager.SESSION_TOKEN_LENGTH) {
                AccessManager.SESSION_TOKEN_CHAR_POOL.random(random)
            }.joinToString("")
        } while (token == excluded)
        return token
    }
}
