export type PythonValue =
  | null
  | boolean
  | number
  | string
  | PythonValue[]
  | { [key: string]: PythonValue };

export type PythonTestCase = {
  functionName: string;
  args: PythonValue[];
  kwargs?: { [key: string]: PythonValue };
};

export type PythonRequest = {
  requestId: string;
  code: string;
  testCases: PythonTestCase[];
};

export type PythonResponse = {
  requestId: string;
  results: PythonValue[];
  stdout: string;
  error: string | null;
  timedOut: boolean;
};

export type PythonRun = {
  promise: Promise<PythonResponse>;
  stop: () => void;
};

const OUTPUT_LIMIT = 20_000;
const EXECUTION_TIMEOUT_MS = 5_000;
const INITIALIZATION_TIMEOUT_MS = 30_000;
const MAX_CODE_LENGTH = 100_000;
const MAX_TEST_CASES = 25;
const MAX_VALUE_DEPTH = 10;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_LENGTH = 10_000;

function isPythonValue(value: unknown, depth = 0): value is PythonValue {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value !== "string" || value.length <= MAX_STRING_LENGTH;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_COLLECTION_ITEMS &&
      value.every((item) => isPythonValue(item, depth + 1))
    );
  }
  if (typeof value !== "object") return false;

  const entries = Object.entries(value);
  return (
    entries.length <= MAX_COLLECTION_ITEMS &&
    entries.every(
      ([key, item]) =>
        key.length <= MAX_STRING_LENGTH && isPythonValue(item, depth + 1),
    )
  );
}

function isPythonTestCase(value: unknown): value is PythonTestCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const testCase = value as Record<string, unknown>;
  return (
    typeof testCase.functionName === "string" &&
    testCase.functionName.length <= 100 &&
    /^[A-Za-z_]\w*$/.test(testCase.functionName) &&
    Array.isArray(testCase.args) &&
    testCase.args.length <= MAX_COLLECTION_ITEMS &&
    testCase.args.every((item) => isPythonValue(item)) &&
    (testCase.kwargs === undefined ||
      (testCase.kwargs !== null &&
        typeof testCase.kwargs === "object" &&
        !Array.isArray(testCase.kwargs) &&
        isPythonValue(testCase.kwargs)))
  );
}

export function isPythonTestCases(value: unknown): value is PythonTestCase[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TEST_CASES &&
    value.every(isPythonTestCase)
  );
}

function isPythonResponse(value: unknown): value is PythonResponse {
  if (!value || typeof value !== "object") return false;

  const response = value as Record<string, unknown>;
  return (
    typeof response.requestId === "string" &&
    Array.isArray(response.results) &&
    response.results.length <= MAX_TEST_CASES &&
    response.results.every((result) => isPythonValue(result)) &&
    typeof response.stdout === "string" &&
    response.stdout.length <= OUTPUT_LIMIT + 100 &&
    (response.error === null ||
      (typeof response.error === "string" &&
        response.error.length <= OUTPUT_LIMIT)) &&
    typeof response.timedOut === "boolean"
  );
}

function isRequest(value: unknown): value is PythonRequest {
  if (!value || typeof value !== "object") return false;

  const request = value as Record<string, unknown>;
  return (
    typeof request.requestId === "string" &&
    /^[\w.-]{1,100}$/.test(request.requestId) &&
    typeof request.code === "string" &&
    request.code.length <= MAX_CODE_LENGTH &&
    isPythonTestCases(request.testCases)
  );
}

