---
name: chrome-devtools
description: 'Expert-level browser automation, debugging, and performance analysis using Chrome DevTools MCP. Use for interacting with web pages, capturing screenshots, analyzing network traffic, and profiling performance.'
license: MIT
---

# Chrome DevTools Agent

## Overview

A specialized skill for controlling and inspecting a live Chrome browser. This skill leverages the `chrome-devtools` MCP server to perform a wide range of browser-related tasks, from simple navigation to complex performance profiling.

## When to Use

Use this skill when:

- **Browser Automation**: Navigating pages, clicking elements, filling forms, and handling dialogs.
- **Visual Inspection**: Taking screenshots or text snapshots of web pages.
- **Debugging**: Inspecting console messages, evaluating JavaScript in the page context, and analyzing network requests.
- **Performance Analysis**: Recording and analyzing performance traces to identify bottlenecks and Core Web Vital issues.
- **Emulation**: Resizing the viewport or emulating network/CPU conditions.

## Tools in this product

Use these names. They run inside the account computer over localhost Chrome debugging. There is no host MCP URL.

- `browser_list_pages`, `browser_navigate`, `browser_snapshot`
- `browser_click` and `browser_fill` take `uid` from the latest snapshot
- `browser_press_key` with `PageDown` or `Home` scrolls
- `browser_handle_dialog` accepts or dismisses `alert` / `confirm` / `prompt`
- `browser_wait_for` waits for visible text

## Ads versus captchas

1. `browser_snapshot` first.
2. If you see Close, Skip, X, or "No thanks", `browser_click` that uid or `browser_handle_dialog` with `accept: false`.
3. `browser_press_key` `Escape`, then snapshot again.
4. A search-engine page that says "enable JavaScript" or shows only a challenge widget, with no site content, is a bot wall. Say that in Blockers. Do not call it a site captcha and do not invent rankings.
5. `NEEDS_PERSON` only for a real sign-in, 2FA, or payment form after the overlay is gone.

## Tool Categories

### 1. Navigation & Page Management

- `new_page`: Open a new tab/page.
- `navigate_page`: Go to a specific URL, reload, or navigate history.
- `select_page`: Switch context between open pages.
- `list_pages`: See all open pages and their IDs.
- `close_page`: Close a specific page.
- `wait_for`: Wait for specific text to appear on the page.

### 2. Input & Interaction

- `click`: Click on an element (use `uid` from snapshot).
- `fill` / `fill_form`: Type text into inputs or fill multiple fields at once.
- `hover`: Move the mouse over an element.
- `press_key`: Send keyboard shortcuts or special keys (e.g., "Enter", "Control+C").
- `drag`: Drag and drop elements.
- `handle_dialog`: Accept or dismiss browser alerts/prompts.
- `upload_file`: Upload a file through a file input.

### 3. Debugging & Inspection

- `take_snapshot`: Get a text-based accessibility tree (best for identifying elements).
- `take_screenshot`: Capture a visual representation of the page or a specific element.
- `list_console_messages` / `get_console_message`: Inspect the page's console output.
- `evaluate_script`: Run custom JavaScript in the page context.
- `list_network_requests` / `get_network_request`: Analyze network traffic and request details.

### 4. Emulation & Performance

- `resize_page`: Change the viewport dimensions.
- `emulate`: Throttling CPU/Network or emulating geolocation.
- `performance_start_trace`: Start recording a performance profile.
- `performance_stop_trace`: Stop recording and save the trace.
- `performance_analyze_insight`: Get detailed analysis from recorded performance data.

## Workflow Patterns

### Live SPA / signed-in session (Instagram, dashboards)

1. `browser_navigate` to the exact profile/post URL.
2. `browser_snapshot` — read counts and captions from the snapshot text.
3. `browser_click` / `browser_press_key` with fresh `uid`s only.
4. Write Findings when Success is met. Do **not** fall back to `bash`, `grep` of HTML, `curl`, or `chromium --headless --dump-dom`.

### Pattern A: Identifying Elements (Snapshot-First)

Always prefer `take_snapshot` over `take_screenshot` for finding elements. The snapshot provides `uid` values which are required by interaction tools.

```markdown
1. `take_snapshot` to get the current page structure.
2. Find the `uid` of the target element.
3. Use `click(uid=...)` or `fill(uid=..., value=...)`.
```

### Pattern B: Troubleshooting Errors

When a page is failing, check both console logs and network requests.

```markdown
1. `list_console_messages` to check for JavaScript errors.
2. `list_network_requests` to identify failed (4xx/5xx) resources.
3. `evaluate_script` to check the value of specific DOM elements or global variables.
```

### Pattern C: Performance Profiling

Identify why a page is slow.

```markdown
1. `performance_start_trace(reload=true, autoStop=true)`
2. Wait for the page to load/trace to finish.
3. `performance_analyze_insight` to find LCP issues or layout shifts.
```

## Best Practices

- **Context Awareness**: Always run `list_pages` and `select_page` if you are unsure which tab is currently active.
- **Snapshots**: Take a new snapshot after any major navigation or DOM change, as `uid` values may change.
- **Timeouts**: Use reasonable timeouts for `wait_for` to avoid hanging on slow-loading elements.
- **Screenshots**: Use `take_screenshot` sparingly for visual verification, but rely on `take_snapshot` for logic.