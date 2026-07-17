# Component Comment Feature Plan

## Goal

Allow users viewing a Striff architecture diagram on a GitHub PR to **select diagram components** (classes, packages, etc.), see a **live subdiagram preview** of just those components, and **post a PR comment** containing their text alongside the rendered subdiagram image.

This turns Striff diagrams from read-only visualizations into a collaboration tool — reviewers can point at specific architectural elements and discuss them inline.

## How It Works (End-to-End)

1. User views a Striff diagram on a GitHub PR page
2. A `+` affordance appears on hover over each selectable diagram entity
3. Clicking `+` opens a slide-out comment panel and selects that component
4. User selects up to 10 components; each selection triggers a backend preview request
5. Backend extracts the selected subdiagram from the stored PlantUML source, renders it as SVG, returns it
6. Preview renders in the panel in real-time as the user adjusts their selection
7. User writes their comment text
8. User submits: the extension navigates to GitHub's PR conversation composer, inserts the comment text, and pastes/attaches the rendered subdiagram image

## Current Architecture Decision

This feature is **backend-first** for diagram semantics. The extension does **not** parse PlantUML or extract subdiagrams on the client side.

### Extension owns

- selection UI (hover affordances, click-to-select, highlight styling)
- comment panel state (open/close, draft text, selected IDs)
- preview request orchestration (debounce, stale-response protection)
- GitHub composer submission flow (navigate, set text, attach image)

### Backend owns

- original PlantUML source persistence (stored alongside each diagram artifact)
- subdiagram extraction from PlantUML source (filtering selected components + their relationships)
- subdiagram SVG rendering (PlantUML server render)
- subdiagram render caching (Redis-first with in-memory fallback)

---

## Implementation Status

### DONE — Backend (`striff-api`)

All backend work for Phase 1 is **implemented and tested**:

| Component | Status | Details |
|-----------|--------|---------|
| `StriffDiagramArtifact` stores `pumlSource` | Done | Persisted alongside SVG artifacts in MongoDB |
| Fallback PUML decode from SVG | Done | `PlantUmlSvgSourceDecoder` recovers source from older artifacts via `plantuml-src` SVG comments |
| `SubdiagramController` | Done | `POST /api/v1/striffs/{operationId}/diagrams/{diagramIndex}/subdiagram` |
| `SubdiagramRenderService` | Done | Validates component IDs, retrieves artifact, normalizes IDs via `PUMLHelper.pumlId()`, renders SVG |
| `SubdiagramPlantUmlExtractor` | Done | Parses PlantUML syntax, extracts selected components + direct relationships, preserves packages/style |
| `SubdiagramRenderCache` | Done | Redis + in-memory fallback, keyed by `v1:{operationId}:{diagramIndex}:{format}:sha256(selectedIds)`, TTL 60min |
| ID normalization | Done | Java-style IDs (`com.example.MyClass`) mapped to PlantUML IDs (`com-example-MyClass`) |
| Max component validation | Done | Configurable limit (default 10), returns error on exceed |
| Tests | Done | `SubdiagramRenderServiceTest`, `SubdiagramPlantUmlExtractorTest`, `SubdiagramRenderCacheTest` |

### DONE — Library (`striff-lib`)

| Component | Status | Details |
|-----------|--------|---------|
| `pumlSource()` on rendered diagrams | Done | Exposes original PlantUML source from rendered diagrams |
| SVG `data-qualified-name` post-processing | Done | `PUMLDiagram.stripQualifiedPumlIds()` maps hyphenated PUML IDs back to original `uniqueName` values in SVG attributes |

### DONE — Extension (`striff-browser-extension`)

| Component | Status | Details |
|-----------|--------|---------|
| `src/plantuml-utils.js` | Done | PlantUML encoding/decoding utility (extracts PUML from SVG comments, encodes/decodes PlantUML format). Not used by the backend-first comment flow, but available as a fallback. |
| `operationId` in extension state | Done | Available via `S.__engagementCtx.operationId` — set from the API response when striffs are loaded |
| SVG component identity mapping | Done | SVG `data-qualified-name` attributes on diagram entities match `DiagramComponent.uniqueName()` (via ADR-003 post-processing) |