const WORKER_SOURCE = (pyodideIndexUrl: string) => `
const PYODIDE_INDEX_URL = ${JSON.stringify(pyodideIndexUrl)};
const OUTPUT_LIMIT = ${OUTPUT_LIMIT};

function validValue(value, depth = 0) {
  if (depth > ${MAX_VALUE_DEPTH}) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value !== "string" || value.length <= ${MAX_STRING_LENGTH};
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= ${MAX_COLLECTION_ITEMS} && value.every(item => validValue(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const entries = Object.entries(value);
  return entries.length <= ${MAX_COLLECTION_ITEMS} && entries.every(([key, item]) => key.length <= ${MAX_STRING_LENGTH} && validValue(item, depth + 1));
}

function validRequest(value) {
  return value && typeof value === "object" &&
    typeof value.requestId === "string" && /^[\\w.-]{1,100}$/.test(value.requestId) &&
    typeof value.code === "string" && value.code.length <= ${MAX_CODE_LENGTH} &&
    Array.isArray(value.testCases) && value.testCases.length <= ${MAX_TEST_CASES} &&
    value.testCases.every(testCase => testCase && typeof testCase === "object" &&
      typeof testCase.functionName === "string" && testCase.functionName.length <= 100 && /^[A-Za-z_]\\w*$/.test(testCase.functionName) &&
      Array.isArray(testCase.args) && testCase.args.length <= ${MAX_COLLECTION_ITEMS} &&
      testCase.args.every(item => validValue(item)) &&
      (testCase.kwargs === undefined || (testCase.kwargs && typeof testCase.kwargs === "object" &&
        !Array.isArray(testCase.kwargs) && validValue(testCase.kwargs))));
}

let pyodidePromise;
let stdout = "";
let outputTruncated = false;

function capture(text) {
  const remaining = OUTPUT_LIMIT - stdout.length;
  if (remaining > 0) stdout += text.slice(0, remaining);
  if (text.length > remaining) outputTruncated = true;
}

function response(requestId, results, error) {
  const marker = "\\n… output truncated …";
  const captured = outputTruncated
    ? stdout.slice(0, Math.max(0, OUTPUT_LIMIT - marker.length)) + marker
    : stdout;
  self.postMessage({
    requestId,
    results,
    stdout: captured,
    error: error ? String(error).slice(0, OUTPUT_LIMIT) : null,
    timedOut: false
  });
}

self.onmessage = async event => {
  const message = event.data;
  if (!message || message.type !== "run" || !validRequest(message.request)) return;
  const request = message.request;
  stdout = "";
  outputTruncated = false;

  try {
    if (!pyodidePromise) {
      pyodidePromise = import(PYODIDE_INDEX_URL + "pyodide.mjs").then(
        ({ loadPyodide }) => loadPyodide({ indexURL: PYODIDE_INDEX_URL }),
      );
    }
    const pyodide = await pyodidePromise;
    self.postMessage({ type: "ready", requestId: request.requestId });

    self.onmessage = async executeEvent => {
      const executeMessage = executeEvent.data;
      if (!executeMessage || executeMessage.type !== "execute" ||
          executeMessage.requestId !== request.requestId) return;

      try {
        pyodide.setStdout({ batched: text => capture(text + "\\n") });
        pyodide.setStderr({ batched: text => capture(text + "\\n") });
        pyodide.globals.set("__pyspace_code", request.code);
        pyodide.globals.set("__pyspace_cases", JSON.stringify(request.testCases));
        const rawResults = await pyodide.runPythonAsync(\`
import json
import math

__pyspace_namespace = {}
exec(compile(__pyspace_code, "<user code>", "exec"), __pyspace_namespace, __pyspace_namespace)
__pyspace_parsed_cases = json.loads(__pyspace_cases)
__pyspace_results = []

def __pyspace_to_json(value, depth=0):
    if depth > 10:
        return "<maximum result depth exceeded>"
    if value is None or isinstance(value, (bool, str)):
        return value[:1000] + "…" if isinstance(value, str) and len(value) > 1000 else value
    if isinstance(value, int):
        return value if abs(value) <= 9007199254740991 else str(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if isinstance(value, (list, tuple)):
        items = [__pyspace_to_json(item, depth + 1) for item in value[:50]]
        if len(value) > 50:
            items.append("<additional items omitted>")
        return items
    if isinstance(value, dict):
        items = list(value.items())
        result = {str(key)[:1000]: __pyspace_to_json(item, depth + 1) for key, item in items[:50]}
        if len(items) > 50:
            result["<truncated>"] = True
        return result
    return repr(value)[:1000]

for __pyspace_case in __pyspace_parsed_cases:
    __pyspace_function = __pyspace_namespace.get(__pyspace_case["functionName"])
    if not callable(__pyspace_function):
        raise TypeError("Function '" + __pyspace_case["functionName"] + "' is not defined or is not callable.")
    __pyspace_result = __pyspace_function(*__pyspace_case["args"], **__pyspace_case.get("kwargs", {}))
    __pyspace_results.append(__pyspace_to_json(__pyspace_result))

json.dumps(__pyspace_results, allow_nan=False)
\`);
        const resultJson = typeof rawResults === "string" ? rawResults : rawResults.toString();
        if (rawResults && typeof rawResults.destroy === "function") rawResults.destroy();
        response(request.requestId, JSON.parse(resultJson), null);
      } catch (error) {
        response(request.requestId, [], error instanceof Error ? error.message : error);
      }
    };
  } catch (error) {
    response(request.requestId, [], error instanceof Error ? error.message : error);
  }
};
`;

