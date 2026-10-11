# Pyspace Python Playground

Pyspace is a browser-based Python playground. Edit `main.py` with Python
syntax highlighting, describe what you want the code to do, and run it in the
output console. Python runs in a fresh Pyodide worker inside an opaque-origin
sandbox for every run, so code has no access to the app's origin or storage.
Use **Download** to save your code as `main.py`.

Use **Function tests (optional)** to call short functions with JSON-compatible
basic types. For example, with `def add(a, b): return a + b`, enter:

```json
[{"functionName":"add","args":[2,3]}]
```

The output panel shows the returned values. Runs can be stopped and have a
five-second execution limit; captured output is capped to keep large prints
from overwhelming the page.

The **Fix my code** action uses the `/api/fix` Gemini endpoint. Set
`GEMINI_API_KEY` in the server environment (or your hosting provider's
environment-variable settings) before starting or deploying the app; the key
is never sent to the browser. Code and intended behavior are required; optional
context includes an error message, JSON-array example arguments, and a
JSON-encoded expected result. The tool is intended for short, self-contained
Python functions; external packages, databases, interactive input, and user
files are outside the supported execution scope. If intended behavior is
unclear, the app asks a follow-up question. Suggested corrections are not
executed automatically; review the highlighted diff, then copy the correction,
apply it, or restore and edit the submitted code. Failed requests show a
readable error and a **Retry** action. **Load example** fills the editor and
context fields with a broken accumulator demo (`[[2, 3, 4]]` should return
`9`).

## Run locally

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

The pinned Pyodide 314.0.7 runtime and its matching assets are included in the
deployment under `public/pyodide`. To use **Fix my code**, add a Gemini API
key to `.env.local`:

```dotenv
GEMINI_API_KEY=your-gemini-api-key
```

The key is only used by the server-side `/api/fix` route; never expose it in
client-side code. `.env.local` is ignored by Git.

## Deploy on Vercel

In the Vercel project settings, clear **Root Directory** completely (no spaces)
to use the repository root. Add `GEMINI_API_KEY` under **Settings → Environment
Variables**, then redeploy. Local `.env.local` values are not automatically
uploaded to Vercel.

The npm deprecation and install-script messages shown during installation are
warnings. They do not explain a starter page appearing after deployment.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

For more details, see the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying).
