"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import {
  createPythonRun,
  isPythonTestCases,
  type PythonRun,
} from "@/lib/pythonRunner";

const Editor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const starterCode = `# Welcome to Pyspace
name = "world"
print(f"Hello, {name}!")
`;

type FixRequest = {
  code: string;
  intendedBehavior: string;
  errorMessage?: string;
  exampleArguments?: string;
  expectedResult?: string;
  followUpAnswer?: string;
};

type FixResult = {
  needsClarification: boolean;
  question: string | null;
  correctedCode: string | null;
  summary: string | null;
  explanations: string[];
  concept: string | null;
};

function isFixResult(value: unknown): value is FixResult {
  if (!value || typeof value !== "object") return false;

  const result = value as Record<string, unknown>;
  return (
    typeof result.needsClarification === "boolean" &&
    (typeof result.question === "string" || result.question === null) &&
    (typeof result.correctedCode === "string" ||
      result.correctedCode === null) &&
    (typeof result.summary === "string" || result.summary === null) &&
    Array.isArray(result.explanations) &&
    result.explanations.every((item) => typeof item === "string") &&
    (typeof result.concept === "string" || result.concept === null)
  );
}

type DiffLine = {
  kind: "added" | "removed" | "context";
  text: string;
};

function buildCodeDiff(original: string, corrected: string): DiffLine[] {
  const oldLines = original.split("\n");
  const newLines = corrected.split("\n");
  if (oldLines.length > 300 || newLines.length > 300) {
    return [
      ...oldLines.map((text) => ({ kind: "removed" as const, text })),
      ...newLines.map((text) => ({ kind: "added" as const, text })),
    ];
  }

  const lengths = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint16Array(newLines.length + 1),
  );
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? lengths[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              lengths[oldIndex + 1][newIndex],
              lengths[oldIndex][newIndex + 1],
            );
    }
  }

  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (
      oldIndex < oldLines.length &&
      newIndex < newLines.length &&
      oldLines[oldIndex] === newLines[newIndex]
    ) {
      diff.push({ kind: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      oldIndex < oldLines.length &&
      (newIndex === newLines.length ||
        lengths[oldIndex + 1][newIndex] >= lengths[oldIndex][newIndex + 1])
    ) {
      diff.push({ kind: "removed", text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      diff.push({ kind: "added", text: newLines[newIndex] });
      newIndex += 1;
    }
  }
  return diff;
}

export default function Home() {
  const [code, setCode] = useState(starterCode);
  const [testCases, setTestCases] = useState("[]");
  const [intendedBehavior, setIntendedBehavior] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [exampleArguments, setExampleArguments] = useState("");
  const [expectedResult, setExpectedResult] = useState("");
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [fixResult, setFixResult] = useState<FixResult | null>(null);
  const [originalFixCode, setOriginalFixCode] = useState<string | null>(null);
  const [fixError, setFixError] = useState("");
  const [isFixing, setIsFixing] = useState(false);
  const [lastFixRequest, setLastFixRequest] = useState<FixRequest | null>(null);
  const [output, setOutput] = useState("");
  const [runError, setRunError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isLoadingPython, setIsLoadingPython] = useState(false);
  const pythonRunRef = useRef<PythonRun | null>(null);
  const correctionRequestIdRef = useRef(0);
  const editorRef = useRef<{ focus: () => void } | null>(null);

  const invalidateCorrection = () => {
    correctionRequestIdRef.current += 1;
    setIsFixing(false);
    setFixError("");
    setFixResult(null);
    setOriginalFixCode(null);
    setLastFixRequest(null);
    setClarificationAnswer("");
  };

  const clearExecutionResult = () => {
    const activeRun = pythonRunRef.current;
    pythonRunRef.current = null;
    activeRun?.stop();
    setIsLoadingPython(false);
    setIsRunning(false);
    setOutput("");
    setRunError("");
  };

  const updateCode = (value: string) => {
    if (value === code) return;
    setCode(value);
    clearExecutionResult();
    invalidateCorrection();
  };

  const updateTestCases = (value: string) => {
    if (value === testCases) return;
    setTestCases(value);
    clearExecutionResult();
  };

  const runCode = useCallback(async () => {
    setOutput("");
    setRunError("");
    let activeRun: PythonRun | null = null;

    try {
      const parsedTestCases: unknown = JSON.parse(testCases);
      if (!isPythonTestCases(parsedTestCases)) {
        throw new Error(
          "Tests must be a JSON array of up to 25 cases with a functionName and basic-type args.",
        );
      }

      setIsRunning(true);
      activeRun = createPythonRun(
        {
          requestId: crypto.randomUUID(),
          code,
          testCases: parsedTestCases,
        },
        setIsLoadingPython,
      );
      pythonRunRef.current = activeRun;
      const response = await activeRun.promise;
      if (pythonRunRef.current !== activeRun) return;
      const resultsOutput =
        response.results.length > 0
          ? `Results:\n${response.results.map((result) => JSON.stringify(result)).join("\n")}`
          : "";
      setOutput(
        [response.stdout, resultsOutput]
          .filter(Boolean)
          .join(response.stdout && !response.stdout.endsWith("\n") ? "\n" : ""),
      );

      if (response.error) setRunError(response.error);
    } catch (error) {
      setRunError(
        error instanceof Error ? error.message : "Python could not be run.",
      );
    } finally {
      if (!activeRun || pythonRunRef.current === activeRun) {
        setIsLoadingPython(false);
        setIsRunning(false);
        pythonRunRef.current = null;
      }
    }
  }, [code, testCases]);

  const requestFix = useCallback(async (request: FixRequest) => {
    const requestId = correctionRequestIdRef.current + 1;
    correctionRequestIdRef.current = requestId;
    setIsFixing(true);
    setFixError("");
    setFixResult(null);
    setLastFixRequest(request);

    try {
      const response = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const data: unknown = await response.json();

      if (!response.ok) {
        const message =
          data && typeof data === "object" && "error" in data
            ? data.error
            : undefined;
        throw new Error(
          typeof message === "string" && message
            ? message
            : "The fix request failed. Please try again.",
        );
      }

      if (!isFixResult(data)) {
        throw new Error("Gemini returned an unexpected response. Please retry.");
      }

      if (correctionRequestIdRef.current !== requestId) return;
      setOriginalFixCode(request.code);
      setFixResult(data);
      setClarificationAnswer("");
    } catch (error) {
      if (correctionRequestIdRef.current !== requestId) return;
      setFixError(
        error instanceof Error
          ? error.message
          : "The fix request failed. Please try again.",
      );
    } finally {
      if (correctionRequestIdRef.current === requestId) {
        setIsFixing(false);
      }
    }
  }, []);

  const handleFix = () => {
    if (!code.trim() || code.length > 20_000) {
      setFixError("Enter nonblank code with no more than 20,000 characters.");
      return;
    }
    if (!intendedBehavior.trim() || intendedBehavior.length > 3_000) {
      setFixError(
        "Describe the intended behavior in 3,000 characters or fewer.",
      );
      return;
    }
    if (
      fixResult?.needsClarification &&
      (!clarificationAnswer.trim() || clarificationAnswer.length > 3_000)
    ) {
      setFixError(
        "Enter a clarification answer in 3,000 characters or fewer.",
      );
      return;
    }

    let normalizedArguments: string | undefined;
    if (exampleArguments.trim()) {
      try {
        const parsed: unknown = JSON.parse(exampleArguments);
        if (!Array.isArray(parsed)) {
          throw new Error("Arguments must be a JSON array.");
        }
        normalizedArguments = JSON.stringify(parsed);
      } catch {
        setFixError("Example arguments must be a valid JSON array.");
        return;
      }
    }

    let normalizedExpectedResult: string | undefined;
    if (expectedResult.trim()) {
      try {
        normalizedExpectedResult = JSON.stringify(JSON.parse(expectedResult));
      } catch {
        setFixError("Expected result must be valid JSON.");
        return;
      }
    }

    void requestFix({
      code,
      intendedBehavior,
      ...(errorMessage.trim() ? { errorMessage: errorMessage.trim() } : {}),
      ...(normalizedArguments !== undefined
        ? { exampleArguments: normalizedArguments }
        : {}),
      ...(normalizedExpectedResult !== undefined
        ? { expectedResult: normalizedExpectedResult }
        : {}),
      ...(fixResult?.needsClarification && clarificationAnswer.trim()
        ? { followUpAnswer: clarificationAnswer.trim() }
        : {}),
    });
  };

  const loadExample = () => {
    cancelCode();
    invalidateCorrection();
    setCode(`def sum_numbers(numbers):
    total = 0
    for number in numbers:
        total = number
    return total
`);
    setTestCases("[]");
    setIntendedBehavior(
      "Return the sum of all numbers in the list, adding each number to the running total.",
    );
    setErrorMessage("");
    setExampleArguments("[[2, 3, 4]]");
    setExpectedResult("9");
    setClarificationAnswer("");
    setFixResult(null);
    setOriginalFixCode(null);
    setFixError("");
    setOutput("");
    setRunError("");
  };

  const stopCode = () => pythonRunRef.current?.stop();

  const cancelCode = () => {
    const activeRun = pythonRunRef.current;
    pythonRunRef.current = null;
    activeRun?.stop();
    setIsLoadingPython(false);
    setIsRunning(false);
  };

  const diffLines =
    originalFixCode !== null && fixResult?.correctedCode
      ? buildCodeDiff(originalFixCode, fixResult.correctedCode)
      : [];

  const downloadCode = () => {
    const file = new Blob([code], { type: "text/x-python;charset=utf-8" });
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "main.py";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyCorrectedCode = async () => {
    if (!fixResult?.correctedCode) return;

    try {
      await navigator.clipboard.writeText(fixResult.correctedCode);
    } catch {
      setFixError("Could not copy the corrected code. Please copy it manually.");
    }
  };

  return (
    <main className="workspace">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Pyspace home">
          <span className="brand-mark" aria-hidden="true">
            {"</>"}
          </span>
          <span>pyspace</span>
        </Link>
        <div className="topbar-note">
          <span className="status-dot" />
          Python playground
        </div>
        <button className="button button-secondary example-button" onClick={loadExample}>
          Load example
        </button>
      </header>

      <section className="intro">
        <p className="eyebrow">A little space to figure it out</p>
        <h1>Write Python. Make it work.</h1>
        <p className="intro-copy">
          Try an idea, run it in your browser, or ask for a thoughtful fix when
          you get stuck.
        </p>
      </section>

      <section className="workspace-grid" aria-label="Python workspace">
        <div className="editor-column">
          <section className="panel editor-panel" aria-label="Python code editor">
            <div className="panel-heading">
              <div className="file-label">
                <span className="python-badge">Py</span>
                <span>main.py</span>
              </div>
              <span className="panel-hint">
                Python 3 · {code.length.toLocaleString()}/20k chars
              </span>
            </div>
            <div className="editor-wrap">
              <Editor
                onMount={(editor) => {
                  editorRef.current = editor;
                }}
                height="390px"
                language="python"
                theme="vs-dark"
                value={code}
                onChange={(value) => updateCode(value ?? "")}
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  fontFamily: "var(--font-geist-mono), monospace",
                  lineNumbers: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  tabSize: 4,
                  padding: { top: 18, bottom: 18 },
                }}
              />
            </div>
            <details className="test-case-settings">
              <summary>Function tests (optional)</summary>
              <p>
                Call functions with JSON basic types. Each case needs a
                functionName and args; kwargs is optional.
              </p>
              <textarea
                className="text-field test-case-input"
                aria-label="Function test cases in JSON"
                rows={4}
                value={testCases}
                onChange={(event) => updateTestCases(event.target.value)}
                placeholder={'[{"functionName":"add","args":[2,3]}]'}
                disabled={isRunning}
              />
            </details>
            <div className="editor-actions">
              <p className="editor-note">Your code runs locally in your browser.</p>
              <div className="editor-button-group">
                <button
                  className="button button-secondary"
                  onClick={downloadCode}
                  disabled={!code}
                >
                  Download
                </button>
                {isRunning ? (
                  <button className="button button-stop" onClick={stopCode}>
                    Stop
                  </button>
                ) : (
                  <button
                    className="button button-run"
                    onClick={() => void runCode()}
                    disabled={!code.trim()}
                  >
                    <span aria-hidden="true">▶</span>
                    Run code
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="panel output-panel" aria-labelledby="output-title">
            <div className="panel-heading output-heading">
              <h2 id="output-title">Output</h2>
              <span className="panel-hint">Console</span>
            </div>
            <pre
              className={`output-content${runError ? " output-error" : ""}`}
              aria-live="polite"
            >
              {output}
              {runError}
              {!output && !runError &&
                (isRunning
                  ? isLoadingPython
                    ? "Loading Python…"
                    : "Running Python…"
                  : "Run your code to see the output.")}
            </pre>
          </section>
        </div>

        <aside className="panel fix-panel" aria-labelledby="fix-title">
          <div className="fix-heading">
            <span className="fix-icon" aria-hidden="true">✳</span>
            <div>
              <p className="eyebrow">Pair programmer</p>
              <h2 id="fix-title">Fix my code</h2>
            </div>
          </div>
          <p className="fix-description">
            Explain what you expected, and Gemini will help you understand and
            correct the code.
          </p>
          <p className="supported-scope">
            Best for short, self-contained Python functions. External packages,
            databases, interactive input, and user files are outside the
            supported execution scope.
          </p>

          <label className="field-label" htmlFor="intended-behavior">
            What should the code do? <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="intended-behavior"
            className="text-field"
            rows={4}
            value={intendedBehavior}
            maxLength={3_000}
            required
            aria-required="true"
            onChange={(event) => {
              invalidateCorrection();
              setIntendedBehavior(event.target.value);
            }}
            placeholder="Describe the expected result or the problem you noticed…"
            disabled={isFixing}
          />
          <p className="field-limit">{intendedBehavior.length}/3,000 characters</p>

          <label className="field-label" htmlFor="error-message">
            Error message <span className="optional-label">(optional)</span>
          </label>
          <textarea
            id="error-message"
            className="text-field"
            rows={2}
            value={errorMessage}
            maxLength={3_000}
            onChange={(event) => {
              invalidateCorrection();
              setErrorMessage(event.target.value);
            }}
            placeholder="Paste the error or traceback, if any…"
            disabled={isFixing}
          />

          <label className="field-label field-spaced" htmlFor="example-arguments">
            Example arguments{" "}
            <span className="optional-label">(optional JSON array)</span>
          </label>
          <textarea
            id="example-arguments"
            className="text-field"
            rows={2}
            value={exampleArguments}
            maxLength={3_000}
            onChange={(event) => {
              invalidateCorrection();
              setExampleArguments(event.target.value);
            }}
            placeholder="[[2, 3, 4]]"
            disabled={isFixing}
          />

          <label className="field-label field-spaced" htmlFor="expected-result">
            Expected result{" "}
            <span className="optional-label">(optional JSON value)</span>
          </label>
          <textarea
            id="expected-result"
            className="text-field"
            rows={2}
            value={expectedResult}
            maxLength={3_000}
            onChange={(event) => {
              invalidateCorrection();
              setExpectedResult(event.target.value);
            }}
            placeholder="9, null, false, 0, …"
            disabled={isFixing}
          />

          {fixResult?.needsClarification && (
            <div className="clarification-box" role="status">
              <p>{fixResult.question}</p>
              <label className="field-label" htmlFor="clarification-answer">
                Your answer
              </label>
              <textarea
                id="clarification-answer"
                className="text-field"
                rows={3}
                value={clarificationAnswer}
                maxLength={3_000}
                required
                aria-required="true"
                onChange={(event) => setClarificationAnswer(event.target.value)}
                placeholder="Add a little more detail…"
                disabled={isFixing}
              />
            </div>
          )}

          <button
            className="button button-fix"
            onClick={handleFix}
            disabled={
              isFixing ||
              !code.trim() ||
              code.length > 20_000 ||
              !intendedBehavior.trim() ||
              intendedBehavior.length > 3_000 ||
              (fixResult?.needsClarification &&
                (!clarificationAnswer.trim() ||
                  clarificationAnswer.length > 3_000))
            }
          >
            {isFixing ? (
              <>
                <span className="spinner" />
                Looking closely…
              </>
            ) : fixResult?.needsClarification ? (
              "Send answer"
            ) : (
              "Help me fix it"
            )}
          </button>

          {fixError && (
            <div className="error-box" role="alert">
              <p>{fixError}</p>
              {lastFixRequest && (
                <button
                  className="text-button"
                  onClick={() => void requestFix(lastFixRequest)}
                  disabled={isFixing}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {fixResult && !fixResult.needsClarification && (
            <div className="fix-result" aria-live="polite">
              <div className="result-title-row">
                <h3>Suggested correction — not executed</h3>
                <button
                  className="text-button"
                  onClick={() => void copyCorrectedCode()}
                >
                  Copy corrected code
                </button>
              </div>
              {fixResult.summary && <p className="result-summary">{fixResult.summary}</p>}
              {fixResult.correctedCode && (
                <pre className="corrected-code">
                  <code>{fixResult.correctedCode}</code>
                </pre>
              )}
              {originalFixCode !== null && fixResult.correctedCode && (
                <details className="code-comparison">
                  <summary>Highlighted diff from submitted code</summary>
                  <pre className="code-diff" aria-label="Highlighted code diff">
                    {diffLines.map((line, index) => (
                      <span
                        className={`diff-line diff-${line.kind}`}
                        key={`${index}-${line.kind}`}
                      >
                        <span className="diff-marker" aria-hidden="true">
                          {line.kind === "added"
                            ? "+"
                            : line.kind === "removed"
                              ? "−"
                              : " "}
                        </span>
                        {line.text || " "}
                        {"\n"}
                      </span>
                    ))}
                  </pre>
                </details>
              )}
              {fixResult.explanations.length > 0 && (
                <div className="explanation">
                  <h4>What changed</h4>
                  <ul>
                    {fixResult.explanations.map((explanation, index) => (
                      <li key={`${index}-${explanation}`}>{explanation}</li>
                    ))}
                  </ul>
                </div>
              )}
              {fixResult.concept && (
                <div className="concept-card">
                  <span className="concept-label">Python concept</span>
                  <p>{fixResult.concept}</p>
                </div>
              )}
              <button
                className="button button-secondary apply-button"
                onClick={() => {
                  if (fixResult.correctedCode) {
                    updateCode(fixResult.correctedCode);
                  }
                }}
                disabled={!fixResult.correctedCode}
              >
                Use corrected code
              </button>
              {originalFixCode !== null && (
                <button
                  className="text-button edit-submission-button"
                  onClick={() => {
                    updateCode(originalFixCode);
                    editorRef.current?.focus();
                  }}
                >
                  Edit submission
                </button>
              )}
            </div>
          )}
        </aside>
      </section>

      <footer className="footer">
        <span>Made for the bugs that teach you something.</span>
        <span>Code stays in your browser unless you ask for a fix.</span>
      </footer>
    </main>
  );
}
