# Project Zero

live : https://zero.hypatia.earth
development: https://localhost:5173
docs: ../../docs/zero/zero--index.md   // (Obsidian Vault, via hypatia/docs symlink)
mirror : https://github.com/hypatia-earth/zero

## Important Zero Concepts

**Data Window:** Always centered on actual today's calendar date, shifts at midnight. 
**Model Run:** Timestamp from server used to tag timesteps as ANL (analysis/past) or FCT (forecast/future).

## Zero Deployment

`npm run deploy:zero`// live
`npm run deploy:beta` // beta for testing

**Before** deploying Zero:
1. Update changelog in Obsidian: `zero/_repo/README.md`
2. Sync to git: `npm run repo-docs:push` (from `zero/` dir), commit and push
3. Deploy: `npm run deploy:zero`
4. Verify in skill browser: new version and no errors in console logs

### Wiki Deployment

`npm run wiki:push`, pushes marked docs in Obsidian to GitHub Wiki

## Zero Git Repository

- **Contains:** Frontend application, TypeScript, Vite build config
- **Shader build:** `wesl` + `wesl-plugin` handles `.wesl` shader imports at build time
  - Shaders live in `src/aurora/shaders/` and `src/layers/*/`
  - Entry point: `src/aurora/shaders/main.wesl`

## Communication with User
- **Keep responses concise**. User will ask for more, if needed
- **Present code only when user asks to**
- Your **terminal has about 40 lines**, the user dislikes scrolling

## Claude Coding Rules

### File System Safety Protocol
1. **NEVER change files without explicit permission**
2. **Wait for explicit confirmation** ("YES", "GO", or similar)
3. **Only then execute file operations**
4. **Never assume approval from context**

### Git Safety Protocol
- **Ask before `git merge`** - always confirm before merging branches
- **Ask before `git branch -d`** - always confirm before deleting branches
- **`git push` needs no confirmation** - can push freely after commit

## Development Behavior
- Ask before creating new files
- Ask before editing existing files
- Ask before running potentially destructive commands

## Developer Mindset
- You're an experienced senior developer
- Don't use trial and error to fix problems
- Examine root causes and work systematically from there
- Think before acting, understand before implementing
- Don't speculate, argue with facts
- Don't propose simple or quick solutions, Zero demands precise and stable.

## Code Quality Rules
- **No defensive default parameters** - Avoid `param: Type = defaultValue` as it masks type errors and hides missing arguments
- **Fail fast and explicit** - Let TypeScript catch missing parameters rather than silently falling back to defaults
- **Let errors surface** - Don't use defensive programming, it masks errors. Let code fail fast so the user can see what's wrong
- **Proper Typescript** - Minimize type casting, any.
- **Use quality checks** - run `npm run quality` or `npm run type-check`to examine.

### Exception Handling
- Read-only operations (Read, Glob, Grep, LS) are allowed
- Information gathering is permitted
- Analysis and research require no permission
- Only file modifications require explicit approval

- **AGAIN: do not use defensive programming, it masks errors**

## Documentation (Obsidian Vault)
**Search Obsidian Vault for context before implementing:**
```bash
# Find by tag (in YAML frontmatter)
Grep pattern="  - tagname" path="/Users/noiv/Library/Mobile Documents/iCloud~md~obsidian/Documents/Hypatia"

# Find by status
Grep pattern="status: analysis" path="...vault..."

# Find by keyword
Grep pattern="QueueService" path="...vault..."
```

## Working in this Environment
- System is M4 with 14 cores, 24GB, GNU Parallel is installed
- Don't start long runnning scripts, user will do happily

## Browser Testing 
- Browser daemon skill is available for interactive browser testing
- Documentation: `~/.claude/skills/playwright-skill/SKILL.md`
- symlinks to ../stagehand
- **Always use full absolute paths** — never `~`, never `node` prefix
  - `/Users/noiv/.claude/skills/playwright-skill/browser-client.js`
  - `/Users/noiv/.claude/skills/playwright-skill/browser-daemon.js`
- **Never prefix commands with `sleep`** — use separate sequential Bash calls instead
- **Always use `--persist`** — preserves IDB, localStorage, cookies across restarts
- Default browser: Firefox (`--browser=chrome` for Chrome)
- Supports navigation, JavaScript execution, console log inspection, and element screenshots
- Execute loops as JS in browser
- **Start daemon as background Bash task** (shows in status bar), send commands in foreground:
  ```
  Bash(command: "/.../browser-daemon.js --persist --size=dev", run_in_background: true)
  Bash(command: "/.../browser-client.js navigate https://...")
  Bash(command: "/.../browser-client.js screenshot /path/to/file.png .css-selector")
  ```
- Browser console logs in skill accumulate and gets very long fast. Clear console before reload, navigate and read after.

### Examples
```
/Users/noiv/.claude/skills/playwright-skill/browser-client.js console-clear
/Users/noiv/.claude/skills/playwright-skill/browser-client.js exec "location.reload()"
```

### Services are exposed at localhost
```
if (location.hostname === 'localhost') {
    (window as unknown as { __hypatia: object }).__hypatia = {
    optionsService: this.optionsService,
    configService: this.configService,
    stateService: this.stateService,
    layersService: this.layersService,
    ....
```
