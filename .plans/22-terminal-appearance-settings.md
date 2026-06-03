# Terminal Appearance Settings

## Summary

Add a `Terminal` section to the web/desktop General settings page for terminal appearance:

- `Font family`: free-form CSS font-family string.
- `Font size`: numeric pixel size, clamped to `8-24`.

Persist both as client-only settings and apply them live to existing xterm.js terminal instances without requiring a terminal remount.

## Scope

In scope:

- Web/desktop terminal only: `apps/web` xterm.js terminal drawer.
- General settings UI.
- Client settings schema/persistence.
- Live update of mounted terminal font family/size.
- Tests for schema defaults, settings UI persistence, and terminal renderer behavior.

Out of scope:

- Mobile terminal font-family support.
- Native mobile bridge changes.
- Installed font discovery.
- Bundled Nerd Font assets.
- Server-side settings or sync across machines.

## Decisions Locked

- Platform: web/desktop only.
- Storage: client-only settings via `ClientSettingsSchema`, not server settings.
- Font family UI: free-form text input.
- Font size UI: numeric input committed on blur/Enter.
- Font size range: clamp to `8-24`.
- Defaults:
  - `terminalFontFamily`: current hard-coded xterm value:
    `"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`
  - `terminalFontSize`: current hard-coded xterm value: `12`
- Apply behavior: update already-mounted terminal instances live.
- Label spelling: use `Font family`, not `Font-Familly`.

## Public API / Type Changes

Update [packages/contracts/src/settings.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/packages/contracts/src/settings.ts):

Add exported constants:

```ts
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const DEFAULT_TERMINAL_FONT_SIZE = 12;
```

Add schema:

```ts
export const TerminalFontFamily = TrimmedString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value || DEFAULT_TERMINAL_FONT_FAMILY),
      encode: (value) => Effect.succeed(value),
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_FAMILY)),
);

export const TerminalFontSize = Schema.Number.pipe(
  Schema.filter((value) => Number.isFinite(value)),
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_TERMINAL_FONT_SIZE)),
);
```

Implementation note: if the project’s Effect Schema helpers make `Number.isFinite` awkward, use an equivalent finite-number check already accepted by Effect.

Add client settings fields:

```ts
terminalFontFamily: TerminalFontFamily,
terminalFontSize: TerminalFontSize,
```

Add client patch fields:

```ts
terminalFontFamily: Schema.optionalKey(TerminalFontFamily),
terminalFontSize: Schema.optionalKey(TerminalFontSize),
```

Keep clamping in UI/helper logic, not as schema rejection, so older or externally edited persisted values can be normalized by the app instead of breaking hydration.

## Helper Logic

Create small pure helpers, preferably near settings logic if already colocated patterns fit:

File: [apps/web/src/components/settings/SettingsPanels.logic.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/settings/SettingsPanels.logic.ts)

Add:

```ts
export function normalizeTerminalFontSize(value: unknown): number
```

Behavior:

- Parse number from string or number.
- If not finite, return `DEFAULT_TERMINAL_FONT_SIZE`.
- Clamp below `MIN_TERMINAL_FONT_SIZE` to `MIN_TERMINAL_FONT_SIZE`.
- Clamp above `MAX_TERMINAL_FONT_SIZE` to `MAX_TERMINAL_FONT_SIZE`.
- Preserve decimals if entered, unless the existing input UX strongly prefers integers.

Add:

```ts
export function normalizeTerminalFontFamily(value: string): string
```

Behavior:

- Trim.
- If empty, return `DEFAULT_TERMINAL_FONT_FAMILY`.
- Otherwise return the trimmed string unchanged.

## Settings UI

Update [apps/web/src/components/settings/SettingsPanels.tsx](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/settings/SettingsPanels.tsx).

Add a new section after `General` or near the other visual preferences:

```tsx
<SettingsSection title="Terminal">
  ...
</SettingsSection>
```

Rows:

1. `Font family`
   - Description: `CSS font-family used by the terminal. Use an installed Nerd Font for prompt glyphs.`
   - Control: `DraftInput`
   - Width: `w-full sm:w-96`
   - Value: `settings.terminalFontFamily`
   - Placeholder: `DEFAULT_TERMINAL_FONT_FAMILY`
   - `spellCheck={false}`
   - `aria-label="Terminal font family"`
   - On commit: `updateSettings({ terminalFontFamily: normalizeTerminalFontFamily(next) })`
   - Reset button when value differs from default.

