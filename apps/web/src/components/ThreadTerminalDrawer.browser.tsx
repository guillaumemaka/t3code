import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId, type TerminalAttachStreamEvent } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_TERMINAL_FONT_FAMILY } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const {
  terminalConstructorSpy,
  terminalDisposeSpy,
  terminalRefreshSpy,
  fitAddonFitSpy,
  fitAddonLoadSpy,
  terminalInstances,
  environmentApiById,
  readEnvironmentApiMock,
  readLocalApiMock,
  ensureLocalApiMock,
} = vi.hoisted(() => ({
  terminalConstructorSpy: vi.fn(),
  terminalDisposeSpy: vi.fn(),
  terminalRefreshSpy: vi.fn(),
  fitAddonFitSpy: vi.fn(),
  fitAddonLoadSpy: vi.fn(),
  terminalInstances: [] as Array<{
    options: { fontFamily?: string; fontSize?: number; theme?: unknown };
  }>,
  environmentApiById: new Map<
    string,
    {
      terminal: {
        open: ReturnType<typeof vi.fn>;
        attach: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        resize: ReturnType<typeof vi.fn>;
      };
    }
  >(),
  readEnvironmentApiMock: vi.fn((environmentId: string) => environmentApiById.get(environmentId)),
  ensureLocalApiMock: vi.fn(),
  readLocalApiMock: vi.fn<
    () =>
      | {
          contextMenu: { show: ReturnType<typeof vi.fn> };
          shell: { openExternal: ReturnType<typeof vi.fn> };
        }
      | undefined
  >(() => ({
    contextMenu: { show: vi.fn(async () => null) },
    shell: { openExternal: vi.fn(async () => undefined) },
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = fitAddonFitSpy;
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options: { fontFamily?: string; fontSize?: number; theme?: unknown } = {};
    buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        getLine: vi.fn(() => null),
      },
    };

    constructor(options: { fontFamily?: string; fontSize?: number; theme?: unknown }) {
      this.options = { ...options };
      terminalInstances.push(this);
      terminalConstructorSpy(options);
    }

    loadAddon(addon: unknown) {
      fitAddonLoadSpy(addon);
    }

    open() {}

    write() {}

    clear() {}

    clearSelection() {}

    focus() {}

    refresh(start?: number, end?: number) {
      terminalRefreshSpy(start, end);
    }

    scrollToBottom() {}

    hasSelection() {
      return false;
    }

    getSelection() {
      return "";
    }

    getSelectionPosition() {
      return null;
    }

    attachCustomKeyEventHandler() {
      return true;
    }

    registerLinkProvider() {
      return { dispose: vi.fn() };
    }

    onData() {
      return { dispose: vi.fn() };
    }

    onSelectionChange() {
      return { dispose: vi.fn() };
    }

    dispose() {
      terminalDisposeSpy();
    }
  },
}));

vi.mock("~/environmentApi", () => ({
  readEnvironmentApi: readEnvironmentApiMock,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: ensureLocalApiMock,
  readLocalApi: readLocalApiMock,
}));

import { TerminalViewport } from "./ThreadTerminalDrawer";
import { __resetClientSettingsPersistenceForTests, useUpdateSettings } from "../hooks/useSettings";

function TerminalSettingsUpdateButton() {
  const { updateSettings } = useUpdateSettings();
  return (
    <button
      type="button"
      onClick={() =>
        updateSettings({
          terminalFontFamily: '"JetBrainsMono Nerd Font", monospace',
          terminalFontSize: 16,
        })
      }
    >
      Update terminal settings
    </button>
  );
}

const THREAD_ID = ThreadId.make("thread-terminal-browser");

function createEnvironmentApi() {
  const snapshot = {
    threadId: THREAD_ID,
    terminalId: "term-1",
    cwd: "/repo/project",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-04-07T00:00:00.000Z",
  };

  return {
    terminal: {
      open: vi.fn(async () => snapshot),
      attach: vi.fn(
        (
          _input: unknown,
          listener: (event: TerminalAttachStreamEvent) => void,
          _options?: unknown,
        ) => {
          listener({ type: "snapshot", snapshot });
          return vi.fn();
        },
      ),
      write: vi.fn(async () => undefined),
      resize: vi.fn(async () => undefined),
    },
  };
}

