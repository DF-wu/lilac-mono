# Catppuccin file icons

Icons and associations are from [catppuccin/vscode-icons](https://github.com/catppuccin/vscode-icons)
at commit `b6915da9f6889b683a110aa747de96c2820a537d` (v1.26.0). The MIT license is included in `LICENSE` and embedded in the SVG sprite so built assets retain the notice.

`associations.json` contains the filename, extension, and language associations from
`src/defaults/fileIcons.ts`. `catppuccin.svg` combines the referenced `icons/css-variables/*.svg`
files and `_file.svg` into SVG symbols. Internal IDs are prefixed with the icon name to avoid
collisions. The `--vscode-ctp-` variables are renamed to `--file-icon-` and defined in
`components/file-icon.css` using the upstream Latte and Mocha colors.

The web app serves the sprite locally. No browser extension, runtime CDN, or package is required.
