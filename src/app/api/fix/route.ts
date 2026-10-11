import { ApiError, GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { z } from "zod";

const GEMINI_MODEL = "gemini-3.5-flash-lite";

const requestSchema = z.object({
  code: z.string().max(20_000).refine((value) => value.trim().length > 0),
  intendedBehavior: z.string().max(3_000).refine((value) => value.trim().length > 0),
  errorMessage: z.string().max(3_000).optional(),
  exampleArguments: z.string().max(3_000).optional(),
  expectedResult: z.string().max(3_000).optional(),
  followUpAnswer: z
    .string()
    .max(3_000)
    .refine((value) => value.trim().length > 0)
    .optional(),
});

const resultSchema = z.object({
  needsClarification: z.boolean(),
  question: z.string().nullable().optional(),
  correctedCode: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  explanations: z.array(z.string()).optional(),
  concept: z.string().nullable().optional(),
});

type FailureCategory =
  | "authentication"
  | "authorization"
  | "quota"
  | "model"
  | "request"
  | "response"
  | "upstream";

class ModelResponseError extends Error {}

function getErrorType(error: unknown): string {
  if (error instanceof ApiError) return "ApiError";
  if (error instanceof z.ZodError) return "ZodError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof ModelResponseError) return "ModelResponseError";
  if (error instanceof Error) return "Error";
  return "UnknownError";
}

function classifyFailure(error: unknown): {
  category: FailureCategory;
  message: string;
  status: number;
} {
  if (
    error instanceof ModelResponseError ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  ) {
    return {
      category: "response",
      message: "Gemini returned an invalid response. Please retry.",
      status: 502,
    };
  }

  if (error instanceof ApiError) {
    if (error.status === 401) {
      return {
        category: "authentication",
        message: "Gemini rejected the server API key. Check GEMINI_API_KEY in the server environment.",
        status: 502,
      };
    }
    if (error.status === 403) {
      return {
        category: "authorization",
        message: "Gemini denied access. Check API access and key restrictions for the server project.",
        status: 502,
      };
    }
    if (error.status === 404) {
      return {
        category: "model",
        message: `The Gemini model ${GEMINI_MODEL} is unavailable. Check that it is enabled for this API key.`,
        status: 502,
      };
    }
    if (error.status === 429) {
      return {
        category: "quota",
        message: "Gemini rate or quota limit reached. Wait a moment, then retry.",
        status: 429,
      };
    }
    if (error.status === 400) {
      return {
        category: "request",
        message: "Gemini rejected the request. Please retry, or check the model request configuration.",
        status: 502,
      };
    }
    if (error.status === 408 || error.status >= 500) {
      return {
        category: "upstream",
        message: "Gemini is temporarily unavailable. Please retry in a moment.",
        status: 503,
      };
    }
  }

  return {
    category: "upstream",
    message: "Could not reach Gemini. Check the server connection and retry.",
    status: 503,
  };
}

function parseModelResponse(text: string) {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const result = resultSchema.parse(JSON.parse(json));

  if (result.needsClarification) {
    if (!result.question?.trim()) {
      throw new ModelResponseError("Missing clarification question.");
    }

    return {
      needsClarification: true,
      question: result.question,
      correctedCode: null,
      summary: null,
      explanations: [],
      concept: null,
    };
  }

  if (!result.correctedCode?.trim()) {
    throw new ModelResponseError("Missing corrected code.");
  }

  return {
    needsClarification: false,
    question: null,
    correctedCode: result.correctedCode,
    summary: result.summary ?? null,
    explanations: result.explanations ?? [],
    concept: result.concept ?? null,
  };
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = requestSchema.safeParse(rawBody);
  if (!parsedRequest.success) {
    return NextResponse.json(
      {
        error:
          "Provide nonblank code and intended behavior; keep code within 20,000 characters and behavior and clarification answers within 3,000 characters.",
      },
      { status: 400 },
    );
  }

  const { exampleArguments, expectedResult } = parsedRequest.data;
  let parsedExampleArguments: unknown;
  let parsedExpectedResult: unknown;
  try {
    if (exampleArguments?.trim()) {
      parsedExampleArguments = JSON.parse(exampleArguments);
      if (!Array.isArray(parsedExampleArguments)) {
        throw new Error("Example arguments must be a JSON array.");
      }
    }
    if (expectedResult?.trim()) {
      parsedExpectedResult = JSON.parse(expectedResult);
    }
  } catch {
    return NextResponse.json(
      {
        error:
          "Example arguments must be a JSON array, and the expected result must be valid JSON.",
      },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Gemini is not configured. Add GEMINI_API_KEY to the server environment." },
      { status: 503 },
    );
  }

  const {
    code,
    intendedBehavior,
    errorMessage,
    followUpAnswer,
  } = parsedRequest.data;
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: {
        attempts: 3,
        initialDelay: 1,
        maxDelay: 4,
      },
    },
  });
  const prompt = `You are a patient Python tutor. Help debug the user's Python code.
Return only a JSON object with this shape:
{
  "needsClarification": boolean,
  "question": string or null,
  "correctedCode": string or null,
  "summary": string or null,
  "explanations": array of short strings,
  "concept": string or null
}

If the intended behavior is unclear, set needsClarification to true, ask one concise question, and set the other result fields to null or an empty array. Otherwise provide complete corrected Python code, a concise summary, a few brief explanations of the changes, and one underlying Python concept.

User's code:
\`\`\`python
${code}
\`\`\`

Intended behavior:
${intendedBehavior}

${errorMessage ? `Observed error message:\n${errorMessage}` : ""}

${exampleArguments?.trim() ? `Example function arguments (JSON):\n${JSON.stringify(parsedExampleArguments)}` : ""}

${expectedResult?.trim() ? `Expected result (JSON):\n${JSON.stringify(parsedExpectedResult)}` : ""}

${followUpAnswer ? `Answer to your follow-up question:\n${followUpAnswer}` : ""}`;

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      },
    });

    if (!response.text) {
      throw new ModelResponseError("Empty response.");
    }

    return NextResponse.json(parseModelResponse(response.text));
  } catch (error) {
    const failure = classifyFailure(error);
    console.error("Gemini code-fix request failed", {
      category: failure.category,
      errorType: getErrorType(error),
      ...(error instanceof ApiError ? { upstreamStatus: error.status } : {}),
    });
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