### NOT DONE — Extension (All Remaining Work)

None of the comment feature UI or logic has been implemented yet:

| Component | Status | Description |
|-----------|--------|-------------|
| `diagramIndex` in extension state | **Done** | Always `0` — the extension renders a single diagram per operation |
| Comment mode state | **Not done** | No `S.__commentState` or equivalent |
| `+` hover affordances | **Not done** | No overlay UI on diagram entities |
| Slide-out comment panel | **Not done** | No `src/striffs-comment-panel.js` |
| Selection highlight styling | **Not done** | No visual indication of selected components |
| `background.js` subdiagram handler | **Not done** | No `renderSubdiagram` message handler |
| Preview rendering | **Not done** | No debounce, no stale-response protection, no preview area |
| Submit flow | **Not done** | No GitHub composer integration, no image paste/attach |
| Error handling & invalidation | **Not done** | No error states for preview failures, no SPA navigation cleanup |
| Tests | **Not done** | No UI tests for any comment feature behavior |

---

## Phase 1 Scope

### Phase 1 should support

- hover `+` affordance on commentable diagram entities
- slide-out comment panel
- selection of up to 10 components
- live preview driven by backend subdiagram render endpoint
- general PR conversation comment flow through GitHub UI
- visible error state when preview generation fails
- blocked submission when preview is invalid

### Phase 1 should not support

- inline diff comments
- review-thread APIs
- frontend PlantUML parsing
- frontend subdiagram extraction

## Product Decisions

- candidate components are diagram entities shown in the SVG, identified by `data-qualified-name` attribute, **including AI review note nodes**
- selection cap is 10
- clicking `+` opens the panel and toggles that component into selection
- comment mode disables normal entity navigation while active
- Escape closes the panel and clears transient comment state
- first line of the final comment is only the user message
- the rendered subdiagram image is added after that
- if preview render fails, show a visible error and hide or disable submit
- if the user attempts to select an 11th component, block it and show a toast
- if the current diagram cannot be mapped to backend identity, do not expose the feature

## Selection Panel Stability During Diagram Updates

The comment/selection panel must remain **completely stable** while the underlying diagram changes behind the scenes. This applies to two lifecycle events:

1. **Base diagram regeneration** — when the initial PlantUML diagram is generated or re-rendered
2. **AI enrichment update** — when the enriched/annotated diagram replaces the base diagram

### Requirements

- The panel must not close, reset, or visually jump when either event occurs
- The user's selected components (e.g. 4 highlighted entities) must **persist** through diagram swaps
- When the new diagram (base or enriched) lands, the extension must **re-apply** the user's selection highlights onto the new SVG entities
- The user should experience **zero interruption** — no flicker, no deselection, no panel reset
- Selected component identity must be tracked by **stable logical IDs** (not DOM node references), so they survive full SVG replacement
- If the enriched diagram introduces new entities, they should appear unselected — only the user's prior picks stay highlighted
- The preview should not auto-refresh or flash during the diagram swap unless the user changes their selection

### Implementation implication

The selection state (`selectedIds`) must be keyed by component identifiers that are **stable across diagram versions**, not by SVG DOM node references. When the diagram container is swapped (base → enriched), the extension should:

1. detect the SVG replacement event
2. re-identify selectable entities in the new SVG
3. re-apply highlight styling to any entity matching a previously selected ID
4. keep the panel DOM untouched — no re-render of the panel itself

## Diagram Identity (Resolved)

The extension needs `{ operationId, diagramIndex }` to call the backend subdiagram endpoint. Both are now resolved:

- **`operationId`** — already available via `S.__engagementCtx.operationId` from the API response
- **`diagramIndex`** — always `0`. The extension currently renders a single diagram per operation, so the index is hardcoded.

## Remaining Work (Implementation Steps)

### Step 1: Add comment-selection mode in `src/striffs.js`

Add state for:

