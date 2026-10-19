// v2 directory plugins resolve `server` (or `index`) from the package root
// rather than reading package.json `exports`, so this file is the stable
// entrypoint for both a symlinked checkout and an npm install.
export { default, ClinePassPlugin, ClinePassSetup } from "./dist/index.js"