export function createPythonRun(
  request: PythonRequest,
  onLoading: (loading: boolean) => void,
): PythonRun {
  if (!isRequest(request)) {
    throw new Error("Python request contains invalid code or test cases.");
  }

  let iframe: HTMLIFrameElement | null = document.createElement("iframe");
  let executionTimer: number | undefined;
  let settled = false;
  let ready = false;
  let resolvePromise: (response: PythonResponse) => void;

  const promise = new Promise<PythonResponse>((resolve) => {
    resolvePromise = resolve;
  });

  const cleanup = () => {
    window.clearTimeout(executionTimer);
    window.clearTimeout(initializationTimer);
    window.removeEventListener("message", handleMessage);
    iframe?.remove();
    iframe = null;
  };

  const finish = (response: PythonResponse) => {
    if (settled) return;
    settled = true;
    cleanup();
    onLoading(false);
    resolvePromise(response);
  };

  const makeResponse = (
    results: PythonValue[],
    stdout: string,
    error: string | null,
    timedOut = false,
  ): PythonResponse => ({ requestId: request.requestId, results, stdout, error, timedOut });

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (
      !iframe ||
      event.source !== iframe.contentWindow ||
      event.origin !== "null" ||
      !event.data ||
      typeof event.data !== "object"
    ) {
      return;
    }

    const message = event.data as Record<string, unknown>;
    if (message.requestId !== request.requestId) return;

    if (message.type === "ready" && !ready) {
      ready = true;
      onLoading(false);
      window.clearTimeout(initializationTimer);
      executionTimer = window.setTimeout(() => {
        finish(makeResponse([], "", "Execution timed out after 5 seconds.", true));
      }, EXECUTION_TIMEOUT_MS);
      iframe.contentWindow?.postMessage(
        { type: "execute", requestId: request.requestId },
        "*",
      );
      return;
    }

    if (
      message.type === "response" &&
      isPythonResponse(message.response) &&
      message.response.requestId === request.requestId
    ) {
      finish(message.response);
    }
  };

  const iframeBootstrap = `
    (() => {
      const expectedParentOrigin = ${JSON.stringify(window.location.origin)};
      const workerSource = ${JSON.stringify(WORKER_SOURCE(new URL("/pyodide/", window.location.origin).href))};
      const requestId = ${JSON.stringify(request.requestId)};
      let worker = null;
      let workerUrl = null;
      let ready = false;

      function validValue(value, depth = 0) {
        if (depth > ${MAX_VALUE_DEPTH}) return false;
        if (value === null || typeof value === "boolean" || typeof value === "string") {
          return typeof value !== "string" || value.length <= ${MAX_STRING_LENGTH};
        }
        if (typeof value === "number") return Number.isFinite(value);
        if (Array.isArray(value)) return value.length <= ${MAX_COLLECTION_ITEMS} && value.every(item => validValue(item, depth + 1));
        if (typeof value !== "object") return false;
        const entries = Object.entries(value);
        return entries.length <= ${MAX_COLLECTION_ITEMS} && entries.every(([key, item]) => key.length <= ${MAX_STRING_LENGTH} && validValue(item, depth + 1));
      }

      function validRequest(value) {
        return value && typeof value === "object" &&
          typeof value.requestId === "string" && /^[\\w.-]{1,100}$/.test(value.requestId) &&
          typeof value.code === "string" && value.code.length <= ${MAX_CODE_LENGTH} &&
          Array.isArray(value.testCases) && value.testCases.length <= ${MAX_TEST_CASES} &&
          value.testCases.every(testCase => testCase && typeof testCase === "object" &&
            typeof testCase.functionName === "string" && testCase.functionName.length <= 100 && /^[A-Za-z_]\\w*$/.test(testCase.functionName) &&
            Array.isArray(testCase.args) && testCase.args.length <= ${MAX_COLLECTION_ITEMS} &&
            testCase.args.every(item => validValue(item)) &&
            (testCase.kwargs === undefined || (testCase.kwargs && typeof testCase.kwargs === "object" &&
              !Array.isArray(testCase.kwargs) && validValue(testCase.kwargs))));
      }

      function send(message) {
        parent.postMessage(message, "*");
      }

      function destroyWorker() {
        if (worker) worker.terminate();
        worker = null;
        workerUrl = null;
      }

      window.addEventListener("message", event => {
        if (event.source !== parent || event.origin !== expectedParentOrigin ||
            !event.data || typeof event.data !== "object") return;
        const message = event.data;
        if (message.type === "start" && message.request && validRequest(message.request) &&
            message.request.requestId === requestId && !worker) {
          workerUrl = "data:text/javascript," + encodeURIComponent(workerSource);
          worker = new Worker(workerUrl, { type: "module" });
          worker.onmessage = workerEvent => {
            const response = workerEvent.data;
            if (!response || typeof response !== "object" ||
                response.requestId !== requestId) return;
            if (response.type === "ready" && !ready) {
              ready = true;
              send({ type: "ready", requestId });
              return;
            }
            if (Array.isArray(response.results) && response.results.length <= ${MAX_TEST_CASES} &&
                response.results.every(item => validValue(item)) &&
                typeof response.stdout === "string" && response.stdout.length <= ${OUTPUT_LIMIT + 100} &&
                (response.error === null ||
                  (typeof response.error === "string" && response.error.length <= ${OUTPUT_LIMIT})) &&
                response.timedOut === false) {
              send({ type: "response", requestId, response });
              destroyWorker();
            }
          };
          worker.onerror = event => {
            event.preventDefault();
            send({ type: "response", requestId, response: {
              requestId, results: [], stdout: "",
              error: "The Python worker failed to start: " + event.message,
              timedOut: false
            }});
            destroyWorker();
          };
          worker.postMessage({ type: "run", request: message.request });
        } else if (message.type === "execute" && ready &&
            message.requestId === requestId && worker) {
          worker.postMessage({ type: "execute", requestId });
        }
      });
    })();
  `;

  const initializationTimer = window.setTimeout(() => {
    finish(makeResponse([], "", "Python runtime initialization timed out."));
  }, INITIALIZATION_TIMEOUT_MS);
  iframe!.sandbox.add("allow-scripts");
  iframe!.title = "Isolated Python runner";
  iframe!.ariaHidden = "true";
  iframe!.tabIndex = -1;
  iframe!.style.cssText =
    "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
  iframe!.srcdoc = `<!doctype html><meta charset="utf-8"><script>${iframeBootstrap}<\/script>`;
  window.addEventListener("message", handleMessage);
  onLoading(true);
  iframe!.addEventListener("load", () => {
    iframe?.contentWindow?.postMessage({ type: "start", request }, "*");
  });
  document.body.append(iframe!);

  return {
    promise,
    stop: () => finish(makeResponse([], "", "Execution stopped.")),
  };
}
