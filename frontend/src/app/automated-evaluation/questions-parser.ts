export interface EvaluationQuestion {
  index: number
  question: string
  expectedAnswer: string
}

/**
 * Parses the automated-evaluation questions file.
 *
 * Expected format: a numbered list of questions, a blank line, then a numbered list of answers.
 */
export function parseQuestionsFile(raw: string): EvaluationQuestion[] {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (!text) {
    throw new Error('The questions file is empty.')
  }

  const blocks = text.split(/\n\s*\n/)
  if (blocks.length < 2) {
    throw new Error('The questions file must contain a question list and an answer list separated by a blank line.')
  }

  const questions = parseNumberedLines(blocks[0])
  const answers = parseNumberedLines(blocks.slice(1).join('\n'))

  if (questions.length === 0) {
    throw new Error('No questions were found in the file.')
  }
  if (questions.length !== answers.length) {
    throw new Error(`Found ${questions.length} questions but ${answers.length} answers.`)
  }

  return questions.map((question, i) => ({
    index: i,
    question,
    expectedAnswer: answers[i]
  }))
}

function parseNumberedLines(block: string): string[] {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/^\d+\.\s*/, '').trim())
    .filter(line => line.length > 0)
}

export function answersMatch(expected: string, actual: string): boolean {
  const expectedNorm = normalizeAnswer(expected)
  const actualNorm = normalizeAnswer(actual)
  if (!expectedNorm || !actualNorm) {
    return false
  }
  return actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm)
}

function normalizeAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}
