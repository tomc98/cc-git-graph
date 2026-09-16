# Source and dependency provenance

Reviewed for the 0.1.4 experimental release on 16 September 2026.

## Original project code

The graph lane algorithm, terminal glyph rendering, colour palette, controller, Git protocols, Python helpers and tests are the project's local implementation. The source and lockfile inventory contains no VS Code Git Graph dependency, bundled source or asset. No third-party font files or icon libraries are bundled.

The browsing experience was inspired by [VS Code Git Graph](https://github.com/mhutchie/vscode-git-graph). Its [reviewed licence](https://github.com/mhutchie/vscode-git-graph/blob/d7f43f429a9e024e896bac9fc65fdc530935c812/LICENSE) withholds permission to distribute derivative works. This project does not vendor that implementation or use its licence. Do not copy its code or assets into contributions.

The [MIT licence](../LICENSE) covers this project's original source and documentation. This inventory checks the files and dependency boundary present in the candidate; it is not a forensic authorship certification.

## Third-party components

| Component | Use | Redistribution |
| --- | --- | --- |
| TypeScript 5.9.3, Apache-2.0 | Development typechecking and static source audit | Installed by npm; excluded from the plugin/archive |
| Claude Code API declarations | Development typechecking | Generated locally or fetched from the official tagged repository with a pinned checksum; ignored and excluded from releases |
| Claude Code | External host runtime | Not bundled or licensed by this project |
| Git, Python and macOS clipboard utility | External system programs | Not bundled |

The four Python helpers import only standard-library modules. Hooks import only local modules and type-only Claude declarations. No Anthropic sample implementation is bundled. `npm run audit:runtime` enforces the TypeScript import boundary; `npm run audit:release` checks metadata, packaged hashes and release contents.

The README illustrations were adapted from maintainer-supplied screenshots using image generation. Repository names, paths, identities, commit data and conversation text were replaced with fictional demo content. The final illustrations were reviewed visually and with OCR; original screenshots are excluded from public source and release archives. Future images require the same review for private repository names, commit messages, file contents and account details.
