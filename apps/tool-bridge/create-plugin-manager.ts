import { createCoreToolPluginManager } from "@stanley2058/lilac-core";
import { getCoreConfig, type CoreConfig } from "@stanley2058/lilac-utils";

export function createToolBridgePluginManager(params: {
  readonly dataDir: string;
  readonly getConfig?: () => Promise<CoreConfig>;
}) {
  return createCoreToolPluginManager({
    runtime: {
      getConfig: params.getConfig ?? (() => getCoreConfig()),
    },
    dataDir: params.dataDir,
  });
}
