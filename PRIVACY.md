# Privacy Policy

`Striffs for GitHub` processes GitHub pull request metadata and repository content needed to render Striffs diagrams.

## Data handled by the extension

- GitHub pull request page metadata from pages where the extension runs
- Repository file paths and changed-file content needed to build diagrams
- Optional GitHub personal access token when the user provides one
- Diagram engagement and AI review feedback events sent to the configured Striffs backend

Engagement events can include:

- Striffs button clicks and generation attempts
- View switches between Diffs and Striffs
- Pan/zoom interactions on a rendered diagram
- File-tree navigation inside the Striffs UI
- Review-note feedback interactions
- Comment-mode entry, exit, and review submission events

## Storage

- The extension stores its optional GitHub token in extension storage until the user clears it.
- The extension stores cached diagrams, feature flags, and related local state in extension storage and browser-managed local caches.

## Network requests

- The extension talks to GitHub endpoints needed for pull request data and repository content.
- The extension talks to the configured Striffs backend to generate diagrams, fetch remote config, poll AI review status, and send engagement/feedback events.

## User control

- Users can clear the saved token from the extension UI.
- Users can clear local Striffs cache/state from the extension UI.
- Users can disable usage-data collection from the extension popup without disabling Striffs generation.