2. `Font size`
   - Description: `Terminal text size in pixels.`
   - Control: `DraftInput`
   - Type/input props:
     - `type="number"`
     - `inputMode="decimal"`
     - `min={MIN_TERMINAL_FONT_SIZE}`
     - `max={MAX_TERMINAL_FONT_SIZE}`
     - `step="0.5"`
     - `className="w-full sm:w-24"`
   - Value: `String(settings.terminalFontSize)`
   - `aria-label="Terminal font size"`
   - On commit: normalize/clamp and persist:
     `updateSettings({ terminalFontSize: normalizeTerminalFontSize(next) })`
   - Reset button when value differs from default.

Update `useSettingsRestore`:

- Include `Terminal font family` in changed labels.
- Include `Terminal font size` in changed labels.
- Reset both fields in `restoreDefaults`.

## Terminal Renderer

Update [apps/web/src/components/ThreadTerminalDrawer.tsx](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/ThreadTerminalDrawer.tsx).

Read settings with selectors to avoid broad rerenders:

```ts
const terminalFontFamily = useSettings((settings) => settings.terminalFontFamily);
const terminalFontSize = useSettings((settings) => settings.terminalFontSize);
```

When constructing `new Terminal`, replace hard-coded values:

```ts
fontSize: terminalFontSize,
fontFamily: terminalFontFamily,
```

Add a live-update effect:

```ts
useEffect(() => {
  const activeTerminal = terminalRef.current;
  const activeFitAddon = fitAddonRef.current;
  if (!activeTerminal || !activeFitAddon) return;

  activeTerminal.options.fontFamily = terminalFontFamily;
  activeTerminal.options.fontSize = terminalFontSize;
  activeTerminal.refresh(0, activeTerminal.rows - 1);
  fitTerminalSafely(activeFitAddon);
}, [terminalFontFamily, terminalFontSize]);
```

Avoid re-creating or re-attaching the terminal just because font settings changed. The existing attach lifecycle should remain keyed to thread/environment/session identity, not appearance settings.

## Edge Cases

- Empty font family input commits back to default.
- Whitespace around font family is trimmed.
- User can enter multi-family CSS strings like:
  `"JetBrainsMono Nerd Font", "Symbols Nerd Font Mono", monospace`
- Invalid font family names are still persisted because the browser fallback chain handles them.
- Non-numeric font size commits to default.
- Font size below `8` commits to `8`.
- Font size above `24` commits to `24`.
- Live refit errors should continue using existing `fitTerminalSafely` behavior.
- Existing persisted client settings without terminal fields decode to defaults.

## Tests

Add/update tests in [packages/contracts/src/settings.test.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/packages/contracts/src/settings.test.ts):

- `DEFAULT_CLIENT_SETTINGS` includes terminal font defaults.
- `ClientSettingsSchema` decodes legacy `{}` with terminal defaults.
- `ClientSettingsSchema` trims terminal font family.
- Empty terminal font family decodes to default.
- `ClientSettingsPatch` accepts terminal font family and size.

Add tests in [apps/web/src/components/settings/SettingsPanels.logic.test.ts](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/settings/SettingsPanels.logic.test.ts):

- `normalizeTerminalFontSize("14") === 14`
- `normalizeTerminalFontSize("7") === 8`
- `normalizeTerminalFontSize("30") === 24`
- `normalizeTerminalFontSize("bad") === DEFAULT_TERMINAL_FONT_SIZE`
- `normalizeTerminalFontFamily("  JetBrainsMono Nerd Font  ") === "JetBrainsMono Nerd Font"`
- empty font family returns default.

Add/update browser tests in [apps/web/src/components/ThreadTerminalDrawer.browser.tsx](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/ThreadTerminalDrawer.browser.tsx):

- Terminal constructor receives `fontFamily` and `fontSize` from settings.
- Changing settings rerenders and updates `terminal.options.fontFamily/fontSize`.
- Changing settings calls `refresh` and `fit`.
- Changing settings does not dispose/recreate/re-attach the terminal.

Add/update browser tests in [apps/web/src/components/settings/SettingsPanels.browser.tsx](/Users/guillaumemaka/.t3/worktrees/t3code/t3code-d3ed8f39/apps/web/src/components/settings/SettingsPanels.browser.tsx):

- General page renders `Terminal` section.
- Editing font family calls client settings persistence with the new value.
- Editing font size clamps out-of-range values before persistence.
- Reset buttons restore terminal defaults.
- Restore defaults includes terminal settings when dirty.

## Validation Commands

Required before considering implementation complete:

```sh
bun fmt
bun lint
bun typecheck
```

Targeted tests to run during implementation:

```sh
bun run test packages/contracts/src/settings.test.ts
bun run test apps/web/src/components/settings/SettingsPanels.logic.test.ts
bun run test apps/web/src/components/ThreadTerminalDrawer.browser.tsx
bun run test apps/web/src/components/settings/SettingsPanels.browser.tsx
```

Do not run `bun test`.
