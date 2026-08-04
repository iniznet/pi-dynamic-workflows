/**
 * Vendored zero-dependency browser review page for the plannotator gate.
 *
 * // Derived from backnotprop/plannotator (https://github.com/backnotprop/plannotator),
 * // MIT OR Apache-2.0. Copyright (c) 2025 backnotprop.
 * // Adapted to pi-dynamic-workflows' self-hosted zero-dependency bridge; the
 * // upstream React SPA, annotation and PR-diff surfaces are NOT vendored.
 *
 * The page is a single self-contained HTML document: no CDN, no bundler, no
 * frameworks. It reads the pending plan from GET /plan, renders the blueprint
 * with textContent-only DOM construction (LLM-authored text is never injected
 * as HTML), and POSTs { planId } to /approve when the human clicks Approve.
 * The inline script deliberately avoids template literals so the outer TS
 * template literal below stays interpolation-free.
 */

export function renderReviewPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Plan Review</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0d1117;
    color: #e6edf3;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  main { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; overflow-wrap: anywhere; }
  .pill {
    display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; background: #21262d; color: #8b949e;
  }
  .pill.approved { background: #1f6f2f; color: #b7e0b8; }
  .pill.rejected { background: #7d2222; color: #ffc9c9; }
  .panel {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 1rem 1.25rem; margin-top: 1.25rem;
  }
  .prompt { font-size: 1.05rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .choices { list-style: none; padding: 0; margin: 0.5rem 0 0; }
  .choices li { padding: 0.25rem 0; border-top: 1px solid #21262d; }
  .chip {
    display: inline-block; margin: 0.25rem 0.25rem 0 0; padding: 0.15rem 0.5rem;
    background: #1c2330; border: 1px solid #2d5a8a; border-radius: 4px;
    font-size: 0.8rem; color: #79c0ff;
  }
  pre.blueprint {
    margin: 0; padding: 0.75rem; background: #0d1117; border: 1px solid #21262d;
    border-radius: 6px; overflow-x: auto; font-size: 0.85rem; white-space: pre-wrap;
  }
  .actions { margin-top: 1.5rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  button#approve {
    font: inherit; font-weight: 600; color: #fff; background: #238636;
    border: 1px solid #2ea043; border-radius: 6px; padding: 0.6rem 1.4rem; cursor: pointer;
  }
  button#approve:disabled { background: #21262d; border-color: #30363d; color: #8b949e; cursor: default; }
  .error { color: #ff7b72; margin: 0; font-size: 0.9rem; }
  footer.meta {
    margin-top: 2rem; font-size: 0.8rem; color: #8b949e;
    border-top: 1px solid #21262d; padding-top: 0.75rem; overflow-wrap: anywhere;
  }
  @media (max-width: 480px) { main { padding-top: 1.5rem; } }
</style>
</head>
<body>
<main>
  <h1 id="title">Loading plan\u2026</h1>
  <span id="status" class="pill">pending</span>
  <section id="blueprint"></section>
  <div class="actions">
    <button id="approve" type="button">Approve Plan</button>
    <p id="error" class="error" hidden></p>
  </div>
  <footer id="meta" class="meta"></footer>
</main>
<script>
(function () {
  "use strict";
  var state = { plan: null, approved: false };
  var sse = null;
  var pollTimer = null;

  function el(tag, text) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function pill(status) {
    var node = document.getElementById("status");
    node.textContent = status;
    node.className = "pill" + (status === "approved" ? " approved" : status === "rejected" ? " rejected" : "");
  }

  function renderBlueprint(container, blueprint) {
    container.textContent = "";
    if (blueprint === undefined || blueprint === null) {
      container.appendChild(el("p", "No blueprint payload."));
      return;
    }
    if (typeof blueprint === "string") {
      var pre = el("pre", blueprint);
      pre.className = "blueprint";
      container.appendChild(pre);
      return;
    }
    if (typeof blueprint === "object" && !Array.isArray(blueprint)) {
      if (typeof blueprint.prompt === "string") {
        container.appendChild(el("p", blueprint.prompt)).className = "prompt";
      }
      if (typeof blueprint.kind === "string") {
        container.appendChild(el("span", blueprint.kind)).className = "chip";
      }
      if (Array.isArray(blueprint.choices)) {
        var list = el("ul");
        list.className = "choices";
        blueprint.choices.forEach(function (choice) {
          list.appendChild(el("li", choice));
        });
        container.appendChild(list);
      }
      if (blueprint.default !== undefined) {
        container.appendChild(el("span", "declared default: " + JSON.stringify(blueprint.default))).className = "chip";
      }
      var json = el("pre", JSON.stringify(blueprint, null, 2));
      json.className = "blueprint";
      container.appendChild(json);
      return;
    }
    var raw = el("pre", JSON.stringify(blueprint, null, 2));
    raw.className = "blueprint";
    container.appendChild(raw);
  }

  function renderMeta(plan) {
    var meta = document.getElementById("meta");
    meta.textContent = "";
    if (plan.runId) meta.appendChild(el("span", "run " + plan.runId + " \u00b7 call " + plan.callIndex));
    if (plan.submittedAt) meta.appendChild(el("span", " submitted " + plan.submittedAt));
  }

  function renderPlan(plan) {
    state.plan = plan;
    document.getElementById("title").textContent = plan.title || "Execution Blueprint Review";
    pill(plan.status || "pending");
    renderBlueprint(document.getElementById("blueprint"), plan.blueprint);
    renderMeta(plan);
    if (plan.status === "approved") {
      state.approved = true;
      var button = document.getElementById("approve");
      button.textContent = "Approved \u2713";
      button.disabled = true;
    }
  }

  function loadPlan() {
    return fetch("/plan").then(function (res) {
      if (!res.ok) throw new Error("plan endpoint returned " + res.status);
      return res.json().then(function (data) { return data.plan; });
    });
  }

  function approve() {
    var button = document.getElementById("approve");
    var errorEl = document.getElementById("error");
    errorEl.hidden = true;
    if (!state.plan) {
      errorEl.textContent = "No plan loaded yet.";
      errorEl.hidden = false;
      return;
    }
    button.disabled = true;
    fetch("/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: state.plan.id })
    }).then(function (res) {
      if (res.ok) {
        state.approved = true;
        button.textContent = "Approved \u2713";
        pill("approved");
        closeStreams();
        return;
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        errorEl.textContent = data.error || "Approval failed (" + res.status + ")";
        errorEl.hidden = false;
        // 5xx is transient: re-arm after a 1s backoff. 4xx/409 is terminal:
        // the button stays disabled (a duplicate approve can never re-run
        // side effects).
        if (res.status >= 500) {
          setTimeout(function () { button.disabled = false; }, 1000);
        }
      });
    }).catch(function (err) {
      errorEl.textContent = "Network error: " + err.message;
      errorEl.hidden = false;
      button.disabled = false;
    });
  }

  function closeStreams() {
    if (sse) { try { sse.close(); } catch (e) {} sse = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function updateStatus(plan) {
    if (!plan) return;
    state.plan = plan;
    pill(plan.status || "pending");
    if (plan.status === "approved") {
      state.approved = true;
      document.getElementById("approve").textContent = "Approved \u2713";
      document.getElementById("approve").disabled = true;
      closeStreams();
    }
  }

  function startPoll() {
    if (pollTimer) return;
    var deadline = Date.now() + 60000;
    pollTimer = setInterval(function () {
      loadPlan().then(updateStatus).catch(function () {});
      if (Date.now() > deadline) closeStreams();
    }, 2000);
  }

  function openSse() {
    if (typeof EventSource === "undefined") { startPoll(); return; }
    try {
      sse = new EventSource("/sse");
      sse.onmessage = function (event) {
        var plan;
        try { plan = JSON.parse(event.data); } catch (e) { return; }
        updateStatus(plan);
      };
      sse.onerror = function () {
        // SSE unavailable (proxy/headless): degrade to polling, never block.
        closeStreams();
        startPoll();
      };
    } catch (e) {
      startPoll();
    }
  }

  document.getElementById("approve").addEventListener("click", approve);
  loadPlan().then(renderPlan).catch(function () {
    document.getElementById("title").textContent = "No pending plan";
  });
  openSse();
})();
</script>
</body>
</html>
`;
}
