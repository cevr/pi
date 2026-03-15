/**
 * editor autocomplete capability registry.
 *
 * contributors decorate the editor's base autocomplete provider rather than
 * replacing the editor host itself. that keeps domain semantics out of the ui
 * host while preserving normal fallback behavior like @file completion.
 *
 * backed by SubscriptionRef inside the `EditorCapabilities` Effect service.
 */

import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { Effect, Layer, Ref, Schema, ServiceMap, SubscriptionRef } from "effect";

// ---------------------------------------------------------------------------
// types (shared between Effect and legacy APIs)
// ---------------------------------------------------------------------------

export interface EditorAutocompleteContext {
  cwd: string;
}

export interface EditorAutocompleteContributor {
  id: string;
  priority?: number;
  enhance(provider: AutocompleteProvider, context: EditorAutocompleteContext): AutocompleteProvider;
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class EditorCapabilitiesError extends Schema.TaggedErrorClass<EditorCapabilitiesError>()(
  "EditorCapabilitiesError",
  { message: Schema.String },
) {}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sortContributors(
  contributors: Map<string, EditorAutocompleteContributor>,
): EditorAutocompleteContributor[] {
  return [...contributors.values()].sort((a, b) => {
    const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });
}

function composeProvider(
  baseProvider: AutocompleteProvider,
  context: EditorAutocompleteContext,
  contributors: Map<string, EditorAutocompleteContributor>,
): AutocompleteProvider {
  let provider = baseProvider;
  for (const contributor of sortContributors(contributors)) {
    provider = contributor.enhance(provider, context);
  }
  return provider;
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

export class EditorCapabilities extends ServiceMap.Service<
  EditorCapabilities,
  {
    readonly register: (
      contributor: EditorAutocompleteContributor,
    ) => Effect.Effect<() => Effect.Effect<void>>;
    readonly list: () => Effect.Effect<EditorAutocompleteContributor[]>;
    readonly compose: (
      baseProvider: AutocompleteProvider,
      context: EditorAutocompleteContext,
    ) => Effect.Effect<AutocompleteProvider>;
  }
>()("@cvr/pi-editor-capabilities/index/EditorCapabilities") {
  static layer = Layer.effect(
    EditorCapabilities,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make(new Map<string, EditorAutocompleteContributor>());

      return {
        register: (contributor: EditorAutocompleteContributor) =>
          Effect.gen(function* () {
            yield* SubscriptionRef.update(ref, (map) => {
              const next = new Map(map);
              next.set(contributor.id, contributor);
              return next;
            });
            return () =>
              SubscriptionRef.update(ref, (map) => {
                const next = new Map(map);
                if (next.get(contributor.id) === contributor) {
                  next.delete(contributor.id);
                }
                return next;
              });
          }),

        list: () => SubscriptionRef.get(ref).pipe(Effect.map(sortContributors)),

        compose: (baseProvider: AutocompleteProvider, context: EditorAutocompleteContext) =>
          SubscriptionRef.get(ref).pipe(
            Effect.map((contributors) => composeProvider(baseProvider, context, contributors)),
          ),
      };
    }),
  );

  static layerTest = Layer.effect(
    EditorCapabilities,
    Effect.gen(function* () {
      const ref = yield* Ref.make(new Map<string, EditorAutocompleteContributor>());

      return {
        register: (contributor: EditorAutocompleteContributor) =>
          Effect.gen(function* () {
            yield* Ref.update(ref, (map) => {
              const next = new Map(map);
              next.set(contributor.id, contributor);
              return next;
            });
            return () =>
              Ref.update(ref, (map) => {
                const next = new Map(map);
                if (next.get(contributor.id) === contributor) {
                  next.delete(contributor.id);
                }
                return next;
              });
          }),

        list: () => Ref.get(ref).pipe(Effect.map(sortContributors)),

        compose: (baseProvider: AutocompleteProvider, context: EditorAutocompleteContext) =>
          Ref.get(ref).pipe(
            Effect.map((contributors) => composeProvider(baseProvider, context, contributors)),
          ),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// sync API — bridges to encapsulated state (no bare module-level singletons)
// ---------------------------------------------------------------------------

const _state = {
  contributors: new Map<string, EditorAutocompleteContributor>(),
  listeners: new Set<() => void>(),
};

function emitChange(): void {
  for (const listener of _state.listeners) listener();
}

export function registerEditorAutocompleteContributor(
  contributor: EditorAutocompleteContributor,
): () => void {
  const previous = _state.contributors.get(contributor.id);
  _state.contributors.set(contributor.id, contributor);
  if (previous !== contributor) emitChange();

  return () => {
    if (_state.contributors.get(contributor.id) !== contributor) return;
    _state.contributors.delete(contributor.id);
    emitChange();
  };
}

export function subscribeEditorAutocompleteContributors(listener: () => void): () => void {
  _state.listeners.add(listener);
  return () => {
    _state.listeners.delete(listener);
  };
}

export function listEditorAutocompleteContributors(): EditorAutocompleteContributor[] {
  return sortContributors(_state.contributors);
}

export function composeEditorAutocompleteProvider(
  baseProvider: AutocompleteProvider,
  context: EditorAutocompleteContext,
): AutocompleteProvider {
  return composeProvider(baseProvider, context, _state.contributors);
}