- whether comment mode is active
- selected component ids
- hovered entity
- active diagram identity
- pending preview request generation id
- preview result / preview error
- draft text

Behavior:

- show `+` affordance on eligible `g[data-qualified-name]` nodes
- keep current overlay positioning approach
- in comment mode, clicking a diagram entity toggles selection instead of navigating
- apply selected outline styling to selected entities

### Step 2: Add the slide-out comment panel

Add a dedicated panel module:

- `src/striffs-comment-panel.js`

Responsibilities:

- render panel shell
- manage textarea
- render selected chips
- show preview area
- show error state
- expose submit / close behavior

Suggested panel sections:

- header
- selected components
- preview
- error area
- comment textarea
- submit controls

### Step 3: Wire preview requests through `background.js`

The extension should not call the API directly from the content script.

Flow:

1. content script collects:
   - `operationId`
   - `diagramIndex`
   - sorted selected component ids
2. content script sends background message
3. `background.js` calls:
   - `POST /api/v1/striffs/{operationId}/diagrams/{diagramIndex}/subdiagram`
4. background returns:
   - rendered SVG
   - optionally extracted source / metadata if useful
5. content script updates preview

Requirements:

- debounce rapid selection changes
- ignore stale preview responses
- surface structured backend errors cleanly

### Step 4: Add submit flow for general conversation comments only

Keep this simple in phase 1.

Flow:

1. validate:
   - non-empty comment text
   - valid preview SVG exists
2. navigate to PR conversation composer if needed
3. set textarea content to the user message
4. convert rendered subdiagram SVG to PNG via `<canvas>`
5. attach PNG to GitHub's composer using the file upload input (or simulated drop event)
6. GitHub handles CDN hosting and markdown embedding automatically

Still deferred:

- inline comments

Reason:

- no exact line anchoring has been designed yet
- forcing it now would create a brittle feature

### Step 5: Add error handling and invalidation rules

The extension should invalidate comment state when:

- GitHub SPA navigation changes the active page/PR context
- the selected component ids no longer exist in the current diagram
- backend identity for the current diagram disappears

The extension should **NOT** invalidate comment state when:

- the base diagram regenerates or the enriched diagram replaces it — instead, re-apply selection highlights to the new SVG and keep the panel stable (see Selection Panel Stability section)

Errors to handle cleanly:

- no diagram identity available
- backend returns `404` for missing artifact
- backend returns extraction/render validation error
- network failure
- backend returns stale/invalid payload

### Step 6: Add Playwright comment flow tests

Extend the existing Playwright UI tests (`test/striffs-visual-tests.js`, `test/manual-smoke-live.js`) with comment-flow scenarios. These tests exercise the real extension in a real browser against a real GitHub PR — they select components, verify the preview, and verify the comment appears in GitHub's conversation view, but do **not** actually post the comment.

#### Test scenarios to add

**After the Striffs diagram has rendered** (i.e. after clicking "Striffs" and waiting for the SVG):

1. **`+` affordance visibility**
   - Hover over a diagram entity with `data-qualified-name`
   - Assert the `+` affordance appears
   - Move mouse away, assert it disappears

2. **Panel open and component selection**
   - Click the `+` affordance on a diagram entity
   - Assert the comment panel slides open
   - Assert that entity is highlighted as selected
   - Assert a chip for that component appears in the panel
   - Click the same entity again, assert it is deselected

3. **Multi-select and 10-component cap**
   - Select 3 components by clicking their `+` affordances
   - Assert 3 chips in the panel
   - Select up to 10, assert all are shown
   - Attempt to select an 11th, assert a toast appears and the 11th is not selected

4. **Live preview**
   - Select 2 components
   - Wait for the backend subdiagram preview to render in the panel
   - Assert an `<img>` or inline SVG is visible in the preview area
   - Deselect one component
   - Assert the preview updates (new request fired, stale response ignored)

