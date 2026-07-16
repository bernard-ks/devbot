import path from "node:path";
import { clearRuntimeLock, markRuntimeRunning, runtimeLockPath } from "./runtime-lock.js";
import {
  assertSafeLegacyRuntimeRoot,
  migrateLegacyRuntimeState,
  runtimeStateRoot,
  type RuntimeMigrationOptions
} from "./runtime-paths.js";

export interface RuntimeStateLease {
  primaryLock: string;
  legacyLock: string;
  migrated: string[];
  release(): void;
}

export interface AcquireRuntimeStateOptions extends RuntimeMigrationOptions {
  primaryLock?: string;
}

/**
 * Fence both this release's protected lock and the checkout-local lock understood
 * by older releases before moving any live state. This prevents split ledgers
 * during an upgrade or a concurrent old/new startup race.
 */
export function acquireRuntimeStateLease(options: AcquireRuntimeStateOptions = {}): RuntimeStateLease {
  const legacyRoot = path.resolve(options.legacyRoot ?? path.join(process.cwd(), ".devbot"));
  const targetRoot = path.resolve(options.targetRoot ?? runtimeStateRoot());
  const primaryLock = path.resolve(options.primaryLock ?? runtimeLockPath());
  const legacyLock = path.join(legacyRoot, "runtime.pid");
  assertSafeLegacyRuntimeRoot(legacyRoot);

  const acquired: string[] = [];
  try {
    markRuntimeRunning(primaryLock);
    acquired.push(primaryLock);
    if (legacyLock !== primaryLock) {
      // `.devbot` also contains repository metadata, so preserve its existing
      // directory mode while still creating a private 0600 compatibility lock.
      markRuntimeRunning(legacyLock, { hardenDirectory: false });
      acquired.push(legacyLock);
    }
    const migrated = migrateLegacyRuntimeState({
      legacyRoot,
      targetRoot,
      ...(options.environment ? { environment: options.environment } : {})
    });
    let released = false;
    return {
      primaryLock,
      legacyLock,
      migrated,
      release(): void {
        if (released) return;
        released = true;
        for (const lock of [...acquired].reverse()) clearRuntimeLock(lock);
      }
    };
  } catch (error) {
    for (const lock of acquired.reverse()) clearRuntimeLock(lock);
    throw error;
  }
}
