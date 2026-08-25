package ch.ddis.speakeasy.feedback

import ch.ddis.speakeasy.util.Config
import java.io.File

object AutomatedEvaluationQuestions {
    private lateinit var questionsFile: File

    fun init(config: Config) {
        questionsFile = File(File(config.dataPath), "automated-evaluation-questions.txt")
    }

    fun read(): String {
        if (!::questionsFile.isInitialized || !questionsFile.exists()) {
            throw IllegalStateException("automated-evaluation-questions.txt was not found in the data directory.")
        }
        return questionsFile.readText()
    }
}