5. **Comment draft and preview in conversation view**
   - With components selected and preview rendered, type a comment in the panel textarea
   - Click the "Comment" submit button
   - Assert the extension navigates to (or opens) the GitHub PR conversation tab
   - Assert the GitHub comment composer textarea is populated with the user's text
   - Assert the subdiagram image is attached/visible in the composer preview
   - **Do not click "Comment" on GitHub** — the test stops here, the comment is not posted

6. **Panel close and cleanup**
   - Press Escape while the panel is open
   - Assert the panel closes
   - Assert all selection highlights are removed from the diagram
   - Assert normal entity click behavior is restored

7. **Error state**
   - Block the subdiagram backend endpoint (e.g. via the extension's test hooks or a failing URL override)
   - Select a component
   - Assert a visible error state appears in the panel
   - Assert the submit button is disabled or hidden

#### Integration with existing tests

These scenarios extend the existing `TestScenarios` object in `striffs-visual-tests.js` and/or add a new async flow in `manual-smoke-live.js` that runs after the diagram has fully rendered. They reuse the same `launchPersistentContext` setup, the same profile directory pattern, and the same service worker detection logic.

#### Backend tests

Already implemented:

- `SubdiagramRenderServiceTest`
- `SubdiagramPlantUmlExtractorTest`
- `SubdiagramRenderCacheTest`

## File Plan

### New files in the extension

- `src/striffs-comment-panel.js`

### Modified files in the extension

- `src/striffs.js` — comment mode state, selection logic, `+` affordances
- `src/background.js` — `renderSubdiagram` message handler
- `manifest.json` — if new permissions or content script entries needed

## Suggested Extension State Model

Keep the state minimal and backend-oriented:

```js
S.__commentState = {
  active: false,
  operationId: null,
  diagramIndex: null,
  selectedIds: [],
  draftText: "",
  previewSvg: null,
  previewError: null,
  requestSeq: 0,
  completedSeq: 0
};
```

Notes:

- do not store parsed PUML structures
- do not store frontend relationship graphs
- only store UI and request lifecycle state
- `selectedIds` must use stable logical IDs that survive SVG replacement (see Selection Panel Stability section)
- state should survive diagram swaps without resetting — the panel re-applies highlights to the new SVG

## Background Request Contract

Extension-side message:

```js
{
  type: "renderSubdiagram",
  operationId: "...",
  diagramIndex: 0,
  selectedComponentIds: ["...", "..."]
}
```

Normalized success payload:

```js
{
  ok: true,
  svg: "<svg ...>"
}
```

Normalized failure payload:

```js
{
  ok: false,
  errorMessage: "...",
  errorCode: "..."
}
```

## Resolved Design Decisions

### Review note selectability

AI review note nodes are **selectable** in Phase 1. They are treated like any other diagram entity — users can click `+` on them, include them in their selection, and they appear in the subdiagram preview.

### Composer image insertion

Use **direct file attachment** via GitHub's upload input. The extension converts the rendered subdiagram SVG to a PNG file and attaches it using the file input element in GitHub's comment composer. GitHub renders the image and hosts it on their CDN automatically — the preview in the composer shows the hosted image immediately.

Flow:
1. Render subdiagram SVG → convert to PNG blob via `<canvas>`
2. Create a `File` object from the blob
3. Set the file on GitHub's hidden `<input type="file">` element (or simulate a `drop` event on the composer textarea)
4. GitHub handles upload, CDN hosting, and markdown image embedding automatically

This avoids clipboard API complexity and gives a more reliable attachment than paste-based approaches.

## Recommended Implementation Order

1. Add comment mode state and `+` affordances in `src/striffs.js`
2. Build panel UI and selection state flow
3. Add `background.js` handler for backend subdiagram preview
4. Render live preview with debounce and stale-response protection
5. Implement general comment submit flow
6. Add extension UI tests

## Definition Of Done For Phase 1

- user can click `+` on a diagram component
- panel opens with that component selected
- selecting up to 10 components updates preview successfully
- preview comes from backend endpoint, not frontend PUML parsing
- preview failures are visible and block submission
- normal entity navigation is blocked while comment mode is active
- user can submit a general PR conversation comment with text plus subdiagram image
- feature is disabled when backend identity is unavailable
