import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("../lib/runtime", async () => {
  const Layer = await import("effect/Layer");
  return {
    runtime: { runPromise: vi.fn() },
    layer: Layer.empty,
  };
});

import { createMobilePreferencesState } from "./preferences";
import { useAtomCommand } from "./use-atom-command";
import * as MobilePreferences from "../persistence/mobile-preferences";
import * as MobileDatabase from "../persistence/mobile-database";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((resume) => {
    resolve = resume;
  });
  return { promise, resolve } as const;
}

function makePreferencesState(
  service: Omit<MobilePreferences.MobilePreferencesStore["Service"], "update"> &
    Partial<Pick<MobilePreferences.MobilePreferencesStore["Service"], "update">>,
) {
  const completeService = MobilePreferences.MobilePreferencesStore.of({
    ...service,
    update:
      service.update ??
      ((transform) =>
        service.load.pipe(
          Effect.flatMap((current) => service.savePatch(transform(current))),
          Effect.mapError((cause) =>
            cause._tag === "MobilePreferencesSaveError"
              ? cause
              : new MobilePreferences.MobilePreferencesSaveError({ cause }),
          ),
        )),
  });
  return createMobilePreferencesState(
    Atom.runtime(Layer.succeed(MobilePreferences.MobilePreferencesStore, completeService)),
  );
}

describe("mobile preferences state", () => {
  it.effect("preserves an optimistic patch when the initial load finishes later", () =>
    Effect.gen(function* () {
      const pendingLoad = deferred<MobilePreferences.Preferences>();
      const savePatch = vi.fn((patch: Partial<MobilePreferences.Preferences>) =>
        Effect.succeed(patch),
      );
      const state = makePreferencesState({
        load: Effect.promise(() => pendingLoad.promise),
        savePatch,
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);

      const save = yield* Effect.forkChild(
        Effect.exit(
          state.savePreferences.run(registry, {
            collapsedProjectGroups: ["project:new"],
          }),
        ),
        { startImmediately: true },
      );
      pendingLoad.resolve({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:old"],
      });

      const preferences = yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
        suspendOnWaiting: true,
      });
      const saveResult = yield* Fiber.join(save);
      expect(preferences).toEqual({
        baseFontSize: 18,
        collapsedProjectGroups: ["project:new"],
      });
      expect(savePatch).toHaveBeenCalledWith({
        collapsedProjectGroups: ["project:new"],
      });
      expect(Exit.isFailure(saveResult)).toBe(false);

      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("keeps both favorites when the React command sends updates before a render", () =>
    Effect.gen(function* () {
      let persisted: MobilePreferences.Preferences = { modelFavorites: [] };
      const state = makePreferencesState({
        load: Effect.succeed(persisted),
        savePatch: (patch) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...patch };
            return persisted;
          }),
        update: (transform) =>
          Effect.sync(() => {
            persisted = { ...persisted, ...transform(persisted) };
            return persisted;
          }),
      });
      const registry = AtomRegistry.make();
      const unmountPreferences = registry.mount(state.preferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      function useSavePreferences() {
        return useAtomCommand(state.savePreferences, { reportFailure: false });
      }
      const setters: Array<ReturnType<typeof useSavePreferences>> = [];
      function CaptureSetter() {
        setters.push(useSavePreferences());
        return null;
      }
      renderToString(
        createElement(RegistryContext.Provider, { value: registry }, createElement(CaptureSetter)),
      );
      const savePreferences = setters[0]!;
      const provider = ProviderInstanceId.make("codex");
      const first = savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "astra" }],
        }),
      });
      const second = savePreferences({
        transform: (current) => ({
          modelFavorites: [...(current.modelFavorites ?? []), { provider, model: "sol" }],
        }),
      });
      yield* Effect.promise(() => Promise.all([first, second]));

      expect(persisted.modelFavorites).toEqual([
        { provider, model: "astra" },
        { provider, model: "sol" },
      ]);

      yield* Effect.promise(() =>
        savePreferences({
          transform: (current) => ({
            modelFavorites: (current.modelFavorites ?? []).filter(
              (favorite) => favorite.model !== "astra",
            ),
          }),
        }),
      );
      expect(persisted.modelFavorites).toEqual([{ provider, model: "sol" }]);

      unmountPreferences();
      registry.dispose();
    }),
  );

  it.effect("clears the optimistic patch when a save is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const store = {
        load: Effect.succeed({ baseFontSize: 16 }),
        savePatch: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      };
      const state = makePreferencesState(store);
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);
      yield* AtomRegistry.getResult(registry, state.preferencesAtom, { suspendOnWaiting: true });

      const fiber = yield* Effect.forkChild(
        state.save({ baseFontSize: 20 }, registry).pipe(
          Effect.provide(
            Layer.succeed(
              MobilePreferences.MobilePreferencesStore,
              MobilePreferences.MobilePreferencesStore.of({
                ...store,
                update: () => Effect.die("unexpected"),
              }),
            ),
          ),
        ),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);

      expect(AsyncResult.getOrElse(registry.get(state.preferencesAtom), () => ({}))).toEqual({
        baseFontSize: 16,
      });
      unmount();
      registry.dispose();
    }),
  );

  it.effect("falls back to empty preferences when secure storage cannot be read", () =>
    Effect.gen(function* () {
      const state = makePreferencesState({
        load: Effect.fail(
          new MobilePreferences.MobilePreferencesLoadError({
            cause: new Error("secure storage unavailable"),
          }),
        ),
        savePatch: (patch) => Effect.succeed(patch),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(state.preferencesAtom);

      expect(
        yield* AtomRegistry.getResult(registry, state.preferencesAtom, {
          suspendOnWaiting: true,
        }),
      ).toEqual({});

      unmount();
      registry.dispose();
    }),
  );
});

describe("model picker preferences on disk", () => {
  it.effect(
    "restores explicit open and closed choices in a fresh store alongside old preferences",
    () =>
      Effect.gen(function* () {
        let stored: MobileDatabase.StoredPreferencesJson = {
          payload: JSON.stringify({ baseFontSize: 18 }),
          updatedAt: 1,
        };
        const persistence = MobilePreferences.layer.pipe(
          Layer.provide(
            Layer.mock(MobileDatabase.MobileDatabase)({
              loadPreferencesJson: Effect.sync(() => Option.some(stored)),
              savePreferencesJson: (payload, updatedAt) =>
                Effect.sync(() => {
                  stored = { payload, updatedAt };
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(MobileSecureStorage.MobileSecureStorage)({
              getItem: () => Effect.succeed(null),
              removeItem: () => Effect.void,
            }),
          ),
        );
        const load = MobilePreferences.MobilePreferencesStore.pipe(
          Effect.flatMap((store) => store.load),
        );
        expect(yield* load.pipe(Effect.provide(persistence))).toEqual({ baseFontSize: 18 });
        const expanded = {
          '["env-a","example-provider"]': true,
          '["env-b","example-provider"]': false,
        };
        yield* MobilePreferences.MobilePreferencesStore.pipe(
          Effect.flatMap((store) => store.update(() => ({ modelPickerExpanded: expanded }))),
          Effect.provide(persistence),
        );
        expect(yield* load.pipe(Effect.provide(persistence))).toEqual({
          baseFontSize: 18,
          modelPickerExpanded: expanded,
        });
      }),
  );
});
