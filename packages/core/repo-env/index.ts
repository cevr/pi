import { ConfigProvider, Effect, FileSystem, Option, Path } from "effect";

const PACKAGE_NAME = "@cvr/pi";
const ENV_FILENAME = ".env";
const EMPTY_PROVIDER = ConfigProvider.fromEnv({ env: {} });

function makeShellEnvProvider() {
  return ConfigProvider.fromEnv({
    env: Object.fromEntries(
      Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    ),
  });
}

const resolveStartPath = Effect.fn("@cvr/pi-repo-env/index/resolveStartPath")(function* (
  start: string | URL,
) {
  const path = yield* Path.Path;

  if (start instanceof URL) {
    return yield* path.fromFileUrl(start);
  }

  if (start.startsWith("file:")) {
    return yield* path.fromFileUrl(new URL(start));
  }

  return path.resolve(start);
});

const resolveStartDir = Effect.fn("@cvr/pi-repo-env/index/resolveStartDir")(function* (
  start: string | URL,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = yield* resolveStartPath(start);
  const exists = yield* fs.exists(resolved);

  if (!exists) {
    return resolved;
  }

  const info = yield* fs.stat(resolved);
  return info.type === "Directory" ? resolved : path.dirname(resolved);
});

const isPackageRoot = Effect.fn("@cvr/pi-repo-env/index/isPackageRoot")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageJsonPath = path.join(dir, "package.json");
  const exists = yield* fs.exists(packageJsonPath);

  if (!exists) {
    return false;
  }

  const packageJson = yield* fs.readFileString(packageJsonPath).pipe(
    Effect.map((text) => {
      try {
        return JSON.parse(text) as { name?: unknown };
      } catch {
        return null;
      }
    }),
  );

  return packageJson?.name === PACKAGE_NAME;
});

export const findRepoRoot = Effect.fn("@cvr/pi-repo-env/index/findRepoRoot")(function* (
  start: string | URL,
) {
  const path = yield* Path.Path;
  let current = yield* resolveStartDir(start);

  while (true) {
    if (yield* isPackageRoot(current)) {
      return Option.some(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return Option.none<string>();
    }

    current = parent;
  }
});

export const makeRepoEnvProvider = Effect.fn("@cvr/pi-repo-env/index/makeRepoEnvProvider")(function* (
  start: string | URL,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* findRepoRoot(start);

  const repoEnvProvider =
    Option.isNone(repoRoot)
      ? EMPTY_PROVIDER
      : yield* Effect.gen(function* () {
          const envPath = path.join(repoRoot.value, ENV_FILENAME);
          const exists = yield* fs.exists(envPath);
          if (!exists) {
            return EMPTY_PROVIDER;
          }
          return yield* ConfigProvider.fromDotEnv({ path: envPath });
        });

  return ConfigProvider.orElse(makeShellEnvProvider(), repoEnvProvider);
});

export const layerRepoEnv = (start: string | URL) => ConfigProvider.layer(makeRepoEnvProvider(start));
