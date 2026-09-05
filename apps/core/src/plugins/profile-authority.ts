import {
  profileIncludes,
  resolveNativeSubagentProfile,
  type CoreConfig,
  type NativeSubagentProfile,
} from "@stanley2058/lilac-utils";

function profileAllowsLevel2Contribution(
  profile: ReturnType<typeof resolveNativeSubagentProfile>,
  params: { readonly pluginId: string; readonly callableId: string },
): boolean {
  return (
    profileIncludes(profile.level2.plugins, params.pluginId) &&
    profileIncludes(profile.level2.callables, params.callableId)
  );
}

export function isLevel2ContributionAllowedForNativeProfile(params: {
  readonly config: CoreConfig;
  readonly profileName: NativeSubagentProfile;
  readonly pluginId: string;
  readonly callableId: string;
}): boolean {
  const profile = resolveNativeSubagentProfile(params.config, params.profileName);
  return profileAllowsLevel2Contribution(profile, params);
}

export function isWebFetchAllowedForNativeProfile(params: {
  readonly config: CoreConfig;
  readonly profileName: NativeSubagentProfile;
}): boolean {
  const profile = resolveNativeSubagentProfile(params.config, params.profileName);
  if (!profile.network) return false;
  return profileAllowsLevel2Contribution(profile, { pluginId: "web", callableId: "fetch" });
}