async function mountTerminalViewport(props: {
  threadRef: ReturnType<typeof scopeThreadRef>;
  drawerBackgroundColor?: string;
  drawerTextColor?: string;
  runtimeEnv?: Record<string, string>;
  clientSettings?: Partial<typeof DEFAULT_CLIENT_SETTINGS>;
}) {
  window.nativeApi = {
    persistence: {
      getClientSettings: vi.fn().mockResolvedValue(props.clientSettings ?? null),
      setClientSettings: vi.fn().mockResolvedValue(undefined),
    },
  } as never;
  ensureLocalApiMock.mockReturnValue(window.nativeApi);

  const drawer = document.createElement("div");
  drawer.className = "thread-terminal-drawer";
  if (props.drawerBackgroundColor) {
    drawer.style.backgroundColor = props.drawerBackgroundColor;
  }
  if (props.drawerTextColor) {
    drawer.style.color = props.drawerTextColor;
  }

  const host = document.createElement("div");
  host.style.width = "800px";
  host.style.height = "400px";
  drawer.append(host);
  document.body.append(drawer);

  const screen = await render(
    <>
      <TerminalViewport
        threadRef={props.threadRef}
        threadId={THREAD_ID}
        terminalId="term-1"
        terminalLabel="Terminal"
        cwd="/repo/project"
        {...(props.runtimeEnv ? { runtimeEnv: props.runtimeEnv } : {})}
        onSessionExited={() => undefined}
        onAddTerminalContext={() => undefined}
        focusRequestId={0}
        autoFocus={false}
        resizeEpoch={0}
        drawerHeight={320}
        keybindings={[]}
      />
      <TerminalSettingsUpdateButton />
    </>,
    { container: host },
  );

  return {
    rerender: async (nextProps: {
      threadRef: ReturnType<typeof scopeThreadRef>;
      runtimeEnv?: Record<string, string>;
    }) => {
      await screen.rerender(
        <>
          <TerminalViewport
            threadRef={nextProps.threadRef}
            threadId={THREAD_ID}
            terminalId="term-1"
            terminalLabel="Terminal"
            cwd="/repo/project"
            {...(nextProps.runtimeEnv ? { runtimeEnv: nextProps.runtimeEnv } : {})}
            onSessionExited={() => undefined}
            onAddTerminalContext={() => undefined}
            focusRequestId={0}
            autoFocus={false}
            resizeEpoch={0}
            drawerHeight={320}
            keybindings={[]}
          />
          <TerminalSettingsUpdateButton />
        </>,
      );
    },
    cleanup: async () => {
      await screen.unmount();
      drawer.remove();
    },
  };
}

describe("TerminalViewport", () => {
  afterEach(() => {
    __resetClientSettingsPersistenceForTests();
    environmentApiById.clear();
    readEnvironmentApiMock.mockClear();
    ensureLocalApiMock.mockReset();
    readLocalApiMock.mockClear();
    terminalConstructorSpy.mockClear();
    terminalDisposeSpy.mockClear();
    terminalRefreshSpy.mockClear();
    fitAddonFitSpy.mockClear();
    fitAddonLoadSpy.mockClear();
    terminalInstances.length = 0;
    Reflect.deleteProperty(window, "nativeApi");
  });

  it("does not create a terminal when APIs are unavailable", async () => {
    readEnvironmentApiMock.mockReturnValueOnce(undefined);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).not.toHaveBeenCalled();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders and attaches the terminal without the desktop local API", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    readLocalApiMock.mockReturnValueOnce(undefined);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the terminal mounted when xterm fit runs before dimensions are ready", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);
    fitAddonFitSpy.mockImplementationOnce(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'dimensions')");
    });

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      expect(fitAddonFitSpy).toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("reattaches the terminal when the scoped thread reference changes", async () => {
    const environmentA = createEnvironmentApi();
    const environmentB = createEnvironmentApi();
    environmentApiById.set("environment-a", environmentA);
    environmentApiById.set("environment-b", environmentB);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environmentA.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-b" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environmentB.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reattach the terminal when the scoped thread reference values stay the same", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      });

      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("does not reattach when runtime env contents are unchanged but object identity changes", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      runtimeEnv: { PATH: "/usr/bin", T3: "1" },
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });

      await mounted.rerender({
        threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
        runtimeEnv: { T3: "1", PATH: "/usr/bin" },
      });

      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      });
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("constructs the terminal with default font settings", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
            fontSize: DEFAULT_CLIENT_SETTINGS.terminalFontSize,
          }),
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("updates mounted terminal font options without recreating or reattaching", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
    });

    try {
      await vi.waitFor(() => {
        expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      const terminal = terminalInstances[0];
      expect(terminal?.options.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
      expect(terminal?.options.fontSize).toBe(12);

      terminalRefreshSpy.mockClear();
      fitAddonFitSpy.mockClear();
      await page.getByRole("button", { name: "Update terminal settings" }).click();

      await vi.waitFor(() => {
        expect(terminal?.options.fontFamily).toBe('"JetBrainsMono Nerd Font", monospace');
        expect(terminal?.options.fontSize).toBe(16);
      });
      expect(terminalRefreshSpy).toHaveBeenCalledWith(0, 23);
      expect(fitAddonFitSpy).toHaveBeenCalled();
      expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      expect(environment.terminal.attach).toHaveBeenCalledTimes(1);
      expect(terminalDisposeSpy).not.toHaveBeenCalled();
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the drawer surface colors for the terminal theme", async () => {
    const environment = createEnvironmentApi();
    environmentApiById.set("environment-a", environment);

    const mounted = await mountTerminalViewport({
      threadRef: scopeThreadRef("environment-a" as never, THREAD_ID),
      drawerBackgroundColor: "rgb(24, 28, 36)",
      drawerTextColor: "rgb(228, 232, 240)",
    });

    try {
      await vi.waitFor(() => {
        expect(terminalConstructorSpy).toHaveBeenCalledTimes(1);
      });

      expect(terminalConstructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: expect.objectContaining({
            background: "rgb(24, 28, 36)",
            foreground: "rgb(228, 232, 240)",
          }),
        }),
      );
    } finally {
      await mounted.cleanup();
    }
  });
});
